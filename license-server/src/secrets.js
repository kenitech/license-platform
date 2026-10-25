import fs from 'node:fs';
import path from 'node:path';

export class SecretsError extends Error {}

// key-peppers: one "<id>:<base64 secret>" per line. The first line is used
// for new keys; all lines are tried when looking a key up, so a new pepper
// can be added at the top without breaking keys already sold.
export function loadPeppers(secretsDir) {
  const file = path.join(secretsDir, 'key-peppers');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new SecretsError(`cannot read ${file}: ${err.code || err.message} (see Part 1 step 5 of the guide)`);
  }
  const peppers = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z0-9_-]{1,16}):(\S+)$/.exec(line);
    if (!m) throw new SecretsError(`${file} line ${i + 1}: expected "<id>:<base64 secret>"`);
    const secret = Buffer.from(m[2], 'base64');
    if (secret.length < 16) throw new SecretsError(`${file} line ${i + 1}: pepper is shorter than 16 bytes`);
    if (peppers.some((p) => p.id === m[1])) throw new SecretsError(`${file}: pepper id ${m[1]} appears twice`);
    peppers.push({ id: m[1], secret });
  }
  if (!peppers.length) throw new SecretsError(`${file} contains no pepper`);
  return peppers;
}

// admin-clients.json: [{ "id": "espocrm", "secret": "...", "roles": ["crm"] }]
export function loadAdminClients(secretsDir) {
  const file = path.join(secretsDir, 'admin-clients.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new SecretsError(`cannot read ${file}: ${err.code || err.message}`);
  }
  if (!Array.isArray(parsed)) throw new SecretsError(`${file} must contain a JSON array`);
  const clients = new Map();
  for (const c of parsed) {
    if (!c || typeof c.id !== 'string' || typeof c.secret !== 'string' || c.secret.length < 16) {
      throw new SecretsError(`${file}: each client needs an "id" and a "secret" of at least 16 characters`);
    }
    if (clients.has(c.id)) throw new SecretsError(`${file}: client ${c.id} appears twice`);
    clients.set(c.id, { id: c.id, secret: c.secret, roles: Array.isArray(c.roles) ? c.roles : [] });
  }
  return clients;
}
