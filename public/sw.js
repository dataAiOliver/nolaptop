/*
 * Deliberately minimal.
 *
 * This app is a live view of remote machines: a cached session list is worse
 * than no session list, because it would show a state that may no longer be
 * true. So the service worker exists only to make the app installable and to
 * serve the shell when the phone is offline — every API call goes to the
 * network and is never cached.
 */

const SHELL_CACHE = "cc-shell-v1";
const SHELL_ASSETS = ["/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache data or the event stream.
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(request).catch(async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      return new Response("Offline — Claude Control needs a connection to your servers.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }),
  );
});
