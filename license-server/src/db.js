import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from './sqlite.js';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  product_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  current_version TEXT,
  supported_os TEXT NOT NULL DEFAULT '[]',
  offline_policy TEXT NOT NULL DEFAULT 'perpetual',
  offline_check_days INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  rev INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  product_id TEXT NOT NULL REFERENCES applications(product_id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  duration_value INTEGER,
  duration_unit TEXT,
  renewal_policy TEXT NOT NULL DEFAULT 'none',
  max_devices INTEGER NOT NULL DEFAULT 1,
  price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  transfer_policy TEXT NOT NULL DEFAULT 'self_service',
  transfers_per_year INTEGER,
  offline_grace_days INTEGER NOT NULL DEFAULT 0,
  payment_grace_days INTEGER NOT NULL DEFAULT 0,
  entitlements TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  rev INTEGER NOT NULL,
  PRIMARY KEY (product_id, code)
);

CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  product_id TEXT NOT NULL,
  plan_code TEXT NOT NULL,
  terms TEXT NOT NULL,
  type TEXT NOT NULL,
  entitlements TEXT NOT NULL DEFAULT '[]',
  max_devices INTEGER NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_pepper_id TEXT NOT NULL,
  key_last4 TEXT NOT NULL,
  customer_id TEXT,
  customer_name TEXT,
  contact_id TEXT,
  order_ref TEXT,
  order_item_id TEXT,
  order_seq INTEGER,
  grant_reason TEXT,
  status TEXT NOT NULL DEFAULT 'issued',
  status_reason TEXT,
  issued_at INTEGER NOT NULL,
  starts_at INTEGER NOT NULL,
  expires_at INTEGER,
  auto_renew INTEGER NOT NULL DEFAULT 0,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  cancelled_at INTEGER,
  updated_at INTEGER NOT NULL,
  rev INTEGER NOT NULL,
  UNIQUE (order_ref, order_item_id, order_seq)
);
CREATE INDEX IF NOT EXISTS licenses_rev ON licenses(rev);
CREATE INDEX IF NOT EXISTS licenses_order ON licenses(order_ref, order_item_id);

CREATE TABLE IF NOT EXISTS activations (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  product_id TEXT NOT NULL,
  device_hash TEXT NOT NULL,
  device_name TEXT,
  os TEXT,
  app_version TEXT,
  secret_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  activated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  released_at INTEGER,
  release_kind TEXT,
  rev INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS activations_license ON activations(license_id, status);
CREATE INDEX IF NOT EXISTS activations_rev ON activations(rev);

CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transfers_license ON transfers(license_id, at);

CREATE TABLE IF NOT EXISTS trials (
  product_id TEXT NOT NULL,
  device_hash TEXT NOT NULL,
  license_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  PRIMARY KEY (product_id, device_hash)
);

CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  action TEXT NOT NULL,
  license_id TEXT,
  license_ref TEXT,
  activation_id TEXT,
  product_id TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  ip TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_license ON audit(license_id, seq);

CREATE TABLE IF NOT EXISTS idempotency (
  client_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, key)
);
`;

export function openDatabase(file, { create = true } = {}) {
  if (!create && !fs.existsSync(file)) throw new Error(`database ${file} does not exist`);
  if (create) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  const meta = db.prepare('SELECT value FROM meta WHERE key = ?');
  const setMeta = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING');
  setMeta.run('schema_version', String(SCHEMA_VERSION));
  // instance_id identifies this database; generation goes up on every
  // restore, which tells EspoCRM to resynchronize everything.
  setMeta.run('instance_id', randomUUID());
  setMeta.run('generation', '1');
  setMeta.run('rev', '0');
  const version = Number(meta.get('schema_version').value);
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error(`database ${file} was created by a newer license server (schema ${version})`);
  }
  return db;
}

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

// Every change to a license or activation takes the next revision number,
// so EspoCRM can ask for "everything changed since revision N".
export function nextRev(db) {
  const row = db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev' RETURNING value").get();
  return Number(row.value);
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
