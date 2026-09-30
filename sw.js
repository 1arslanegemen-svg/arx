// COINFORCE service worker: uygulama kabuğunu önbelleğe alır; veriler her zaman sunucudan gelir.
const CACHE = "arx-v4";
const SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  if (url.hostname.endsWith("supabase.co")) return;                 // canlı veri: hiç önbelleğe alma
  if (req.mode === "navigate" || url.pathname.endsWith("/index.html")) {
    // Sayfa: önce ağ (güncellemeler hemen gelsin), çevrimdışıysa önbellek
    e.respondWith(fetch(req).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put("./index.html", cp)); return r; })
      .catch(() => caches.match("./index.html")));
    return;
  }
  // Simgeler, kütüphane ve yazı tipleri: önce önbellek
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
    if (r.ok && (url.origin === location.origin || url.hostname === "cdn.jsdelivr.net" || url.hostname.endsWith("gstatic.com") || url.hostname.endsWith("googleapis.com"))) {
      const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp));
    }
    return r;
  })));
});
