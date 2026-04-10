/**
 * 本地验证脚本：测试 TP-Link IPC MULTITRANS 双向音频握手
 * 用法: node test-talkback.mjs <ip> <username> <password>
 *
 * 例: node test-talkback.mjs 192.168.31.56 admin 123456zxc
 *
 * 该脚本会按顺序尝试多种 Digest 变体（HA2 method × URI 格式），
 * 找到能通过认证的组合后继续后续音频测试。和插件里 probeCamera /
 * TalkbackSession 的逻辑保持一致。
 */

import * as net from 'net';
import * as dgram from 'dgram';
import * as crypto from 'crypto';
import { spawn } from 'child_process';

const [ip, username, password] = process.argv.slice(2);
if (!ip || !username || !password) {
  console.error('Usage: node test-talkback.mjs <ip> <username> <password>');
  process.exit(1);
}

// ── Digest helpers ────────────────────────────────────────────────────────────
function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

function computeDigest(username, password, realm, nonce, method, uri, qopParams) {
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  if (qopParams) {
    const { qop, nc, cnonce } = qopParams;
    return md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  }
  return md5(`${ha1}:${nonce}:${ha2}`);
}

function parseWwwAuth(header) {
  // When multiple WWW-Authenticate headers exist (Basic + Digest), prefer the Digest line
  const digestLine = header.split(/\r?\n/).find(l => /WWW-Authenticate:\s*Digest/i.test(l)) ?? header;
  return {
    realm: digestLine.match(/realm="([^"]+)"/)?.[1] ?? '',
    nonce: digestLine.match(/nonce="([^"]+)"/)?.[1] ?? '',
    qop:   digestLine.match(/qop="([^"]+)"/)?.[1]   ?? '',
  };
}

function buildDigestAuth(username, password, realm, nonce, qop, method, uri) {
  if (qop.includes('auth')) {
    const cnonce = crypto.randomBytes(8).toString('hex');
    const nc = '00000001';
    const responseHash = computeDigest(username, password, realm, nonce, method, uri, { qop: 'auth', nc, cnonce });
    return `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${responseHash}"`;
  }
  const responseHash = computeDigest(username, password, realm, nonce, method, uri);
  return `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${responseHash}"`;
}

// ── RTSP exchange helper ──────────────────────────────────────────────────────
function exchange(socket, request, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout waiting for response'));
    }, timeoutMs);
    const onError = (err) => { cleanup(); reject(err); };
    const onData = (chunk) => {
      buf += chunk.toString();
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const headers = buf.slice(0, headerEnd);
      const cl = parseInt(headers.match(/Content-Length:\s*(\d+)/i)?.[1] ?? '0');
      if (buf.length >= headerEnd + 4 + cl) {
        cleanup();
        resolve(buf.slice(0, headerEnd + 4 + cl));
      }
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.write(request, (err) => { if (err) { cleanup(); reject(err); } });
  });
}

function connectSocket(ip, port) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.once('error', reject);
    socket.connect(port, ip, () => {
      socket.removeAllListeners('error');
      resolve(socket);
    });
  });
}

// ── Auth variants (same list as the plugin) ───────────────────────────────────
const AUTH_VARIANTS = [
  { label: '默认 (HA2 method=MULTITRANS, uri=绝对)',  digestMethod: 'MULTITRANS', uriMode: 'absolute' },
  { label: '回退1 (HA2 method=DESCRIBE, uri=绝对)',    digestMethod: 'DESCRIBE',   uriMode: 'absolute' },
  { label: '回退2 (HA2 method=MULTITRANS, uri=路径)',  digestMethod: 'MULTITRANS', uriMode: 'path' },
  { label: '回退3 (HA2 method=DESCRIBE, uri=路径)',    digestMethod: 'DESCRIBE',   uriMode: 'path' },
];

function variantDigestUri(host, mode) {
  return mode === 'absolute' ? `rtsp://${host}/multitrans` : '/multitrans';
}

/**
 * Single-variant handshake attempt on an already-connected socket.
 * Returns:
 *   { status: 'ok',           sessionId?, cseq }
 *   { status: 'unauthorized' }
 *   { status: 'unsupported'  }  // 400
 * Throws on parse/network errors.
 */
async function attemptHandshake(socket, host, username, password, digestMethod, digestUri, clientUuid) {
  const requestUri = `rtsp://${host}/multitrans`;
  let cseq = 0;

  const req1 = `MULTITRANS ${requestUri} RTSP/1.0\r\nCSeq: ${cseq++}\r\nX-Client-UUID: ${clientUuid}\r\n\r\n`;
  const r1 = await exchange(socket, req1);
  console.log('      step1 响应:');
  console.log('      ' + r1.slice(0, 500).replace(/\r\n/g, '\n      '));

  if (r1.includes('200')) {
    const sessionId = r1.match(/Session:\s*([^\r\n;]+)/i)?.[1]?.trim();
    return { status: 'ok', sessionId, cseq };
  }
  if (r1.includes('400')) return { status: 'unsupported' };
  if (!r1.includes('401')) throw new Error(`Unexpected step1 response: ${r1.split('\r\n')[0]}`);

  const wwwAuth = r1.match(/WWW-Authenticate:\s*Digest\s+(.+)/i)?.[1]
    ?? r1.match(/WWW-Authenticate:\s*(.+)/i)?.[1] ?? '';
  const { realm, nonce, qop } = parseWwwAuth(wwwAuth);
  if (!realm || !nonce) throw new Error('Failed to parse WWW-Authenticate');

  console.log(`      挑战 — realm="${realm}" nonce="${nonce}" qop="${qop || '(none)'}"`);
  console.log(`      HA2 method="${digestMethod}" uri="${digestUri}"${qop.includes('auth') ? ' qop=auth' : ''}`);

  const authHeader = buildDigestAuth(username, password, realm, nonce, qop, digestMethod, digestUri);
  const req2 = `MULTITRANS ${requestUri} RTSP/1.0\r\nCSeq: ${cseq++}\r\nAuthorization: ${authHeader}\r\nX-Client-UUID: ${clientUuid}\r\n\r\n`;
  const r2 = await exchange(socket, req2);
  console.log('      step2 响应:');
  console.log('      ' + r2.slice(0, 500).replace(/\r\n/g, '\n      '));

  if (r2.includes('200')) {
    const sessionId = r2.match(/Session:\s*([^\r\n;]+)/i)?.[1]?.trim();
    return { status: 'ok', sessionId, cseq };
  }
  if (r2.includes('401')) return { status: 'unauthorized' };
  throw new Error(`Unexpected step2 response: ${r2.split('\r\n')[0]}`);
}

// ── Main test ─────────────────────────────────────────────────────────────────
async function testHandshake() {
  const host = `${ip}`;
  const requestUri = `rtsp://${host}/multitrans`;
  const clientUuid = crypto.randomUUID();

  console.log(`\n=== MULTITRANS Handshake Test ===`);
  console.log(`Target: ${ip}:554  User: ${username}`);
  console.log(`共 ${AUTH_VARIANTS.length} 个 Digest 变体待尝试\n`);

  let authedSocket;
  let sessionId;
  let cseq = 0;
  let workingVariant;
  const failed = [];

  for (let i = 0; i < AUTH_VARIANTS.length; i++) {
    const v = AUTH_VARIANTS[i];
    const digestUri = variantDigestUri(host, v.uriMode);
    console.log(`[${i + 1}/${AUTH_VARIANTS.length}] 尝试 ${v.label}`);

    let socket;
    try {
      socket = await connectSocket(ip, 554);
      console.log('      TCP connected ✓');

      const result = await attemptHandshake(socket, host, username, password, v.digestMethod, digestUri, clientUuid);

      if (result.status === 'ok') {
        authedSocket = socket;
        sessionId = result.sessionId;
        cseq = result.cseq;
        workingVariant = v;
        console.log(`      ✓ 认证成功\n`);
        break;
      }
      if (result.status === 'unsupported') {
        socket.destroy();
        console.error('\n❌ 摄像头返回 400 — 不支持 MULTITRANS (请确认是否为中国版固件)');
        return false;
      }
      console.log(`      ✗ 401 被拒\n`);
      failed.push(v.label);
      socket.destroy();
    } catch (e) {
      if (socket) socket.destroy();
      console.log(`      ✗ 异常: ${e.message}\n`);
      if (i === 0) {
        console.error(`\n❌ 连接失败: ${e.message}`);
        return false;
      }
      failed.push(`${v.label} (${e.message})`);
    }
  }

  if (!authedSocket) {
    console.error(`\n❌ 所有 ${AUTH_VARIANTS.length} 个 Digest 变体均被拒绝 (401)`);
    console.error(`   已尝试: ${failed.join(' | ')}`);
    console.error(`   请确认使用的是 TP-Link 本地设备账号密码 (通常与云/App 账号不同)`);
    return false;
  }

  console.log(`✅ 成功握手变体: ${workingVariant.label}`);
  console.log(`      session="${sessionId ?? '(none)'}"\n`);

  // Step 3: Open channel
  const payload = JSON.stringify({
    type: 'request', seq: 0,
    params: { method: 'get', talk: { mode: 'half_duplex' } },
  });

  const sessionHeader = sessionId ? `Session: ${sessionId}\r\n` : '';
  const r3 = await exchange(authedSocket,
    `MULTITRANS ${requestUri} RTSP/1.0\r\nCSeq: ${cseq++}\r\n${sessionHeader}Content-Type: application/json\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`
  );
  const statusLine3 = r3.split('\r\n')[0];
  console.log('[3/3] Channel open response:', statusLine3);
  console.log('      body:', r3.slice(r3.indexOf('\r\n\r\n') + 4).trim() || '(empty)');

  if (!r3.includes('200')) {
    console.error('Failed to open talk channel');
    authedSocket.destroy();
    return false;
  }

  console.log('\n✅ Handshake SUCCESS — channel is open\n');

  // ── Audio test: send 3s of 1kHz test tone ──────────────────────────────────
  console.log('=== Audio Test: sending 3s test tone to camera ===');

  const udpServer = dgram.createSocket('udp4');
  const udpPort = await new Promise((res) => {
    udpServer.bind(0, '127.0.0.1', () => res(udpServer.address().port));
  });
  console.log(`UDP RTP server on port ${udpPort}`);

  let packetCount = 0;
  udpServer.on('message', (rtpPacket) => {
    packetCount++;
    // Wrap in RTSP interleaved: $ | ch(1B) | len(2B) | data
    const header = Buffer.alloc(4);
    header[0] = 0x24;
    header[1] = 1;
    header.writeUInt16BE(rtpPacket.length, 2);
    if (!authedSocket.destroyed) {
      authedSocket.write(Buffer.concat([header, rtpPacket]));
    }
  });

  // FFmpeg: generate 3s sine tone → PCM A-law 8kHz → RTP → UDP
  const ffmpegArgs = [
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=3',
    '-vn',
    '-af', 'aresample=8000,pan=mono|c0=c0,adelay=300:all=1',
    '-acodec', 'pcm_alaw',
    '-ar', '8000', '-ac', '1',
    '-f', 'rtp', `rtp://127.0.0.1:${udpPort}`,
  ];

  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  ffmpeg.stderr.on('data', () => process.stdout.write('.'));

  await new Promise((res) => ffmpeg.on('exit', res));
  console.log(`\nFFmpeg done. Sent ${packetCount} RTP packets to camera.`);

  udpServer.close();
  authedSocket.destroy();
  return true;
}

testHandshake().then((ok) => {
  process.exit(ok ? 0 : 1);
}).catch((err) => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
