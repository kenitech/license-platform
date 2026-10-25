import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';

export const KID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class KeyError extends Error {}

const privatePath = (dir, kid) => path.join(dir, `${kid}.key.pem`);
const publicPath = (dir, kid) => path.join(dir, `${kid}.pub.pem`);

export function generateSigningKey(dir, kid) {
  if (!KID_PATTERN.test(kid)) {
    throw new KeyError('key name may contain letters, digits, ".", "-" and "_" (for example prod-2026-10)');
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(privatePath(dir, kid))) {
    throw new KeyError(`key ${kid} already exists in ${dir}; choose a new name`);
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  // "wx" fails if the file appeared meanwhile; the mode applies at creation.
  fs.writeFileSync(privatePath(dir, kid), privatePem, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(privatePath(dir, kid), 0o600);
  fs.writeFileSync(publicPath(dir, kid), publicPem, { mode: 0o644, flag: 'wx' });
  return { kid, privateFile: privatePath(dir, kid), publicFile: publicPath(dir, kid) };
}

export function listKeys(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.pub.pem'))
    .map((f) => f.slice(0, -'.pub.pem'.length))
    .filter((kid) => KID_PATTERN.test(kid))
    .sort()
    .map((kid) => {
      const stat = fs.statSync(publicPath(dir, kid));
      return {
        kid,
        publicKey: fs.readFileSync(publicPath(dir, kid), 'utf8'),
        hasPrivateKey: fs.existsSync(privatePath(dir, kid)),
        createdAt: stat.mtime.toISOString(),
      };
    });
}

// Loads the private signing key, refusing one that other users can read:
// anyone holding it can mint licenses.
export function loadSigningKey(dir, kid, { allowInsecure = false } = {}) {
  const file = privatePath(dir, kid);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new KeyError(`signing key ${kid} not found: ${file} does not exist (create it with "node bin/keys.js generate ${kid}")`);
    }
    throw err;
  }
  if (!allowInsecure && process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new KeyError(
      `signing key ${file} is accessible by group/others (mode ${(stat.mode & 0o777).toString(8)}); ` +
      `run: chmod 600 ${file}`,
    );
  }
  const privateKey = createPrivateKey(fs.readFileSync(file, 'utf8'));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new KeyError(`signing key ${kid} is not an Ed25519 key`);
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  return { kid, privateKey, publicKey };
}

// The keyring apps embed: every public key in the directory is trusted, and
// "active" names the key new certificates are signed with.
export function buildKeyring(dir, activeKid) {
  const keys = listKeys(dir);
  if (activeKid && !keys.some((k) => k.kid === activeKid)) {
    throw new KeyError(`key ${activeKid} not found in ${dir}`);
  }
  return {
    format: 'lmp-keyring-1',
    active: activeKid || null,
    keys: keys.map((k) => ({ kid: k.kid, alg: 'Ed25519', publicKey: k.publicKey })),
  };
}

export function exportPublicKeyring(dir, activeKid, outFile = path.join(dir, 'public-keyring.json')) {
  const keyring = buildKeyring(dir, activeKid);
  fs.writeFileSync(outFile, JSON.stringify(keyring, null, 2) + '\n', { mode: 0o644 });
  fs.chmodSync(outFile, 0o644);
  return { file: outFile, keyring };
}
