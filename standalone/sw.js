const scope = self.registration.scope;
const cachePrefix = "capture-desk-shell:" + scope + ":";
const cacheName = cachePrefix + "2";
const core = ["./", "./index.html", "./style.css", "./locales.js", "./recording-store.js", "./recorder.js", "./sw.js"];
const optional = ["../chrome-extension/ai-providers.js", "../chrome-extension/assist-panel.js", "../chrome-extension/assist-panel.css"];
const assets = new Set([...core, ...optional].map(path => new URL(path, scope).href));

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll(core.map(path => new URL(path, scope).href));
    await Promise.allSettled(optional.map(path => cache.add(new URL(path, scope).href)));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const old = (await caches.keys()).filter(name => name.startsWith(cachePrefix) && name !== cacheName);
    await Promise.all(old.map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || !assets.has(event.request.url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    try {
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone()).catch(() => {});
      return response;
    } catch {
      return (await cache.match(event.request)) || Response.error();
    }
  })());
});
