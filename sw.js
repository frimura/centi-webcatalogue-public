
const CACHE = 'centi-catalog-shell-v5';

const FILES = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/search.js',
  './search-rules.json',
  './manifest.json',
  './assets/icon.svg'
];

// Install the new service worker.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(FILES))
      .then(() => self.skipWaiting())
  );
});

// Activate the new version and remove old caches.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key.startsWith('centi-catalog-shell-') && key !== CACHE)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Fetch strategy.
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin
  ) {
    return;
  }

  // Always try the network first for website files.
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();

          caches.open(CACHE).then(cache => {
            cache.put(request, copy);
          });
        }

        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);

        if (cached) return cached;

        return new Response('You are offline and this file is not cached.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' }
        });
      })
  );
});
