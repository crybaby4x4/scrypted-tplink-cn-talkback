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
  uri: string
): string {
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  return md5(`${ha1}:${nonce}:${ha2}`);
}

export function parseWwwAuthenticate(header: string): { realm: string; nonce: string } {
  const realm = header.match(/realm="([^"]+)"/)?.[1] ?? '';
  const nonce = header.match(/nonce="([^"]+)"/)?.[1] ?? '';
  return { realm, nonce };
}
