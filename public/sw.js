/**
 * The offline shell.
 *
 * Network-first, with the cache only answering when the network does not. An online visitor therefore always
 * gets what the server just sent, which is the right default for an app whose whole point is that the
 * words in it are not anywhere else.
 *
 * ## The rule, and why it is a path check and not a header check
 *
 * Nothing under `/api/` is ever written to disk, whatever its `destination` and whatever the server said
 * about caching. This file used to argue the point from `destination` alone: `image` was on the
 * cacheable list, both of the app's per-account image sources are `<img>` requests, and both answer
 * `Cache-Control: public, max-age=86400`, so the `no-store`/`no-cache` guard did not stop them either.
 *
 * What that actually persisted: `src/upload.ts`'s `mediaProxyUrl` appends the account's 24-hour upload
 * token to every media URL, so the token landed in Cache Storage keys in plaintext, and `src/utils.ts`'s
 * `avatarUrl` fetched `/api/avatar/<uuid>`. DM media is encrypted client-side before upload, so those
 * bytes are ciphertext - but global-channel (`#general`) media is uploaded in the clear, so this file was
 * writing *plaintext photos* out of the public channel into Cache Storage. Cache Storage is not encrypted
 * at rest and is not covered by anything this project clears on logout.
 *
 * A deny-list of one prefix is enough and needs no maintenance: `/api/*` is every request the client makes
 * to its own backend, and the app's own `style`/`script`/`font` assets are served from `/assets/`, which
 * is what keeps the offline shell working.
 */

const BUILD_ID = '__WN_BUILD_ID__';

// Stamped by the build, so a deploy gets a new cache and the eviction below actually fires. It was a
// hand-maintained `whispernet-v5` that nothing rewrote, which meant the delete-older-caches step had never
// once deleted anything and never would: every release kept adding content-hashed chunks to the same
// cache, generation after generation, until the browser evicted the whole origin under quota pressure.
//
// The stamp is a fresh value on every build, not the package version. A version only moves when somebody
// remembers to move it, and the failure this cache name exists to prevent is a fix to *this file* being
// served out of the generation it just tried to retire - which by definition did not bump the version.
const CACHE_NAME = `whispernet-${BUILD_ID}`;

/** What is worth keeping a copy of. Anything else is fetched and forgotten. */
const CACHEABLE_DESTINATIONS = new Set(['style', 'script', 'font', 'image']);

/** Never cached, whatever the destination says. See the note at the top of this file. */
const NEVER_CACHED_PREFIXES = ['/api/'];

self.addEventListener('install', (event) => {
  // Precache the shell, or rather the *one* file a cold offline start needs.
  //
  // The write guard below refuses to store `no-cache` responses, and the server sends exactly that for the
  // shell so a stale bundle can never be pinned - which is right, and which meant nothing was ever in the
  // cache under the key the navigate-failure branch looks in. The branch was documented as unreachable and
  // then still consulted, so it could only ever miss: close the app with no connection, reopen it, and get
  // the browser's network-error page instead of the app.
  //
  // Fetched with `cache: 'reload'` so this is a genuine network read and not whatever is in the HTTP cache,
  // and stored under the same `CACHE_NAME`, which `BUILD_ID` rotates. That is what keeps the shell pinned
  // no worse than everything else: a deploy that changes the worker rotates the cache with it.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.put('./index.html', fetch('./index.html', { cache: 'reload' })))
      // A failed precache must not fail the install - the app is fully usable online, which is the
      // overwhelmingly common case - and it must not reject, or `skipWaiting` never runs and the new worker
      // never activates.
      .catch(() => { /* offline at install time; the running page carries on */ })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        // Only this app's own caches. An origin's Cache Storage is shared by every service worker ever
        // registered on it - ours, anything the user's other apps put there, anything a page on this host
        // has left behind - and a blanket delete is the kind of thing that throws away another app's data
        // in a tab that has nothing to do with us.
        Promise.all(keys.filter((k) => k !== CACHE_NAME && k.startsWith('whispernet-')).map((k) => caches.delete(k)))
      ),
      // Inside `waitUntil`, which is where it has to be. `claim()` is asynchronous and outside it the
      // worker's lifetime is not extended for the takeover: terminated in that window and every already-open
      // tab keeps running the *old* worker, and so the old cache generation, for good. That is precisely the
      // pinning this file's BUILD_ID stamp exists to prevent, defeated by the one call that adopts them.
      self.clients.claim(),
    ])
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache the worker itself, or anything account-scoped, whatever it arrives as.
  if (url.pathname.endsWith('/sw.js')) return;
  if (NEVER_CACHED_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return;

  const wanted = event.request.method === 'GET' &&
    (event.request.mode === 'navigate' || CACHEABLE_DESTINATIONS.has(event.request.destination));

  event.respondWith(
    fetch(event.request).then((res) => {
      if (wanted && res && res.status === 200 && res.type === 'basic') {
        const cacheControl = res.headers.get('cache-control') || '';
        // The server answers an unknown path with the app shell and `no-cache` so that a stale bundle is
        // never pinned. Copying that into the cache would store an HTML error page under a hashed .js URL,
        // and every later offline load of it would get HTML.
        if (!cacheControl.includes('no-store') && !cacheControl.includes('no-cache')) {
          const copy = res.clone();
          // Held until the write finishes. Not passed to `waitUntil`, so the worker could be terminated
          // part-way through and the entry simply never landed - a cache that silently loses writes looks
          // exactly like a cache that is working.
          event.waitUntil(
            caches.open(CACHE_NAME)
              .then((cache) => cache.put(event.request, copy))
              .catch(() => { /* quota, or a response the Cache API will not store */ })
          );
        }
      }
      return res;
    }).catch(async (err) => {
      if (event.request.mode !== 'navigate') throw err;
      // `caches.match` resolves to undefined on a miss, and handing that to `respondWith` throws a TypeError
      // the user sees as a generic network error instead of the app's own offline screen. Always resolve to
      // a Response or rethrow.
      //
      // The cached shell, stored by `install`. Served only on this branch - the catch - so a cached copy can
      // never shadow a fresh one, which is the failure a `no-cache` shell is guarding against.
      //
      // `./index.html` rather than `event.request`, because the request here is a navigation whose URL is
      // whatever the user opened (`/`, or a deep link), and the precache put the entry under one fixed name.
      // `ignoreSearch` covers a query string on either side.
      const hit = (await caches.match(event.request, { ignoreSearch: true }))
        || (await caches.match('./index.html', { ignoreSearch: true }));
      if (hit) return hit;
      throw err;
    })
  );
});