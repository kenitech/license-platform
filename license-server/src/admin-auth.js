import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import { ApiError } from './errors.js';

// Admin requests carry
//   Authorization: LMP-HMAC client=<id>, ts=<unix seconds>, nonce=<random>, sig=<base64url>
// where sig = HMAC-SHA256(secret, METHOD \n PATH?QUERY \n ts \n nonce \n hex(SHA256(body))).
// The secret itself never travels over the wire.
export const MAX_CLOCK_SKEW = 300;

export function adminSignature(secret, { method, path, ts, nonce, body }) {
  const bodyHash = createHash('sha256').update(body || '').digest('hex');
  return createHmac('sha256', secret)
    .update(`${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${bodyHash}`)
    .digest('base64url');
}

export function signAdminRequest(clientId, secret, { method, path, body = '', now = Math.floor(Date.now() / 1000), nonce }) {
  const n = nonce || randomBytes(16).toString('hex');
  const sig = adminSignature(secret, { method, path, ts: now, nonce: n, body });
  return `LMP-HMAC client=${clientId}, ts=${now}, nonce=${n}, sig=${sig}`;
}

function parseAuthorization(header) {
  const m = /^LMP-HMAC\s+(.+)$/i.exec(header || '');
  if (!m) return null;
  const out = {};
  for (const part of m[1].split(',')) {
    const [k, ...v] = part.trim().split('=');
    out[k] = v.join('=');
  }
  return out.client && out.ts && out.nonce && out.sig ? out : null;
}

const rejected = () => new ApiError(401, 'invalid_client', 'The license server rejected the CRM credentials');

export class AdminAuthenticator {
  constructor({ clients, now = () => Math.floor(Date.now() / 1000) }) {
    this.clients = clients;
    this.now = now;
    this.seenNonces = new Map();
  }

  authenticate({ method, path, headers, body }) {
    const auth = parseAuthorization(headers.authorization);
    if (!auth) throw rejected();
    const client = this.clients.get(auth.client);
    if (!client || !client.roles.includes('crm')) throw rejected();
    const ts = Number(auth.ts);
    const now = this.now();
    if (!Number.isInteger(ts) || Math.abs(now - ts) > MAX_CLOCK_SKEW) {
      throw new ApiError(401, 'clock_skew', 'The request time differs from the license server clock by more than 5 minutes; check the time on both servers');
    }
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(auth.nonce)) throw rejected();
    const expected = Buffer.from(adminSignature(client.secret, { method, path, ts, nonce: auth.nonce, body }));
    const given = Buffer.from(auth.sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw rejected();
    const nonceKey = `${client.id}:${auth.nonce}`;
    this.pruneNonces(now);
    if (this.seenNonces.has(nonceKey)) throw new ApiError(401, 'replayed_request', 'This request was already received');
    this.seenNonces.set(nonceKey, ts);
    return client;
  }

  pruneNonces(now) {
    if (this.seenNonces.size < 1000) return;
    for (const [k, ts] of this.seenNonces) if (now - ts > MAX_CLOCK_SKEW * 2) this.seenNonces.delete(k);
  }
}

// --------------------------------------------------------- IP allow list

export function normalizeIp(ip) {
  if (!ip) return '';
  return ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

// Entries are exact addresses (IPv4 or IPv6) or IPv4 CIDR ranges.
export function ipAllowed(ip, allowList) {
  const addr = normalizeIp(ip);
  for (const entry of allowList) {
    if (entry.includes('/')) {
      const [base, bitsText] = entry.split('/');
      const bits = Number(bitsText);
      if (net.isIPv4(base) && net.isIPv4(addr) && bits >= 0 && bits <= 32) {
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        if ((ipv4ToInt(addr) & mask) === (ipv4ToInt(base) & mask)) return true;
      }
    } else if (normalizeIp(entry) === addr) {
      return true;
    }
  }
  return false;
}
