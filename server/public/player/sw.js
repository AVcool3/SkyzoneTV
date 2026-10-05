/* ParkCast player service worker.
 *
 * Media cache: each /media/ file is downloaded from the server ONCE per
 * device, then served from local storage on every later loop — a video
 * looping all day costs zero server bandwidth after its first play. File
 * ids are immutable (a replaced file gets a new id) so entries never go
 * stale; the player posts the urls its current state uses and anything
 * else is pruned.
 *
 * Shell cache: the player page itself is network-first with a cached
 * fallback, and the player keeps its last state in localStorage — so a TV
 * that reboots while the internet is down still comes up and plays.
 *
 * Every path here fails OPEN: on any internal error the request falls
 * back to a plain network fetch. A bug in this file must never blank a
 * screen — worse bandwidth beats a dead TV.
 */
const MEDIA_CACHE = 'parkcast-media-v1';
const SHELL_CACHE = 'parkcast-shell-v1';
const SHELL_PATHS = ['/player/', '/player/player.js', '/player/birthday.js'];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then(c => c.addAll(SHELL_PATHS)).catch(() => {})
  );
});
self.addEventListener('activate', event => {
  // Take over already-open player pages — the whole point is the fleet
  // starts caching without anyone touching a TV.
  event.waitUntil(self.clients.claim());
});

const isShellPath = p =>
  p === '/player' || p === '/player/' || p === '/player/index.html' ||
  p === '/player/player.js' || p === '/player/birthday.js';
// '/player' and '/player/index.html' are the same document as '/player/'.
const shellKey = p =>
  (p === '/player' || p === '/player/index.html') ? '/player/' : p;

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/media/')) {
    event.respondWith(media(event, req, url.pathname));
  } else if (isShellPath(url.pathname)) {
    event.respondWith(shell(req, shellKey(url.pathname)));
  }
  // Everything else (/api, /ws upgrades, dashboard) is untouched.
});

// ---- media: cache-first, fill in the background ---------------------------
const downloading = new Map(); // pathname -> in-flight full download

async function media(event, req, pathname) {
  try {
    const cache = await caches.open(MEDIA_CACHE);
    const hit = await cache.match(pathname);
    if (hit) return await rangeify(req, hit);
    // Miss: stream from the network untouched so playback starts instantly,
    // while one full copy downloads into the cache for every later loop.
    // (First cycle costs roughly double; every cycle after costs nothing.)
    if (!downloading.has(pathname)) {
      const dl = fullDownload(cache, pathname);
      downloading.set(pathname, dl);
      event.waitUntil(dl); // keep the worker alive until the copy lands
    }
    return await fetch(req);
  } catch {
    return fetch(req);
  }
}

async function fullDownload(cache, pathname) {
  try {
    const res = await fetch(pathname); // no Range header -> full 200 body
    // Only a complete, healthy body is worth keeping; put() may also throw
    // on storage quota, which simply leaves this file streaming as before.
    if (res.status === 200) await cache.put(pathname, res);
  } catch {}
  downloading.delete(pathname);
}

// Video elements ask for byte ranges; answer them by slicing the cached
// blob (blob slices are disk-backed — no full-file copy in memory).
async function rangeify(req, cached) {
  const blob = await cached.blob();
  const type = cached.headers.get('content-type') || 'application/octet-stream';
  const range = req.headers.get('range');
  const m = range && /bytes=(\d+)-(\d*)/.exec(range);
  if (!m) {
    // No range (images) or a shape we don't parse: Chromium's media stack
    // accepts a full 200 for a ranged request and slices it itself.
    return new Response(blob, {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(blob.size) }
    });
  }
  const total = blob.size;
  const start = parseInt(m[1], 10);
  const end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
  if (start >= total || start > end) {
    return new Response(null, {
      status: 416, headers: { 'Content-Range': `bytes */${total}` }
    });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes'
    }
  });
}

// ---- shell: network-first, cached fallback for offline reboots ------------
async function shell(req, key) {
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      try {
        // Re-wrap before storing: a redirected response (e.g. /player ->
        // /player/) is refused by the browser when replayed for a
        // navigation, so strip the redirect flag by rebuilding it.
        const body = await res.clone().blob();
        const clean = new Response(body, {
          status: 200,
          headers: { 'Content-Type': res.headers.get('content-type') || 'text/html' }
        });
        const cache = await caches.open(SHELL_CACHE);
        await cache.put(key, clean);
      } catch {}
      return res;
    }
    throw new Error('bad status');
  } catch {
    const hit = await caches.match(key, { cacheName: SHELL_CACHE });
    return hit || fetch(req);
  }
}

// ---- messages from the player page ----------------------------------------
self.addEventListener('message', event => {
  const msg = event.data || {};
  if (msg.type === 'retain' && Array.isArray(msg.urls) && msg.urls.length) {
    // Keep only what the screen's current state references. Empty lists are
    // ignored on purpose: a powered-off or just-paired screen must not wipe
    // a cache it will want again in the morning.
    event.waitUntil((async () => {
      try {
        const keep = new Set(msg.urls.map(u => {
          try { return new URL(u, self.location.origin).pathname; } catch { return u; }
        }));
        const cache = await caches.open(MEDIA_CACHE);
        for (const req of await cache.keys()) {
          if (!keep.has(new URL(req.url).pathname)) await cache.delete(req);
        }
      } catch {}
    })());
  }
  if (msg.type === 'stats' && event.source) {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(MEDIA_CACHE);
        const keys = await cache.keys();
        event.source.postMessage({
          type: 'stats',
          cachedMedia: keys.map(k => new URL(k.url).pathname)
        });
      } catch {}
    })());
  }
});
