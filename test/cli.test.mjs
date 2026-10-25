import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startServer } from '../license-server/src/server.js';
import { makeInstall, seedProduct, startTestServer } from './helpers.mjs';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'license-server');
const node = (args, env) => spawnSync(process.execPath, args, { cwd: serverDir, env: { ...process.env, ...env }, encoding: 'utf8' });

describe('bin/keys.js', () => {
  it('generates keys, exports the keyring and supports rotation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmp-keys-'));
    const env = { LMP_KEYS_DIR: dir };
    assert.equal(node(['bin/keys.js', 'generate', 'prod-2026-10'], env).status, 0);
    const mode = fs.statSync(path.join(dir, 'prod-2026-10.key.pem')).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal(node(['bin/keys.js', 'generate', 'prod-2026-10'], env).status, 1, 'refuses to overwrite');
    assert.equal(node(['bin/keys.js', 'export-public', 'prod-2026-10'], env).status, 0);
    assert.equal(node(['bin/keys.js', 'generate', 'prod-2027-10'], env).status, 0);
    // Rotation step 2: the new key is trusted but the old one still signs.
    assert.equal(node(['bin/keys.js', 'export-public', 'prod-2026-10'], env).status, 0);
    const ring = JSON.parse(fs.readFileSync(path.join(dir, 'public-keyring.json'), 'utf8'));
    assert.equal(ring.active, 'prod-2026-10');
    assert.deepEqual(ring.keys.map((k) => k.kid), ['prod-2026-10', 'prod-2027-10']);
    assert.ok(!JSON.stringify(ring).includes('PRIVATE'));
  });
});

describe('server start-up checks', () => {
  it('refuses to start without HTTPS', async () => {
    const install = makeInstall();
    await assert.rejects(startServer({ ...install.env, LMP_TLS_CERT_FILE: '' }, { log: () => {} }), /HTTPS is not configured/);
  });

  it('refuses a signing key readable by others', async () => {
    const install = makeInstall();
    fs.chmodSync(path.join(install.dirs.keys, 'test-2026-10.key.pem'), 0o644);
    await assert.rejects(startServer(install.env, { log: () => {} }), /accessible by group\/others/);
  });

  it('reports a missing certificate file', async () => {
    const install = makeInstall();
    await assert.rejects(startServer({ ...install.env, LMP_TLS_CERT_FILE: '/nonexistent/fullchain.pem' }, { log: () => {} }), /no such file/);
  });
});

describe('bin/backup.js', () => {
  it('creates, verifies and restores backups, raising the generation', async () => {
    const t = await startTestServer();
    await seedProduct(t);
    const issued = await t.admin('POST', '/v1/admin/licenses/issue', {
      productId: 'acme-editor', planCode: 'pro-lifetime', quantity: 2, grantReason: 'backup test',
    });
    assert.equal(issued.status, 201);
    const env = t.env;
    const created = node(['bin/backup.js', 'create'], env);
    assert.equal(created.status, 0, created.stdout + created.stderr);
    const file = JSON.parse(created.stdout).file;
    const verified = node(['bin/backup.js', 'verify', file], env);
    assert.equal(verified.status, 0);
    assert.equal(JSON.parse(verified.stdout).ok, true);
    assert.equal(JSON.parse(verified.stdout).licenses, 2);

    // A license sold after the backup disappears on restore.
    await t.admin('POST', '/v1/admin/licenses/issue', {
      productId: 'acme-editor', planCode: 'pro-lifetime', quantity: 1, grantReason: 'after backup',
    });
    const before = await t.admin('GET', '/v1/admin/status');
    await t.close();
    const restored = node(['bin/backup.js', 'restore', file], env);
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    const out = JSON.parse(restored.stdout);
    assert.ok(out.previousDatabase.includes('license.db.pre-restore-'));
    assert.equal(out.generation, before.body.generation + 1);

    const again = await startServer(env, { log: () => {} });
    try {
      const s = again.service.status({ fresh: true });
      assert.equal(s.counts.licenses, 2);
      assert.equal(s.auditChain, 'intact');
      assert.equal(s.generation, before.body.generation + 1);
    } finally {
      await again.close();
    }
  });

  it('rejects a damaged backup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmp-bad-'));
    const file = path.join(dir, 'license-20260101T000000Z.db');
    fs.writeFileSync(file, 'not a database');
    const r = node(['bin/backup.js', 'verify', file], { LMP_BACKUP_DIR: dir });
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stdout).ok, false);
  });
});

describe('let\'s encrypt deploy hook', () => {
  it('is valid shell', () => {
    execFileSync('sh', ['-n', path.join(serverDir, '..', 'deploy', 'letsencrypt', 'lmp-deploy-hook.sh')]);
  });
});
