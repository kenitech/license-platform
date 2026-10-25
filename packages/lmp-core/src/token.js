import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { b64urlDecode, b64urlEncode, canonicalJson } from './encoding.js';

// Activation certificates are compact signed tokens:
//   lmp1.<base64url(canonical JSON payload)>.<base64url(Ed25519 signature)>
// The signature covers the text "lmp1.<payload>". The payload carries the
// signing key id (kid) so clients can pick the right key from their keyring.
export const TOKEN_PREFIX = 'lmp1';

export function signToken(payload, privateKey, kid) {
  if (!kid) throw new Error('signing key id is required');
  const body = b64urlEncode(canonicalJson({ ...payload, kid }));
  const signingInput = `${TOKEN_PREFIX}.${body}`;
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  const signature = sign(null, Buffer.from(signingInput), key);
  return `${signingInput}.${b64urlEncode(signature)}`;
}

export function decodeToken(token) {
  if (typeof token !== 'string') throw new TokenError('malformed', 'token must be a string');
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    throw new TokenError('malformed', 'not an lmp1 token');
  }
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch {
    throw new TokenError('malformed', 'payload is not valid JSON');
  }
  if (!payload || typeof payload !== 'object' || typeof payload.kid !== 'string') {
    throw new TokenError('malformed', 'payload has no kid');
  }
  return { payload, signingInput: `${parts[0]}.${parts[1]}`, signature: parts[2] };
}

// keyring: { keys: [{ kid, publicKey (SPKI PEM) }] }. Returns the payload or
// throws TokenError. Expiry and product checks are the caller's job, because
// they depend on the clock and on offline policy.
export function verifyToken(token, keyring) {
  const { payload, signingInput, signature } = decodeToken(token);
  const entry = (keyring?.keys || []).find((k) => k.kid === payload.kid);
  if (!entry) throw new TokenError('unknown_key', `signing key ${payload.kid} is not trusted`);
  let ok = false;
  try {
    ok = verify(null, Buffer.from(signingInput), createPublicKey(entry.publicKey), b64urlDecode(signature));
  } catch {
    ok = false;
  }
  if (!ok) throw new TokenError('bad_signature', 'signature does not match');
  return payload;
}

export class TokenError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
