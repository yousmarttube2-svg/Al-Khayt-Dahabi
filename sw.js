/* =========================================================================
   Service Worker - الخيط الذهبي
   الهدف الأساسي: تلبية شرط Chrome لإظهار زر "تثبيت التطبيق" تلقائيًا،
   مع تخزين بسيط لملفات الواجهة (HTML/CSS/JS/الأيقونات) لتسريع التحميل
   وإتاحة فتح واجهة التطبيق حتى بدون اتصال (البيانات نفسها تبقى تتطلب
   اتصالاً بـ Firebase، فهذا التخزين المؤقت لا يغطي قراءة/كتابة البيانات).
   ========================================================================= */

const CACHE_NAME = "khayt-dahabi-shell-v1";
const SHELL_FILES = [
  "./index.html",
  "./style.css",
  "./app.js",
  "./firebase-config.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

// عند التثبيت: خزّن ملفات واجهة التطبيق الأساسية
self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(SHELL_FILES);
    })
  );
  self.skipWaiting();
});

// عند التفعيل: حذف أي نسخ تخزين قديمة من إصدارات سابقة
self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) { return key !== CACHE_NAME; })
            .map(function (key) { return caches.delete(key); })
      );
    })
  );
  self.clients.claim();
});

// استراتيجية الجلب: شبكة أولاً مع رجوع للتخزين المؤقت عند انقطاع الاتصال
// (لا نتدخل في طلبات Firebase/Firestore الخارجية، فقط ملفات نفس الموقع)
self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return; // اترك طلبات Firebase كما هي بدون تدخل

  event.respondWith(
    fetch(event.request)
      .then(function (response) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
        return response;
      })
      .catch(function () {
        return caches.match(event.request);
      })
  );
});
