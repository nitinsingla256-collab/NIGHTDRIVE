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
 * Load the interface layer into the same sandbox and click every control.
 *
 * The engine and the UI are separate files wired together by `window.ND` and a
 * delegated `[data-action]` handler. A typo in either half is invisible to a
 * syntax check and to the static graph check in validate.mjs; running the real
 * handler is the only thing that proves a button does something.
 */
async function loadInterface(context, recordError) {
  const source = readFileSync(join(root, 'engine/app.js'), 'utf8');
  try {
    vm.runInContext(source, context, { filename: 'engine/app.js' });
  } catch (e) {
    recordError('app.js init: ' + e.message, e.stack);
    return { source, loaded: false };
  }
  // Let the interface's own init settle (capability probe, hydrate).
  await new Promise((resolve) => setTimeout(resolve, 40));
  return { source, loaded: true };
}

async function clickEveryControl(context, recordError, source) {
  const report = { clicked: 0, failed: [], effects: {} };

  const names = [...new Set([...source.matchAll(/^\s*'([a-z]+\.[a-zA-Z.]+)':/gm)].map((m) => m[1]))];
  const snapshot = () => JSON.stringify({ s: context.window.ND.settings, st: context.window.ND.state() });
  for (const name of names) {
    const before = snapshot();
    const el = makeElement('button');
    // The delegated handler reads the attribute, not the dataset property.
    el.setAttribute('data-action', name);
    el.closest = (sel) => (sel === '[data-action]' ? el : null);
    try {
      context.document.dispatch('click', {
        target: el,
        currentTarget: context.document,
        preventDefault() {},
        stopPropagation() {}
      });
      report.clicked++;
      // Which controls provably changed something, so the test can require it
      // for the ones that must have an effect.
      report.effects[name] = snapshot() !== before;
    } catch (e) {
      report.failed.push({ action: name, message: e.message });
      recordError(`${name}: ${e.message}`, e.stack);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  // Proof the delegated handler really reached the engine, not that the click
  // vanished: toggle the format and read it back through engine state.
  const probe = makeElement('button');
  probe.setAttribute('data-action', 'clock.format');
  probe.closest = (sel) => (sel === '[data-action]' ? probe : null);
  const before = context.window.ND.state().clock24;
  context.document.dispatch('click', {
    target: probe, currentTarget: context.document,
    preventDefault() {}, stopPropagation() {}
  });
  const after = context.window.ND.state().clock24;
  report.delegation = { before, after, changed: before !== after };

  return report;
}

/**
 * Drive the interface the way a person would, against the same stub.
 *
 * These are the behaviours that only exist as timing and state: the drawer's
 * open delay, its close grace period, pinning, the keyboard route, and whether
 * a page load makes a sound. A screenshot would not prove any of them.
 */
function runBehaviours(context, recordError, helpers) {
  const doc = context.document;
  const el = (id) => doc.getElementById(id);
  const drawer = el('drawer');
  const trigger = el('drawer-trigger');
  const audio = el('engine-audio');
  const ND = context.window.ND;
  const out = {};

  const step = (name, fn) => {
    try { fn(); } catch (e) { recordError(`behaviour ${name}: ${e.message}`, e.stack); }
  };
  const key = (k, mods) => step('key ' + k, () => doc.dispatch('keydown', Object.assign({
    key: k, ctrlKey: false, metaKey: false, preventDefault() {}, stopPropagation() {}
  }, mods || {})));
  const clickAction = (name) => {
    const b = makeElement('button');
    b.setAttribute('data-action', name);
    b.closest = (sel) => (sel === '[data-action]' ? b : null);
    doc.dispatch('click', { target: b, currentTarget: doc, preventDefault() {}, stopPropagation() {} });
  };
  const isOpen = () => drawer.classList.contains('is-open');

  out.closedAtBoot = !isOpen();

  // Approach opens it after the 90 ms delay, not instantly.
  step('enter', () => trigger.dispatch('pointerenter', {}));
  out.noInstantOpen = !isOpen();
  helpers.drain();
  out.opensOnApproach = isOpen();

  // Leaving does not slam it shut; it waits out the grace period.
  step('leave', () => drawer.dispatch('pointerleave', {}));
  out.noInstantClose = isOpen();
  helpers.drain();
  out.closesAfterGrace = !isOpen();

  // Pin outlives the pointer leaving.
  clickAction('drawer.pin');
  helpers.drain();
  step('enter pinned', () => trigger.dispatch('pointerenter', {}));
  helpers.drain();
  step('leave pinned', () => drawer.dispatch('pointerleave', {}));
  helpers.drain();
  out.pinnedStaysOpen = isOpen() && ND.settings.drawerPinned === true;

  // Unpin, then Escape is the keyboard exit.
  clickAction('drawer.pin');
  helpers.drain();
  key('Escape');
  helpers.drain();
  out.escapeCloses = !isOpen();

  // Ctrl+B is the mouse-free route in and out.
  key('b', { ctrlKey: true });
  helpers.drain();
  out.keyboardOpens = isOpen();
  key('b', { ctrlKey: true });
  helpers.drain();
  out.keyboardCloses = !isOpen();

  // Startup: a page load must be silent; the button must not be.
  out.silentOnLoad = audio.playCalls === 0;
  clickAction('engine.start');
  helpers.drain();
  out.soundOnManualStart = audio.playCalls > 0;

  // A rejected upload: wrong type, then too large. Neither may throw, and both
  // must say why.
  const lastInput = () => doc.body.children[doc.body.children.length - 1];
  clickAction('car.import');
  const input = lastInput();
  out.filePickerOpened = !!(input && input.type === 'file');
  const reject = (file) => {
    const toastEl = el('toast');
    toastEl.textContent = '';
    input.files = [file];
    input.dispatch('change', {});
    helpers.drain();
    return toastEl.textContent;
  };
  out.wrongTypeMessage = reject({ type: 'text/plain', size: 2048, name: 'notes.txt' });
  out.tooLargeMessage = reject({ type: 'image/png', size: 55 * 1024 * 1024, name: 'huge.png' });
  out.rejectsWrongType = /Unsupported/i.test(out.wrongTypeMessage || '');
  out.rejectsLargeFile = /MB/.test(out.tooLargeMessage || '');

  return out;
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
  clock = [10, 0],
  runUI = false,
  behaviour = false,
  storage = null,
  storageThrows = false
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

  // The audio element: spies so "did a sound actually play at boot" is a fact
  // rather than a guess. A real browser would also block autoplay before a
  // gesture; that policy cannot be reproduced here.
  const audioEl = makeElement('audio');
  audioEl.playCalls = 0;
  audioEl.pauseCalls = 0;
  audioEl.play = function () { audioEl.playCalls++; return Promise.resolve(); };
  audioEl.pause = function () { audioEl.pauseCalls++; };
  byId.set('engine-audio', audioEl);

  const selectorCache = new Map();
  const documentTitle = makeElement('title');
  const documentListeners = new Map();
  const document = {
    documentElement: makeElement('html'),
    body: makeElement('body'),
    title: 'NIGHTDRIVE',
    readyState: 'complete',
    hidden: false,
    activeElement: null,
    getElementById: (id) => getId(id),
    querySelector(sel) {
      if (sel === '[data-layer="a"]') return layerA;
      if (sel === '[data-layer="b"]') return layerB;
      // Identity matters: app.js holds element references and toggles classes
      // on them, so a fresh stub per call would hide the behaviour.
      if (sel[0] === '#') return getId(sel.slice(1));
      if (!selectorCache.has(sel)) selectorCache.set(sel, makeElement('div'));
      return selectorCache.get(sel);
    },
    querySelectorAll() { return []; },
    createElement(tag) { return makeElement(tag); },
    createTextNode(t) { return { nodeType: 3, textContent: t }; },
    addEventListener(type, fn) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = documentListeners.get(type) || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    dispatch(type, event = {}) {
      (documentListeners.get(type) || []).forEach((fn) => fn(event));
    },
    _listeners: documentListeners,
    _title: documentTitle
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

  // A key/value store that survives between runs, so "reload" can be the same
  // storage with a fresh document.
  const storageStub = storage || (() => {
    const store = new Map();
    return {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => {
        if (storageThrows) throw new Error('QuotaExceededError: the quota has been exceeded.');
        store.set(k, String(v));
      },
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
      get length() { return store.size; },
      _store: store
    };
  })();

  const rafQueue = [];
  const requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
  const cancelAnimationFrame = () => {};

  // Timers are real enough to test behaviour: an id, and a clearTimeout that
  // actually cancels. Without that, the drawer's cancelled open timer would
  // still fire and a close would look like an open.
  let timerSeq = 0;
  const timers = new Map();
  const timersRun = [];
  const setTimeoutStub = (fn) => { const id = ++timerSeq; timers.set(id, fn); return id; };
  const clearTimeoutStub = (id) => { timers.delete(id); };
  const setIntervalStub = () => 0;
  let timerErrors = [];
  const drainTimers = (rounds = 40) => {
    for (let i = 0; i < rounds && timers.size; i++) {
      const batch = [...timers.values()];
      timers.clear();
      for (const fn of batch) {
        try { fn(); } catch (e) { timerErrors.push({ message: e.message, stack: e.stack }); }
      }
    }
    return timersRun.length;
  };

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
    isSecureContext: false,
    // Preferences are small key/value pairs; IndexedDB is deliberately absent
    // so the memory fallback path is the one under test.
    localStorage: storageStub
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
  drainTimers();
  for (const e of timerErrors) recordError('timer: ' + e.message, e.stack);

  // Optionally exercise the interface layer after the engine is up.
  // Read the clock before any control is clicked: one of the checks is that a
  // fresh profile renders 24-hour time.
  const hudAtBoot = getId('hud-time').textContent;

  let ui = null;
  let behaviours = null;
  if (runUI || behaviour) {
    const loaded = await loadInterface(context, recordError);
    ui = { loaded: loaded.loaded, clicked: 0, failed: [], effects: {} };
    if (loaded.loaded && runUI) {
      Object.assign(ui, await clickEveryControl(context, recordError, loaded.source));
      ui.loaded = true;
    }
    if (loaded.loaded && behaviour) {
      behaviours = runBehaviours(context, recordError, { drain: drainTimers });
    }
    // Drain whatever the clicks queued (toasts, delayed capability probes).
    drainTimers();
    for (const e of timerErrors) recordError('ui timer: ' + e.message, e.stack);
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

  // Geometry used by the depth clock. These are pure functions exported by
  // the engine, so they can be exercised without laying out a page.
  const call = (name, ...args) => {
    try {
      const fn = sandbox[name];
      return typeof fn === 'function' ? fn(...args) : null;
    } catch (e) {
      recordError('geometry ' + name + ': ' + e.message, e.stack);
      return null;
    }
  };

  return {
    ok: errors.length === 0,
    errors,
    consoleErrors,
    ui,
    behaviours,
    audio: { playCalls: audioEl.playCalls, pauseCalls: audioEl.pauseCalls },
    // A copy, so a later run cannot mutate what this one observed.
    settings: context.window.ND ? JSON.parse(JSON.stringify(context.window.ND.settings)) : null,
    storage: storageStub,
    geo: {
      polygon: call('ridgePolygon', [[0, 0.5], [1, 0.6]]),
      peak: call('ridgeAt', [[0, 0.4], [1, 0.6]], 0.5),
      cover1920: call('plateRect', 1376, 768, 1920, 1080, 0.62, 0.74),
      coverTall: call('plateRect', 1376, 768, 1080, 1920, 0.58, 0.74)
    },
    hudAtBoot,
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
