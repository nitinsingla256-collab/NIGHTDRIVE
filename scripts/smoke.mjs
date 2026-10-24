#!/usr/bin/env node
/**
 * NIGHTDRIVE — engine smoke test.
 *
 * Runs `engine/script.js` inside a deliberately small DOM stub so that the
 * whole boot path executes: platform detection, asset loading, layer
 * population, the rAF blend loop, HUD, battery fallback and weather fallback.
 *
 * This exists because a top-level `ReferenceError` (calling `logToHost()`
 * before `PLATFORM` was initialised) used to abort the script before a single
 * scene was ever drawn — the wallpaper then silently showed only its CSS
 * gradient placeholder. A syntax check cannot catch that; executing can.
 *
 * No dependencies: the sandbox is hand-written so `npm test` stays zero-install.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeClassList() {
  const set = new Set();
  return {
    add(...names) { names.forEach((n) => set.add(n)); },
    remove(...names) { names.forEach((n) => set.delete(n)); },
    contains(name) { return set.has(name); },
    toggle(name, force) {
      const on = force === undefined ? !set.has(name) : !!force;
      if (on) set.add(name); else set.delete(name);
      return on;
    },
    _set: set
  };
}

function makeElement(tagName = 'div', opts = {}) {
  const listeners = new Map();
  const el = {
    tagName: tagName.toUpperCase(),
    nodeType: 1,
    style: {
      _props: {},
      setProperty(name, value) { this._props[name] = String(value); },
      getPropertyValue(name) { return this._props[name] || ''; },
      removeProperty(name) { delete this._props[name]; },
      removeProperty_: undefined
    },
    dataset: {},
    attributes: {},
    classList: makeClassList(),
    children: [],
    innerHTML: '',
    textContent: '',
    value: '',
    offsetWidth: 100,
    offsetHeight: 100,
    clientWidth: 1920,
    clientHeight: 1080,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    dispatch(type, event = {}) {
      (listeners.get(type) || []).forEach((fn) => fn(event));
    },
    _listeners: listeners,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
    removeAttribute(name) { delete this.attributes[name]; },
    hasAttribute(name) { return name in this.attributes; },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; },
    remove() {},
    focus() {},
    blur() {},
    click() { this.dispatch('click'); },
    querySelector() { return makeElement('div'); },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { width: 1920, height: 1080, left: 0, top: 0, right: 1920, bottom: 1080 }; },
    getContext() {
      if (opts.noCanvas) return null;
      return {
        canvas: el,
        fillStyle: '', globalAlpha: 1,
        clearRect() {}, beginPath() {}, arc() {}, fill() {}, closePath() {},
        drawImage() {}, fillRect() {}, save() {}, restore() {}, scale() {}, translate() {},
        setTransform() {}, resetTransform() {}
      };
    },
    toDataURL() { return 'data:,'; }
  };
  return el;
}

/**
 * Boot the engine. Returns a promise resolving to a report:
 *   { ok, errors: [...], hudText, sceneSrcs, layerCount }
 */
export async function runEngineSmoke({
  frames = 3,
  settleMs = 60,
  plateSize = [1376, 768],
  viewport = [1920, 1080],
  availablePaths = null,  // null = everything resolves; array = allowlist
  // Fixed wall-clock time (local) so results never depend on when the suite
  // runs. 10:00 is solidly inside the "day" period, so no blend window is open
  // and both layers hold the same period unless a test says otherwise.
  clock = [10, 0]
} = {}) {
  const source = readFileSync(join(root, 'engine/script.js'), 'utf8');
  const errors = [];
  const consoleErrors = [];

  const recordError = (message, stack) => errors.push({ message, stack });

  // ── Elements the script reaches for by id ────────────────────────────────
  const byId = new Map();
  const getId = (id) => {
    if (!byId.has(id)) byId.set(id, makeElement('div'));
    return byId.get(id);
  };

  // ── The two scene layers, with their five children each ──────────────────
  const layerChildren = ['scene-fallback', 'svg-scene', 'scene-img', 'svg-headlights', 'headlight-img', 'car-img'];
  const makeLayer = (name) => {
    const layer = makeElement('div');
    layer.setAttribute('data-layer', name);
    const kids = new Map();
    for (const cls of layerChildren) {
      const child = makeElement('div');
      child.classList.add(cls);
      if (cls === 'scene-img' || cls === 'headlight-img' || cls === 'car-img') {
        child.tagName = 'IMG';
        // Real browsers report intrinsic size; default to 16:9 so the
        // landscape path is what the stub exercises.
        child.naturalWidth = plateSize[0];
        child.naturalHeight = plateSize[1];
        child.complete = true;
      }
      kids.set('.' + cls, child);
    }
    const inner = layer.querySelector;
    layer.querySelector = (sel) => {
      if (kids.has(sel)) return kids.get(sel);
      return inner.call(layer, sel);
    };
    layer._kids = kids;
    return layer;
  };
  const layerA = makeLayer('a');
  const layerB = makeLayer('b');

  const document = {
    documentElement: makeElement('html'),
    body: makeElement('body'),
    readyState: 'complete',
    hidden: false,
    getElementById: (id) => getId(id),
    querySelector(sel) {
      if (sel === '[data-layer="a"]') return layerA;
      if (sel === '[data-layer="b"]') return layerB;
      return makeElement('div');
    },
    querySelectorAll() { return []; },
    createElement(tag) { return makeElement(tag); },
    createTextNode(t) { return { nodeType: 3, textContent: t }; },
    addEventListener() {},
    removeEventListener() {}
  };

  // ── Image loading: succeed asynchronously so asset promises resolve ──────
  const isAvailable = (src) => !availablePaths || availablePaths.some((a) => src.endsWith(a));

  class FakeImage {
    constructor() {
      this.onload = null; this.onerror = null; this._src = '';
      this.naturalWidth = plateSize[0];
      this.naturalHeight = plateSize[1];
    }
    set src(value) {
      this._src = value;
      setImmediate(() => {
        if (!isAvailable(value)) { if (this.onerror) this.onerror(); return; }
        this.naturalWidth = plateSize[0];
        this.naturalHeight = plateSize[1];
        if (this.onload) this.onload();
      });
    }
    get src() { return this._src; }
    decode() { return Promise.resolve(); }
  }

  class FakeXHR {
    constructor() { this.status = 404; this.responseText = ''; this.timeout = 0; this._src = ''; }
    open(_m, url) { this._src = url; }
    send() {
      this.status = isAvailable(this._src) ? 200 : 404;
      setImmediate(() => { if (this.onload) this.onload(); });
    }
    addEventListener() {}
  }

  const rafQueue = [];
  const requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
  const cancelAnimationFrame = () => {};

  const timers = [];
  const setTimeoutStub = (fn) => { timers.push(fn); return timers.length; };
  const setIntervalStub = () => 0;
  const clearTimeoutStub = () => {};

  const windowStub = {
    innerWidth: viewport[0],
    innerHeight: viewport[1],
    devicePixelRatio: 2,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {}, removeEventListener() {} }),
    requestAnimationFrame,
    cancelAnimationFrame,
    setTimeout: setTimeoutStub,
    clearTimeout: clearTimeoutStub,
    setInterval: setIntervalStub,
    clearInterval: () => {},
    isSecureContext: false,
    location: { href: 'http://localhost:8080/index.html', origin: 'http://localhost:8080', protocol: 'http:' },
    fetch: () => Promise.reject(new Error('offline in smoke test')),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    Image: FakeImage,
    XMLHttpRequest: FakeXHR
  };

  const navigatorStub = {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) SmokeTest',
    platform: 'Linux x86_64',
    maxTouchPoints: 0,
    onLine: true,
    language: 'en-GB'
    // No geolocation, no getBattery — exercises the honest fallbacks.
  };

  // Pin the clock. PERIODS is keyed on local wall-clock minutes, so without
  // this the suite changes behaviour as the day rolls through blend windows.
  class FixedDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(2000, 0, 1, clock[0], clock[1], 0, 0);
      else super(...args);
    }
    static now() { return new Date(2000, 0, 1, clock[0], clock[1], 0, 0).getTime(); }
  }

  const sandbox = {
    document,
    navigator: navigatorStub,
    location: windowStub.location,
    console: {
      log() {},
      warn() {},
      error(...args) { consoleErrors.push(args.join(' ')); }
    },
    requestAnimationFrame,
    cancelAnimationFrame,
    setTimeout: setTimeoutStub,
    clearTimeout: clearTimeoutStub,
    setInterval: setIntervalStub,
    clearInterval: () => {},
    fetch: windowStub.fetch,
    Image: FakeImage,
    XMLHttpRequest: FakeXHR,
    matchMedia: windowStub.matchMedia,
    getComputedStyle: windowStub.getComputedStyle,
    URL,
    Date: FixedDate,
    Math,
    JSON,
    Promise,
    Map,
    Set,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    parseInt,
    parseFloat,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
    innerWidth: viewport[0],
    innerHeight: viewport[1],
    devicePixelRatio: 2,
    isSecureContext: false
  };
  sandbox.window = windowStub;
  sandbox.globalThis = sandbox;
  sandbox.self = windowStub;

  const context = vm.createContext(sandbox);

  try {
    vm.runInContext(source, context, { filename: 'engine/script.js' });
  } catch (e) {
    recordError(e.message, e.stack);
    return { ok: false, errors, consoleErrors, hudText: '', sceneSrcs: [], framesRun: 0 };
  }

  // Let asset promises and the boot chain settle.
  await new Promise((resolve) => setTimeout(resolve, settleMs));

  // Run a few animation frames so the blend loop executes.
  let framesRun = 0;
  for (let i = 0; i < frames; i++) {
    const cbs = rafQueue.splice(0, rafQueue.length);
    for (const cb of cbs) {
      try { cb(16 * (i + 1)); framesRun++; } catch (e) { recordError(e.message, e.stack); }
    }
    // rAF callbacks re-register themselves; give them a tick.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  // Drain any startup timers (ignition visuals etc.).
  for (const fn of timers) {
    try { fn(); } catch (e) { recordError(e.message, e.stack); }
  }

  const sceneSrcs = [layerA, layerB]
    .map((layer) => layer._kids.get('.scene-img').getAttribute('src') || layer._kids.get('.scene-img').src)
    .filter(Boolean);

  const layerStyle = (layer) => ({
    src: layer._kids.get('.scene-img').getAttribute('src') || layer._kids.get('.scene-img').src || '',
    focus: layer.style.getPropertyValue('--focus'),
    plateUrl: layer.style.getPropertyValue('--plate-url'),
    contain: layer.classList.contains('layer--contain'),
    imgContain: layer._kids.get('.scene-img').classList.contains('scene-img--contain'),
    carSrc: layer._kids.get('.car-img').getAttribute('src') || layer._kids.get('.car-img').src || '',
    hasCar: layer.classList.contains('layer--has-car')
  });

  return {
    ok: errors.length === 0,
    errors,
    consoleErrors,
    hudText: getId('hud-time').textContent,
    hudDate: getId('hud-date').textContent,
    sceneSrcs,
    framesRun,
    layerCount: 2,
    layers: [layerStyle(layerA), layerStyle(layerB)]
  };
}

// Allow `node scripts/smoke.mjs` for a quick manual run.
if (process.argv[1] && process.argv[1].endsWith('smoke.mjs')) {
  const report = await runEngineSmoke();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
