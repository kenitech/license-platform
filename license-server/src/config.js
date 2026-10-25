import path from 'node:path';

export class ConfigError extends Error {}

function int(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

function bool(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new ConfigError(`${name} must be true or false (got "${raw}")`);
}

function list(env, name) {
  return (env[name] || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

// Reads the server settings from environment variables (systemd loads them
// from /etc/lmp/license-server.env). Every setting has a safe default except
// the signing key id, which must be chosen explicitly.
export function loadConfig(env = process.env) {
  const tlsMode = (env.LMP_TLS_MODE || 'direct').toLowerCase();
  if (!['direct', 'proxy'].includes(tlsMode)) {
    throw new ConfigError(`LMP_TLS_MODE must be "direct" or "proxy" (got "${env.LMP_TLS_MODE}")`);
  }
  const config = {
    host: env.LMP_LISTEN_HOST || (tlsMode === 'proxy' ? '127.0.0.1' : '0.0.0.0'),
    port: int(env, 'LMP_PORT', tlsMode === 'proxy' ? 8443 : 443, { min: 0, max: 65535 }),
    tlsMode,
    tlsCertFile: env.LMP_TLS_CERT_FILE || '',
    tlsKeyFile: env.LMP_TLS_KEY_FILE || '',
    // In proxy mode the server trusts X-Forwarded-For / X-Forwarded-Proto
    // only from these addresses.
    trustedProxies: list(env, 'LMP_TRUSTED_PROXIES').length ? list(env, 'LMP_TRUSTED_PROXIES') : ['127.0.0.1', '::1'],
    dataDir: env.LMP_DATA_DIR || '/var/lib/lmp',
    keysDir: env.LMP_KEYS_DIR || '/etc/lmp/keys',
    secretsDir: env.LMP_SECRETS_DIR || '/etc/lmp/secrets',
    backupDir: env.LMP_BACKUP_DIR || '/var/backups/lmp',
    backupKeep: int(env, 'LMP_BACKUP_KEEP', 168, { min: 1 }),
    signingKid: env.LMP_SIGNING_KID || '',
    adminAllowedIps: list(env, 'LMP_ADMIN_ALLOWED_IPS'),
    activationFailureLimit: int(env, 'LMP_ACTIVATION_FAILURE_LIMIT', 10, { min: 1 }),
    activationFailureWindow: int(env, 'LMP_ACTIVATION_FAILURE_WINDOW_SECONDS', 600, { min: 1 }),
    publicRateLimit: int(env, 'LMP_PUBLIC_RATE_LIMIT_PER_MINUTE', 120, { min: 1 }),
    logLevel: env.LMP_LOG_LEVEL || 'info',
    allowInsecureKeyFiles: bool(env, 'LMP_ALLOW_INSECURE_KEY_FILES', false),
  };
  config.dbFile = env.LMP_DB_FILE || path.join(config.dataDir, 'license.db');
  return config;
}

export function validateServerConfig(config) {
  if (!config.signingKid) {
    throw new ConfigError('LMP_SIGNING_KID is not set: choose the signing key created with "node bin/keys.js generate <name>"');
  }
  if (config.tlsMode === 'direct' && (!config.tlsCertFile || !config.tlsKeyFile)) {
    throw new ConfigError(
      'HTTPS is not configured: set LMP_TLS_CERT_FILE and LMP_TLS_KEY_FILE ' +
      '(or LMP_TLS_MODE=proxy when a TLS reverse proxy runs on the same machine)',
    );
  }
  if (!config.adminAllowedIps.length) {
    throw new ConfigError('LMP_ADMIN_ALLOWED_IPS is empty: set it to the IP address of your EspoCRM server');
  }
}
