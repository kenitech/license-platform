#!/usr/bin/env node
// Signing key management.
//   node bin/keys.js generate <name>        create a new Ed25519 signing key
//   node bin/keys.js export-public <active> write public-keyring.json (all keys trusted, <active> signs)
//   node bin/keys.js list                   show the keys in LMP_KEYS_DIR
import path from 'node:path';
import { exportPublicKeyring, generateSigningKey, KeyError, listKeys } from '../src/keys.js';

const dir = process.env.LMP_KEYS_DIR || '/etc/lmp/keys';
const [command, arg, out] = process.argv.slice(2);

function usage() {
  process.stderr.write(
    'usage:\n' +
    '  node bin/keys.js generate <name>              e.g. prod-2026-10\n' +
    '  node bin/keys.js export-public <active-name> [output-file]\n' +
    '  node bin/keys.js list\n' +
    `keys directory: ${dir} (set LMP_KEYS_DIR to change)\n`,
  );
  process.exit(2);
}

try {
  if (command === 'generate' && arg) {
    const r = generateSigningKey(dir, arg);
    console.log(`created signing key ${r.kid}`);
    console.log(`  private key: ${r.privateFile} (keep secret, mode 600)`);
    console.log(`  public key:  ${r.publicFile}`);
    console.log(`next: node bin/keys.js export-public <name of the key that should sign>`);
  } else if (command === 'export-public' && arg) {
    const r = exportPublicKeyring(dir, arg, out ? path.resolve(out) : undefined);
    console.log(`wrote ${r.file}`);
    console.log(`  trusted keys: ${r.keyring.keys.map((k) => k.kid).join(', ')}`);
    console.log(`  signing key:  ${r.keyring.active}`);
    console.log('give this file to your app developers; it contains no secrets');
  } else if (command === 'list') {
    const keys = listKeys(dir);
    if (!keys.length) console.log(`no keys in ${dir}`);
    for (const k of keys) console.log(`${k.kid}\t${k.hasPrivateKey ? 'private+public' : 'public only'}\t${k.createdAt}`);
  } else {
    usage();
  }
} catch (err) {
  if (err instanceof KeyError || err.code) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
