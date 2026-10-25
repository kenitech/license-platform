import { randomBytes, createHmac } from 'node:crypto';
import { CROCKFORD, crockfordNormalize } from './encoding.js';

// A license key is 25 Crockford base32 characters in five groups of five:
// 24 random characters (120 bits) and one check character that catches typos
// before the key is sent anywhere. Example: 7KQ2M-X9D4F-0RTVA-B3HZC-8NW5P
const KEY_RANDOM_CHARS = 24;

function randomChars(count) {
  const out = [];
  while (out.length < count) {
    for (const byte of randomBytes(count * 2)) {
      // 256 is a multiple of 32, so masking keeps the distribution uniform.
      out.push(CROCKFORD[byte & 31]);
      if (out.length === count) break;
    }
  }
  return out.join('');
}

function checkChar(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    sum = (sum + CROCKFORD.indexOf(body[i]) * (i + 1)) % 32;
  }
  return CROCKFORD[sum];
}

function group(text, size = 5) {
  return text.match(new RegExp(`.{1,${size}}`, 'g')).join('-');
}

export function generateLicenseKey() {
  const body = randomChars(KEY_RANDOM_CHARS);
  return group(body + checkChar(body));
}

// Returns the canonical 25-character form, or null when the text is not a
// well-formed key (wrong length, bad characters or wrong check character).
export function normalizeLicenseKey(text) {
  if (typeof text !== 'string') return null;
  const raw = crockfordNormalize(text);
  if (raw.length !== KEY_RANDOM_CHARS + 1) return null;
  for (const ch of raw) if (!CROCKFORD.includes(ch)) return null;
  const body = raw.slice(0, KEY_RANDOM_CHARS);
  if (checkChar(body) !== raw[KEY_RANDOM_CHARS]) return null;
  return raw;
}

export function formatLicenseKey(normalized) {
  return group(normalized);
}

export function licenseKeyLast4(normalized) {
  return normalized.slice(-4);
}

// Keys are never stored. The server keeps HMAC-SHA256(pepper, key) so a copy
// of the database alone cannot be used to recover or test keys.
export function hashLicenseKey(normalized, pepper) {
  return createHmac('sha256', pepper).update('lmp-key:' + normalized).digest('base64url');
}

// License references are public identifiers such as LIC-3KE8-WDA1-SQVX.
export function generateLicenseReference() {
  return 'LIC-' + group(randomChars(12), 4);
}
