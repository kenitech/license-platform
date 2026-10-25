// Encoding helpers shared by the server and the client SDK.

export function b64urlEncode(input) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  return buf.toString('base64url');
}

export function b64urlDecode(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new TypeError('invalid base64url');
  }
  return Buffer.from(text, 'base64url');
}

// Deterministic JSON: object keys sorted, no whitespace. Used for signatures
// and for the audit hash chain, so both sides always hash the same bytes.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('non-finite number in canonical JSON');
    }
    if (value === undefined) return 'null';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

// Crockford base32 (no I, L, O, U), used for license keys and references.
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function crockfordNormalize(text) {
  return String(text)
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}
