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
 *      ``/workspaces/abc`` doesn't 404 when the network is flaky.
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
import { stashSharedFiles } from "./lib/shareTargetStash";
import {
  cleanupOutdatedCaches,
  matchPrecache,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// ----- Precache -----
precacheAndRoute(self.__WB_MANIFEST ?? []);
cleanupOutdatedCaches();

// ----- SPA navigation: NETWORK-FIRST -----
// Critically NOT cache-first. The app shell (index.html) embeds the hashed
// chunk filenames for the *current* build; serving a stale precached shell
// after a redeploy makes the page reference chunks the server already
// deleted → "Failed to fetch dynamically imported module" 404s on lazy
// routes (e.g. the workspace canvas). So every navigation fetches the live
// index.html (which always reflects what's on disk), and we fall back to the
// precached shell ONLY when the network is unreachable (offline support).
async function navigationHandler(): Promise<Response> {
  try {
    const fresh = await fetch("/index.html", { cache: "no-store" });
    if (fresh && fresh.ok) return fresh;
  } catch {
    // Network unreachable — fall through to the offline shell below.
  }
  const cached = await matchPrecache("/index.html");
  return cached ?? Response.error();
}

registerRoute(
  new NavigationRoute(navigationHandler, {
    denylist: [
      /^\/api\//,
      // Signed media links (WP-7.5) — a file, never the app shell.
      /^\/m\//,
      /^\/uploads\//,
      // The PromptlySync app download — a file, never the app shell.
      /^\/downloads\//,
      /^\/openapi\.json$/,
      /^\/docs/,
      /^\/redoc/,
    ],
  })
);

// ----- Share target: "Share → Promptly Files" (R-211) -----
// The installed Files app is a share target; the OS POSTs the shared files
// here. Stash them and send the app to Files, which uploads them (the
// upload needs the signed-in page — the worker has no token).
self.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "POST" || url.pathname !== "/files/share-target") return;
  event.respondWith(
    (async () => {
      try {
        const form = await event.request.formData();
        const files = form.getAll("files").filter((v): v is File => v instanceof File);
        await stashSharedFiles(files);
      } catch {
        // Nothing usable arrived — still land the user in Files.
      }
      return Response.redirect("/files/?shared=1", 303);
    })()
  );
});

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
  /** Rooms: the sender's picture (else the app's icon). */
  icon?: string;
  /** Rooms: stack this ``line`` under the room's earlier unread ones. */
  stack?: boolean;
  line?: string;
  /** Rooms: unread messages in all — the number on the app icon. */
  app_badge?: number;
}

/** How many stacked lines a room's notification shows before "+N more". */
const STACK_SHOWN = 5;

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

  event.waitUntil(
    (async () => {
      let title = payload.title;
      let body = payload.body;
      let lines: string[] = [];
      let count = 1;
      // A room's messages stack in one notification, like a messaging app:
      // the newest few lines, and "+N more" for the rest. Tapping it (or
      // reading the room in the app) clears the stack.
      if (payload.stack && payload.tag) {
        const line = payload.line || payload.body;
        try {
          const prev = (await self.registration.getNotifications({ tag: payload.tag }))[0];
          const data = (prev?.data ?? {}) as { lines?: string[]; count?: number };
          lines = [...(data.lines ?? []), line].slice(-STACK_SHOWN);
          count = (data.count ?? 0) + 1;
        } catch {
          lines = [line];
        }
        if (count > 1) {
          title = `${payload.title} (${count} new)`;
          const hidden = count - lines.length;
          body = (hidden > 0 ? `+${hidden} earlier\n` : "") + lines.join("\n");
        }
      }
      if (typeof payload.app_badge === "number") {
        const nav = self.navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
        try {
          if (payload.app_badge > 0) await nav.setAppBadge?.(payload.app_badge);
          else await nav.clearAppBadge?.();
        } catch {
          // Not supported here.
        }
      }
      // ``renotify`` is a valid Notification spec field (tells Chrome to
      // vibrate / sound again even when the tag already exists) but the
      // TypeScript DOM lib hasn't caught up. Build as a loose object and
      // cast at the call site.
      const options = {
        body,
        // The sender's picture for a message; Promptly's icon otherwise.
        icon: payload.icon || "/pwa-192.png",
        badge: "/pwa-192.png",
        tag: payload.tag,
        // Notifications with the same ``tag`` replace previous ones
        // rather than stacking — so "export ready" twice in a row
        // doesn't clutter the tray.
        renotify: Boolean(payload.tag),
        timestamp: Date.now(),
        data: {
          url: payload.url ?? "/",
          category: payload.category,
          lines,
          count,
        },
      } as NotificationOptions;
      await self.registration.showNotification(title, options);
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data ?? {};
  const url = (data.url as string) || "/";

  event.waitUntil(
    (async () => {
      // Prefer focusing an already-open Promptly tab rather than
      // spawning a new one. Match by origin+path so "the tab already
      // on /workspaces" gets reused when a second push arrives.
      const wins = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Rooms and Photos install as their own apps: a push for one goes to
      // a window already in that app, else opens fresh (so the installed
      // app, which owns that scope, handles it) — never hijacks Promptly.
      const scope = ["/rooms/", "/photos/"].find((s) => url.startsWith(s)) ?? null;
      const inScope = (w: WindowClient | Client) => {
        const p = new URL(w.url).pathname;
        return scope ? p.startsWith(scope) : !p.startsWith("/rooms/") && !p.startsWith("/photos/");
      };
      const target = wins.find((w) => new URL(w.url).origin === self.location.origin && inScope(w));
      if (target) {
        try {
          await (target as WindowClient).focus();
          if ("navigate" in target) {
            await (target as WindowClient).navigate(url);
          }
          return;
        } catch {
          // Ignore — falls through to ``openWindow`` below.
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
