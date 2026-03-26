/**
 * 本地验证脚本：测试 TP-Link IPC MULTITRANS 双向音频握手
 * 用法: node test-talkback.mjs <ip> <username> <password>
 *
 * 例: node test-talkback.mjs 192.168.31.56 admin 123456zxc
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

function computeDigest(username, password, realm, nonce, method, uri) {
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  return md5(`${ha1}:${nonce}:${ha2}`);
}

function parseWwwAuth(header) {
  return {
    realm: header.match(/realm="([^"]+)"/)?.[1] ?? '',
    nonce: header.match(/nonce="([^"]+)"/)?.[1] ?? '',
  };
}

// ── RTSP exchange helper ──────────────────────────────────────────────────────
function exchange(socket, request, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      socket.removeListener('data', onData);
      reject(new Error('Timeout waiting for response'));
    }, timeoutMs);

    const onData = (chunk) => {
      buf += chunk.toString();
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const headers = buf.slice(0, headerEnd);
      const cl = parseInt(headers.match(/Content-Length:\s*(\d+)/i)?.[1] ?? '0');
      if (buf.length >= headerEnd + 4 + cl) {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        resolve(buf.slice(0, headerEnd + 4 + cl));
      }
    };

    socket.on('data', onData);
    socket.write(request, (err) => err && reject(err));
  });
}

// ── Main test ─────────────────────────────────────────────────────────────────
async function testHandshake() {
  const uri = `rtsp://${ip}/multitrans`;
  const clientUuid = crypto.randomUUID();
  let cseq = 0;

  console.log(`\n=== MULTITRANS Handshake Test ===`);
  console.log(`Target: ${ip}:554  User: ${username}\n`);

  // Connect
  const socket = new net.Socket();
  await new Promise((res, rej) => {
    socket.connect(554, ip, res);
    socket.once('error', rej);
  });
  console.log('[1/3] TCP connected ✓');

  // Step 1: Challenge
  const r1 = await exchange(socket,
    `MULTITRANS ${uri} RTSP/1.0\r\nCSeq: ${cseq++}\r\nX-Client-UUID: ${clientUuid}\r\n\r\n`
  );
  const statusLine1 = r1.split('\r\n')[0];
  console.log('[1/3] Challenge response:', statusLine1);
  console.log('      full response:', r1.replace(/\r\n/g, ' | '));

  let sessionId;

  if (r1.includes('401')) {
    // Need digest auth
    const wwwAuth = r1.match(/WWW-Authenticate:\s*Digest\s+(.+)/i)?.[1] ?? r1.match(/WWW-Authenticate:\s*(.+)/i)?.[1] ?? '';
    const { realm, nonce } = parseWwwAuth(wwwAuth);
    console.log(`      realm="${realm}"  nonce="${nonce}"`);
    if (!realm || !nonce) {
      console.error('Failed to parse WWW-Authenticate header');
      socket.destroy(); return false;
    }

    const responseHash = computeDigest(username, password, realm, nonce, 'MULTITRANS', uri);
    const authHeader = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${responseHash}"`;

    const r2 = await exchange(socket,
      `MULTITRANS ${uri} RTSP/1.0\r\nCSeq: ${cseq++}\r\nAuthorization: ${authHeader}\r\nX-Client-UUID: ${clientUuid}\r\n\r\n`
    );
    const statusLine2 = r2.split('\r\n')[0];
    console.log('[2/3] Auth response:', statusLine2);

    if (!r2.includes('200')) {
      console.error('Authentication failed! Check username/password');
      socket.destroy(); return false;
    }
    sessionId = r2.match(/Session:\s*([^\r\n;]+)/i)?.[1]?.trim();
  } else if (r1.includes('200')) {
    // No auth required, session may already be in first response
    console.log('[2/3] No auth required (200 OK on first request)');
    sessionId = r1.match(/Session:\s*([^\r\n;]+)/i)?.[1]?.trim();
  } else {
    console.error('Unexpected response:', statusLine1);
    socket.destroy(); return false;
  }

  console.log(`      session="${sessionId ?? '(none)'}"`);
  // Some cameras don't require a session ID for the channel open step

  // Step 3: Open channel
  const payload = JSON.stringify({
    type: 'request', seq: 0,
    params: { method: 'get', talk: { mode: 'half_duplex' } },
  });

  const sessionHeader = sessionId ? `Session: ${sessionId}\r\n` : '';
  const r3 = await exchange(socket,
    `MULTITRANS ${uri} RTSP/1.0\r\nCSeq: ${cseq++}\r\n${sessionHeader}Content-Type: application/json\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`
  );
  const statusLine3 = r3.split('\r\n')[0];
  console.log('[3/3] Channel open response:', statusLine3);
  console.log('      body:', r3.slice(r3.indexOf('\r\n\r\n') + 4).trim() || '(empty)');

  if (!r3.includes('200')) {
    console.error('Failed to open talk channel');
    socket.destroy(); return false;
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
    if (!socket.destroyed) {
      socket.write(Buffer.concat([header, rtpPacket]));
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
  ffmpeg.stderr.on('data', (d) => process.stdout.write('.'));

  await new Promise((res) => ffmpeg.on('exit', res));
  console.log(`\nFFmpeg done. Sent ${packetCount} RTP packets to camera.`);

  udpServer.close();
  socket.destroy();
  return true;
}

testHandshake().then((ok) => {
  process.exit(ok ? 0 : 1);
}).catch((err) => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
