/* Service worker: network-first so app updates always reach the browser when
 * online, with a cache fallback so the app still opens offline.
 * API responses are never cached (always fetched fresh from the bridge). */
const CACHE = 'bhe-v133';
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest', './icon.svg'];

// Let the page tell a freshly-installed worker to activate immediately instead
// of waiting for all tabs to close. Paired with the controllerchange auto-reload
// in app.js, this means new code reaches the user on the next load.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('install', (e) => {
  // pre-cache the shell for offline, but don't block; take over immediately
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.includes('/api/')) return; // let API calls hit the network directly
  // network-first: fresh code when online, cached shell when offline
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  );
});
