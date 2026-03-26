import * as net from 'net';
import * as dgram from 'dgram';
import * as crypto from 'crypto';
import { ChildProcess, spawn } from 'child_process';
import { computeDigestResponse, parseWwwAuthenticate } from './digest';

export class TalkbackSession {
  private socket: net.Socket | undefined;
  private ffmpegProcess: ChildProcess | undefined;
  private udpServer: dgram.Socket | undefined;
  private cseq = 0;

  constructor(
    private ip: string,
    private username: string,
    private password: string,
    private console: Console
  ) {}

  async start(ffmpegInputArgs: string[]): Promise<void> {
    const uri = `rtsp://${this.ip}/multitrans`;
    const clientUuid = crypto.randomUUID();

    this.socket = new net.Socket();

    // Connect TCP to camera:554
    await new Promise<void>((resolve, reject) => {
      this.socket!.connect(554, this.ip, resolve);
      this.socket!.once('error', reject);
    });
    this.console.log('[talkback] TCP connected');

    // Step 1: Request (some cameras return 200 directly, others require 401 digest)
    const r1 = await this.exchange(
      `MULTITRANS ${uri} RTSP/1.0\r\nCSeq: ${this.cseq++}\r\nX-Client-UUID: ${clientUuid}\r\n\r\n`
    );
    this.console.log('[talkback] step1:', r1.slice(0, 200));

    let sessionId: string | undefined;

    if (r1.includes('401')) {
      // Step 2: Digest auth required
      const wwwAuth = r1.match(/WWW-Authenticate:\s*Digest\s+(.+)/i)?.[1] ?? r1.match(/WWW-Authenticate:\s*(.+)/i)?.[1] ?? '';
      const { realm, nonce } = parseWwwAuthenticate(wwwAuth);
      if (!realm || !nonce) throw new Error('Failed to parse WWW-Authenticate challenge');

      const responseHash = computeDigestResponse(this.username, this.password, realm, nonce, 'MULTITRANS', uri);
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

    this.console.log('[talkback] session:', sessionId ?? '(none)');

    // Step 3: Open talk channel
    const payload = JSON.stringify({
      type: 'request',
      seq: 0,
      params: { method: 'get', talk: { mode: 'half_duplex' } },
    });
    const sessionHeader = sessionId ? `Session: ${sessionId}\r\n` : '';
    const channelResp = await this.exchange(
      `MULTITRANS ${uri} RTSP/1.0\r\nCSeq: ${this.cseq++}\r\n${sessionHeader}Content-Type: application/json\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`
    );
    this.console.log('[talkback] channel open:', channelResp.slice(0, 200));

    // Start UDP server to receive RTP from FFmpeg
    const udpPort = await this.startUdpServer();
    this.console.log('[talkback] UDP server on port', udpPort);

    // Start FFmpeg to transcode mic audio → PCM A-law 8kHz → RTP → UDP
    this.startFfmpeg(ffmpegInputArgs, udpPort);
    this.console.log('[talkback] FFmpeg started');
  }

  private startUdpServer(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.udpServer = dgram.createSocket('udp4');

      this.udpServer.on('error', (err) => {
        this.console.error('[talkback] UDP error:', err);
      });

      this.udpServer.on('message', (rtpPacket) => {
        if (!this.socket || this.socket.destroyed) return;
        // Wrap in RTSP interleaved frame: $ | channel(1B) | length(2B) | rtp_data
        const header = Buffer.alloc(4);
        header[0] = 0x24;                          // '$'
        header[1] = 1;                             // channel 1 = audio
        header.writeUInt16BE(rtpPacket.length, 2); // payload length
        try {
          this.socket.write(Buffer.concat([header, rtpPacket]));
        } catch (e) {
          this.console.error('[talkback] socket write error:', e);
        }
      });

      this.udpServer.bind(0, '127.0.0.1', () => {
        const addr = this.udpServer!.address() as { port: number; address: string };
        resolve(addr.port);
      });

      this.udpServer.once('error', reject);
    });
  }

  private startFfmpeg(inputArgs: string[], udpPort: number): void {
    // inputArgs: FFmpeg input arguments from Scrypted (e.g. ['-i', 'pipe:0'] or actual stream args)
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

  // Send a request and wait for the complete RTSP response (headers + optional body)
  private exchange(request: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => {
        this.socket?.removeListener('data', onData);
        reject(new Error('MULTITRANS exchange timeout'));
      }, 8000);

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();

        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const headers = buffer.slice(0, headerEnd);
        const contentLengthMatch = headers.match(/Content-Length:\s*(\d+)/i);
        const contentLength = contentLengthMatch ? parseInt(contentLengthMatch[1]) : 0;
        const bodyStart = headerEnd + 4;

        if (buffer.length >= bodyStart + contentLength) {
          clearTimeout(timer);
          this.socket?.removeListener('data', onData);
          resolve(buffer.slice(0, bodyStart + contentLength));
        }
      };

      this.socket!.on('data', onData);
      this.socket!.write(request, (err) => {
        if (err) {
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  stop(): void {
    this.console.log('[talkback] stopping');
    this.ffmpegProcess?.kill('SIGTERM');
    this.udpServer?.close();
    this.socket?.destroy();
    this.ffmpegProcess = undefined;
    this.udpServer = undefined;
    this.socket = undefined;
  }
}
