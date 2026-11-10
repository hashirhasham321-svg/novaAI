const CACHE_NAME = "qubix-cache-v2";

const APP_FILES = [
  "/",
  "/index.html",
  "/manifest.json",
  "/share.html",
  "/icon.svg",
  "/privacy.html",
  "/terms.html",
  "/about.html"
];

// INSTALL
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      await Promise.all(
        APP_FILES.map(async file => {
          try {
            await cache.add(file);
          } catch (error) {
            console.warn("Could not cache:", file);
          }
        })
      );
    })
  );

  self.skipWaiting();
});

// ACTIVATE
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );

  self.clients.claim();
});

// FETCH
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);

  // Only cache GET requests
  if (request.method !== "GET") return;

  // Never cache API or private Supabase requests
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.includes("/.netlify/") ||
    url.hostname.includes("supabase.co")
  ) {
    return;
  }

  // Do not cache external websites or CDN resources
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.ok) {
          const copy = response.clone();

          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, copy);
          });
        }

        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);

        if (cached) return cached;

        // Offline fallback for page navigation
        if (request.mode === "navigate") {
          return (
            await caches.match("/index.html")
          ) || new Response(
            "QuBix AI is offline. Please reconnect to the internet.",
            {
              status: 503,
              headers: {
                "Content-Type": "text/plain; charset=utf-8"
              }
            }
          );
        }

        return new Response("Offline", { status: 503 });
      })
  );
});
