import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from './sqlite.js';
import { appendAudit, verifyAuditChain } from './audit.js';
import { getMeta, openDatabase, setMeta, transaction } from './db.js';

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

// Hourly backups: a consistent copy taken with VACUUM INTO while the server
// keeps running, then the oldest copies beyond `keep` are removed.
export function createBackup({ dbFile, backupDir, keep }) {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o750 });
  const target = path.join(backupDir, `license-${stamp()}.db`);
  if (fs.existsSync(target)) throw new Error(`${target} already exists`);
  const db = openDatabase(dbFile, { create: false });
  try {
    db.prepare('VACUUM INTO ?').run(target);
  } finally {
    db.close();
  }
  fs.chmodSync(target, 0o640);
  const removed = pruneBackups(backupDir, keep);
  return { ok: true, file: target, bytes: fs.statSync(target).size, removed };
}

export function listBackups(backupDir) {
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir)
    .filter((f) => /^license-\d{8}T\d{6}Z\.db$/.test(f))
    .sort()
    .map((f) => path.join(backupDir, f));
}

export function pruneBackups(backupDir, keep) {
  const all = listBackups(backupDir);
  const old = all.slice(0, Math.max(0, all.length - keep));
  for (const f of old) fs.rmSync(f, { force: true });
  return old.map((f) => path.basename(f));
}

// Checks that a backup opens, passes SQLite's integrity check and still has
// an intact audit chain. It never modifies the file.
export function verifyBackup(file) {
  if (!fs.existsSync(file)) return { ok: false, file, error: 'file not found' };
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const integrityText = Object.values(integrity)[0];
    if (integrityText !== 'ok') return { ok: false, file, error: `integrity check: ${integrityText}` };
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    for (const t of ['meta', 'licenses', 'activations', 'audit']) {
      if (!tables.has(t)) return { ok: false, file, error: `not a license database (no ${t} table)` };
    }
    const chain = verifyAuditChain(db);
    const count = (sql) => db.prepare(sql).get().n;
    return {
      ok: chain.intact,
      file,
      integrity: 'ok',
      auditChain: chain.intact ? 'intact' : 'broken',
      ...(chain.intact ? {} : { error: chain.reason }),
      instanceId: getMeta(db, 'instance_id'),
      generation: Number(getMeta(db, 'generation')),
      licenses: count('SELECT COUNT(*) AS n FROM licenses'),
      activations: count('SELECT COUNT(*) AS n FROM activations'),
      auditEntries: chain.entries,
    };
  } catch (err) {
    return { ok: false, file, error: err.message };
  } finally {
    db?.close();
  }
}

function ownLike(file, reference) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  const st = fs.statSync(reference);
  fs.chownSync(file, st.uid, st.gid);
}

// Replaces the live database with a backup. The current database is kept as
// license.db.pre-restore-<time>. The generation number is raised above both
// databases' values so EspoCRM notices the restore and resynchronizes.
export function restoreBackup({ dbFile, backupFile }) {
  const check = verifyBackup(backupFile);
  if (!check.ok) throw new Error(`backup ${backupFile} failed verification: ${check.error}`);
  let currentGeneration = 0;
  let keptAs = null;
  if (fs.existsSync(dbFile)) {
    const live = new DatabaseSync(dbFile);
    try {
      currentGeneration = Number(getMeta(live, 'generation')) || 0;
      live.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      live.close();
    }
    keptAs = `${dbFile}.pre-restore-${stamp()}`;
    fs.renameSync(dbFile, keptAs);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(dbFile + suffix)) fs.renameSync(dbFile + suffix, keptAs + suffix);
    }
  }
  fs.copyFileSync(backupFile, dbFile);
  fs.chmodSync(dbFile, 0o640);
  const db = openDatabase(dbFile, { create: false });
  try {
    const generation = Math.max(currentGeneration, check.generation) + 1;
    transaction(db, () => {
      setMeta(db, 'generation', generation);
      setMeta(db, 'restored_at', new Date().toISOString());
      setMeta(db, 'restored_from', path.basename(backupFile));
      appendAudit(db, {
        at: Math.floor(Date.now() / 1000),
        actor: { type: 'system', name: 'backup.js restore' },
        action: 'database_restored',
        details: { from: path.basename(backupFile), generation },
      });
    });
    for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
      if (fs.existsSync(f)) ownLike(f, path.dirname(dbFile));
    }
    return { ok: true, restoredFrom: backupFile, previousDatabase: keptAs, generation };
  } finally {
    db.close();
  }
}
