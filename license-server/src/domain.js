import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  addDuration,
  deviceHash,
  DURATION_UNITS,
  formatLicenseKey,
  generateLicenseKey,
  generateLicenseReference,
  hashLicenseKey,
  LICENSE_TYPES,
  licenseKeyLast4,
  normalizeLicenseKey,
  PLAN_CODE_PATTERN,
  PRODUCT_ID_PATTERN,
  RENEWAL_POLICIES,
  signToken,
  TRANSFER_POLICIES,
} from '../../packages/lmp-core/src/index.js';
import { appendAudit, verifyAuditChain } from './audit.js';
import { getMeta, nextRev, transaction } from './db.js';
import { ApiError, badRequest, conflict, forbidden, notFound } from './errors.js';

const DAY = 86400;
const YEAR = 365 * DAY;
const MAX_ISSUE_QUANTITY = 1000;
const ENTITLEMENT_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

export const iso = (t) => (t === null || t === undefined ? null : new Date(t * 1000).toISOString().replace('.000Z', 'Z'));
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// ---------------------------------------------------------------- validation

function str(body, name, { required = false, max = 200, min = 0, pattern = null } = {}) {
  const v = body?.[name];
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  if (typeof v !== 'string') throw badRequest(`${name} must be text`);
  const t = v.trim();
  if (t.length < min) throw badRequest(`${name} must be at least ${min} characters`);
  if (t.length > max) throw badRequest(`${name} must be at most ${max} characters`);
  if (pattern && !pattern.test(t)) throw badRequest(`${name} has an invalid format`);
  return t;
}

function intField(body, name, { required = false, min = 0, max = 1e9 } = {}) {
  const v = body?.[name];
  if (v === undefined || v === null || v === '') {
    if (required) throw badRequest(`${name} is required`);
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

function oneOf(body, name, values, fallback) {
  const v = body?.[name] ?? fallback;
  if (!values.includes(v)) throw badRequest(`${name} must be one of: ${values.join(', ')}`);
  return v;
}

function reasonField(body, { required = true } = {}) {
  return str(body, 'reason', { required, min: required ? 3 : 0, max: 1000 });
}

function actorOf(body, client) {
  const a = body?.actor && typeof body.actor === 'object' ? body.actor : {};
  return {
    type: 'admin',
    id: typeof a.id === 'string' ? a.id.slice(0, 64) : null,
    name: typeof a.name === 'string' ? a.name.slice(0, 200) : client?.id || null,
  };
}

function parseTime(value, name) {
  const ms = Date.parse(value);
  if (typeof value !== 'string' || Number.isNaN(ms)) throw badRequest(`${name} must be an ISO date`);
  return Math.floor(ms / 1000);
}

// -------------------------------------------------------------------- views

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function applicationView(a) {
  return {
    productId: a.product_id,
    name: a.name,
    currentVersion: a.current_version,
    supportedOs: parseJson(a.supported_os, []),
    offlinePolicy: a.offline_policy,
    offlineCheckDays: a.offline_check_days,
    status: a.status,
    createdAt: iso(a.created_at),
    updatedAt: iso(a.updated_at),
  };
}

function planView(p, licenseCount = undefined) {
  return {
    productId: p.product_id,
    code: p.code,
    name: p.name,
    type: p.type,
    durationValue: p.duration_value,
    durationUnit: p.duration_unit,
    renewalPolicy: p.renewal_policy,
    maxDevices: p.max_devices,
    priceCents: p.price_cents,
    currency: p.currency,
    transferPolicy: p.transfer_policy,
    transfersPerYear: p.transfers_per_year,
    offlineGraceDays: p.offline_grace_days,
    paymentGraceDays: p.payment_grace_days,
    entitlements: parseJson(p.entitlements, []),
    status: p.status,
    licenseCount,
    updatedAt: iso(p.updated_at),
  };
}

function termsOf(lic) {
  return parseJson(lic.terms, {});
}

// The end of the period in which the license still works: the expiry, plus
// the payment grace period for subscriptions.
function validUntil(lic) {
  if (lic.expires_at === null || lic.expires_at === undefined) return null;
  const grace = lic.type === 'subscription' ? (termsOf(lic).paymentGraceDays || 0) * DAY : 0;
  return lic.expires_at + grace;
}

export function licenseState(lic, now, activeCount) {
  if (['revoked', 'suspended', 'cancelled'].includes(lic.status)) return lic.status;
  const until = validUntil(lic);
  if (until !== null && now >= until) return 'expired';
  if (lic.type === 'subscription' && lic.expires_at !== null && now >= lic.expires_at) return 'past_due';
  return activeCount > 0 ? 'active' : 'available';
}

// ----------------------------------------------------------------- service

export class LicenseService {
  constructor({ db, peppers, signing, keyringKids = [], now = () => Math.floor(Date.now() / 1000), log = () => {} }) {
    this.db = db;
    this.peppers = peppers;
    this.signing = signing;
    this.keyringKids = keyringKids;
    this.now = now;
    this.log = log;
    this.auditCache = null;
  }

  // ---------------------------------------------------------------- helpers

  activeCount(licenseId) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM activations WHERE license_id = ? AND status = 'active'")
      .get(licenseId).n;
  }

  licenseView(lic, now = this.now()) {
    const active = this.activeCount(lic.id);
    const terms = termsOf(lic);
    return {
      id: lic.id,
      reference: lic.reference,
      productId: lic.product_id,
      planCode: lic.plan_code,
      planName: terms.planName ?? null,
      type: lic.type,
      status: licenseState(lic, now, active),
      baseStatus: lic.status,
      statusReason: lic.status_reason,
      entitlements: parseJson(lic.entitlements, []),
      maxDevices: lic.max_devices,
      activeDevices: active,
      keyLast4: lic.key_last4,
      customerId: lic.customer_id,
      customerName: lic.customer_name,
      contactId: lic.contact_id,
      orderRef: lic.order_ref,
      orderItemId: lic.order_item_id,
      grantReason: lic.grant_reason,
      renewalPolicy: terms.renewalPolicy ?? 'none',
      transferPolicy: terms.transferPolicy ?? null,
      transfersPerYear: terms.transfersPerYear ?? null,
      transfersUsedThisYear: this.transfersUsed(lic.id, now),
      issuedAt: iso(lic.issued_at),
      startsAt: iso(lic.starts_at),
      expiresAt: iso(lic.expires_at),
      validUntil: iso(validUntil(lic)),
      autoRenew: !!lic.auto_renew,
      cancelAtPeriodEnd: !!lic.cancel_at_period_end,
      cancelledAt: iso(lic.cancelled_at),
      updatedAt: iso(lic.updated_at),
      rev: lic.rev,
    };
  }

  publicLicenseView(lic, now = this.now()) {
    const v = this.licenseView(lic, now);
    return {
      reference: v.reference,
      productId: v.productId,
      planCode: v.planCode,
      planName: v.planName,
      type: v.type,
      status: v.status,
      entitlements: v.entitlements,
      expiresAt: v.expiresAt,
      validUntil: v.validUntil,
      maxDevices: v.maxDevices,
      activeDevices: v.activeDevices,
    };
  }

  activationView(a, lic = null) {
    const license = lic || this.db.prepare('SELECT reference FROM licenses WHERE id = ?').get(a.license_id);
    return {
      id: a.id,
      licenseId: a.license_id,
      licenseReference: license?.reference ?? null,
      productId: a.product_id,
      deviceFingerprint: a.device_hash.slice(0, 16),
      deviceName: a.device_name,
      os: a.os,
      appVersion: a.app_version,
      status: a.status,
      activatedAt: iso(a.activated_at),
      lastSeenAt: iso(a.last_seen_at),
      releasedAt: iso(a.released_at),
      releaseKind: a.release_kind,
      rev: a.rev,
    };
  }

  auditView(r) {
    const details = parseJson(r.details, {});
    delete details.licenseDigest;
    return {
      seq: r.seq,
      at: iso(r.at),
      actorType: r.actor_type,
      actorId: r.actor_id,
      actorName: r.actor_name,
      action: r.action,
      licenseId: r.license_id,
      licenseReference: r.license_ref,
      activationId: r.activation_id,
      productId: r.product_id,
      details,
      ip: r.ip,
    };
  }

  getLicenseRow(idOrRef) {
    const lic = this.db.prepare('SELECT * FROM licenses WHERE id = ? OR reference = ?').get(idOrRef, idOrRef);
    if (!lic) throw notFound('license not found', 'license_not_found');
    return lic;
  }

  findByKey(normalizedKey) {
    const stmt = this.db.prepare('SELECT * FROM licenses WHERE key_hash = ?');
    for (const p of this.peppers) {
      const lic = stmt.get(hashLicenseKey(normalizedKey, p.secret));
      if (lic) return lic;
    }
    return null;
  }

  newKeyFields() {
    const key = generateLicenseKey();
    const normalized = normalizeLicenseKey(key);
    const pepper = this.peppers[0];
    return {
      key: formatLicenseKey(normalized),
      hash: hashLicenseKey(normalized, pepper.secret),
      pepperId: pepper.id,
      last4: licenseKeyLast4(normalized),
    };
  }

  transfersUsed(licenseId, now) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM transfers WHERE license_id = ? AND at > ?')
      .get(licenseId, now - YEAR).n;
  }

  // Saves the given license columns, takes a new revision and writes the
  // audit entry, which records the license's digest after the change.
  updateLicense(lic, changes, audit) {
    const now = this.now();
    const fields = { ...changes, updated_at: now, rev: nextRev(this.db) };
    const cols = Object.keys(fields);
    this.db.prepare(`UPDATE licenses SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map((c) => fields[c]), lic.id);
    const updated = this.db.prepare('SELECT * FROM licenses WHERE id = ?').get(lic.id);
    appendAudit(this.db, { at: now, license: updated, ...audit });
    return updated;
  }

  touchLicense(lic, audit) {
    return this.updateLicense(lic, {}, audit);
  }

  releaseActivation(a, kind) {
    const now = this.now();
    this.db.prepare("UPDATE activations SET status = 'released', released_at = ?, release_kind = ?, rev = ? WHERE id = ?")
      .run(now, kind, nextRev(this.db), a.id);
  }

  certificate(lic, activation, app) {
    const now = this.now();
    const terms = termsOf(lic);
    const periodic = app?.offline_policy === 'periodic' && app.offline_check_days;
    const payload = {
      typ: 'lmp-cert',
      v: 1,
      lid: lic.id,
      lic: lic.reference,
      pid: lic.product_id,
      plan: lic.plan_code,
      ltype: lic.type,
      ent: parseJson(lic.entitlements, []),
      md: lic.max_devices,
      act: activation.id,
      dev: activation.device_hash,
      iat: now,
      lexp: validUntil(lic),
      ogr: ['fixed_term', 'subscription'].includes(lic.type) ? (terms.offlineGraceDays || 0) * DAY : 0,
      chk: periodic ? now + app.offline_check_days * DAY : null,
    };
    return signToken(payload, this.signing.privateKey, this.signing.kid);
  }

  // ----------------------------------------------------------- applications

  upsertApplication(productId, body, client) {
    if (!PRODUCT_ID_PATTERN.test(productId || '')) {
      throw badRequest('Product Identifier may contain lowercase letters, digits, ".", "-" and "_" (2 to 64 characters)');
    }
    const name = str(body, 'name', { required: true });
    const currentVersion = str(body, 'currentVersion', { max: 50 });
    const os = body?.supportedOs ?? [];
    if (!Array.isArray(os) || os.some((o) => typeof o !== 'string' || !o || o.length > 40)) {
      throw badRequest('supportedOs must be a list of names');
    }
    const offlinePolicy = oneOf(body, 'offlinePolicy', ['perpetual', 'periodic'], 'perpetual');
    const offlineCheckDays = offlinePolicy === 'periodic'
      ? intField(body, 'offlineCheckDays', { required: true, min: 1, max: 365 })
      : null;
    const status = oneOf(body, 'status', ['active', 'archived'], 'active');
    const now = this.now();
    return transaction(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM applications WHERE product_id = ?').get(productId);
      const rev = nextRev(this.db);
      if (existing) {
        this.db.prepare(`UPDATE applications SET name=?, current_version=?, supported_os=?, offline_policy=?,
            offline_check_days=?, status=?, updated_at=?, rev=? WHERE product_id=?`)
          .run(name, currentVersion, JSON.stringify(os), offlinePolicy, offlineCheckDays, status, now, rev, productId);
      } else {
        this.db.prepare(`INSERT INTO applications(product_id, name, current_version, supported_os, offline_policy,
            offline_check_days, status, created_at, updated_at, rev) VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(productId, name, currentVersion, JSON.stringify(os), offlinePolicy, offlineCheckDays, status, now, now, rev);
      }
      appendAudit(this.db, {
        at: now,
        actor: actorOf(body, client),
        action: existing ? 'application_updated' : 'application_registered',
        productId,
        details: { name, offlinePolicy, offlineCheckDays, status },
      });
      return applicationView(this.db.prepare('SELECT * FROM applications WHERE product_id = ?').get(productId));
    });
  }

  getApplication(productId) {
    const a = this.db.prepare('SELECT * FROM applications WHERE product_id = ?').get(productId);
    if (!a) throw notFound('application not found', 'application_not_found');
    return applicationView(a);
  }

  // ------------------------------------------------------------------ plans

  upsertPlan(productId, code, body, client) {
    if (!PLAN_CODE_PATTERN.test(code || '')) {
      throw badRequest('Plan Code may contain lowercase letters, digits, ".", "-" and "_" (2 to 64 characters)');
    }
    const app = this.db.prepare('SELECT * FROM applications WHERE product_id = ?').get(productId);
    if (!app) throw notFound(`application ${productId} is not registered on the license server`, 'application_not_found');
    const p = this.validatePlan(body);
    const now = this.now();
    return transaction(this.db, () => {
      const existing = this.db.prepare('SELECT * FROM plans WHERE product_id = ? AND code = ?').get(productId, code);
      const licenseCount = this.db.prepare('SELECT COUNT(*) AS n FROM licenses WHERE product_id = ? AND plan_code = ?')
        .get(productId, code).n;
      if (existing && licenseCount > 0 && existing.type !== p.type) {
        throw conflict('Licenses exist for this plan, so its License Type is locked. Create a new plan and archive this one.', 'plan_locked');
      }
      const rev = nextRev(this.db);
      const values = [p.name, p.type, p.durationValue, p.durationUnit, p.renewalPolicy, p.maxDevices, p.priceCents,
        p.currency, p.transferPolicy, p.transfersPerYear, p.offlineGraceDays, p.paymentGraceDays,
        JSON.stringify(p.entitlements), p.status];
      if (existing) {
        this.db.prepare(`UPDATE plans SET name=?, type=?, duration_value=?, duration_unit=?, renewal_policy=?,
            max_devices=?, price_cents=?, currency=?, transfer_policy=?, transfers_per_year=?, offline_grace_days=?,
            payment_grace_days=?, entitlements=?, status=?, updated_at=?, rev=? WHERE product_id=? AND code=?`)
          .run(...values, now, rev, productId, code);
      } else {
        this.db.prepare(`INSERT INTO plans(name, type, duration_value, duration_unit, renewal_policy, max_devices,
            price_cents, currency, transfer_policy, transfers_per_year, offline_grace_days, payment_grace_days,
            entitlements, status, created_at, updated_at, rev, product_id, code)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(...values, now, now, rev, productId, code);
      }
      appendAudit(this.db, {
        at: now,
        actor: actorOf(body, client),
        action: existing ? 'plan_updated' : 'plan_created',
        productId,
        details: { code, ...p },
      });
      const row = this.db.prepare('SELECT * FROM plans WHERE product_id = ? AND code = ?').get(productId, code);
      return planView(row, licenseCount);
    });
  }

  validatePlan(body) {
    const type = oneOf(body, 'type', LICENSE_TYPES);
    const p = {
      name: str(body, 'name', { required: true }),
      type,
      durationValue: null,
      durationUnit: null,
      renewalPolicy: 'none',
      maxDevices: intField(body, 'maxDevices', { min: 1, max: 1000 }) ?? 1,
      priceCents: intField(body, 'priceCents', { min: 0, max: 1e12 }) ?? 0,
      currency: str(body, 'currency', { max: 3, pattern: /^[A-Z]{3}$/ }),
      transferPolicy: oneOf(body, 'transferPolicy', TRANSFER_POLICIES, 'self_service'),
      transfersPerYear: null,
      offlineGraceDays: 0,
      paymentGraceDays: 0,
      entitlements: [],
      status: oneOf(body, 'status', ['active', 'archived'], 'active'),
    };
    const hasDuration = body?.durationValue !== undefined && body?.durationValue !== null && body?.durationValue !== '';
    if (type === 'lifetime') {
      if (hasDuration) throw badRequest('A lifetime plan has no duration: leave Duration empty');
      if ((body?.renewalPolicy ?? 'none') !== 'none') throw badRequest('A lifetime plan is not renewable');
    } else {
      p.durationValue = intField(body, 'durationValue', { required: true, min: 1, max: 1000 });
      p.durationUnit = oneOf(body, 'durationUnit', DURATION_UNITS);
      if (type === 'trial') {
        const days = p.durationUnit === 'days' ? p.durationValue
          : p.durationUnit === 'months' ? p.durationValue * 30 : p.durationValue * 365;
        if (days > 365) throw badRequest('A trial lasts from 1 to 365 days');
      }
      const allowed = { fixed_term: ['none', 'manual'], trial: ['none'], subscription: ['manual', 'automatic'] }[type];
      p.renewalPolicy = oneOf(body, 'renewalPolicy', allowed, allowed[0]);
      if (!RENEWAL_POLICIES.includes(p.renewalPolicy)) throw badRequest('invalid renewal policy');
    }
    if (p.transferPolicy === 'limited_per_year') {
      p.transfersPerYear = intField(body, 'transfersPerYear', { required: true, min: 1, max: 100 });
    }
    if (type === 'fixed_term' || type === 'subscription') {
      p.offlineGraceDays = intField(body, 'offlineGraceDays', { min: 0, max: 365 }) ?? 0;
    }
    if (type === 'subscription') {
      p.paymentGraceDays = intField(body, 'paymentGraceDays', { min: 0, max: 90 }) ?? 0;
    }
    const ent = body?.entitlements ?? [];
    if (!Array.isArray(ent) || ent.some((e) => typeof e !== 'string' || !ENTITLEMENT_PATTERN.test(e))) {
      throw badRequest('entitlements must be a list of feature codes such as "pro" (lowercase letters, digits, ".", "-", "_", ":")');
    }
    p.entitlements = [...new Set(ent)];
    return p;
  }

  getPlan(productId, code) {
    const row = this.db.prepare('SELECT * FROM plans WHERE product_id = ? AND code = ?').get(productId, code);
    if (!row) throw notFound(`plan ${code} not found for ${productId}`, 'plan_not_found');
    return row;
  }

  // ---------------------------------------------------------------- issuing

  insertLicense(plan, { customer, contactId, order, seq, grantReason }) {
    const now = this.now();
    const k = this.newKeyFields();
    const terms = {
      planName: plan.name,
      durationValue: plan.duration_value,
      durationUnit: plan.duration_unit,
      renewalPolicy: plan.renewal_policy,
      transferPolicy: plan.transfer_policy,
      transfersPerYear: plan.transfers_per_year,
      offlineGraceDays: plan.offline_grace_days,
      paymentGraceDays: plan.payment_grace_days,
      priceCents: plan.price_cents,
      currency: plan.currency,
    };
    const expiresAt = plan.type === 'lifetime' ? null : addDuration(now, plan.duration_value, plan.duration_unit);
    const id = randomUUID();
    let reference;
    for (;;) {
      reference = generateLicenseReference();
      if (!this.db.prepare('SELECT 1 FROM licenses WHERE reference = ?').get(reference)) break;
    }
    this.db.prepare(`INSERT INTO licenses(id, reference, product_id, plan_code, terms, type, entitlements, max_devices,
        key_hash, key_pepper_id, key_last4, customer_id, customer_name, contact_id, order_ref, order_item_id, order_seq,
        grant_reason, status, issued_at, starts_at, expires_at, auto_renew, updated_at, rev)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'issued',?,?,?,?,?,?)`)
      .run(id, reference, plan.product_id, plan.code, JSON.stringify(terms), plan.type, plan.entitlements,
        plan.max_devices, k.hash, k.pepperId, k.last4, customer?.id ?? null, customer?.name ?? null, contactId ?? null,
        order?.ref ?? null, order?.itemId ?? null, seq ?? null, grantReason ?? null, now, now, expiresAt,
        plan.type === 'subscription' && plan.renewal_policy === 'automatic' ? 1 : 0, now, nextRev(this.db));
    return { lic: this.db.prepare('SELECT * FROM licenses WHERE id = ?').get(id), key: k.key };
  }

  issueLicenses(body, client) {
    const productId = str(body, 'productId', { required: true, pattern: PRODUCT_ID_PATTERN, max: 64 });
    const planCode = str(body, 'planCode', { required: true, pattern: PLAN_CODE_PATTERN, max: 64 });
    const quantity = intField(body, 'quantity', { required: true, min: 1, max: MAX_ISSUE_QUANTITY });
    const customer = body?.customer && typeof body.customer === 'object'
      ? { id: str(body.customer, 'id', { max: 64 }), name: str(body.customer, 'name', { max: 200 }) }
      : null;
    const contactId = str(body, 'contactId', { max: 64 });
    const order = body?.order && typeof body.order === 'object'
      ? { ref: str(body.order, 'ref', { required: true, max: 100 }), itemId: str(body.order, 'itemId', { required: true, max: 64 }) }
      : null;
    const grantReason = str(body, 'grantReason', { max: 1000 });
    const plan = this.getPlan(productId, planCode);
    if (!order && plan.price_cents > 0 && (!grantReason || grantReason.length < 5)) {
      throw badRequest('A paid plan issued without an order needs an administrative grant reason (at least 5 characters)', 'grant_reason_required');
    }
    const app = this.db.prepare('SELECT * FROM applications WHERE product_id = ?').get(productId);
    if (plan.status !== 'active') throw conflict(`plan ${planCode} is archived; licenses can no longer be issued from it`, 'plan_archived');
    if (app.status !== 'active') throw conflict(`application ${productId} is archived`, 'application_archived');
    const actor = actorOf(body, client);

    // For an order line, only the licenses not yet issued are created, so
    // issuing again after an interruption never duplicates licenses.
    let start = 1;
    let existing = [];
    if (order) {
      existing = this.db.prepare('SELECT * FROM licenses WHERE order_ref = ? AND order_item_id = ? ORDER BY order_seq')
        .all(order.ref, order.itemId);
      if (existing.some((l) => l.product_id !== productId || l.plan_code !== planCode)) {
        throw conflict('this order line already has licenses of a different plan', 'order_line_mismatch');
      }
      start = existing.length + 1;
    }
    const issued = [];
    for (let seq = start; seq <= quantity; seq++) {
      // One transaction per license: if the process stops halfway, every
      // license already returned is complete and the rest can be retried.
      transaction(this.db, () => {
        const { lic, key } = this.insertLicense(plan, { customer, contactId, order, seq: order ? seq : null, grantReason });
        appendAudit(this.db, {
          at: this.now(),
          actor,
          action: 'license_issued',
          license: lic,
          details: {
            planCode, quantity, orderRef: order?.ref ?? null, orderItemId: order?.itemId ?? null,
            grantReason: grantReason ?? null, keyLast4: lic.key_last4, client: client?.id ?? null,
          },
        });
        issued.push({ ...this.licenseView(lic), key });
      });
    }
    return {
      requested: quantity,
      alreadyIssued: existing.length,
      issued,
      existing: existing.map((l) => this.licenseView(l)),
    };
  }

  // ----------------------------------------------------- admin operations

  getLicenseDetail(idOrRef) {
    const lic = this.getLicenseRow(idOrRef);
    const activations = this.db.prepare('SELECT * FROM activations WHERE license_id = ? ORDER BY activated_at').all(lic.id);
    return { license: this.licenseView(lic), activations: activations.map((a) => this.activationView(a, lic)) };
  }

  licenseOperation(idOrRef, op, body, client) {
    const handler = {
      suspend: this.opSuspend,
      reactivate: this.opReactivate,
      revoke: this.opRevoke,
      extend: this.opExtend,
      renew: this.opRenew,
      'cancel-subscription': this.opCancelSubscription,
      'replace-key': this.opReplaceKey,
      recover: this.opRecover,
      'release-all': this.opReleaseAll,
    }[op];
    if (!handler) throw notFound(`unknown license operation ${op}`, 'unknown_operation');
    const actor = actorOf(body, client);
    return transaction(this.db, () => {
      const lic = this.getLicenseRow(idOrRef);
      const result = handler.call(this, lic, body || {}, actor) || {};
      const fresh = this.db.prepare('SELECT * FROM licenses WHERE id = ?').get(lic.id);
      return { ...result, ...this.getLicenseDetail(fresh.id) };
    });
  }

  opSuspend(lic, body, actor) {
    const reason = reasonField(body);
    if (lic.status === 'revoked') throw conflict('a revoked license cannot be suspended', 'invalid_state');
    if (lic.status === 'suspended') throw conflict('the license is already suspended', 'invalid_state');
    this.updateLicense(lic, { status: 'suspended', status_reason: reason }, { actor, action: 'license_suspended', details: { reason } });
  }

  opRevoke(lic, body, actor) {
    const reason = reasonField(body);
    if (lic.status === 'revoked') throw conflict('the license is already revoked', 'invalid_state');
    this.updateLicense(lic, { status: 'revoked', status_reason: reason }, { actor, action: 'license_revoked', details: { reason } });
  }

  opReactivate(lic, body, actor) {
    const reason = reasonField(body, { required: false });
    if (!['suspended', 'revoked', 'cancelled'].includes(lic.status)) {
      throw conflict('only a suspended, revoked or cancelled license can be reactivated', 'invalid_state');
    }
    this.updateLicense(lic, { status: 'issued', status_reason: null, cancelled_at: null },
      { actor, action: 'license_reactivated', details: { reason, previousStatus: lic.status } });
  }

  opExtend(lic, body, actor) {
    if (!['fixed_term', 'trial'].includes(lic.type)) {
      throw conflict('only fixed-term and trial licenses can be extended; use Renew for subscriptions', 'not_extendable');
    }
    const now = this.now();
    let newExpiry;
    if (body.expiresAt) {
      newExpiry = parseTime(body.expiresAt, 'expiresAt');
    } else {
      const value = intField(body, 'value', { required: true, min: 1, max: 1000 });
      const unit = oneOf(body, 'unit', DURATION_UNITS);
      newExpiry = addDuration(Math.max(lic.expires_at, now), value, unit);
    }
    if (newExpiry <= now) throw badRequest('the new expiry date must be in the future');
    if (newExpiry <= lic.expires_at) throw badRequest('the new expiry date must be later than the current one');
    this.updateLicense(lic, { expires_at: newExpiry }, {
      actor, action: 'license_extended',
      details: { previousExpiresAt: iso(lic.expires_at), expiresAt: iso(newExpiry), reason: reasonField(body, { required: false }) },
    });
  }

  opRenew(lic, body, actor) {
    const terms = termsOf(lic);
    if (!['subscription', 'fixed_term'].includes(lic.type) || !['manual', 'automatic'].includes(terms.renewalPolicy)) {
      throw conflict("this license's plan is not renewable", 'not_renewable');
    }
    if (['revoked', 'cancelled'].includes(lic.status)) {
      throw conflict(`a ${lic.status} license must be reactivated before it is renewed`, 'invalid_state');
    }
    const periods = intField(body, 'periods', { min: 1, max: 120 }) ?? 1;
    const now = this.now();
    // Renewing within the payment grace continues the old period, so the
    // customer is not charged for days already covered.
    const base = now < validUntil(lic) ? lic.expires_at : now;
    const newExpiry = addDuration(base, terms.durationValue * periods, terms.durationUnit);
    this.updateLicense(lic, { expires_at: newExpiry, cancel_at_period_end: 0, auto_renew: terms.renewalPolicy === 'automatic' ? 1 : 0 }, {
      actor, action: 'license_renewed',
      details: { periods, previousExpiresAt: iso(lic.expires_at), expiresAt: iso(newExpiry), paymentRef: str(body, 'paymentRef', { max: 200 }) },
    });
  }

  opCancelSubscription(lic, body, actor) {
    if (lic.type !== 'subscription') throw conflict('only subscriptions can be cancelled', 'not_subscription');
    if (lic.status === 'cancelled') throw conflict('the subscription is already cancelled', 'invalid_state');
    const atPeriodEnd = body.atPeriodEnd !== false;
    const reason = reasonField(body, { required: false });
    if (atPeriodEnd) {
      this.updateLicense(lic, { cancel_at_period_end: 1, auto_renew: 0 },
        { actor, action: 'subscription_cancelled', details: { atPeriodEnd, endsAt: iso(validUntil(lic)), reason } });
    } else {
      this.updateLicense(lic, { status: 'cancelled', cancelled_at: this.now(), auto_renew: 0, status_reason: reason },
        { actor, action: 'subscription_cancelled', details: { atPeriodEnd, reason } });
    }
  }

  replaceKey(lic, actor, action, details) {
    const k = this.newKeyFields();
    this.updateLicense(lic, { key_hash: k.hash, key_pepper_id: k.pepperId, key_last4: k.last4 },
      { actor, action, details: { ...details, previousKeyLast4: lic.key_last4, keyLast4: k.last4 } });
    return k.key;
  }

  opReplaceKey(lic, body, actor) {
    const reason = reasonField(body);
    return { key: this.replaceKey(lic, actor, 'license_key_replaced', { reason }) };
  }

  opRecover(lic, body, actor) {
    const reason = reasonField(body);
    const ids = Array.isArray(body.activationIds) ? body.activationIds : [];
    const active = this.db.prepare("SELECT * FROM activations WHERE license_id = ? AND status = 'active'").all(lic.id);
    const targets = ids.length ? active.filter((a) => ids.includes(a.id)) : active;
    if (ids.length && targets.length !== ids.length) throw notFound('a selected device is not an active device of this license', 'activation_not_found');
    for (const a of targets) this.releaseActivation(a, 'lost_device');
    const details = { reason, releasedDevices: targets.map((a) => a.device_name || a.id), replaceKey: !!body.replaceKey };
    if (body.replaceKey) {
      return { key: this.replaceKey(lic, actor, 'license_recovered', details), released: targets.length };
    }
    this.touchLicense(lic, { actor, action: 'license_recovered', details });
    return { released: targets.length };
  }

  opReleaseAll(lic, body, actor) {
    const reason = reasonField(body);
    const active = this.db.prepare("SELECT * FROM activations WHERE license_id = ? AND status = 'active'").all(lic.id);
    for (const a of active) this.releaseActivation(a, 'release_all');
    this.touchLicense(lic, { actor, action: 'devices_released', details: { reason, released: active.length } });
    return { released: active.length };
  }

  adminReleaseActivation(activationId, body, client) {
    const reason = reasonField(body);
    const kind = body?.assisted ? 'assisted_transfer' : 'admin_release';
    const actor = actorOf(body, client);
    return transaction(this.db, () => {
      const a = this.db.prepare('SELECT * FROM activations WHERE id = ?').get(activationId);
      if (!a) throw notFound('device activation not found', 'activation_not_found');
      if (a.status !== 'active') throw conflict('this device is already released', 'invalid_state');
      this.releaseActivation(a, kind);
      const lic = this.db.prepare('SELECT * FROM licenses WHERE id = ?').get(a.license_id);
      this.touchLicense(lic, {
        actor, action: 'device_released', activationId: a.id,
        details: { reason, kind, deviceName: a.device_name },
      });
      return {
        activation: this.activationView(this.db.prepare('SELECT * FROM activations WHERE id = ?').get(a.id), lic),
        ...this.getLicenseDetail(lic.id),
      };
    });
  }

  // -------------------------------------------------------- public (apps)

  auditFailure(ip, details, lic = null) {
    transaction(this.db, () => appendAudit(this.db, {
      at: this.now(), actor: { type: 'device' }, action: 'activation_failed', license: lic, ip, details,
    }));
  }

  checkUsable(lic, now) {
    const state = licenseState(lic, now, 0);
    const messages = {
      revoked: ['license_revoked', 'This license has been revoked'],
      suspended: ['license_suspended', 'This license is suspended; contact support'],
      cancelled: ['license_cancelled', 'This subscription has been cancelled'],
      expired: ['license_expired', 'This license has expired'],
    };
    if (messages[state]) {
      const [code, message] = messages[state];
      throw new ApiError(403, code, message, { status: state });
    }
  }

  deviceFields(body) {
    const deviceId = str(body, 'deviceId', { required: true, min: 8, max: 256 });
    return {
      hash: deviceHash(deviceId),
      name: str(body, 'deviceName', { max: 200 }),
      os: str(body, 'os', { max: 100 }),
      appVersion: str(body, 'appVersion', { max: 50 }),
    };
  }

  createActivation(lic, dev) {
    const now = this.now();
    const secret = randomBytes(32).toString('base64url');
    const id = randomUUID();
    this.db.prepare(`INSERT INTO activations(id, license_id, product_id, device_hash, device_name, os, app_version,
        secret_hash, status, activated_at, last_seen_at, rev) VALUES (?,?,?,?,?,?,?,?,'active',?,?,?)`)
      .run(id, lic.id, lic.product_id, dev.hash, dev.name, dev.os, dev.appVersion, sha256(secret), now, now, nextRev(this.db));
    return { activation: this.db.prepare('SELECT * FROM activations WHERE id = ?').get(id), secret };
  }

  activationResponse(lic, activation, secret) {
    const app = this.db.prepare('SELECT * FROM applications WHERE product_id = ?').get(lic.product_id);
    return {
      activationId: activation.id,
      activationSecret: secret,
      certificate: this.certificate(lic, activation, app),
      license: this.publicLicenseView(lic),
    };
  }

  activate(body, ip) {
    const productId = str(body, 'productId', { required: true, max: 64 });
    const dev = this.deviceFields(body);
    const normalized = normalizeLicenseKey(body?.licenseKey);
    if (!normalized) {
      this.auditFailure(ip, { reason: 'malformed_key', productId });
      throw new ApiError(400, 'invalid_key', 'This license key is not valid. Check it for typing mistakes.');
    }
    const found = this.findByKey(normalized);
    if (!found) {
      this.auditFailure(ip, { reason: 'unknown_key', productId, keyLast4: licenseKeyLast4(normalized) });
      throw new ApiError(404, 'invalid_key', 'This license key is not valid. Check it for typing mistakes.');
    }
    if (found.product_id !== productId) {
      this.auditFailure(ip, { reason: 'wrong_product', productId }, found);
      throw forbidden('This license key is for a different application', 'wrong_product');
    }
    const now = this.now();
    try {
      this.checkUsable(found, now);
    } catch (err) {
      this.auditFailure(ip, { reason: err.code }, found);
      throw err;
    }
    let failure = null;
    const result = transaction(this.db, () => {
      const lic = this.db.prepare('SELECT * FROM licenses WHERE id = ?').get(found.id);
      // Activating again on the same computer (for example after a
      // reinstall) reuses its activation instead of taking another slot.
      const same = this.db.prepare("SELECT * FROM activations WHERE license_id = ? AND device_hash = ? AND status = 'active'")
        .get(lic.id, dev.hash);
      if (same) {
        const secret = randomBytes(32).toString('base64url');
        this.db.prepare('UPDATE activations SET secret_hash = ?, last_seen_at = ?, device_name = COALESCE(?, device_name), os = COALESCE(?, os), app_version = COALESCE(?, app_version), rev = ? WHERE id = ?')
          .run(sha256(secret), now, dev.name, dev.os, dev.appVersion, nextRev(this.db), same.id);
        this.touchLicense(lic, { actor: { type: 'device' }, action: 'reactivated_same_device', activationId: same.id, ip, details: { deviceName: dev.name } });
        return this.activationResponse(lic, this.db.prepare('SELECT * FROM activations WHERE id = ?').get(same.id), secret);
      }
      if (lic.type === 'trial') {
        const used = this.db.prepare('SELECT license_id FROM trials WHERE product_id = ? AND device_hash = ?').get(lic.product_id, dev.hash);
        if (used && used.license_id !== lic.id) {
          failure = { action: 'trial_denied', lic, err: forbidden('A trial of this application was already used on this computer', 'trial_denied') };
          return null;
        }
      }
      if (this.activeCount(lic.id) >= lic.max_devices) {
        failure = {
          action: 'activation_failed', lic, reason: 'device_limit',
          err: conflict('Device limit reached: release a computer in the application or contact support', 'device_limit_reached'),
        };
        return null;
      }
      const { activation, secret } = this.createActivation(lic, dev);
      if (lic.type === 'trial') {
        this.db.prepare('INSERT OR IGNORE INTO trials(product_id, device_hash, license_id, started_at) VALUES (?,?,?,?)')
          .run(lic.product_id, dev.hash, lic.id, now);
      }
      const updated = this.touchLicense(lic, {
        actor: { type: 'device' }, action: 'activated', activationId: activation.id, ip,
        details: { deviceName: dev.name, os: dev.os, appVersion: dev.appVersion },
      });
      return this.activationResponse(updated, activation, secret);
    });
    if (failure) {
      transaction(this.db, () => appendAudit(this.db, {
        at: now, actor: { type: 'device' }, action: failure.action, license: failure.lic, ip,
        details: { reason: failure.reason || failure.err.code, deviceName: dev.name },
      }));
      throw failure.err;
    }
    return result;
  }

  findActivation(body) {
    const id = str(body, 'activationId', { required: true, max: 64 });
    const secret = str(body, 'activationSecret', { required: true, max: 128 });
    const a = this.db.prepare('SELECT * FROM activations WHERE id = ?').get(id);
    const given = Buffer.from(sha256(secret));
    if (!a || !timingSafeEqual(given, Buffer.from(a.secret_hash))) {
      throw new ApiError(401, 'invalid_activation', 'This activation is not known to the license server');
    }
    return a;
  }

  refresh(body, ip) {
    const a = this.findActivation(body);
    if (a.status !== 'active') {
      throw new ApiError(410, 'activation_released', 'This computer is no longer activated for this license', { releaseKind: a.release_kind });
    }
    const lic = this.db.prepare('SELECT * FROM licenses WHERE id = ?').get(a.license_id);
    this.checkUsable(lic, this.now());
    const appVersion = str(body, 'appVersion', { max: 50 });
    return transaction(this.db, () => {
      this.db.prepare('UPDATE activations SET last_seen_at = ?, app_version = COALESCE(?, app_version), rev = ? WHERE id = ?')
        .run(this.now(), appVersion, nextRev(this.db), a.id);
      const fresh = this.db.prepare('SELECT * FROM activations WHERE id = ?').get(a.id);
      const app = this.db.prepare('SELECT * FROM applications WHERE product_id = ?').get(lic.product_id);
      void ip;
      return { certificate: this.certificate(lic, fresh, app), license: this.publicLicenseView(lic) };
    });
  }

  // "Transfer to another computer": the customer releases this computer so
  // the same key can be activated on the new one.
  selfRelease(body, ip) {
    const a = this.findActivation(body);
    if (a.status !== 'active') {
      throw new ApiError(410, 'activation_released', 'This computer is no longer activated for this license');
    }
    return transaction(this.db, () => {
      const lic = this.db.prepare('SELECT * FROM licenses WHERE id = ?').get(a.license_id);
      const terms = termsOf(lic);
      const now = this.now();
      const used = this.transfersUsed(lic.id, now);
      if (terms.transferPolicy === 'not_transferable') {
        throw forbidden('This license is not transferable', 'transfer_not_allowed');
      }
      if (terms.transferPolicy === 'support_only') {
        throw forbidden('Transfers of this license are done by support: contact the vendor', 'transfer_not_allowed');
      }
      if (terms.transferPolicy === 'limited_per_year' && used >= terms.transfersPerYear) {
        throw conflict('Transfer limit reached for this year: contact support', 'transfer_limit_reached');
      }
      this.releaseActivation(a, 'self_transfer');
      this.db.prepare('INSERT INTO transfers(license_id, at) VALUES (?, ?)').run(lic.id, now);
      this.touchLicense(lic, {
        actor: { type: 'device' }, action: 'device_released', activationId: a.id, ip,
        details: { kind: 'self_transfer', deviceName: a.device_name },
      });
      const remaining = terms.transferPolicy === 'limited_per_year' ? terms.transfersPerYear - used - 1 : null;
      return { released: true, transfersRemaining: remaining };
    });
  }

  startTrial(body, ip) {
    const productId = str(body, 'productId', { required: true, max: 64 });
    const planCode = str(body, 'planCode', { max: 64 });
    const dev = this.deviceFields(body);
    const app = this.db.prepare("SELECT * FROM applications WHERE product_id = ? AND status = 'active'").get(productId);
    const plan = app && (planCode
      ? this.db.prepare("SELECT * FROM plans WHERE product_id = ? AND code = ? AND type = 'trial' AND status = 'active'").get(productId, planCode)
      : this.db.prepare("SELECT * FROM plans WHERE product_id = ? AND type = 'trial' AND status = 'active' ORDER BY code LIMIT 1").get(productId));
    if (!plan) throw notFound('This application has no trial', 'no_trial');
    const now = this.now();
    let denied = false;
    const result = transaction(this.db, () => {
      if (this.db.prepare('SELECT 1 FROM trials WHERE product_id = ? AND device_hash = ?').get(productId, dev.hash)) {
        denied = true;
        return null;
      }
      const { lic } = this.insertLicense(plan, { grantReason: 'self-service trial' });
      appendAudit(this.db, {
        at: now, actor: { type: 'device' }, action: 'license_issued', license: lic, ip,
        details: { planCode: plan.code, trial: true, keyLast4: lic.key_last4 },
      });
      const { activation, secret } = this.createActivation(lic, dev);
      this.db.prepare('INSERT INTO trials(product_id, device_hash, license_id, started_at) VALUES (?,?,?,?)')
        .run(productId, dev.hash, lic.id, now);
      const updated = this.touchLicense(lic, {
        actor: { type: 'device' }, action: 'trial_started', activationId: activation.id, ip,
        details: { deviceName: dev.name, os: dev.os, appVersion: dev.appVersion },
      });
      return this.activationResponse(updated, activation, secret);
    });
    if (denied) {
      transaction(this.db, () => appendAudit(this.db, {
        at: now, actor: { type: 'device' }, action: 'trial_denied', productId, ip, details: { deviceName: dev.name },
      }));
      throw forbidden('A trial of this application was already used on this computer', 'trial_denied');
    }
    return result;
  }

  // -------------------------------------------------------- sync & status

  changes({ since = 0, auditSince = 0, limit = 500 }) {
    const lim = Math.min(Math.max(Number(limit) || 500, 1), 2000);
    const s = Number(since) || 0;
    const as = Number(auditSince) || 0;
    const now = this.now();
    const licenses = this.db.prepare('SELECT * FROM licenses WHERE rev > ? ORDER BY rev LIMIT ?').all(s, lim);
    const activations = this.db.prepare('SELECT * FROM activations WHERE rev > ? ORDER BY rev LIMIT ?').all(s, lim);
    const audit = this.db.prepare('SELECT * FROM audit WHERE seq > ? ORDER BY seq LIMIT ?').all(as, lim);
    // The next cursor may only move past revisions both lists have covered.
    const currentRev = Number(getMeta(this.db, 'rev'));
    const licDone = licenses.length < lim;
    const actDone = activations.length < lim;
    let nextSince = currentRev;
    if (!licDone || !actDone) {
      nextSince = Math.min(
        licDone ? currentRev : licenses[licenses.length - 1].rev,
        actDone ? currentRev : activations[activations.length - 1].rev,
      );
    }
    return {
      instanceId: getMeta(this.db, 'instance_id'),
      generation: Number(getMeta(this.db, 'generation')),
      serverTime: iso(now),
      licenses: licenses.filter((l) => l.rev <= nextSince).map((l) => this.licenseView(l, now)),
      activations: activations.filter((a) => a.rev <= nextSince).map((a) => this.activationView(a)),
      audit: audit.map((r) => this.auditView(r)),
      nextSince,
      nextAuditSince: audit.length ? audit[audit.length - 1].seq : as,
      more: !licDone || !actDone || audit.length === lim,
    };
  }

  auditFor(idOrRef) {
    const lic = this.getLicenseRow(idOrRef);
    return this.db.prepare('SELECT * FROM audit WHERE license_id = ? ORDER BY seq').all(lic.id).map((r) => this.auditView(r));
  }

  auditStatus({ fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && this.auditCache && now - this.auditCache.at < 60_000) return this.auditCache.result;
    const result = verifyAuditChain(this.db);
    this.auditCache = { at: now, result };
    if (!result.intact) this.log('error', 'audit chain broken', result);
    return result;
  }

  status({ fresh = false } = {}) {
    const audit = this.auditStatus({ fresh });
    const count = (sql) => this.db.prepare(sql).get().n;
    return {
      status: 'ok',
      auditChain: audit.intact ? 'intact' : 'broken',
      auditEntries: audit.entries,
      auditProblem: audit.intact ? null : audit.reason,
      signingKid: this.signing.kid,
      trustedKids: this.keyringKids,
      instanceId: getMeta(this.db, 'instance_id'),
      generation: Number(getMeta(this.db, 'generation')),
      serverTime: iso(this.now()),
      counts: {
        applications: count('SELECT COUNT(*) AS n FROM applications'),
        plans: count('SELECT COUNT(*) AS n FROM plans'),
        licenses: count('SELECT COUNT(*) AS n FROM licenses'),
        activeDevices: count("SELECT COUNT(*) AS n FROM activations WHERE status = 'active'"),
      },
    };
  }
}
