// Service worker for Shiloh's Plants.
//
// Strategy:
//   - HTML / navigations → network-FIRST, fall back to cache only when offline.
//     This way every visit gets fresh code while still working offline.
//   - Static assets (icons, manifest) → cache-first.
//   - Supabase + CDN → always network (no SW interception).
//
// Bump CACHE when you ship a change that should invalidate old caches.
const CACHE = 'plants-shell-v2';
const SHELL = ['/', '/index.html', '/manifest.json', '/icon-192.svg', '/icon-512.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);

  // Bypass Supabase, CDNs, fonts — let them go straight to the network
  if (u.hostname.includes('supabase')) return;
  if (u.hostname.includes('cdn.jsdelivr.net')) return;
  if (u.hostname.includes('fonts.googleapis.com')) return;
  if (u.hostname.includes('fonts.gstatic.com')) return;

  const isHTML =
    e.request.mode === 'navigate' ||
    e.request.destination === 'document' ||
    u.pathname === '/' ||
    u.pathname.endsWith('.html');

  if (isHTML) {
    // Network-first for the shell — fresh code wins, cache is the offline safety net.
    e.respondWith(
      fetch(e.request).then(resp => {
        if (resp && resp.ok) {
          const respClone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, respClone));
        }
        return resp;
      }).catch(() => caches.match(e.request).then(c => c || caches.match('/')))
    );
  } else {
    // Cache-first for static assets (icons, etc.) — they rarely change.
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
        if (resp && resp.ok && resp.type === 'basic') {
          const respClone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, respClone));
        }
        return resp;
      }))
    );
  }
});
