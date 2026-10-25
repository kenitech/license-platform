export { b64urlEncode, b64urlDecode, canonicalJson, crockfordNormalize, CROCKFORD } from './encoding.js';
export {
  generateLicenseKey,
  normalizeLicenseKey,
  formatLicenseKey,
  licenseKeyLast4,
  hashLicenseKey,
  generateLicenseReference,
} from './license-key.js';
export { signToken, verifyToken, decodeToken, TokenError, TOKEN_PREFIX } from './token.js';

import { createHash } from 'node:crypto';

// Devices are identified by a hash of the app's device id, so the server
// never stores machine identifiers. Certificates carry the same hash.
export function deviceHash(deviceId) {
  return createHash('sha256').update('lmp-dev:' + deviceId).digest('hex');
}

export const LICENSE_TYPES = ['lifetime', 'fixed_term', 'trial', 'subscription'];
export const RENEWAL_POLICIES = ['none', 'manual', 'automatic'];
export const TRANSFER_POLICIES = ['self_service', 'limited_per_year', 'support_only', 'not_transferable'];
export const DURATION_UNITS = ['days', 'months', 'years'];
export const PRODUCT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
export const PLAN_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

const DAY = 86400;

// Adds a duration to a unix time (seconds). Months and years follow the
// calendar, clamping to the last day of the month (Jan 31 + 1 month = Feb 28).
export function addDuration(unixSeconds, value, unit) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new RangeError('duration must be a non-negative integer');
  if (unit === 'days') return unixSeconds + n * DAY;
  const months = unit === 'months' ? n : unit === 'years' ? n * 12 : NaN;
  if (Number.isNaN(months)) throw new RangeError(`unknown duration unit ${unit}`);
  const d = new Date(unixSeconds * 1000);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1,
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return Math.floor(target.getTime() / 1000);
}
