import { createHash } from 'node:crypto';
import { canonicalJson } from '../../packages/lmp-core/src/index.js';

const GENESIS = 'lmp-audit-genesis';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function entryBody(row) {
  return canonicalJson({
    seq: row.seq,
    at: row.at,
    actorType: row.actor_type,
    actorId: row.actor_id ?? null,
    actorName: row.actor_name ?? null,
    action: row.action,
    licenseId: row.license_id ?? null,
    licenseRef: row.license_ref ?? null,
    activationId: row.activation_id ?? null,
    productId: row.product_id ?? null,
    details: row.details,
    ip: row.ip ?? null,
  });
}

// The fields of a license that matter for enforcement. Each audit entry for a
// license records their digest after the change, so editing a license row in
// the database without going through the server breaks the chain check.
export function licenseDigest(lic) {
  return sha256(canonicalJson({
    id: lic.id,
    reference: lic.reference,
    productId: lic.product_id,
    planCode: lic.plan_code,
    terms: lic.terms,
    type: lic.type,
    entitlements: lic.entitlements,
    maxDevices: lic.max_devices,
    keyHash: lic.key_hash,
    status: lic.status,
    startsAt: lic.starts_at,
    expiresAt: lic.expires_at ?? null,
    autoRenew: lic.auto_renew,
    cancelAtPeriodEnd: lic.cancel_at_period_end,
    customerId: lic.customer_id ?? null,
  }));
}

export function appendAudit(db, entry) {
  const last = db.prepare('SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1').get();
  const row = {
    seq: (last?.seq ?? 0) + 1,
    at: entry.at,
    actor_type: entry.actor?.type || 'system',
    actor_id: entry.actor?.id ?? null,
    actor_name: entry.actor?.name ?? null,
    action: entry.action,
    license_id: entry.license?.id ?? null,
    license_ref: entry.license?.reference ?? null,
    activation_id: entry.activationId ?? null,
    product_id: entry.productId ?? entry.license?.product_id ?? null,
    details: { ...(entry.details || {}) },
    ip: entry.ip ?? null,
  };
  if (entry.license) row.details.licenseDigest = licenseDigest(entry.license);
  const prev = last?.hash ?? sha256(GENESIS);
  const hash = sha256(prev + '\n' + entryBody(row));
  db.prepare(`INSERT INTO audit(seq, at, actor_type, actor_id, actor_name, action, license_id, license_ref,
      activation_id, product_id, details, ip, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.seq, row.at, row.actor_type, row.actor_id, row.actor_name, row.action, row.license_id,
      row.license_ref, row.activation_id, row.product_id, JSON.stringify(row.details), row.ip, prev, hash);
  return row.seq;
}

// Walks the whole chain, then checks every license against the digest of its
// newest audit entry. Returns { intact, entries, brokenAt?, reason? }.
export function verifyAuditChain(db) {
  let prev = sha256(GENESIS);
  let expectedSeq = 1;
  let entries = 0;
  const latestDigest = new Map();
  for (const row of db.prepare('SELECT * FROM audit ORDER BY seq').iterate()) {
    if (row.seq !== expectedSeq) {
      return { intact: false, entries, brokenAt: expectedSeq, reason: `audit entry ${expectedSeq} is missing` };
    }
    let details;
    try {
      details = JSON.parse(row.details);
    } catch {
      return { intact: false, entries, brokenAt: row.seq, reason: 'audit entry details are not valid JSON' };
    }
    const hash = sha256(prev + '\n' + entryBody({ ...row, details }));
    if (row.prev_hash !== prev || row.hash !== hash) {
      return { intact: false, entries, brokenAt: row.seq, reason: `audit entry ${row.seq} was altered` };
    }
    if (row.license_id && details.licenseDigest) latestDigest.set(row.license_id, details.licenseDigest);
    prev = hash;
    expectedSeq++;
    entries++;
  }
  for (const lic of db.prepare('SELECT * FROM licenses').iterate()) {
    const digest = latestDigest.get(lic.id);
    if (!digest) return { intact: false, entries, reason: `license ${lic.reference} has no audit history` };
    if (digest !== licenseDigest(lic)) {
      return { intact: false, entries, reason: `license ${lic.reference} was changed outside the license server` };
    }
  }
  return { intact: true, entries };
}
