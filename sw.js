// عامل الخدمة: تخزين ملفات التطبيق للعمل دون إنترنت. لا يخزن أي صور من الكاميرا.
const CACHE = 'osmo-adventure-v0.1.0';
const ASSETS = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './src/app.js', './src/vision/geometry.js', './src/vision/rectify.js', './src/vision/quality.js',
  './src/vision/adaptive.js', './src/calibration/store.js', './src/platform/orientation.js', './src/platform/camera.js',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// الشبكة أولًا مع الرجوع للمخزن — يضمن وصول التحديثات أثناء التطوير ويعمل دون إنترنت.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./index.html')))
  );
});
