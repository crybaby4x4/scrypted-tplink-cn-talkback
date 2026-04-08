import * as crypto from 'crypto';

export function md5(data: string): string {
  return crypto.createHash('md5').update(data).digest('hex');
}

export function computeDigestResponse(
  username: string,
  password: string,
  realm: string,
  nonce: string,
  method: string,
  uri: string,
  qopParams?: { qop: string; nc: string; cnonce: string }
): string {
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  if (qopParams) {
    const { qop, nc, cnonce } = qopParams;
    return md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  }
  return md5(`${ha1}:${nonce}:${ha2}`);
}

export function parseWwwAuthenticate(header: string): { realm: string; nonce: string; qop: string } {
  // When multiple WWW-Authenticate headers exist (Basic + Digest), find the Digest line
  const digestLine = header.split(/\r?\n/).find(l => /WWW-Authenticate:\s*Digest/i.test(l)) ?? header;
  const realm = digestLine.match(/realm="([^"]+)"/)?.[1] ?? '';
  const nonce = digestLine.match(/nonce="([^"]+)"/)?.[1] ?? '';
  const qop   = digestLine.match(/qop="([^"]+)"/)?.[1]   ?? '';
  return { realm, nonce, qop };
}
