import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { generateSigningKey, exportPublicKeyring } from '../license-server/src/keys.js';
import { startServer } from '../license-server/src/server.js';
import { signAdminRequest } from '../license-server/src/admin-auth.js';

export const CRM_SECRET = 'test-crm-secret-' + randomBytes(12).toString('hex');

export function makeCert(dir, name = 'server') {
  const cert = path.join(dir, `${name}.crt`);
  const key = path.join(dir, `${name}.key`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
  { stdio: 'ignore' });
  return { cert, key };
}

// A complete server installation in a temporary directory.
export function makeInstall({ kid = 'test-2026-10' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmp-test-'));
  const dirs = {
    root,
    keys: path.join(root, 'keys'),
    secrets: path.join(root, 'secrets'),
    data: path.join(root, 'data'),
    backups: path.join(root, 'backups'),
    tls: path.join(root, 'tls'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  fs.chmodSync(dirs.keys, 0o700);
  generateSigningKey(dirs.keys, kid);
  exportPublicKeyring(dirs.keys, kid);
  fs.writeFileSync(path.join(dirs.secrets, 'key-peppers'), `p1:${randomBytes(32).toString('base64')}\n`);
  fs.writeFileSync(path.join(dirs.secrets, 'admin-clients.json'),
    JSON.stringify([{ id: 'espocrm', secret: CRM_SECRET, roles: ['crm'] }]));
  const tls = makeCert(dirs.tls);
  const env = {
    LMP_SIGNING_KID: kid,
    LMP_ADMIN_ALLOWED_IPS: '127.0.0.1',
    LMP_TLS_MODE: 'direct',
    LMP_LISTEN_HOST: '127.0.0.1',
    LMP_PORT: '0',
    LMP_TLS_CERT_FILE: tls.cert,
    LMP_TLS_KEY_FILE: tls.key,
    LMP_DATA_DIR: dirs.data,
    LMP_KEYS_DIR: dirs.keys,
    LMP_SECRETS_DIR: dirs.secrets,
    LMP_BACKUP_DIR: dirs.backups,
    LMP_LOG_LEVEL: 'error',
  };
  return { dirs, env, tls, keyring: JSON.parse(fs.readFileSync(path.join(dirs.keys, 'public-keyring.json'), 'utf8')) };
}

// fetch() look-alike that trusts the test certificate.
export function makeFetch(caFile) {
  const ca = fs.readFileSync(caFile);
  return (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, ca }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: res.headers,
          json: async () => JSON.parse(text),
          text: async () => text,
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export class Clock {
  constructor(t = Math.floor(Date.now() / 1000)) {
    this.t = t;
  }
  now = () => this.t;
  advance(seconds) {
    this.t += seconds;
  }
}

export async function startTestServer(opts = {}) {
  const install = makeInstall(opts);
  const clock = opts.clock || new Clock();
  const running = await startServer({ ...install.env, ...(opts.env || {}) }, { log: () => {}, now: clock.now });
  const base = `https://127.0.0.1:${running.port}`;
  const fetch = makeFetch(install.tls.cert);
  async function call(method, pathname, body, headers = {}) {
    const text = body === undefined ? '' : JSON.stringify(body);
    const res = await fetch(base + pathname, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: text || undefined,
    });
    return { status: res.status, body: await res.json() };
  }
  async function admin(method, pathname, body, { headers = {}, secret = CRM_SECRET, clientId = 'espocrm' } = {}) {
    const text = body === undefined ? '' : JSON.stringify(body);
    const authorization = signAdminRequest(clientId, secret, { method, path: pathname, body: text, now: clock.now() });
    const res = await fetch(base + pathname, {
      method,
      headers: { 'content-type': 'application/json', authorization, ...headers },
      body: text || undefined,
    });
    return { status: res.status, body: await res.json() };
  }
  return { ...install, ...running, base, fetch, call, admin, clock };
}

export async function seedProduct(t, { productId = 'acme-editor', plans = {} } = {}) {
  const app = await t.admin('PUT', `/v1/admin/applications/${productId}`, {
    name: 'Acme Editor', currentVersion: '1.0.0', supportedOs: ['windows', 'macos'], offlinePolicy: 'perpetual',
    actor: { id: 'u1', name: 'Admin User' },
  });
  if (app.status !== 200) throw new Error(JSON.stringify(app.body));
  const defaults = {
    'pro-lifetime': { name: 'Pro Lifetime', type: 'lifetime', maxDevices: 2, priceCents: 9900, currency: 'EUR', entitlements: ['pro'] },
    'pro-yearly': { name: 'Pro Yearly', type: 'subscription', durationValue: 1, durationUnit: 'years', renewalPolicy: 'manual', maxDevices: 1, priceCents: 4900, paymentGraceDays: 7, offlineGraceDays: 14 },
    'term-30': { name: '30 days', type: 'fixed_term', durationValue: 30, durationUnit: 'days', maxDevices: 1, transferPolicy: 'limited_per_year', transfersPerYear: 1 },
    trial: { name: 'Trial', type: 'trial', durationValue: 14, durationUnit: 'days', maxDevices: 1 },
    ...plans,
  };
  for (const [code, plan] of Object.entries(defaults)) {
    const r = await t.admin('PUT', `/v1/admin/applications/${productId}/plans/${code}`, plan);
    if (r.status !== 200) throw new Error(`${code}: ${JSON.stringify(r.body)}`);
  }
}
