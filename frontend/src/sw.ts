/// <reference lib="webworker" />
/**
 * Promptly service worker.
 *
 * Consumed by ``vite-plugin-pwa`` in ``injectManifest`` mode. The
 * plugin replaces ``self.__WB_MANIFEST`` with the precache list at
 * build time.
 *
 * Responsibilities:
 *   1. Precache the hashed app shell so repeat visits are instant
 *      and offline-capable.
 *   2. SPA navigation fallback — URLs without a cached static
 *      match return ``/index.html`` so a hard reload on
 *      ``/projects/abc`` doesn't 404 when the network is flaky.
 *   3. Web Push: receive encrypted pushes from the backend,
 *      render native notifications, and open the right URL when
 *      the user clicks one. The push payload schema is mirrored
 *      from ``backend/app/notifications/dispatch.py``.
 *
 * What we deliberately DON'T do here:
 *   - Intercept ``/api/**`` traffic. The backend handles streaming
 *     (SSE) and large file uploads the SW would only complicate.
 *   - Cache authenticated user data. Everything private stays in
 *     the app layer (IndexedDB / React Query) where a SW uninstall
 *     doesn't leak into other browser profiles.
 */
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { createHandlerBoundToURL } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// ----- Precache -----
precacheAndRoute(self.__WB_MANIFEST ?? []);
cleanupOutdatedCaches();

// ----- SPA navigation fallback -----
const navFallback = createHandlerBoundToURL("/index.html");
registerRoute(
  new NavigationRoute(navFallback, {
    denylist: [
      /^\/api\//,
      /^\/uploads\//,
      /^\/openapi\.json$/,
      /^\/docs/,
      /^\/redoc/,
    ],
  })
);

// Activate immediately + take control of open tabs so a deploy
// doesn't leave half the sessions on the old SW.
self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// ---------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------

interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  category?: string;
}

self.addEventListener("push", (event) => {
  // Be defensive — payload may arrive as JSON (the happy path), as a
  // plain string (unusual but legal), or be empty (keep-alive style
  // pushes some browsers emit). Gracefully show a "new activity"
  // fallback in the weird cases so the user doesn't get a silent
  // "nothing happened" from a browser that already vibrated.
  let payload: PushPayload = { title: "Promptly", body: "You have new activity." };
  try {
    if (event.data) {
      const text = event.data.text();
      if (text) {
        try {
          const parsed = JSON.parse(text) as Partial<PushPayload>;
          payload = { ...payload, ...parsed };
        } catch {
          payload.body = text;
        }
      }
    }
  } catch {
    // Keep the fallback payload.
  }

  // ``renotify`` is a valid Notification spec field (tells Chrome to
  // vibrate / sound again even when the tag already exists) but the
  // TypeScript DOM lib hasn't caught up. Build as a loose object and
  // cast at the call site.
  const options = {
    body: payload.body,
    // Lean on the maskable icon as the primary display — it's what
    // Chrome / Android prefer for rich notifications. Falling back
    // to the regular 192 icon keeps iOS-Safari-via-home-screen
    // happy too.
    icon: "/pwa-192.png",
    badge: "/pwa-192.png",
    tag: payload.tag,
    // Notifications with the same ``tag`` replace previous ones
    // rather than stacking — so "export ready" twice in a row
    // doesn't clutter the tray.
    renotify: Boolean(payload.tag),
    data: {
      url: payload.url ?? "/",
      category: payload.category,
    },
  } as NotificationOptions;

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data ?? {};
  const url = (data.url as string) || "/";

  event.waitUntil(
    (async () => {
      // Prefer focusing an already-open Promptly tab rather than
      // spawning a new one. Match by origin+path so "the tab already
      // on /projects" gets reused when a second push arrives.
      const wins = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const win of wins) {
        const winUrl = new URL(win.url);
        if (winUrl.origin === self.location.origin) {
          try {
            await win.focus();
            if ("navigate" in win) {
              await (win as WindowClient).navigate(url);
            }
            return;
          } catch {
            // Ignore — falls through to ``openWindow`` below.
          }
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});

// Fired by the browser when a subscription is invalidated (key
// rotation, storage wipe, etc.). We'd normally re-subscribe here;
// for now we just clean up so the dispatch helper doesn't keep
// trying to push to a dead endpoint — the app-level code will
// re-prompt next time the user opens the Notifications panel.
self.addEventListener("pushsubscriptionchange", (event) => {
  const ev = event as ExtendableEvent & {
    oldSubscription?: PushSubscription | null;
  };
  ev.waitUntil(
    (async () => {
      try {
        const sub = ev.oldSubscription;
        if (sub) {
          await sub.unsubscribe();
        }
      } catch {
        // Best-effort — nothing to do if the unsubscribe fails.
      }
    })()
  );
});
