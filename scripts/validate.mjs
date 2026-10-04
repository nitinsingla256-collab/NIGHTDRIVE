#!/usr/bin/env node
// Project sanity checks — run by `npm test` and CI.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const engine = join(root, 'engine');
let failures = 0;
const ok = (msg) => console.log('  ✓ ' + msg);
const fail = (msg) => { console.error('  ✗ ' + msg); failures++; };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

console.log('Engine files');
for (const f of ['index.html', 'script.js', 'styles.css', 'themes.css']) check(existsSync(join(engine, f)), f);

console.log('index.html references');
const html = readFileSync(join(engine, 'index.html'), 'utf8');
for (const [, ref] of html.matchAll(/(?:src|href)="([^"#:]+?)(?:\?[^"]*)?"/g)) {
  check(existsSync(join(engine, ref)), ref);
}

console.log('script.js');
const js = readFileSync(join(engine, 'script.js'), 'utf8');
try { new vm.Script(js, { filename: 'script.js' }); ok('parses'); } catch (e) { fail('syntax: ' + e.message); }

// Extract the PERIODS ids and ASSETS table without running the DOM code
const assetsSrc = js.match(/const ASSETS = (\{[\s\S]*?\n\});/);
const periodIds = [...js.matchAll(/^\s{4}id: '(\w+)'/gm)].map(m => m[1]);
check(periodIds.length === 6, `6 periods defined (${periodIds.join(', ')})`);
if (!assetsSrc) fail('ASSETS table not found');
else {
  const ASSETS = vm.runInNewContext('(' + assetsSrc[1] + ')');
  console.log('Scene assets (at least one file per period)');
  for (const id of periodIds) {
    const a = ASSETS[id];
    if (!a) { fail(`${id}: missing from ASSETS`); continue; }
    const found = a.scene.find(p => existsSync(join(engine, p)));
    check(found, `${id}: ${found || 'no scene file found'}`);
  }
}

console.log('Host configs');
const tauri = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
check(existsSync(join(root, 'src-tauri', tauri.build.distDir, 'index.html')), 'tauri distDir points at engine');
check(tauri.tauri.windows.some(w => w.label === 'main'), 'tauri window labelled "main"');
check(existsSync(join(root, 'src-tauri/build.rs')), 'src-tauri/build.rs present');
JSON.parse(readFileSync(join(engine, 'assets/manifest.json'), 'utf8')); ok('assets/manifest.json is valid JSON');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
