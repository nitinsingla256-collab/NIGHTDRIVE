/* ══════════════════════════════════════════════
   NIGHTDRIVE — Service worker: offline engine shell
   Pre-caches every file the wallpaper needs at runtime, so the scene,
   studios, HUD and controls keep working with no network at all.
   ══════════════════════════════════════════════ */

'use strict';

const CACHE_NAME = 'nightdrive-v3.0.0';

const PRECACHE_URLS = [
  './index.html',
  './script.js',
  './app.js',
  './styles.css',
  './assets/ridges.json',
  './assets/studio-catalog.json',
  './engine-start.wav',
  './assets/morning/scene.jpg',
  './assets/morning/scene.svg',
  './assets/day/scene.jpg',
  './assets/day/scene.svg',
  './assets/golden-hour/scene.jpg',
  './assets/golden-hour/scene.svg',
  './assets/dusk/scene.jpg',
  './assets/dusk/scene.svg',
  './assets/dusk/headlights.jpg',
  './assets/dusk/headlights.svg',
  './assets/night/scene.jpg',
  './assets/night/scene.svg',
  './assets/night/headlights.jpg',
  './assets/night/headlights.svg',
  './assets/midnight/scene.jpg',
  './assets/midnight/headlights.jpg',
  './assets/midnight/headlights.svg',
  './assets/library/alpine-dawn.jpg',
  './assets/library/coastal-highway-day.jpg',
  './assets/library/redwood-canyon-gold.jpg',
  './assets/library/tokyo-skyline-dusk.jpg',
  './assets/library/starlight-ridge-night.jpg',
  './assets/library/aurora-pass-midnight.jpg',
  './assets/cars/obsidian-muscle-coupe.png',
  './assets/cars/stealth-gt-fastback.png',
  './assets/cars/phantom-apex-supercar.png'
];

const MATCH_OPTS = { ignoreSearch: true };
const cacheKey = (request) => {
  const url = new URL(request.url);
  return url.origin + url.pathname;
};

function cachePut(request, response) {
  if (!response || !response.ok) return response;
  const copy = response.clone();
  caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey(request), copy));
  return response;
}

function staleWhileRevalidate(request) {
  return caches.match(request, MATCH_OPTS).then((cached) => {
    if (cached) {
      fetch(request).then((response) => cachePut(request, response)).catch(() => {});
      return cached;
    }
    return fetch(request).then((response) => cachePut(request, response));
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(PRECACHE_URLS.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('./index.html', MATCH_OPTS))
    );
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});
