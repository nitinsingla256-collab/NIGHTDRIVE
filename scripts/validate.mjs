#!/usr/bin/env node
// Project sanity checks — run by `npm test` and CI.
import { createHash } from 'node:crypto';
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
check(cacheName === 'nightdrive-v1.7.0', `cache name is ${cacheName || 'missing'}`);
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
  check(csproj.includes('engine') && csproj.includes('RecursiveDir') && /CopyToPublishDirectory="PreserveNewest"/.test(csproj),
    'published host copies the complete engine directory');
  for (const f of ['App.xaml', 'App.xaml.cs', 'MainWindow.xaml', 'MainWindow.xaml.cs',
                   'BatteryHelper.cs', 'ConnectivityHelper.cs', 'DesktopInteraction.cs',
                   'TrayIconHelper.cs', 'WallpaperHelper.cs', 'app.manifest']) {
    check(existsSync(join(win, f)), f);
  }
  const mw = readFileSync(join(win, 'MainWindow.xaml.cs'), 'utf8');
  const desktopInteraction = readFileSync(join(win, 'DesktopInteraction.cs'), 'utf8');
  const connectivity = readFileSync(join(win, 'ConnectivityHelper.cs'), 'utf8');
  check(/engine/.test(mw) && /index\.html/.test(mw), 'host loads engine/index.html');
  check(/RegisterHotKey/.test(desktopInteraction) && /HWND_TOPMOST/.test(desktopInteraction) &&
        /RememberDesktopParent/.test(desktopInteraction),
    'desktop interaction has a hotkey, raise and sink path');
  check(/drawer:open/.test(mw) && /drawer:closed/.test(mw) && /PostDrawerMessage/.test(mw),
    'host bridges drawer open and close messages');
  check(/ProcessFailed/.test(mw) && /NavigationCompleted/.test(mw) && /WebErrorStatus/.test(mw),
    'WebView2 navigation and process diagnostics are wired');
  const domSubscription = mw.indexOf('DOMContentLoaded += OnDomContentLoaded');
  const navigateCall = mw.indexOf('CoreWebView2.Navigate');
  check(domSubscription >= 0 && navigateCall > domSubscription,
    'DOMContentLoaded subscription precedes Navigate');
  check(/drawbridge message/.test(connectivity) && /TryGetWebMessageAsString/.test(connectivity),
    'native bridge logs and parses page messages');

  // C# cannot overload methods by accessibility or extern modifier alone, and
  // UseWPF + UseWindowsForms + ImplicitUsings makes unqualified MessageBox
  // ambiguous; catch both on Linux before Windows CI runs.
  const csMethodDupes = [];
  const csAmbiguousRefs = [];
  const csFiles = ['App.xaml.cs', 'MainWindow.xaml.cs', 'BatteryHelper.cs',
                   'ConnectivityHelper.cs', 'DesktopInteraction.cs',
                   'TrayIconHelper.cs', 'WallpaperHelper.cs'];
  const methodDeclRe = /\b(?:public|private|protected|internal)\s+(?:(?:static|extern|async|override|virtual|partial|unsafe)\s+)*(?!delegate\b)[\w.<>?\[\]]+\s+(\w+)\s*\(([^)]*)\)\s*(?:;|\{|=>)/g;
  for (const f of csFiles) {
    const src = readFileSync(join(win, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const seen = new Set();
    for (const [, name, rawParams] of src.matchAll(methodDeclRe)) {
      const paramSig = rawParams.trim() === '' ? '' : rawParams.split(',').map((p) => {
        const tokens = p.replace(/\[[^\]]*\]/g, '').replace(/=.*$/, '').trim().split(/\s+/);
        return tokens.slice(0, -1).join(' ');
      }).join(',');
      const sig = `${name}(${paramSig})`;
      if (seen.has(sig)) csMethodDupes.push(`${f}: ${sig}`);
      seen.add(sig);
    }
    if (/\busing\s+System\.Windows\s*;/.test(src) &&
        !/\busing\s+MessageBox\s*=/.test(src) &&
        /(?<![.\w])MessageBox\s*\./.test(src)) {
      csAmbiguousRefs.push(`${f}: unqualified MessageBox`);
    }
  }
  check(csMethodDupes.length === 0,
    csMethodDupes.length
      ? `duplicate C# method signature(s): ${csMethodDupes.join('; ')}`
      : 'no duplicate C# method signatures across Windows host');
  check(csAmbiguousRefs.length === 0,
    csAmbiguousRefs.length
      ? `ambiguous WPF/WinForms reference(s): ${csAmbiguousRefs.join('; ')}`
      : 'no ambiguous WPF/WinForms MessageBox references');
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

console.log('Depth clock data');
{
  const ridgePath = join(engine, 'assets/ridges.json');
  check(existsSync(ridgePath), 'assets/ridges.json exists');
  let ridges = null;
  try { ridges = JSON.parse(readFileSync(ridgePath, 'utf8')); }
  catch (e) { fail('ridges.json parses: ' + e.message); }
  if (ridges) {
    const ids = Object.keys(ridges);
    check(ids.length === 6, `all six periods have a measured skyline (${ids.join(', ')})`);
    let badShape = null;
    let badX = null;
    for (const id of ids) {
      const r = ridges[id];
      if (!r || !Array.isArray(r.ridge) || r.ridge.length < 8) { badShape = id; continue; }
      const xs = r.ridge.map((p) => p[0]);
      const ys = r.ridge.map((p) => p[1]);
      if (xs[0] !== 0 || Math.abs(xs[xs.length - 1] - 1) > 1e-6 || xs.some((x, i) => i && x <= xs[i - 1])) badX = id;
      if (ys.some((y) => y < 0 || y > 1)) badShape = id;
      if (!r.clock || typeof r.clock.x !== 'number' || r.clock.x < 0.1 || r.clock.x > 0.75) badShape = id;
    }
    check(!badShape, badShape ? `malformed ridge data: ${badShape}` : 'ridge data is well formed');
    check(!badX, badX ? `ridge x is not monotonic: ${badX}` : 'ridge x runs 0 -> 1 monotonically');
    // A skyline measured from an older version of a plate would cut the clock
    // at the wrong place; the hash proves the two still match.
    const stale = ids.filter((id) => {
      const file = join(engine, ridges[id].source);
      if (!existsSync(file)) return true;
      return createHash('sha1').update(readFileSync(file)).digest('hex') !== ridges[id].sourceSha1;
    });
    check(stale.length === 0,
      stale.length
        ? `ridge is stale for ${stale.join(', ')} - rerun: python3 scripts/build-ridges.py`
        : 'every skyline matches the plate it was measured from');

    // A ridge that never dips below the sky would leave the clock unoccluded.
    const spans = ids.map((id) => Math.max(...ridges[id].ridge.map((p) => p[1])));
    check(Math.max(...spans) > 0.4, `skylines reach below the clock (lowest ridge ${Math.max(...spans).toFixed(2)})`);
  }
  // The layer stack is what makes the effect work: clock above the scene,
  // foreground above the clock, HUD above the foreground.
  const z = (sel) => {
    const re = new RegExp('\\' + sel + '\\s*\\{[^}]*?z-index:\\s*(\\d+)');
    const m = css.match(re);
    return m ? Number(m[1]) : null;
  };
  const zClock = z('.clock');
  const zFg = z('.foreground');
  const zHud = z('.hud');
  check(zClock === 5 && zFg === 10 && zHud === 15,
    `clock (${zClock}) < foreground (${zFg}) < hud (${zHud})`);
  check(/\.clock \{[^}]*translate\(-50%, -70%\)/.test(css) || /translate\(-50%, -70%\)/.test(css),
    'clock box is lifted by 70 % so its foot sits behind the ridge');
}

console.log('Interface wiring (no browser required)');
{
  // There is no browser in CI, so the interface is checked structurally:
  // every control in the markup must name an action that app.js implements,
  // every id the scripts reach for must exist, and every control must be
  // reachable by keyboard and screen readers. A dead button is caught here
  // rather than by clicking it.
  const appSrc = readFileSync(join(engine, 'app.js'), 'utf8');
  const htmlSrc = readFileSync(join(engine, 'index.html'), 'utf8');

  try { new vm.Script(appSrc, { filename: 'app.js' }); ok('app.js parses'); }
  catch (e) { fail('app.js syntax: ' + e.message); }

  // Both `'x.y': function () {...}` and `'x.y': someFn` are real handlers.
  const declared = new Set([...appSrc.matchAll(/^\s*'([a-z]+\.[a-zA-Z.]+)':\s*(?:function|\w+)/gm)].map((m) => m[1]));
  const used = [...htmlSrc.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);
  const missing = [...new Set(used)].filter((a) => !declared.has(a));
  check(declared.size >= 20, `${declared.size} control actions implemented`);
  check(used.length >= 20, `${used.length} controls wired in the markup`);
  check(missing.length === 0, missing.length ? `controls with no handler: ${missing.join(', ')}` : 'every control has a handler');

  // Ids the scripts ask for must exist in the markup (or be created by script).
  const scriptIds = new Set();
  for (const src of [js, appSrc]) {
    for (const m of src.matchAll(/getElementById\('([^']+)'\)/g)) scriptIds.add(m[1]);
  }
  const htmlIds = new Set([...htmlSrc.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  // Every id either engine script reaches for must exist in the markup. The
  // file input is built by app.js, not authored, so it is named explicitly
  // rather than excusing every missing id.
  const generated = new Set(['file-input']);
  const dangling = [...scriptIds].filter((id) => !htmlIds.has(id) && !generated.has(id));
  check(dangling.length === 0, dangling.length ? `ids referenced but absent: ${dangling.join(', ')}` : `${scriptIds.size} script-referenced ids all exist`);

  // Accessibility: an icon-only control must carry a label; a control with
  // visible text, or one associated with a <label for>, is already labelled.
  const labelledByFor = new Set([...htmlSrc.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));
  const buttons = [...htmlSrc.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  const unlabelled = buttons.filter(([, attrs, inner]) => {
    if (/aria-label=|title=|aria-labelledby=/.test(attrs)) return false;
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
    if (id && labelledByFor.has(id)) return false;
    return inner.replace(/<[^>]*>/g, '').trim().length === 0;
  });
  check(unlabelled.length === 0,
    unlabelled.length
      ? `${unlabelled.length} unlabelled icon button(s): ${unlabelled.map(([, a]) => (a.match(/id="([^"]+)"/) || [, '?'])[1]).join(', ')}`
      : `all ${buttons.length} buttons are labelled`);

  check(!/\sonclick=/.test(htmlSrc), 'no inline onclick handlers (listeners live in app.js)');
  // Icon sprite: every `<use>` must resolve, including the ones swapped in at
  // runtime (the play/pause state).
  const symbols = new Set([...htmlSrc.matchAll(/<symbol[^>]*\bid="([^"]+)"/g)].map((m) => m[1]));
  const useRefs = new Set([
    ...[...htmlSrc.matchAll(/<use[^>]*href="#([^"]+)"/g)].map((m) => m[1]),
    ...[...appSrc.matchAll(/href',\s*'#([\w-]+)'/g)].map((m) => m[1])
  ]);
  const missingSymbols = [...useRefs].filter((id) => !symbols.has(id));
  check(missingSymbols.length === 0,
    missingSymbols.length ? `icons with no symbol: ${missingSymbols.join(', ')}` : `${symbols.size} symbols, every reference resolves`);
  const iconUses = [...htmlSrc.matchAll(/<svg class="ic"[^>]*>\s*<use/g)];
  check(iconUses.length >= 10, `${iconUses.length} icon buttons use the shared sprite`);

  // The UI talks to the engine through window.ND. Every method it calls must
  // exist, or a control dies with "ND.x is not a function" at click time.
  const ndBlock = js.match(/window\.ND = \{([\s\S]*?)\n\};/);
  if (!ndBlock) fail('window.ND is not defined');
  else {
    const api = new Set([...ndBlock[1].matchAll(/^\s*([A-Za-z_]\w*)\s*[:(]/gm)].map((m) => m[1]));
    const calls = new Set([...appSrc.matchAll(/\bND\.(\w+)/g)].map((m) => m[1]));
    const missingApi = [...calls].filter((n) => !api.has(n));
    check(missingApi.length === 0,
      missingApi.length ? `app.js calls missing engine API: ${missingApi.join(', ')}` : `${calls.size}/${api.size} engine APIs used, all defined`);
  }

  check(htmlIds.has('drawer-trigger') && htmlIds.has('drawer') && htmlIds.has('panel') && htmlIds.has('foreground'),
    'drawer, settings panel, clock layer and foreground occluder are present');

  // The startup sequence must not run on boot: a refresh is not an engine start.
  const bootCall = /(?<!\.)\brunCinematicStartup\(\)/.test(js.replace(/function runCinematicStartup/, ''));
  check(!bootCall, 'boot does not call the cinematic startup sequence');
  check(/maybeAutoStartup\(\);/.test(js), 'boot consults the saved startup preference instead');
  check(/startupEffect:\s*'manual'/.test(js), "startup effects default to 'manual'");

  // Boot order: the deferred call at the bottom of the file must come after the
  // settings store is created, or the engine throws on first paint.
  const settingsAt = js.indexOf('const SETTINGS = loadSettings()');
  const bootCallAt = js.search(/(?:^|\n)\s*boot\(\);/);
  check(settingsAt > 0 && bootCallAt > settingsAt,
    'boot runs after the settings store exists');

  // Duplicate ids silently break getElementById in ways no click test would
  // explain, so the markup is checked once here.
  const allIds = [...htmlSrc.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = allIds.filter((id, i) => allIds.indexOf(id) !== i);
  check(dupes.length === 0, dupes.length ? `duplicate ids: ${[...new Set(dupes)].join(', ')}` : `${allIds.length} ids, all unique`);
}

console.log('Engine boot (executed, not just parsed)');
// A top-level ReferenceError used to abort script.js before the first frame,
// leaving only the CSS gradient placeholder on screen. Only executing the
// script catches that class of bug.
try {
  // runUI loads app.js into the same sandbox and clicks every control, so a
  // dead button fails here rather than on someone's desktop.
  const report = await runEngineSmoke({ runUI: true });
  if (report.ok) ok('script.js boots and runs animation frames');
  else {
    fail('boot error: ' + report.errors.map((e) => e.message).join('; '));
    for (const e of report.errors) console.error('      ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n      '));
  }
  // 24-hour by default: two digits, a colon, two digits, no AM/PM suffix.
  check(/^\d{2}:\d{2}$/.test(report.hudAtBoot || ''),
    `clock renders 24-hour by default (${report.hudAtBoot || 'empty'})`);
  check(/\b\d{4}\b/.test(report.hudDate || ''), 'date renders');
  check((report.sceneSrcs || []).length > 0 && report.sceneSrcs.every((s) => s.endsWith('.jpg')),
    `scene images resolved from disk (${(report.sceneSrcs || []).join(', ') || 'none'})`);
  check((report.framesRun || 0) > 0, 'animation loop runs');

  // ── Behaviour, executed ────────────────────────────────────────────────────
  // A screenshot cannot show a 90 ms open delay, a 380 ms close grace period,
  // pinning, or whether a page load makes a noise. These run the real handlers
  // against the same stub, in a clean boot with no controls clicked first.
  const behaviourRun = await runEngineSmoke({ behaviour: true });
  const b = behaviourRun.behaviours || {};
  check(b.closedAtBoot === true, 'drawer starts closed');
  check(b.noInstantOpen === true && b.opensOnApproach === true,
    'drawer opens on approach, after its delay rather than instantly');
  check(b.noInstantClose === true && b.closesAfterGrace === true,
    'drawer closes after the grace period, not the moment the pointer leaves');
  check(b.pinnedStaysOpen === true && b.escapeCloses === true,
    'pin holds the drawer open; Escape closes it');
  check(b.keyboardOpens === true && b.keyboardCloses === true,
    'Ctrl/Cmd+B opens and closes the drawer without a mouse');
  check(b.rejectsWrongType === true && b.rejectsLargeFile === true,
    'wrong file types and oversized images are refused with a reason');

  // Startup: a reload must be silent; only an explicit start may make a sound.
  check(b.silentOnLoad === true, 'no startup sound while the wallpaper loads');
  check(b.soundOnManualStart === true, 'a deliberate Start engine still plays it');
  const reload = await runEngineSmoke({ storage: behaviourRun.storage });
  check(reload.ok, 'a reload with saved settings boots without errors');
  check(reload.audio.playCalls === 0, 'no startup sound on an ordinary reload');
  check(!!reload.settings && typeof reload.settings.clock24 === 'boolean' &&
    reload.settings.clock24 === behaviourRun.settings.clock24,
    'settings saved in one session are restored in the next');
  const quota = await runEngineSmoke({ storageThrows: true });
  check(quota.ok, 'a blocked or full localStorage does not stop the wallpaper');

  // ── Interface layer, executed ──────────────────────────────────────────────
  const ui = report.ui || {};
  check(ui.loaded === true, 'app.js runs against the real engine');
  check((ui.clicked || 0) >= 30, `${ui.clicked || 0} controls were clicked`);
  check((ui.failed || []).length === 0,
    (ui.failed || []).length
      ? 'controls threw: ' + ui.failed.map((f) => `${f.action} (${f.message})`).join(', ')
      : 'no control throws when clicked');
  check(ui.delegation && ui.delegation.changed === true,
    'a delegated click reaches the engine and changes its state');

  // Controls whose whole job is to change something must actually do it.
  const mustChange = ['clock.format', 'clock.visible', 'scene.next', 'scene.auto',
    'audio.mute', 'perf.motion', 'drawer.pin'];
  const inert = mustChange.filter((name) => !(ui.effects || {})[name]);
  check(inert.length === 0,
    inert.length ? `controls with no effect: ${inert.join(', ')}` : `all ${mustChange.length} stateful controls change state`);

  // Depth clock geometry, computed by the engine's own pure functions.
  const geo = report.geo || {};
  check(geo.polygon === 'polygon(0% 100%, 0.000% 50.000%, 100.000% 60.000%, 100% 100%)',
    'ridge polygon closes along the bottom edge');
  check(Math.abs(geo.peak - 0.5) < 1e-6, 'ridge height interpolates between sample points');
  const c = geo.cover1920 || {};
  check(c.width === 1935 && c.height === 1080 && Math.abs(c.left + 9.3) < 0.01,
    'plate rect matches object-fit: cover at 1920x1080');
  const t = geo.coverTall || {};
  check(t.width === 3440 && t.height === 1920, 'portrait window gets the cover rectangle it expects');
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
