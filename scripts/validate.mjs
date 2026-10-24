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

const css = readFileSync(join(engine, 'styles.css'), 'utf8');

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

// Extract the PERIODS ids and the SCENE_ASSETS table without running the DOM code.
// SCENE_ASSETS separates landscape / portrait / car layers so a future
// customisation phase can swap the car and the environment independently.
const assetsSrc = js.match(/const SCENE_ASSETS = (\{[\s\S]*?\n\});/);
const periodIds = [...js.matchAll(/^\s{4}id: '(\w+)'/gm)].map(m => m[1]);
check(periodIds.length === 6, `6 periods defined (${periodIds.join(', ')})`);
let ASSETS = null;
if (!assetsSrc) fail('SCENE_ASSETS table not found');
else {
  const sceneAssets = vm.runInNewContext('(' + assetsSrc[1] + ')');
  console.log('Scene assets (at least one landscape file per period)');
  for (const id of periodIds) {
    const a = sceneAssets[id];
    if (!a) { fail(`${id}: missing from SCENE_ASSETS`); continue; }
    const found = a.landscape.find(p => existsSync(join(engine, p)));
    check(found, `${id}: ${found || 'no scene file found'}`);
    check(Array.isArray(a.focus) && a.focus.length === 2,
      `${id}: focal point defined (${a.focus && a.focus.join(' ')})`);
  }
  // `scene` is derived from `landscape`; keep the consumers' shape stable.
  check(/scene:\s*entry\.landscape/.test(js), 'ASSETS.scene derives from landscape');
  ASSETS = Object.fromEntries(Object.entries(sceneAssets)
    .map(([id, a]) => [id, { scene: a.landscape, headlights: a.headlights }]));
}

// The service worker is what makes the app work offline, so its cache name,
// its pre-cache list and the registration in index.html are all checked.
console.log('Service worker (offline support)');
const sw = readFileSync(join(engine, 'sw.js'), 'utf8');
try { new vm.Script(sw, { filename: 'sw.js' }); ok('sw.js parses'); } catch (e) { fail('sw.js syntax: ' + e.message); }
const cacheName = (sw.match(/const CACHE_NAME = '([^']+)'/) || [])[1];
check(cacheName === 'nightdrive-v1.6.0', `cache name is ${cacheName || 'missing'}`);
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
const frames = new Set();
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
  // A landscape plate narrower than 4:3 starts to lose the car or the horizon
  // when the engine covers a 16:9 frame.
  check(j.width / j.height >= 1.33,
    `${rel} aspect ${(j.width / j.height).toFixed(2)} covers a 16:9 frame`);
  frames.add(`${j.width}x${j.height}`);
}
// Every period is stacked against its neighbour mid-crossfade, so unequal
// frame sizes would visibly shift the composition at the blend.
check(frames.size <= 1,
  `all six periods share one frame size (${[...frames.keys()].join(', ')})`);

console.log('No baked-in branding');
// The brief forbids baked-in model names, logos and watermarks. The plates
// carried a "392" badge on the grille; scripts/rebuild-assets.py retouches it
// and records measureable evidence in the manifest. A pixel heuristic is not
// reliable here: on the dusk plates the badge sits on a lit grille gradient, so
// "brighter than its surroundings" is true of clean grille too.
{
  const manifest = JSON.parse(readFileSync(join(engine, 'assets/manifest.json'), 'utf8'));
  const receipt = manifest.retouch && manifest.retouch.modelBadge;
  if (!receipt || !receipt.applied) {
    fail('model badge retouch is not recorded — plates may still carry baked-in branding');
  } else {
    ok('model badge retouch recorded in the manifest');
    const changed = receipt.meanChangePerPlate || {};
    const untouched = ['morning','day','golden-hour','dusk','night','midnight'].filter((p) => !(changed[p] > 0.5));
    check(untouched.length === 0,
      untouched.length
        ? `badge retouch had no effect on: ${untouched.join(', ')}`
        : `badge retouch changed every plate (${['morning','day','golden-hour','dusk','night','midnight'].map((p) => changed[p]).join(', ')} levels)`);
  }
  // The asset README must tell anyone replacing the plates that the shipped
  // ones were retouched, otherwise a replacement could reintroduce branding.
  check(/retouch|badge/i.test(readFileSync(join(engine, 'assets/README.md'), 'utf8')),
    'assets/README.md documents the badge retouch');
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
  check(report.layers.every((l) => /%/.test(l.focus)),
    `landscape plates use a car-aware focal crop (${report.layers.map((l) => l.focus).join(' / ')})`);
  check(report.layers.every((l) => !l.contain),
    'landscape plates cover the frame (no letterboxing)');

  // A tall plate must never be stretched or blind-cropped: the engine has to
  // switch that layer to "contain over a blurred copy of itself".
  const tall = await runEngineSmoke({ plateSize: [1080, 1920] });
  check(tall.ok, 'tall plate still boots cleanly');
  check(tall.layers.every((l) => l.contain && l.imgContain),
    'tall plate is contained, not stretched or cropped');
  check(tall.layers.every((l) => l.plateUrl.includes('url(')),
    'tall plate gets a blurred backdrop from the same frame');

  // Portrait selection: prefer a portrait plate on a tall viewport, and fall
  // back to the landscape plate (contained) when none ships.
  const landOnly = await runEngineSmoke({
    viewport: [1080, 1920], plateSize: [1080, 1920], availablePaths: ['day/scene.jpg']
  });
  check(landOnly.layers.every((l) => /scene\.jpg$/.test(l.src)),
    'portrait viewport with no portrait plate falls back to the landscape plate');
  const portFile = await runEngineSmoke({
    viewport: [1080, 1920], plateSize: [1080, 1920], availablePaths: ['day/scene-portrait.jpg']
  });
  check(portFile.layers.every((l) => /scene-portrait\.jpg$/.test(l.src)),
    'portrait viewport uses the portrait plate when one exists');
  const wide = await runEngineSmoke({ availablePaths: ['day/scene.jpg'] });
  check(wide.layers.every((l) => /scene\.jpg$/.test(l.src) && !l.contain),
    'landscape viewport keeps using the landscape plate, uncovered');

  // A 3:2 source (the aspect of the supplied art-direction reference) is a
  // legitimate landscape ratio: it must cover the frame, not be contained.
  const threeTwo = await runEngineSmoke({ plateSize: [1500, 1000], availablePaths: ['day/scene.jpg'] });
  check(threeTwo.layers.every((l) => !l.contain && !l.imgContain),
    '3:2 plate covers the frame rather than being letterboxed');
  const fourThree = await runEngineSmoke({ plateSize: [1440, 1080], availablePaths: ['day/scene.jpg'] });
  check(fourThree.layers.every((l) => !l.contain),
    '4:3 plate covers the frame');

  // Car and landscape are independently replaceable: shipping no car layer must
  // leave the plate untouched, and supplying one must composite it.
  // Crossfade windows must hold two different periods at once. 15:50 sits in
  // the 20-minute day -> goldenHour blend window, so the two layers must differ.
  const blending = await runEngineSmoke({ clock: [15, 50], availablePaths: [
    'day/scene.jpg', 'golden-hour/scene.jpg'
  ] });
  check(blending.ok, 'crossfade window boots cleanly');
  check(new Set(blending.sceneSrcs).size === 2,
    `blend window holds two different plates (${blending.sceneSrcs.join(' + ')})`);

  const noCar = await runEngineSmoke({ availablePaths: ['day/scene.jpg'] });
  check(noCar.layers.every((l) => !l.hasCar && !l.carSrc),
    'no car layer ships, so the photographic plate is used as-is');
  const withCar = await runEngineSmoke({ availablePaths: ['day/scene.jpg', 'day/car.png'] });
  check(withCar.layers.every((l) => l.hasCar && /car\.png$/.test(l.carSrc)),
    'a supplied car layer is composited over the plate independently of the scene');
  // Paint order cannot be observed without a renderer, so the declaration that
  // controls it is asserted: the car sits above the plate and under the beams.
  const carZ = Number((css.match(/\.car-img \{[^}]*?z-index:\s*(\d+)/) || [])[1]);
  const beamZ = Number((css.match(/\.headlight-img\.is-on \{[^}]*?z-index:\s*(\d+)/) || [])[1]);
  check(carZ === 1 && beamZ > carZ,
    `car layer paints above the plate and below the beams (car z ${carZ}, beams z ${beamZ})`);
} catch (e) {
  fail('smoke test crashed: ' + e.message);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
