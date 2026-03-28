import * as net from 'net';
import * as dgram from 'dgram';
import * as crypto from 'crypto';
import { ChildProcess, spawn } from 'child_process';
import { computeDigestResponse, parseWwwAuthenticate } from './digest';

const EXCHANGE_TIMEOUT_MS = 8000;
const FFMPEG_KILL_TIMEOUT_MS = 3000;

export type DuplexMode = 'half_duplex' | 'full_duplex';

export class TalkbackSession {
  private socket: net.Socket | undefined;
  private ffmpegProcess: ChildProcess | undefined;
  private udpServer: dgram.Socket | undefined;
  private cseq = 0;

  constructor(
    private ip: string,
    private port: number,
    private username: string,
    private password: string,
    private duplexMode: DuplexMode,
    private console: Console
  ) {}

  async start(ffmpegInputArgs: string[]): Promise<void> {
    const host = this.port === 554 ? this.ip : `${this.ip}:${this.port}`;
    const uri = `rtsp://${host}/multitrans`;
    const clientUuid = crypto.randomUUID();

    this.socket = new net.Socket();

    // Connect TCP to camera RTSP port
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.socket!.once('error', onError);
      this.socket!.connect(this.port, this.ip, () => {
        this.socket!.removeListener('error', onError);
        resolve();
      });
    });
    this.console.log(`[talkback] TCP connected to ${this.ip}:${this.port}`);

    // Step 1: Initial request (some cameras return 200 directly, others 401 for digest)
    const r1 = await this.exchange(
      `MULTITRANS ${uri} RTSP/1.0\r\nCSeq: ${this.cseq++}\r\nX-Client-UUID: ${clientUuid}\r\n\r\n`
    );
    this.console.log('[talkback] step1:', r1.slice(0, 200));

    let sessionId: string | undefined;

    if (r1.includes('401')) {
      // Step 2: Digest auth required
      const wwwAuth = r1.match(/WWW-Authenticate:\s*Digest\s+(.+)/i)?.[1]
        ?? r1.match(/WWW-Authenticate:\s*(.+)/i)?.[1] ?? '';
      const { realm, nonce } = parseWwwAuthenticate(wwwAuth);
      if (!realm || !nonce) throw new Error('Failed to parse WWW-Authenticate challenge');

      const responseHash = computeDigestResponse(
        this.username, this.password, realm, nonce, 'MULTITRANS', uri
      );
      const authHeader = `Digest username="${this.username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${responseHash}"`;

      const r2 = await this.exchange(
        `MULTITRANS ${uri} RTSP/1.0\r\nCSeq: ${this.cseq++}\r\nAuthorization: ${authHeader}\r\nX-Client-UUID: ${clientUuid}\r\n\r\n`
      );
      this.console.log('[talkback] step2 auth:', r2.slice(0, 200));
      if (!r2.includes('200')) throw new Error('Authentication failed');
      sessionId = r2.match(/Session:\s*([^\r\n;]+)/i)?.[1]?.trim();
    } else if (r1.includes('200')) {
      sessionId = r1.match(/Session:\s*([^\r\n;]+)/i)?.[1]?.trim();
    } else {
      throw new Error(`Unexpected response: ${r1.split('\r\n')[0]}`);
    }

    if (!sessionId) {
      this.console.warn('[talkback] no session ID in response, continuing anyway');
    }
    this.console.log('[talkback] session:', sessionId ?? '(none)');

    // Step 3: Open talk channel
    const payload = JSON.stringify({
      type: 'request',
      seq: 0,
      params: { method: 'get', talk: { mode: this.duplexMode } },
    });
    const sessionHeader = sessionId ? `Session: ${sessionId}\r\n` : '';
    const channelResp = await this.exchange(
      `MULTITRANS ${uri} RTSP/1.0\r\nCSeq: ${this.cseq++}\r\n${sessionHeader}Content-Type: application/json\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`
    );
    this.console.log('[talkback] channel open:', channelResp.slice(0, 300));

    if (!channelResp.includes('200')) {
      throw new Error(`Failed to open talk channel: ${channelResp.split('\r\n')[0]}`);
    }

    // Validate business-level response (camera may return 200 but with error_code != 0)
    const bodyMatch = channelResp.match(/\r\n\r\n([\s\S]*)$/);
    if (bodyMatch) {
      const body = bodyMatch[1];
      if (body.includes('"error_code"') && !body.includes('"error_code":0')) {
        throw new Error(`Talk channel error: ${body.trim()}`);
      }
    }

    // Start UDP server to receive RTP from FFmpeg
    const udpPort = await this.startUdpServer();
    this.console.log('[talkback] UDP server on port', udpPort);

    // Start FFmpeg to transcode mic audio -> PCM A-law 8kHz -> RTP -> UDP
    this.startFfmpeg(ffmpegInputArgs, udpPort);
    this.console.log('[talkback] FFmpeg started');
  }

  private startUdpServer(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = dgram.createSocket('udp4');
      this.udpServer = server;

      server.on('message', (rtpPacket) => {
        if (!this.socket || this.socket.destroyed) return;
        // Wrap in RTSP interleaved frame: $ | channel(1B) | length(2B BE) | rtp_data
        const header = Buffer.alloc(4);
        header[0] = 0x24;                          // '$'
        header[1] = 1;                             // channel 1 = audio
        header.writeUInt16BE(rtpPacket.length, 2);
        this.socket.write(Buffer.concat([header, rtpPacket]), (err) => {
          if (err) this.console.error('[talkback] socket write error:', err.message);
        });
      });

      server.once('error', (err) => {
        reject(err);
      });

      server.bind(0, '127.0.0.1', () => {
        // Replace the one-shot error handler with a persistent one now that bind succeeded
        server.removeAllListeners('error');
        server.on('error', (err) => {
          this.console.error('[talkback] UDP error:', err.message);
        });
        resolve((server.address() as net.AddressInfo).port);
      });
    });
  }

  private startFfmpeg(inputArgs: string[], udpPort: number): void {
    const args = [
      ...inputArgs,
      '-vn',
      '-af', 'aresample=8000,pan=mono|c0=c0,adelay=300:all=1,arealtime',
      '-acodec', 'pcm_alaw',
      '-ar', '8000',
      '-ac', '1',
      '-f', 'rtp',
      `rtp://127.0.0.1:${udpPort}`,
    ];

    this.console.log('[talkback] ffmpeg args:', args.join(' '));
    this.ffmpegProcess = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    this.ffmpegProcess.stdout?.on('data', (d: Buffer) => this.console.log('[ffmpeg]', d.toString()));
    this.ffmpegProcess.stderr?.on('data', (d: Buffer) => this.console.log('[ffmpeg]', d.toString()));
    this.ffmpegProcess.on('exit', (code) => this.console.log('[talkback] ffmpeg exited:', code));
  }

  /**
   * Send a request and wait for the complete RTSP response (headers + optional body).
   * Rejects on timeout, socket error, or socket close.
   */
  private exchange(request: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        return reject(new Error('Socket not available'));
      }

      let buffer = '';
      let settled = false;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket?.removeListener('data', onData);
        this.socket?.removeListener('error', onError);
        this.socket?.removeListener('close', onClose);
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('MULTITRANS exchange timeout'));
      }, EXCHANGE_TIMEOUT_MS);

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const onClose = () => {
        cleanup();
        reject(new Error('Socket closed during exchange'));
      };

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();

        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const headers = buffer.slice(0, headerEnd);
        const contentLengthMatch = headers.match(/Content-Length:\s*(\d+)/i);
        const contentLength = contentLengthMatch ? parseInt(contentLengthMatch[1]) : 0;
        const bodyStart = headerEnd + 4;

        if (buffer.length >= bodyStart + contentLength) {
          cleanup();
          resolve(buffer.slice(0, bodyStart + contentLength));
        }
      };

      this.socket.on('data', onData);
      this.socket.on('error', onError);
      this.socket.once('close', onClose);
      this.socket.write(request, (err) => {
        if (err) {
          cleanup();
          reject(err);
        }
      });
    });
  }

  stop(): void {
    this.console.log('[talkback] stopping');

    if (this.ffmpegProcess) {
      const proc = this.ffmpegProcess;
      this.ffmpegProcess = undefined;
      proc.kill('SIGTERM');
      // Force kill if FFmpeg doesn't exit in time
      const killTimer = setTimeout(() => {
        if (!proc.killed) {
          this.console.log('[talkback] force killing ffmpeg');
          proc.kill('SIGKILL');
        }
      }, FFMPEG_KILL_TIMEOUT_MS);
      proc.once('exit', () => clearTimeout(killTimer));
    }

    this.udpServer?.close();
    this.udpServer = undefined;
    this.socket?.destroy();
    this.socket = undefined;
  }
}
