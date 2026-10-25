import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { LicenseClient } from '../packages/lmp-client/src/index.js';
import { generateLicenseKey, verifyToken } from '../packages/lmp-core/src/index.js';
import { DatabaseSync } from '../license-server/src/sqlite.js';
import { CRM_SECRET, seedProduct, startTestServer } from './helpers.mjs';

const DAY = 86400;

describe('license server', () => {
  let t;
  before(async () => {
    t = await startTestServer();
    await seedProduct(t);
  });
  after(async () => t.close());

  const client = (deviceId, extra = {}) => new LicenseClient({
    serverUrl: t.base, productId: 'acme-editor', keyring: t.keyring, storage: LicenseClient.memoryStorage(),
    deviceId, deviceName: deviceId, fetch: t.fetch, now: t.clock.now, ...extra,
  });

  const issue = async (planCode, extra = {}) => {
    const r = await t.admin('POST', '/v1/admin/licenses/issue', {
      productId: 'acme-editor', planCode, quantity: 1, customer: { id: 'acc1', name: 'Customer Ltd' },
      grantReason: 'test grant', actor: { id: 'u1', name: 'Admin User' }, ...extra,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.issued[0];
  };

  it('answers health checks', async () => {
    const r = await t.call('GET', '/v1/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
  });

  it('serves the public keyring', async () => {
    const r = await t.call('GET', '/v1/keyring');
    assert.equal(r.body.active, 'test-2026-10');
    assert.equal(r.body.keys.length, 1);
  });

  it('rejects admin calls with a wrong secret or no signature', async () => {
    const bad = await t.admin('GET', '/v1/admin/status', undefined, { secret: 'wrong-secret-wrong-secret' });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.message, 'The license server rejected the CRM credentials');
    const none = await t.call('GET', '/v1/admin/status');
    assert.equal(none.status, 401);
  });

  it('reports status with an intact audit chain', async () => {
    const r = await t.admin('GET', '/v1/admin/status?fresh=1');
    assert.equal(r.status, 200);
    assert.equal(r.body.auditChain, 'intact');
    assert.equal(r.body.signingKid, 'test-2026-10');
  });

  it('validates plans and locks the type once licenses exist', async () => {
    const lifetimeWithDuration = await t.admin('PUT', '/v1/admin/applications/acme-editor/plans/bad', {
      name: 'Bad', type: 'lifetime', durationValue: 3, durationUnit: 'days',
    });
    assert.equal(lifetimeWithDuration.status, 400);
    const longTrial = await t.admin('PUT', '/v1/admin/applications/acme-editor/plans/bad', {
      name: 'Bad', type: 'trial', durationValue: 400, durationUnit: 'days',
    });
    assert.equal(longTrial.status, 400);
    await issue('pro-lifetime');
    const change = await t.admin('PUT', '/v1/admin/applications/acme-editor/plans/pro-lifetime', {
      name: 'Pro Lifetime', type: 'subscription', durationValue: 1, durationUnit: 'months', renewalPolicy: 'manual',
    });
    assert.equal(change.status, 409);
    assert.equal(change.body.error, 'plan_locked');
    const rename = await t.admin('PUT', '/v1/admin/applications/acme-editor/plans/pro-lifetime', {
      name: 'Pro Lifetime (2026)', type: 'lifetime', maxDevices: 2, priceCents: 9900, entitlements: ['pro'],
    });
    assert.equal(rename.status, 200);
  });

  it('requires a grant reason for paid plans issued without an order', async () => {
    const r = await t.admin('POST', '/v1/admin/licenses/issue', {
      productId: 'acme-editor', planCode: 'pro-lifetime', quantity: 1, grantReason: 'abc',
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'grant_reason_required');
  });

  it('issues only the missing licenses of an order line', async () => {
    const body = {
      productId: 'acme-editor', planCode: 'pro-lifetime', quantity: 3,
      order: { ref: 'ORD-1001', itemId: 'item-1' }, customer: { id: 'acc1', name: 'Customer Ltd' },
    };
    const first = await t.admin('POST', '/v1/admin/licenses/issue', { ...body, quantity: 2 });
    assert.equal(first.body.issued.length, 2);
    const second = await t.admin('POST', '/v1/admin/licenses/issue', body);
    assert.equal(second.body.issued.length, 1);
    assert.equal(second.body.alreadyIssued, 2);
    const third = await t.admin('POST', '/v1/admin/licenses/issue', body);
    assert.equal(third.body.issued.length, 0);
    for (const l of first.body.issued) assert.match(l.key, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/);
  });

  it('never returns a key twice on an idempotent retry', async () => {
    const headers = { 'idempotency-key': 'retry-test-0001' };
    const body = { productId: 'acme-editor', planCode: 'pro-lifetime', quantity: 1, grantReason: 'goodwill grant' };
    const a = await t.admin('POST', '/v1/admin/licenses/issue', body, { headers });
    const b = await t.admin('POST', '/v1/admin/licenses/issue', body, { headers });
    assert.ok(a.body.issued[0].key);
    assert.equal(b.body.replayed, true);
    assert.equal(b.body.issued[0].id, a.body.issued[0].id);
    assert.equal(b.body.issued[0].key, undefined);
  });

  it('activates, verifies offline and enforces the device limit', async () => {
    const lic = await issue('pro-lifetime');
    const c1 = client('device-one-0001');
    const state = await c1.activate(lic.key);
    assert.equal(state.valid, true);
    assert.equal(state.state, 'active');
    assert.deepEqual(state.entitlements, ['pro']);
    assert.equal(c1.hasEntitlement('pro'), true);
    // Activating again on the same computer does not take a second slot.
    await c1.activate(lic.key);
    await client('device-two-0002').activate(lic.key);
    await assert.rejects(client('device-three-03').activate(lic.key), { code: 'device_limit_reached' });
    const detail = await t.admin('GET', `/v1/admin/licenses/${lic.reference}`);
    assert.equal(detail.body.license.status, 'active');
    assert.equal(detail.body.activations.length, 2);
  });

  it('refuses unknown keys and blocks addresses that keep guessing', async () => {
    const guesser = client('guesser-device-1');
    await assert.rejects(guesser.activate(generateLicenseKey()), { code: 'invalid_key', status: 404 });
    const audit = await t.admin('GET', '/v1/admin/changes?since=0&auditSince=0&limit=2000');
    assert.ok(audit.body.audit.some((a) => a.action === 'activation_failed'));
  });

  it('rejects a certificate copied to another computer', async () => {
    const lic = await issue('pro-lifetime');
    const storage = LicenseClient.memoryStorage();
    await client('original-device', { storage }).activate(lic.key);
    const copy = client('other-device-xyz', { storage });
    assert.equal(copy.check().valid, false);
    assert.equal(copy.check().state, 'invalid_certificate');
  });

  it('suspends, reactivates and revokes, and the app learns on its next check', async () => {
    const lic = await issue('pro-lifetime');
    const c = client('suspend-device-1');
    await c.activate(lic.key);
    const s = await t.admin('POST', `/v1/admin/licenses/${lic.id}/suspend`, { reason: 'payment dispute', actor: { name: 'Support' } });
    assert.equal(s.body.license.status, 'suspended');
    const blocked = await c.checkOnline();
    assert.equal(blocked.valid, false);
    assert.equal(blocked.state, 'suspended');
    assert.equal(c.check().valid, false, 'stays blocked offline');
    await t.admin('POST', `/v1/admin/licenses/${lic.id}/reactivate`, {});
    assert.equal((await c.checkOnline()).valid, true);
    await t.admin('POST', `/v1/admin/licenses/${lic.id}/revoke`, { reason: 'chargeback' });
    assert.equal((await c.checkOnline()).state, 'revoked');
    await assert.rejects(client('new-device-1234').activate(lic.key), { code: 'license_revoked' });
  });

  it('replaces a lost key: the old key stops working for new activations', async () => {
    const lic = await issue('pro-lifetime');
    const c = client('replace-device-1');
    await c.activate(lic.key);
    const r = await t.admin('POST', `/v1/admin/licenses/${lic.id}/replace-key`, { reason: 'customer lost the key' });
    assert.ok(r.body.key);
    assert.notEqual(r.body.key, lic.key);
    await assert.rejects(client('replace-device-2').activate(lic.key), { code: 'invalid_key' });
    assert.equal((await c.checkOnline()).valid, true, 'existing activation keeps working');
    assert.equal((await client('replace-device-2').activate(r.body.key)).valid, true);
  });

  it('recovers a lost device and optionally replaces the key', async () => {
    const lic = await issue('pro-lifetime');
    const lost = client('lost-device-0001');
    await lost.activate(lic.key);
    const detail = await t.admin('GET', `/v1/admin/licenses/${lic.id}`);
    const r = await t.admin('POST', `/v1/admin/licenses/${lic.id}/recover`, {
      reason: 'laptop stolen', activationIds: [detail.body.activations[0].id], replaceKey: true,
    });
    assert.equal(r.body.released, 1);
    assert.ok(r.body.key);
    const after = await lost.checkOnline();
    assert.equal(after.valid, false);
    assert.equal(after.state, 'not_activated');
  });

  it('self-service transfer respects the yearly limit; support transfers ignore it', async () => {
    const lic = await issue('term-30');
    const a = client('transfer-a-0001');
    await a.activate(lic.key);
    const first = await a.transfer();
    assert.equal(first.transfersRemaining, 0);
    const b = client('transfer-b-0001');
    await b.activate(lic.key);
    await assert.rejects(b.transfer(), { code: 'transfer_limit_reached' });
    const detail = await t.admin('GET', `/v1/admin/licenses/${lic.id}`);
    const active = detail.body.activations.find((x) => x.status === 'active');
    const rel = await t.admin('POST', `/v1/admin/activations/${active.id}/release`, { reason: 'assisted transfer', assisted: true });
    assert.equal(rel.status, 200);
    assert.equal(rel.body.activation.releaseKind, 'assisted_transfer');
    assert.equal((await client('transfer-c-0001').activate(lic.key)).valid, true);
  });

  it('allows one trial per computer', async () => {
    const c = client('trial-device-001');
    const state = await c.startTrial();
    assert.equal(state.valid, true);
    assert.equal(state.type, 'trial');
    await assert.rejects(client('trial-device-001').startTrial(), { code: 'trial_denied' });
    const keyed = await issue('trial', { grantReason: null });
    await assert.rejects(client('trial-device-001').activate(keyed.key), { code: 'trial_denied' });
  });

  it('extends a fixed-term license and renews a subscription', async () => {
    const term = await issue('term-30');
    const ext = await t.admin('POST', `/v1/admin/licenses/${term.id}/extend`, { value: 10, unit: 'days' });
    assert.equal(Date.parse(ext.body.license.expiresAt) - Date.parse(term.expiresAt), 10 * DAY * 1000);
    const badExt = await t.admin('POST', `/v1/admin/licenses/${term.id}/extend`, { expiresAt: '2001-01-01T00:00:00Z' });
    assert.equal(badExt.status, 400);
    const sub = await issue('pro-yearly');
    const ren = await t.admin('POST', `/v1/admin/licenses/${sub.id}/renew`, { periods: 2 });
    assert.equal(new Date(ren.body.license.expiresAt).getUTCFullYear(), new Date(sub.expiresAt).getUTCFullYear() + 2);
    const lifetime = await issue('pro-lifetime');
    const notRenewable = await t.admin('POST', `/v1/admin/licenses/${lifetime.id}/renew`, { periods: 1 });
    assert.equal(notRenewable.body.error, 'not_renewable');
  });

  it('applies payment grace and offline grace to subscriptions', async () => {
    const sub = await issue('pro-yearly');
    const c = client('sub-device-0001');
    await c.activate(sub.key);
    const expiresAt = Date.parse(sub.expiresAt) / 1000;
    const start = t.clock.t;
    t.clock.t = expiresAt + 3 * DAY; // within the 7-day payment grace
    const inGrace = await c.checkOnline();
    assert.equal(inGrace.valid, true);
    const detail = await t.admin('GET', `/v1/admin/licenses/${sub.id}`);
    assert.equal(detail.body.license.status, 'past_due');
    t.clock.t = expiresAt + 7 * DAY + 2 * DAY; // payment grace over, offline grace (14 days) still running
    assert.equal(c.check().state, 'offline_grace');
    assert.equal((await c.checkOnline()).state, 'expired');
    t.clock.t = start;
  });

  it('cancels a subscription at the end of the paid period', async () => {
    const sub = await issue('pro-yearly');
    const r = await t.admin('POST', `/v1/admin/licenses/${sub.id}/cancel-subscription`, { atPeriodEnd: true });
    assert.equal(r.body.license.cancelAtPeriodEnd, true);
    assert.equal(r.body.license.status, 'available');
    const now = await t.admin('POST', `/v1/admin/licenses/${sub.id}/cancel-subscription`, { atPeriodEnd: false });
    assert.equal(now.body.license.status, 'cancelled');
  });

  it('releases all devices', async () => {
    const lic = await issue('pro-lifetime');
    await client('all-device-0001').activate(lic.key);
    await client('all-device-0002').activate(lic.key);
    const r = await t.admin('POST', `/v1/admin/licenses/${lic.id}/release-all`, { reason: 'reset for customer' });
    assert.equal(r.body.released, 2);
    assert.equal(r.body.license.status, 'available');
  });

  it('signs certificates the app can verify with the keyring', async () => {
    const lic = await issue('pro-lifetime');
    const storage = LicenseClient.memoryStorage();
    await client('sig-device-0001', { storage }).activate(lic.key);
    const payload = verifyToken(storage.load().certificate, t.keyring);
    assert.equal(payload.lic, lic.reference);
    assert.equal(payload.kid, 'test-2026-10');
    const tampered = storage.load().certificate.replace(/\.([^.]+)\./, (m, p) => `.${p.slice(0, -2)}AA.`);
    assert.throws(() => verifyToken(tampered, t.keyring));
  });

  it('pages through the change feed', async () => {
    let since = 0;
    let auditSince = 0;
    const seen = new Set();
    for (let i = 0; i < 100; i++) {
      const r = await t.admin('GET', `/v1/admin/changes?since=${since}&auditSince=${auditSince}&limit=3`);
      for (const l of r.body.licenses) seen.add(l.id);
      since = r.body.nextSince;
      auditSince = r.body.nextAuditSince;
      if (!r.body.more) break;
    }
    const status = await t.admin('GET', '/v1/admin/status');
    assert.equal(seen.size, status.body.counts.licenses);
  });

  it('detects a license changed directly in the database', async () => {
    const lic = await issue('term-30');
    const ok = await t.admin('GET', '/v1/admin/status?fresh=1');
    assert.equal(ok.body.auditChain, 'intact');
    const raw = new DatabaseSync(path.join(t.dirs.data, 'license.db'));
    raw.prepare('UPDATE licenses SET expires_at = expires_at + 999999 WHERE id = ?').run(lic.id);
    const broken = await t.admin('GET', '/v1/admin/status?fresh=1');
    assert.equal(broken.body.auditChain, 'broken');
    raw.prepare('UPDATE licenses SET expires_at = expires_at - 999999 WHERE id = ?').run(lic.id);
    raw.close();
    assert.equal((await t.admin('GET', '/v1/admin/status?fresh=1')).body.auditChain, 'intact');
  });

  it('keeps the CRM secret out of the keyring and stores no keys', async () => {
    const dbText = fs.readFileSync(path.join(t.dirs.data, 'license.db')).toString('latin1');
    assert.ok(!dbText.includes(CRM_SECRET));
  });
});

describe('admin address allow list', () => {
  it('refuses admin calls from other addresses', async () => {
    const t = await startTestServer({ env: { LMP_ADMIN_ALLOWED_IPS: '10.9.9.9' } });
    try {
      const r = await t.admin('GET', '/v1/admin/status');
      assert.equal(r.status, 403);
      assert.equal(r.body.message, 'Not allowed from this address');
    } finally {
      await t.close();
    }
  });
});

describe('proxy mode', () => {
  it('answers "HTTPS is required" for plain HTTP', async () => {
    const { startServer } = await import('../license-server/src/server.js');
    const { makeInstall } = await import('./helpers.mjs');
    const install = makeInstall();
    const s = await startServer({ ...install.env, LMP_TLS_MODE: 'proxy' }, { log: () => {} });
    try {
      const plain = await fetch(`http://127.0.0.1:${s.port}/v1/health`);
      assert.equal(plain.status, 400);
      assert.equal((await plain.json()).message, 'HTTPS is required');
      const viaProxy = await fetch(`http://127.0.0.1:${s.port}/v1/health`, { headers: { 'x-forwarded-proto': 'https' } });
      assert.equal(viaProxy.status, 200);
    } finally {
      await s.close();
    }
  });
});
