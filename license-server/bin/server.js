#!/usr/bin/env node
// License server entry point (run by systemd as lmp-license-server).
import { startServer } from '../src/server.js';

try {
  const { close } = await startServer(process.env);
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(JSON.stringify({ time: new Date().toISOString(), level: 'info', msg: `received ${signal}, stopping` }) + '\n');
    await close();
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
} catch (err) {
  process.stderr.write(`license server refused to start: ${err.message}\n`);
  process.exit(1);
}
