import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { createApp } from './app.js';
import { loadConfig, validateServerConfig } from './config.js';
import { openDatabase } from './db.js';
import { LicenseService } from './domain.js';
import { buildKeyring, loadSigningKey } from './keys.js';
import { createLogger } from './logger.js';
import { loadAdminClients, loadPeppers } from './secrets.js';

function readTls(config) {
  const cert = fs.readFileSync(config.tlsCertFile);
  const key = fs.readFileSync(config.tlsKeyFile);
  // createSecureContext throws when the key does not match the certificate.
  tls.createSecureContext({ cert, key });
  const info = new X509Certificate(cert);
  return { cert, key, info };
}


// Starts the license server and returns { server, close }. All checks run
// before the port opens, so a bad setup fails with a clear message.
export async function startServer(env = process.env, { log = createLogger(env.LMP_LOG_LEVEL), now } = {}) {
  const config = loadConfig(env);
  validateServerConfig(config);
  const signing = loadSigningKey(config.keysDir, config.signingKid, { allowInsecure: config.allowInsecureKeyFiles });
  const keyring = buildKeyring(config.keysDir, config.signingKid);
  const peppers = loadPeppers(config.secretsDir);
  let adminClients = loadAdminClients(config.secretsDir);
  const db = openDatabase(config.dbFile);
  const service = new LicenseService({ db, peppers, signing, keyringKids: keyring.keys.map((k) => k.kid), log, ...(now ? { now } : {}) });
  const handler = createApp({ config, service, adminClients, keyring, log, now });

  let server;
  let tlsState = null;
  if (config.tlsMode === 'direct') {
    tlsState = readTls(config);
    server = https.createServer({ cert: tlsState.cert, key: tlsState.key, minVersion: 'TLSv1.2' }, handler);
  } else {
    server = http.createServer(handler);
  }
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;

  // Certificate renewals: the Let's Encrypt hook runs "systemctl reload",
  // which sends SIGHUP. New connections get the new certificate and open
  // ones are not dropped. A bad pair is refused and the old one kept.
  function reloadTls(reason) {
    if (!tlsState) return;
    try {
      const next = readTls(config);
      if (next.info.fingerprint256 === tlsState.info.fingerprint256) return;
      server.setSecureContext({ cert: next.cert, key: next.key, minVersion: 'TLSv1.2' });
      tlsState = next;
      log('info', 'tls certificate reloaded', { reason, subject: next.info.subject, validTo: next.info.validTo });
    } catch (err) {
      log('error', 'tls certificate reload failed', { reason, error: err.message });
    }
  }
  function reloadClients() {
    try {
      adminClients = loadAdminClients(config.secretsDir);
      handler.setAdminClients(adminClients);
      log('info', 'admin clients reloaded', { clients: [...adminClients.keys()] });
    } catch (err) {
      log('error', 'admin clients reload failed', { error: err.message });
    }
  }
  const onHup = () => {
    reloadTls('SIGHUP');
    reloadClients();
  };
  process.on('SIGHUP', onHup);
  const certTimer = tlsState ? setInterval(() => reloadTls('file change'), 5 * 60_000) : null;
  certTimer?.unref();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  log('info', 'license server started', {
    host: config.host, port: address.port, tls: config.tlsMode, signingKid: signing.kid,
    trustedKids: keyring.keys.map((k) => k.kid), database: config.dbFile,
    certificateValidTo: tlsState?.info.validTo,
  });

  async function close() {
    process.off('SIGHUP', onHup);
    if (certTimer) clearInterval(certTimer);
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
      setTimeout(() => server.closeAllConnections?.(), 5000).unref();
    });
    db.close();
    log('info', 'license server stopped');
  }
  return { server, close, config, service, port: address.port };
}
