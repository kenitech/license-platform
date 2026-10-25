import { createHash } from 'node:crypto';
import { AdminAuthenticator, ipAllowed, normalizeIp } from './admin-auth.js';
import { ApiError, badRequest, notFound } from './errors.js';
import { SlidingCounter } from './rate-limit.js';

export const VERSION = '1.0.0';
const MAX_BODY = 64 * 1024;

// Codes that count toward the per-IP activation failure limit.
const GUESSING_CODES = new Set(['invalid_key', 'wrong_product', 'trial_denied', 'invalid_activation']);

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'strict-transport-security': 'max-age=31536000',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError(413, 'body_too_large', 'request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJsonBody(text) {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw badRequest('request body must be a JSON object', 'invalid_json');
  }
}

// Keys are shown once: a replayed response never contains them again.
function stripKeys(value) {
  if (Array.isArray(value)) return value.map(stripKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'key' || k === 'activationSecret') continue;
      out[k] = stripKeys(v);
    }
    return out;
  }
  return value;
}

export function createApp({ config, service, adminClients, keyring, log = () => {}, now }) {
  const auth = new AdminAuthenticator({ clients: adminClients, now });
  const failures = new SlidingCounter({ limit: config.activationFailureLimit, windowSeconds: config.activationFailureWindow });
  const publicRate = new SlidingCounter({ limit: config.publicRateLimit, windowSeconds: 60 });
  const state = { keyring, adminClients };

  function clientInfo(req) {
    const remote = normalizeIp(req.socket.remoteAddress);
    const viaProxy = config.tlsMode === 'proxy' && ipAllowed(remote, config.trustedProxies);
    if (viaProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      return {
        ip: normalizeIp(forwarded[forwarded.length - 1] || remote),
        secure: String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https',
      };
    }
    return { ip: remote, secure: !!req.socket.encrypted };
  }

  const db = service.db;
  const idemGet = db.prepare('SELECT * FROM idempotency WHERE client_id = ? AND key = ?');
  const idemPut = db.prepare('INSERT OR REPLACE INTO idempotency(client_id, key, request_hash, status, response, created_at) VALUES (?,?,?,?,?,?)');
  const idemPrune = db.prepare('DELETE FROM idempotency WHERE created_at < ?');

  async function handleAdmin(req, res, url, rawBody, ip) {
    if (!ipAllowed(ip, config.adminAllowedIps)) {
      log('warn', 'admin request refused', { ip, path: url.pathname });
      throw new ApiError(403, 'address_not_allowed', 'Not allowed from this address');
    }
    const client = auth.authenticate({ method: req.method, path: url.pathname + url.search, headers: req.headers, body: rawBody });
    const body = parseJsonBody(rawBody);
    const parts = url.pathname.split('/').slice(3).map(decodeURIComponent); // after /v1/admin
    const m = req.method;

    const idemKey = req.headers['idempotency-key'];
    const mutating = m === 'POST' || m === 'PUT';
    let requestHash = null;
    if (mutating && idemKey) {
      if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(idemKey)) throw badRequest('Idempotency-Key has an invalid format');
      requestHash = createHash('sha256').update(`${m} ${url.pathname}\n${rawBody}`).digest('hex');
      const prior = idemGet.get(client.id, idemKey);
      if (prior) {
        if (prior.request_hash !== requestHash) {
          throw new ApiError(422, 'idempotency_mismatch', 'This Idempotency-Key was already used for a different request');
        }
        return [prior.status, { ...JSON.parse(prior.response), replayed: true }];
      }
    }

    const route = () => {
      if (m === 'GET' && parts[0] === 'status' && parts.length === 1) {
        return service.status({ fresh: url.searchParams.get('fresh') === '1' });
      }
      if (parts[0] === 'applications' && parts.length === 2) {
        if (m === 'PUT') return service.upsertApplication(parts[1], body, client);
        if (m === 'GET') return service.getApplication(parts[1]);
      }
      if (parts[0] === 'applications' && parts[2] === 'plans' && parts.length === 4) {
        if (m === 'PUT') return service.upsertPlan(parts[1], parts[3], body, client);
      }
      if (parts[0] === 'licenses') {
        if (m === 'POST' && parts[1] === 'issue' && parts.length === 2) return service.issueLicenses(body, client);
        if (m === 'GET' && parts.length === 2) return service.getLicenseDetail(parts[1]);
        if (m === 'GET' && parts.length === 3 && parts[2] === 'audit') return { audit: service.auditFor(parts[1]) };
        if (m === 'POST' && parts.length === 3) return service.licenseOperation(parts[1], parts[2], body, client);
      }
      if (parts[0] === 'activations' && parts.length === 3 && parts[2] === 'release' && m === 'POST') {
        return service.adminReleaseActivation(parts[1], body, client);
      }
      if (m === 'GET' && parts[0] === 'changes' && parts.length === 1) {
        return service.changes({
          since: url.searchParams.get('since'),
          auditSince: url.searchParams.get('auditSince'),
          limit: url.searchParams.get('limit'),
        });
      }
      throw notFound('no such admin endpoint');
    };

    const result = route();
    const status = mutating && req.method === 'POST' && parts[1] === 'issue' ? 201 : 200;
    if (requestHash) {
      idemPut.run(client.id, idemKey, requestHash, status, JSON.stringify(stripKeys(result)), Math.floor(Date.now() / 1000));
      idemPrune.run(Math.floor(Date.now() / 1000) - 86400);
    }
    log('info', 'admin request', { client: client.id, method: m, path: url.pathname, actor: body?.actor?.name });
    return [status, result];
  }

  async function handlePublic(req, url, rawBody, ip) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/v1/health') {
      db.prepare('SELECT 1').get();
      return [200, { status: 'ok', version: VERSION, time: new Date().toISOString() }];
    }
    if (req.method === 'GET' && p === '/v1/keyring') return [200, state.keyring];
    const actions = {
      '/v1/activations': (b) => service.activate(b, ip),
      '/v1/activations/refresh': (b) => service.refresh(b, ip),
      '/v1/activations/release': (b) => service.selfRelease(b, ip),
      '/v1/trials': (b) => service.startTrial(b, ip),
    };
    const action = req.method === 'POST' ? actions[p] : null;
    if (!action) throw notFound('no such endpoint');
    if (publicRate.hit(ip)) throw new ApiError(429, 'rate_limited', 'Too many requests; try again in a minute');
    if (failures.isBlocked(ip)) {
      throw new ApiError(429, 'too_many_attempts', 'Too many failed attempts from this address; try again later');
    }
    try {
      return [p === '/v1/activations' || p === '/v1/trials' ? 201 : 200, action(parseJsonBody(rawBody))];
    } catch (err) {
      if (err instanceof ApiError && GUESSING_CODES.has(err.code)) failures.record(ip);
      throw err;
    }
  }

  async function handler(req, res) {
    const started = Date.now();
    const { ip, secure } = clientInfo(req);
    let url;
    try {
      url = new URL(req.url, 'https://license-server.invalid');
    } catch {
      send(res, 400, { error: 'invalid_request', message: 'invalid URL' });
      return;
    }
    try {
      if (!secure) throw new ApiError(400, 'https_required', 'HTTPS is required');
      const rawBody = await readBody(req);
      const [status, body] = url.pathname.startsWith('/v1/admin/')
        ? await handleAdmin(req, res, url, rawBody, ip)
        : await handlePublic(req, url, rawBody, ip);
      send(res, status, body);
    } catch (err) {
      if (err instanceof ApiError) {
        send(res, err.status, { error: err.code, message: err.message, ...(err.extra || {}) });
        if (err.status >= 500) log('error', err.message, { path: url.pathname });
      } else {
        log('error', 'internal error', { path: url.pathname, error: err.stack || String(err) });
        send(res, 500, { error: 'internal_error', message: 'The license server could not complete the request' });
      }
    } finally {
      if (config.logLevel === 'debug') log('debug', 'request', { method: req.method, path: url.pathname, ip, ms: Date.now() - started });
    }
  }

  handler.setKeyring = (k) => { state.keyring = k; };
  handler.setAdminClients = (c) => { auth.clients = c; };
  return handler;
}
