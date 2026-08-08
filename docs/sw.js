/* gb3d service worker — offline cache.
 *
 * Precaches the whole self-contained build so that, once loaded, the game
 * launches with no network at all (Add to Home Screen -> open in airplane
 * mode). Cache-first for same-origin GETs; bump CACHE on any asset change.
 *
 * All URLs are relative to this file's directory, so the same worker works no
 * matter what subpath GitHub Pages serves the build under.
 */
const CACHE = 'gb3d-7511cdb6119d';

const ASSETS = [
  '.', 'index.html',
  'game.7511cdb6119d.js', 'love.js', 'love.wasm', 'game.7511cdb6119d.data',
  'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'icon-maskable-512.png',
  'apple-touch-icon.png', 'favicon-32.png', 'favicon.ico',
  'theme/love.css', 'theme/bg.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll fails the whole install if one asset 404s; add individually so
      // a missing optional file (e.g. a theme image) never blocks offline use.
      .then((cache) => Promise.all(ASSETS.map((u) =>
        cache.add(new Request(u, { cache: 'reload' })).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      // Runtime-cache anything new we successfully fetch (e.g. chunked data).
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('index.html')))
  );
});
