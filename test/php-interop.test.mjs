import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CRM_SECRET, startTestServer } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const php = spawnSync('php', ['-v']).status === 0;

describe('EspoCRM extension ↔ license server', { skip: !php && 'php is not installed' }, () => {
  it('signs requests the server accepts and maps errors', async () => {
    const t = await startTestServer();
    try {
      // Asynchronous: the server runs in this process and must keep answering.
      const r = await promisify(execFile)('php', [path.join(here, 'php', 'client-interop.php')], {
        env: { ...process.env, LMP_URL: t.base, LMP_SECRET: CRM_SECRET, LMP_CA: t.tls.cert },
        encoding: 'utf8',
      });
      const out = JSON.parse(r.stdout.trim().split('\n').pop());
      assert.deepEqual(out, {
        status: 'intact',
        app: 'php-app',
        plan: 'basic',
        issued: 2,
        keyFormat: true,
        changes: 2,
        suspend: 'suspended',
        replayKeyHidden: true,
        grantReason: 'grant_reason_required',
        badSecret: 'The license server rejected the CRM credentials',
        notConfigured: 'The license server connection is not configured',
        down: 'unavailable',
      });
    } finally {
      await t.close();
    }
  });
});
