#!/usr/bin/env node
// Builds everything: checks syntax of all JavaScript, PHP and JSON, runs the
// tests, then writes
//   dist/license-platform.zip        server, SDK, deploy files and docs
//   dist/license-manager-1.0.0.zip   the EspoCRM extension
// Usage: node scripts/build.mjs [--skip-tests] [--check-only]
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const args = new Set(process.argv.slice(2));
const step = (msg) => console.log(`\n== ${msg}`);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist'].includes(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(root);
let failures = 0;

step('JavaScript syntax');
for (const f of files.filter((f) => /\.(m?js)$/.test(f))) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    failures++;
    console.error(r.stderr);
  }
}
console.log(`${files.filter((f) => /\.(m?js)$/.test(f)).length} files checked`);

step('JSON');
for (const f of files.filter((f) => f.endsWith('.json'))) {
  try {
    JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (err) {
    failures++;
    console.error(`${path.relative(root, f)}: ${err.message}`);
  }
}
console.log(`${files.filter((f) => f.endsWith('.json')).length} files checked`);

step('PHP syntax');
const phpFiles = files.filter((f) => f.endsWith('.php'));
if (spawnSync('php', ['-v']).status !== 0) {
  console.log('php not installed: skipped');
} else {
  for (const f of phpFiles) {
    const r = spawnSync('php', ['-l', f], { encoding: 'utf8' });
    if (r.status !== 0) {
      failures++;
      console.error(r.stdout + r.stderr);
    }
  }
  console.log(`${phpFiles.length} files checked`);
}

step('Shell syntax');
for (const f of files.filter((f) => f.endsWith('.sh'))) {
  if (spawnSync('sh', ['-n', f]).status !== 0) {
    failures++;
    console.error(`${path.relative(root, f)}: syntax error`);
  }
}

if (failures) {
  console.error(`\n${failures} problem(s) found`);
  process.exit(1);
}
if (args.has('--check-only')) process.exit(0);

if (!args.has('--skip-tests')) {
  step('Tests');
  const tests = fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join('test', f));
  const r = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status);
}

step('Packages');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);
const version = JSON.parse(fs.readFileSync(path.join(root, 'espocrm-extension/manifest.json'), 'utf8')).version;
const extZip = path.join(dist, `license-manager-${version}.zip`);
execFileSync('zip', ['-q', '-r', '-X', extZip, 'manifest.json', 'files', 'scripts'], { cwd: path.join(root, 'espocrm-extension') });

const stage = path.join(dist, 'stage', 'license-platform');
fs.mkdirSync(stage, { recursive: true });
for (const item of ['packages', 'license-server', 'deploy', 'docs', 'README.md']) {
  fs.cpSync(path.join(root, item), path.join(stage, item), { recursive: true });
}
fs.copyFileSync(extZip, path.join(stage, path.basename(extZip)));
const platformZip = path.join(dist, 'license-platform.zip');
execFileSync('zip', ['-q', '-r', '-X', platformZip, 'license-platform'], { cwd: path.join(dist, 'stage') });
fs.rmSync(path.join(dist, 'stage'), { recursive: true, force: true });

for (const z of [platformZip, extZip]) {
  console.log(`${path.relative(root, z)}  ${(fs.statSync(z).size / 1024).toFixed(1)} KB`);
}
console.log('\nbuild ok');
