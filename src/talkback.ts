import * as net from 'net';
import * as dgram from 'dgram';
import * as crypto from 'crypto';
import { ChildProcess, spawn } from 'child_process';
import { computeDigestResponse, parseWwwAuthenticate } from './digest';

const EXCHANGE_TIMEOUT_MS = 8000;
const FFMPEG_KILL_TIMEOUT_MS = 3000;

export type DuplexMode = 'half_duplex' | 'full_duplex';

/**
 * Send a request over a socket and wait for the complete RTSP response (headers + optional body).
 * Rejects on timeout, socket error, or socket close.
 */
function exchange(socket: net.Socket, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!socket || socket.destroyed) {
      return reject(new Error('Socket not available'));
    }

    let buffer = '';
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
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

    socket.on('data', onData);
    socket.on('error', onError);
    socket.once('close', onClose);
    socket.write(request, (err) => {
      if (err) {
        cleanup();
        reject(err);
      }
    });
  });
}

/**
 * Build the Digest Authorization header, with qop=auth support.
 */
function buildDigestAuth(
  username: string,
  password: string,
  realm: string,
  nonce: string,
  qop: string,
  method: string,
  uri: string
): string {
  if (qop.includes('auth')) {
    const cnonce = crypto.randomBytes(8).toString('hex');
    const nc = '00000001';
    const responseHash = computeDigestResponse(username, password, realm, nonce, method, uri, { qop: 'auth', nc, cnonce });
    return `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${responseHash}"`;
  }
  const responseHash = computeDigestResponse(username, password, realm, nonce, method, uri);
  return `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${responseHash}"`;
}

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
    const r1 = await exchange(
      this.socket,
      `MULTITRANS ${uri} RTSP/1.0\r\nCSeq: ${this.cseq++}\r\nX-Client-UUID: ${clientUuid}\r\n\r\n`
    );
    this.console.log('[talkback] step1:', r1.slice(0, 500));

    let sessionId: string | undefined;

    if (r1.includes('401')) {
      // Step 2: Digest auth required
      const wwwAuth = r1.match(/WWW-Authenticate:\s*Digest\s+(.+)/i)?.[1]
        ?? r1.match(/WWW-Authenticate:\s*(.+)/i)?.[1] ?? '';
      const { realm, nonce, qop } = parseWwwAuthenticate(wwwAuth);
      if (!realm || !nonce) throw new Error('Failed to parse WWW-Authenticate challenge');

      this.console.log(`[talkback] auth challenge — realm="${realm}" nonce="${nonce}" qop="${qop}"`);

      const authHeader = buildDigestAuth(this.username, this.password, realm, nonce, qop, 'MULTITRANS', uri);

      const r2 = await exchange(
        this.socket,
        `MULTITRANS ${uri} RTSP/1.0\r\nCSeq: ${this.cseq++}\r\nAuthorization: ${authHeader}\r\nX-Client-UUID: ${clientUuid}\r\n\r\n`
      );
      this.console.log('[talkback] step2 auth:', r2.slice(0, 500));
      if (!r2.includes('200')) throw new Error('Authentication failed (401) — check username/password');
      sessionId = r2.match(/Session:\s*([^\r\n;]+)/i)?.[1]?.trim();
    } else if (r1.includes('200')) {
      sessionId = r1.match(/Session:\s*([^\r\n;]+)/i)?.[1]?.trim();
    } else if (r1.includes('400')) {
      throw new Error('Camera returned 400 Bad Request — MULTITRANS not supported (check CN firmware)');
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
    const channelResp = await exchange(
      this.socket,
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

/**
 * Lightweight probe: verifies TCP connectivity, MULTITRANS support, and credentials.
 * Logs each step in detail for debugging. Does not open a full talkback session.
 */
export async function probeCamera(
  ip: string,
  port: number,
  username: string,
  password: string,
  console: Console
): Promise<string> {
  const host = port === 554 ? ip : `${ip}:${port}`;
  const uri = `rtsp://${host}/multitrans`;
  const clientUuid = crypto.randomUUID();
  const socket = new net.Socket();

  try {
    console.log(`[probe] 正在连接 ${ip}:${port} …`);
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.connect(port, ip, () => { socket.removeAllListeners('error'); resolve(); });
    });
    console.log('[probe] TCP 连接成功');

    // Step 1 — unauthenticated probe
    const req1 = `MULTITRANS ${uri} RTSP/1.0\r\nCSeq: 0\r\nX-Client-UUID: ${clientUuid}\r\n\r\n`;
    console.log('[probe] step1 发送:');
    console.log(req1.trimEnd());
    const r1 = await exchange(socket, req1);
    console.log('[probe] step1 响应:');
    console.log(r1.slice(0, 500));

    if (r1.includes('200')) return '✓ 连接成功（无需认证）';

    if (r1.includes('401')) {
      const wwwAuth = r1.match(/WWW-Authenticate:\s*Digest\s+(.+)/i)?.[1]
        ?? r1.match(/WWW-Authenticate:\s*(.+)/i)?.[1] ?? '';
      const { realm, nonce, qop } = parseWwwAuthenticate(wwwAuth);
      console.log(`[probe] 认证挑战 — realm="${realm}" nonce="${nonce}" qop="${qop}"`);

      if (!realm || !nonce) {
        console.log('[probe] 无法解析 WWW-Authenticate 头');
        return '✗ 无法解析认证挑战';
      }

      const authHeader = buildDigestAuth(username, password, realm, nonce, qop, 'MULTITRANS', uri);
      if (qop.includes('auth')) {
        console.log('[probe] 使用 qop=auth');
      } else {
        console.log('[probe] 使用简单 Digest（无 qop）');
      }

      const req2 = `MULTITRANS ${uri} RTSP/1.0\r\nCSeq: 1\r\nAuthorization: ${authHeader}\r\nX-Client-UUID: ${clientUuid}\r\n\r\n`;
      console.log('[probe] step2 发送:');
      console.log(req2.trimEnd());
      const r2 = await exchange(socket, req2);
      console.log('[probe] step2 响应:');
      console.log(r2.slice(0, 500));

      if (r2.includes('200')) return '✓ 连接成功，认证通过';
      if (r2.includes('401')) return '✗ 认证失败 — 请检查用户名/密码';
      return `✗ step2 意外响应：${r2.split('\r\n')[0]}`;
    }

    if (r1.includes('400')) return '✗ 摄像头返回 400 — 不支持 MULTITRANS 协议（请确认是否为中国版固件）';
    return `✗ 意外响应：${r1.split('\r\n')[0]}`;

  } catch (e: any) {
    console.log(`[probe] 错误：${(e as Error).message}`);
    return `✗ 连接失败：${(e as Error).message}`;
  } finally {
    socket.destroy();
    console.log('[probe] socket 已关闭');
  }
}
