#!/usr/bin/env node
// Project sanity checks — run by `npm test` and CI.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { runEngineSmoke } from './smoke.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const engine = join(root, 'engine');
let failures = 0;
const ok = (msg) => console.log('  ✓ ' + msg);
const fail = (msg) => { console.error('  ✗ ' + msg); failures++; };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

console.log('Engine files');
for (const f of ['index.html', 'script.js', 'styles.css', 'sw.js']) check(existsSync(join(engine, f)), f);

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
let ASSETS = null;
if (!assetsSrc) fail('ASSETS table not found');
else {
  ASSETS = vm.runInNewContext('(' + assetsSrc[1] + ')');
  console.log('Scene assets (at least one file per period)');
  for (const id of periodIds) {
    const a = ASSETS[id];
    if (!a) { fail(`${id}: missing from ASSETS`); continue; }
    const found = a.scene.find(p => existsSync(join(engine, p)));
    check(found, `${id}: ${found || 'no scene file found'}`);
  }
}

// The service worker is what makes the app work offline, so its cache name,
// its pre-cache list and the registration in index.html are all checked.
console.log('Service worker (offline support)');
const sw = readFileSync(join(engine, 'sw.js'), 'utf8');
try { new vm.Script(sw, { filename: 'sw.js' }); ok('sw.js parses'); } catch (e) { fail('sw.js syntax: ' + e.message); }
const cacheName = (sw.match(/const CACHE_NAME = '([^']+)'/) || [])[1];
check(cacheName === 'nightdrive-v1.4.0', `cache name is ${cacheName || 'missing'}`);
check(/serviceWorker/.test(html) && /register\(\s*['"]sw\.js['"]/.test(html), 'index.html registers the service worker');

const preList = sw.match(/const PRECACHE_URLS = \[([\s\S]*?)\];/);
let precached = [];
if (!preList) fail('PRECACHE_URLS not found');
else {
  precached = [...preList[1].matchAll(/'([^']+)'/g)].map(m => m[1].replace(/^\.\//, ''));
  check(precached.length > 0, `${precached.length} files pre-cached`);
  for (const f of ['index.html', 'script.js', 'styles.css']) {
    check(precached.includes(f), `pre-caches ${f}`);
  }
  // Everything the page itself loads (styles, script, ignition sound) must be
  // pre-cached, otherwise the wallpaper is only half-available offline.
  const pageRefs = [...html.matchAll(/(?:src|href)="([^"#:?]+?)(?:\?[^"]*)?"/g)].map(m => m[1]);
  const notCached = pageRefs.filter(ref => ref !== 'sw.js' && !precached.includes(ref));
  check(notCached.length === 0, notCached.length ? `referenced by index.html but not pre-cached: ${notCached.join(', ')}` : 'every file index.html loads is pre-cached');
  for (const rel of precached) check(existsSync(join(engine, rel)), `pre-cached file exists: ${rel}`);
  if (ASSETS) {
    // Every scene/headlight file that actually ships must be in the pre-cache list.
    const shipped = Object.values(ASSETS).flatMap(a => [...a.scene, ...(a.headlights || [])])
      .filter(p => existsSync(join(engine, p)));
    const missing = shipped.filter(p => !precached.includes(p));
    check(missing.length === 0, missing.length ? `not pre-cached: ${missing.join(', ')}` : 'all shipped scene/headlight files are pre-cached');
  }
}

console.log('Host configs');
const tauri = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
check(existsSync(join(root, 'src-tauri', tauri.build.distDir, 'index.html')), 'tauri distDir points at engine');
check(tauri.tauri.windows.some(w => w.label === 'main'), 'tauri window labelled "main"');
check(existsSync(join(root, 'src-tauri/build.rs')), 'src-tauri/build.rs present');
JSON.parse(readFileSync(join(engine, 'assets/manifest.json'), 'utf8')); ok('assets/manifest.json is valid JSON');

console.log('Windows host (.NET / WebView2)');
const win = join(root, 'hosts/windows/NightdriveHost');
const csprojPath = join(win, 'NightdriveHost.csproj');
check(existsSync(csprojPath), 'NightdriveHost.csproj present');
if (existsSync(csprojPath)) {
  const csproj = readFileSync(csprojPath, 'utf8');
  check(/net8\.0-windows/.test(csproj), 'targets net8.0-windows');
  check(/Microsoft\.Web\.WebView2/.test(csproj), 'references Microsoft.Web.WebView2');
  for (const f of ['App.xaml', 'App.xaml.cs', 'MainWindow.xaml', 'MainWindow.xaml.cs',
                   'BatteryHelper.cs', 'ConnectivityHelper.cs', 'TrayIconHelper.cs',
                   'WallpaperHelper.cs', 'app.manifest']) {
    check(existsSync(join(win, f)), f);
  }
  const mw = readFileSync(join(win, 'MainWindow.xaml.cs'), 'utf8');
  check(/engine/.test(mw) && /index\.html/.test(mw), 'host loads engine/index.html');
}

console.log('Scene image quality');
// A pixelated wallpaper is a bug, so the shipped plates are checked rather
// than trusted: they must be big enough for a 1080p+ display and must not be
// chroma-subsampled or heavily quantised. `night` and `midnight` once shipped
// at 0.59-0.82 bits/pixel, which is what made the night sky blocky.
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
function readJpeg(path) {
  const buf = readFileSync(path);
  let i = 2;
  let info = null;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (JPEG_SOF.has(marker)) {
      const seg = i + 4;
      info = {
        height: buf.readUInt16BE(seg + 1),
        width: buf.readUInt16BE(seg + 3),
        comps: [...Array(buf[seg + 5])].map((_, c) => {
          const hv = buf[seg + 7 + c * 3];
          return { h: hv >> 4, v: hv & 15 };
        })
      };
    }
    i += 2 + len;
  }
  if (!info) return null;
  return { ...info, bytes: buf.length, bpp: (buf.length * 8) / (info.width * info.height) };
}

const scenePeriods = ['morning', 'day', 'golden-hour', 'dusk', 'night', 'midnight'];
for (const period of scenePeriods) {
  const rel = `assets/${period}/scene.jpg`;
  const p = join(engine, rel);
  if (!existsSync(p)) { fail(`${rel} missing`); continue; }
  const j = readJpeg(p);
  if (!j) { fail(`${rel} is not a readable JPEG`); continue; }
  check(j.width >= 1280 && j.height >= 720,
    `${rel} is ${j.width}x${j.height} (>= 1280x720)`);
  const chroma = j.comps.length > 1 ? j.comps[1] : null;
  const luma = j.comps[0];
  check(!chroma || (chroma.h === luma.h && chroma.v === luma.v),
    `${rel} keeps full chroma resolution (4:4:4)`);
  check(j.bpp >= 1.0, `${rel} is ${j.bpp.toFixed(2)} bits/pixel (>= 1.0, not over-compressed)`);
}

console.log('Assets');
check(existsSync(join(engine, 'engine-start.wav')), 'engine/engine-start.wav (ignition sound)');
const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
check(/hosts\/windows\/\*\*\/bin\//.test(ignore) && /hosts\/windows\/\*\*\/obj\//.test(ignore),
      '.gitignore covers Windows host build output');

console.log('Engine boot (executed, not just parsed)');
// A top-level ReferenceError used to abort script.js before the first frame,
// leaving only the CSS gradient placeholder on screen. Only executing the
// script catches that class of bug.
try {
  const report = await runEngineSmoke();
  if (report.ok) ok('script.js boots and runs animation frames');
  else {
    fail('boot error: ' + report.errors.map((e) => e.message).join('; '));
    for (const e of report.errors) console.error('      ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n      '));
  }
  check(/\d{2}:\d{2} (AM|PM)/.test(report.hudText || ''), `clock renders (${report.hudText || 'empty'})`);
  check(/\b\d{4}\b/.test(report.hudDate || ''), 'date renders');
  check((report.sceneSrcs || []).length > 0 && report.sceneSrcs.every((s) => s.endsWith('.jpg')),
    `scene images resolved from disk (${(report.sceneSrcs || []).join(', ') || 'none'})`);
  check((report.framesRun || 0) > 0, 'animation loop runs');
} catch (e) {
  fail('smoke test crashed: ' + e.message);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
