import * as net from 'net';
import * as dgram from 'dgram';
import * as crypto from 'crypto';
import { ChildProcess, spawn } from 'child_process';
import { computeDigestResponse, parseWwwAuthenticate } from './digest';

const EXCHANGE_TIMEOUT_MS = 8000;
const FFMPEG_KILL_TIMEOUT_MS = 3000;

export type DuplexMode = 'half_duplex' | 'full_duplex';

/**
 * A Digest computation variant: the (method, uri) pair used in HA2 and the
 * Authorization header. Different TP-Link firmware versions expect different
 * combinations, so we try several before giving up on 401.
 */
interface AuthVariant {
  label: string;
  digestMethod: string;   // method string used in HA2
  digestUriMode: 'absolute' | 'path';  // URI form used in HA2 and Authorization header
}

const AUTH_VARIANTS: AuthVariant[] = [
  { label: '默认 (method=MULTITRANS, 完整URI)',   digestMethod: 'MULTITRANS', digestUriMode: 'absolute' },
  { label: '回退1 (method=DESCRIBE, 完整URI)',     digestMethod: 'DESCRIBE',   digestUriMode: 'absolute' },
  { label: '回退2 (method=MULTITRANS, 路径URI)',   digestMethod: 'MULTITRANS', digestUriMode: 'path' },
  { label: '回退3 (method=DESCRIBE, 路径URI)',     digestMethod: 'DESCRIBE',   digestUriMode: 'path' },
];

function variantDigestUri(host: string, mode: 'absolute' | 'path'): string {
  return mode === 'absolute' ? `rtsp://${host}/multitrans` : '/multitrans';
}

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

type HandshakeResult =
  | { status: 'ok'; sessionId?: string; cseq: number }
  | { status: 'unauthorized' }
  | { status: 'unsupported' };

/**
 * Performs MULTITRANS step 1 (unauth probe) and step 2 (digest auth if challenged) on an
 * already-connected socket. The request line URI is always the absolute form, which is what
 * the camera's RTSP parser expects; only the Digest HA2 inputs vary per variant.
 *
 * Returns:
 *   - 'ok'            — authed (or no auth needed), socket is ready for step 3
 *   - 'unauthorized'  — 401 after sending credentials, caller should try another variant
 *   - 'unsupported'   — camera returned 400 (MULTITRANS not supported)
 * Throws on parse/network errors.
 */
async function attemptHandshake(
  socket: net.Socket,
  host: string,
  username: string,
  password: string,
  digestMethod: string,
  digestUri: string,
  clientUuid: string,
  console: Console,
  logPrefix: string,
): Promise<HandshakeResult> {
  const requestUri = `rtsp://${host}/multitrans`;
  let cseq = 0;

  // Step 1: unauthenticated MULTITRANS request
  const req1 = `MULTITRANS ${requestUri} RTSP/1.0\r\nCSeq: ${cseq++}\r\nX-Client-UUID: ${clientUuid}\r\n\r\n`;
  const r1 = await exchange(socket, req1);
  console.log(`${logPrefix} step1:`);
  console.log(r1.slice(0, 500));

  if (r1.includes('200')) {
    const sessionId = r1.match(/Session:\s*([^\r\n;]+)/i)?.[1]?.trim();
    return { status: 'ok', sessionId, cseq };
  }
  if (r1.includes('400')) return { status: 'unsupported' };
  if (!r1.includes('401')) throw new Error(`Unexpected step1 response: ${r1.split('\r\n')[0]}`);

  // Step 2: parse WWW-Authenticate challenge and retry with Digest
  const wwwAuth = r1.match(/WWW-Authenticate:\s*Digest\s+(.+)/i)?.[1]
    ?? r1.match(/WWW-Authenticate:\s*(.+)/i)?.[1] ?? '';
  const { realm, nonce, qop } = parseWwwAuthenticate(wwwAuth);
  if (!realm || !nonce) throw new Error('Failed to parse WWW-Authenticate challenge');

  console.log(`${logPrefix} 挑战 — realm="${realm}" nonce="${nonce}" qop="${qop || '(none)'}"`);
  console.log(`${logPrefix} HA2 method="${digestMethod}" uri="${digestUri}"${qop.includes('auth') ? ' qop=auth' : ''}`);

  const authHeader = buildDigestAuth(username, password, realm, nonce, qop, digestMethod, digestUri);
  const req2 = `MULTITRANS ${requestUri} RTSP/1.0\r\nCSeq: ${cseq++}\r\nAuthorization: ${authHeader}\r\nX-Client-UUID: ${clientUuid}\r\n\r\n`;
  const r2 = await exchange(socket, req2);
  console.log(`${logPrefix} step2:`);
  console.log(r2.slice(0, 500));

  if (r2.includes('200')) {
    const sessionId = r2.match(/Session:\s*([^\r\n;]+)/i)?.[1]?.trim();
    return { status: 'ok', sessionId, cseq };
  }
  if (r2.includes('401')) return { status: 'unauthorized' };
  throw new Error(`Unexpected step2 response: ${r2.split('\r\n')[0]}`);
}

function connectSocket(ip: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.once('error', reject);
    socket.connect(port, ip, () => {
      socket.removeAllListeners('error');
      resolve(socket);
    });
  });
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
    const requestUri = `rtsp://${host}/multitrans`;
    const clientUuid = crypto.randomUUID();

    // Try each Digest variant on a fresh socket. On first success, keep that socket
    // and proceed with step 3.
    let authedSocket: net.Socket | undefined;
    let sessionId: string | undefined;
    let cseq = 0;
    const failedVariants: string[] = [];

    for (let i = 0; i < AUTH_VARIANTS.length; i++) {
      const variant = AUTH_VARIANTS[i];
      const digestUri = variantDigestUri(host, variant.digestUriMode);
      this.console.log(`[talkback] 尝试变体 ${i + 1}/${AUTH_VARIANTS.length}: ${variant.label}`);

      let socket: net.Socket | undefined;
      try {
        socket = await connectSocket(this.ip, this.port);
        this.console.log(`[talkback] TCP connected to ${this.ip}:${this.port}`);

        const result = await attemptHandshake(
          socket, host, this.username, this.password,
          variant.digestMethod, digestUri, clientUuid, this.console, '[talkback]'
        );

        if (result.status === 'ok') {
          authedSocket = socket;
          sessionId = result.sessionId;
          cseq = result.cseq;
          this.console.log(`[talkback] ✓ 握手成功，使用 ${variant.label}`);
          break;
        }
        if (result.status === 'unsupported') {
          socket.destroy();
          throw new Error('Camera returned 400 — MULTITRANS not supported (check CN firmware)');
        }
        // unauthorized — try next variant
        failedVariants.push(variant.label);
        socket.destroy();
      } catch (e) {
        if (socket) socket.destroy();
        // First variant network/parse error = fatal; further variants won't help
        if (i === 0) throw e;
        // For subsequent variants, record and continue
        failedVariants.push(`${variant.label} (${(e as Error).message})`);
      }
    }

    if (!authedSocket) {
      throw new Error(
        `所有 Digest 变体均认证失败 (401)：${failedVariants.join('; ')}。` +
        `请检查 RTSP 本地账号密码（TP-Link CN 版通常与云账号密码不同）`
      );
    }

    this.socket = authedSocket;
    this.cseq = cseq;

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
      `MULTITRANS ${requestUri} RTSP/1.0\r\nCSeq: ${this.cseq++}\r\n${sessionHeader}Content-Type: application/json\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`
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
 * Iterates through each Digest variant on a fresh TCP connection, logs every step in
 * detail, and reports which variant (if any) succeeded. Does not open a full talkback
 * session — stops at step 2 (auth).
 */
export async function probeCamera(
  ip: string,
  port: number,
  username: string,
  password: string,
  console: Console
): Promise<string> {
  const host = port === 554 ? ip : `${ip}:${port}`;
  console.log(`[probe] 开始探测 ${ip}:${port}（共 ${AUTH_VARIANTS.length} 个 Digest 变体）`);

  const attempted: string[] = [];

  for (let i = 0; i < AUTH_VARIANTS.length; i++) {
    const variant = AUTH_VARIANTS[i];
    const digestUri = variantDigestUri(host, variant.digestUriMode);
    console.log('');
    console.log(`[probe] ─── 变体 ${i + 1}/${AUTH_VARIANTS.length}: ${variant.label} ───`);

    let socket: net.Socket | undefined;
    try {
      socket = await connectSocket(ip, port);
      console.log('[probe] TCP 已连接');

      const result = await attemptHandshake(
        socket, host, username, password,
        variant.digestMethod, digestUri, crypto.randomUUID(), console, '[probe]'
      );

      if (result.status === 'ok') {
        console.log(`[probe] ✓ 成功 — 认证方式: ${variant.label}`);
        return `✓ 网络连通、认证通过（认证方式: ${variant.label}）`;
      }
      if (result.status === 'unsupported') {
        return '✗ 摄像头返回 400 — 不支持 MULTITRANS 协议（请确认是否为中国版固件）';
      }
      console.log(`[probe] ✗ 401 被拒`);
      attempted.push(variant.label);
    } catch (e) {
      console.log(`[probe] ✗ 异常: ${(e as Error).message}`);
      if (i === 0) {
        // First variant failing with a network/parse error usually means nothing else will work
        return `✗ 连接失败：${(e as Error).message}`;
      }
      attempted.push(`${variant.label} (${(e as Error).message})`);
    } finally {
      socket?.destroy();
    }
  }

  return `✗ 所有 ${AUTH_VARIANTS.length} 个 Digest 变体均被拒绝（401）— 请确认使用的是本地设备账号密码（TP-Link CN 版摄像头的本地账号通常与云/App 账号不同），或与 ONVIF 使用同一账号`;
}
