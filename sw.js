/* Service Worker — مكبّر الصوت (PWA خفيفة على GitHub Pages)
 * ---------------------------------------------------------
 * - تثبيت: يخزّن الصفحة والـ manifest والأيقونات مسبقاً.
 * - التنقل (الصفحة): الشبكة أولاً ثم الكاش → التحديثات تصل فوراً.
 * - الأصول (أيقونات/manifest): كاش أولاً ثم الشبكة مع تخزين.
 * - لا نلمس الطلبات عبر النطاقات (cross-origin).
 */
const CACHE = 'mukabir-pwa-v1'
const PRECACHE = ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png']

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => {
        /* فشل التخزين المسبق لا يمنع التنصيب */
      }),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // الصفحة الرئيسية: شبكة أولاً (التحديث يصل فوراً) ثم كاش كاحتياط
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put('./', copy))
          return res
        })
        .catch(() => caches.match('./')),
    )
    return
  }

  // الأصول: كاش أولاً ثم شبكة + تخزين
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(req, copy))
          }
          return res
        }),
    ),
  )
})
