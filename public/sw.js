const CACHE_NAME = 'whispernet-v4-titled';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).then((res) => {
      if (res && res.status === 200 && event.request.method === 'GET' &&
          (event.request.mode === 'navigate' || event.request.destination === 'style' ||
           event.request.destination === 'script' || event.request.destination === 'font')) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return res;
    }).catch(() => caches.match(event.request))
  );
});
