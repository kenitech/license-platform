// License Manager Platform client SDK for Node.js and Electron apps.
//
//   const client = new LicenseClient({
//     serverUrl: 'https://licenses.example.com',
//     productId: 'acme-editor',
//     keyring: JSON.parse(fs.readFileSync('public-keyring.json', 'utf8')),
//     storage: LicenseClient.fileStorage(path.join(app.getPath('userData'), 'license.json')),
//   });
//   await client.activate(userTypedKey);   // once, online
//   const state = await client.checkOnline(); // at startup; falls back to offline
//   if (state.valid && client.hasEntitlement('pro')) { ... }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { deviceHash, normalizeLicenseKey, verifyToken } from '../../lmp-core/src/index.js';

const DAY = 86400;
// A clock that moved back further than this since the last check is treated
// as tampering (offline licenses rely on the local clock).
const CLOCK_ROLLBACK_TOLERANCE = DAY;

export class LicenseError extends Error {
  constructor(code, message, status = 0, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

// A stable identifier for this computer. Apps may pass their own deviceId
// instead; it only has to stay the same across restarts and reinstalls.
export function defaultDeviceId() {
  const tryRead = (file) => {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch {
      return '';
    }
  };
  const tryRun = (cmd, args, pattern) => {
    try {
      const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
      return pattern.exec(out)?.[1] || '';
    } catch {
      return '';
    }
  };
  let id = '';
  if (process.platform === 'linux') id = tryRead('/etc/machine-id') || tryRead('/var/lib/dbus/machine-id');
  if (process.platform === 'darwin') id = tryRun('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], /"IOPlatformUUID" = "([^"]+)"/);
  if (process.platform === 'win32') {
    id = tryRun('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], /MachineGuid\s+REG_SZ\s+(\S+)/);
  }
  if (!id) {
    const macs = Object.values(os.networkInterfaces()).flat()
      .filter((n) => n && !n.internal && n.mac && n.mac !== '00:00:00:00:00:00')
      .map((n) => n.mac).sort();
    id = `${os.hostname()}|${macs[0] || ''}|${os.platform()}|${os.arch()}`;
  }
  return `${process.platform}:${id}`;
}

export class LicenseClient {
  constructor({
    serverUrl, productId, keyring, storage,
    deviceId = defaultDeviceId(), deviceName = os.hostname(), appVersion = null,
    fetch: fetchImpl = globalThis.fetch, now = () => Math.floor(Date.now() / 1000), timeoutMs = 15000,
  }) {
    if (!serverUrl || !productId || !keyring || !storage) {
      throw new TypeError('serverUrl, productId, keyring and storage are required');
    }
    this.serverUrl = serverUrl.replace(/\/+$/, '');
    if (!this.serverUrl.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(this.serverUrl)) {
      throw new TypeError('serverUrl must use https://');
    }
    this.productId = productId;
    this.keyring = keyring;
    this.storage = storage;
    this.deviceId = deviceId;
    this.deviceName = deviceName;
    this.appVersion = appVersion;
    this.fetch = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
  }

  // Stores the activation as JSON in a file readable only by the user.
  static fileStorage(file) {
    return {
      load() {
        try {
          return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
          return null;
        }
      },
      save(data) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
        fs.renameSync(tmp, file);
      },
      clear() {
        fs.rmSync(file, { force: true });
      },
    };
  }

  static memoryStorage() {
    let data = null;
    return { load: () => data, save: (d) => { data = JSON.parse(JSON.stringify(d)); }, clear: () => { data = null; } };
  }

  async request(pathname, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(this.serverUrl + pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new LicenseError('network_error', `The license server could not be reached: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    if (!res.ok) {
      throw new LicenseError(data.error || 'server_error', data.message || `license server answered ${res.status}`, res.status, data);
    }
    return data;
  }

  device() {
    return { deviceId: this.deviceId, deviceName: this.deviceName, os: `${os.platform()} ${os.release()}`, appVersion: this.appVersion };
  }

  saveActivation(result) {
    const payload = verifyToken(result.certificate, this.keyring);
    this.assertCertificateMatches(payload);
    const record = {
      productId: this.productId,
      activationId: result.activationId,
      activationSecret: result.activationSecret,
      certificate: result.certificate,
      license: result.license,
      blocked: null,
      lastCheckAt: this.now(),
      lastOnlineAt: this.now(),
    };
    this.storage.save(record);
    return this.check();
  }

  assertCertificateMatches(payload) {
    if (payload.typ !== 'lmp-cert') throw new LicenseError('invalid_certificate', 'not an activation certificate');
    if (payload.pid !== this.productId) throw new LicenseError('wrong_product', 'certificate is for another application');
    if (payload.dev !== deviceHash(this.deviceId)) throw new LicenseError('wrong_device', 'certificate belongs to another computer');
  }

  // Activates a key on this computer (online, once).
  async activate(licenseKey) {
    const normalized = normalizeLicenseKey(licenseKey);
    if (!normalized) throw new LicenseError('invalid_key', 'This license key is not valid. Check it for typing mistakes.');
    const result = await this.request('/v1/activations', { licenseKey: normalized, productId: this.productId, ...this.device() });
    return this.saveActivation(result);
  }

  // Starts the application's free trial without a key (one per computer).
  async startTrial({ planCode } = {}) {
    const result = await this.request('/v1/trials', { productId: this.productId, planCode, ...this.device() });
    return this.saveActivation(result);
  }

  // Fetches a fresh certificate. Throws LicenseError on refusal; network
  // errors leave the stored activation untouched.
  async refresh() {
    const stored = this.storage.load();
    if (!stored?.activationId) throw new LicenseError('not_activated', 'This computer is not activated');
    try {
      const result = await this.request('/v1/activations/refresh', {
        activationId: stored.activationId, activationSecret: stored.activationSecret, appVersion: this.appVersion,
      });
      const payload = verifyToken(result.certificate, this.keyring);
      this.assertCertificateMatches(payload);
      this.storage.save({ ...stored, certificate: result.certificate, license: result.license, blocked: null, lastCheckAt: this.now(), lastOnlineAt: this.now() });
      return this.check();
    } catch (err) {
      if (err.code === 'activation_released' || err.code === 'invalid_activation') {
        this.storage.clear();
      } else if (/^license_(revoked|suspended|cancelled|expired)$/.test(err.code)) {
        this.storage.save({ ...stored, blocked: { code: err.code, message: err.message }, lastCheckAt: this.now(), lastOnlineAt: this.now() });
      }
      throw err;
    }
  }

  // Use at startup: refreshes when online, otherwise decides offline.
  async checkOnline() {
    try {
      return await this.refresh();
    } catch (err) {
      if (err.code === 'network_error' || err.code === 'rate_limited' || err.status >= 500) return this.check();
      return { ...this.check(), reason: err.code, message: err.message };
    }
  }

  // "Transfer to another computer": frees this computer's slot so the same
  // key can be activated elsewhere.
  async transfer() {
    const stored = this.storage.load();
    if (!stored?.activationId) throw new LicenseError('not_activated', 'This computer is not activated');
    const result = await this.request('/v1/activations/release', {
      activationId: stored.activationId, activationSecret: stored.activationSecret,
    });
    this.storage.clear();
    return result;
  }

  // Offline decision from the stored certificate and the local clock.
  check() {
    const now = this.now();
    const stored = this.storage.load();
    const result = (valid, state, extra = {}) => ({ valid, state, mustGoOnline: false, ...extra });
    if (!stored?.certificate) return result(false, 'not_activated');
    let payload;
    try {
      payload = verifyToken(stored.certificate, this.keyring);
      this.assertCertificateMatches(payload);
    } catch (err) {
      return result(false, 'invalid_certificate', { reason: err.code });
    }
    const info = {
      license: stored.license,
      reference: payload.lic,
      type: payload.ltype,
      plan: payload.plan,
      entitlements: payload.ent || [],
      expiresAt: payload.lexp ? new Date(payload.lexp * 1000).toISOString() : null,
    };
    if (stored.blocked) return result(false, stored.blocked.code.replace(/^license_/, ''), { ...info, reason: stored.blocked.code });
    if (stored.lastCheckAt && now < stored.lastCheckAt - CLOCK_ROLLBACK_TOLERANCE) {
      return result(false, 'clock_tampered', { ...info, mustGoOnline: true });
    }
    if (now > (stored.lastCheckAt || 0)) {
      this.storage.save({ ...stored, lastCheckAt: now });
    }
    if (payload.chk && now > payload.chk) {
      return result(false, 'check_required', { ...info, mustGoOnline: true });
    }
    if (payload.lexp && now >= payload.lexp) {
      if (now < payload.lexp + (payload.ogr || 0)) {
        return result(true, 'offline_grace', { ...info, mustGoOnline: true, graceEndsAt: new Date((payload.lexp + payload.ogr) * 1000).toISOString() });
      }
      return result(false, 'expired', { ...info, mustGoOnline: true });
    }
    const soon = payload.chk && payload.chk - now < 7 * DAY;
    return result(true, 'active', { ...info, mustGoOnline: !!soon });
  }

  hasEntitlement(code) {
    const state = this.check();
    return state.valid && state.entitlements.includes(code);
  }
}
