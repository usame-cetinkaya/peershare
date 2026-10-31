// Network first (so new deploys show up right away), cache as offline fallback.
const CACHE = 'peershare-v2';
const SHARE_CACHE = 'peershare-share';
const SHELL = [
  '/',
  '/app.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];
const TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Android share target: park the shared files, then open the app to pick a person.
async function receiveShare(request) {
  // Any website can POST a form here. A real share from another app has no
  // referrer, so drop posts that come from someone else's page.
  const home = new URL('/', self.location).href;
  if (request.referrer && request.referrer !== 'about:client' && new URL(request.referrer).origin !== self.location.origin) {
    return Response.redirect(home, 303);
  }
  const form = await request.formData();
  const cache = await caches.open(SHARE_CACHE);
  for (const key of await cache.keys()) await cache.delete(key);
  const text = ['title', 'text', 'url'].map((k) => form.get(k)).filter(Boolean).join('\n');
  if (text) await cache.put('/__share/text', new Response(text));
  let i = 0;
  for (const file of form.getAll('files')) {
    if (!(file instanceof File)) continue;
    await cache.put(`/__share/file/${i++}`, new Response(file, {
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Name': encodeURIComponent(file.name) },
    }));
  }
  return Response.redirect(new URL('/?share=1', self.location).href, 303);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.method === 'POST' && url.pathname === '/share') {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET' || url.pathname === '/ws' || url.pathname.startsWith('/api/')) return;
  const key = req.mode === 'navigate' ? '/' : req;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const network = fetch(req).then((res) => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    });
    const timeout = new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS));
    try {
      const res = await Promise.race([network, timeout]);
      if (res) return res;
    } catch {}
    const cached = await cache.match(key);
    return cached || network;
  })());
});
