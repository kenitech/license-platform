#!/usr/bin/env node
// Database backups.
//   node bin/backup.js create            copy the live database into LMP_BACKUP_DIR (hourly timer)
//   node bin/backup.js verify <file>     check a backup; prints "ok": true when usable
//   node bin/backup.js restore <file>    replace the database (stop the server first)
//   node bin/backup.js list              list backups, newest last
import { loadConfig } from '../src/config.js';
import { createBackup, listBackups, restoreBackup, verifyBackup } from '../src/backup.js';

const [command, file] = process.argv.slice(2);
const print = (obj) => console.log(JSON.stringify(obj, null, 2));

try {
  const config = loadConfig(process.env);
  if (command === 'create') {
    print(createBackup({ dbFile: config.dbFile, backupDir: config.backupDir, keep: config.backupKeep }));
  } else if (command === 'verify' && file) {
    const r = verifyBackup(file);
    print(r);
    process.exit(r.ok ? 0 : 1);
  } else if (command === 'restore' && file) {
    print(restoreBackup({ dbFile: config.dbFile, backupFile: file }));
    console.error('restored. start the server, then in EspoCRM open Administration > License Manager and click Run Sync Now');
  } else if (command === 'list') {
    for (const f of listBackups(config.backupDir)) console.log(f);
  } else {
    process.stderr.write('usage: node bin/backup.js create | verify <file> | restore <file> | list\n');
    process.exit(2);
  }
} catch (err) {
  print({ ok: false, error: err.message });
  process.exit(1);
}
