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
import { stashSharedText } from "./notes/shareStash";
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
async function navigationHandler({ url }: { url: URL }): Promise<Response> {
  // Passwords is its own document, never the main shell, online or off. Its
  // response headers (the stricter CSP) come along with it from the network or
  // the precache.
  if (/^\/passwords(\/|$)/.test(url.pathname)) {
    try {
      const fresh = await fetch("/passwords.html", { cache: "no-store" });
      if (fresh && fresh.ok) return fresh;
    } catch {
      // Offline: the vault works from its local copy.
    }
    return (await matchPrecache("/passwords.html")) ?? Response.error();
  }
  try {
    const fresh = await fetch("/index.html", { cache: "no-store" });
    if (fresh && fresh.ok) return withManifest(fresh, url.pathname);
  } catch {
    // Network unreachable — fall through to the offline shell below.
  }
  const cached = await matchPrecache("/index.html");
  return cached ? withManifest(cached, url.pathname) : Response.error();
}

/** Which app a page installs as — the same rule as the ``$pwa_manifest``
 *  map in nginx.spa.conf. It has to be in the HTML itself: some browsers
 *  only read the first manifest, so one the page swaps in later leaves
 *  /rooms or /app/<file>/ looking like Promptly ("already installed"). */
function manifestFor(path: string): string {
  if (/^\/rooms(\/|$)/.test(path)) return "/rooms.webmanifest";
  if (/^\/calendar(\/|$)/.test(path)) return "/calendar.webmanifest";
  if (/^\/maps(\/|$)/.test(path)) return "/maps.webmanifest";
  if (/^\/mail(\/|$)/.test(path)) return "/mail.webmanifest";
  if (/^\/photos(\/|$)/.test(path)) return "/photos.webmanifest";
  if (/^\/notes(\/|$)/.test(path)) return "/notes.webmanifest";
  const app = /^\/app\/([0-9a-fA-F-]{36})/.exec(path);
  if (app) return `/api/items/app-manifest/${app[1]}.webmanifest`;
  return "/manifest.webmanifest";
}

const MAIN_MANIFEST_TAG = '<link rel="manifest" href="/manifest.webmanifest">';

async function withManifest(res: Response, path: string): Promise<Response> {
  const href = manifestFor(path);
  if (href === "/manifest.webmanifest") return res;
  const html = (await res.text()).replace(MAIN_MANIFEST_TAG, `<link rel="manifest" href="${href}">`);
  return new Response(html, { status: res.status, statusText: res.statusText, headers: res.headers });
}

registerRoute(
  new NavigationRoute(navigationHandler, {
    denylist: [
      /^\/api\//,
      // Signed media links (WP-7.5) — a file, never the app shell.
      /^\/m\//,
      /^\/uploads\//,
      // The Android app download — a file, never the app shell.
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

// ----- Share target: "Share → Promptly Notes" -----
// Text or a link shared into the installed Notes app becomes a note. The
// share is a POST so the words never sit in a URL; the page makes the note
// (it works offline too, from the outbox).
self.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "POST" || url.pathname !== "/notes/share-target") return;
  event.respondWith(
    (async () => {
      try {
        const form = await event.request.formData();
        const str = (k: string) => {
          const v = form.get(k);
          return typeof v === "string" ? v.slice(0, 20_000) : "";
        };
        await stashSharedText({ title: str("title"), text: str("text"), url: str("url") });
      } catch {
        // Nothing usable arrived — still open Notes.
      }
      return Response.redirect("/notes/?shared=1", 303);
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
  /** Buttons on the notification ("Going", "Done", "Snooze 1 hour"): each
   * carries a signed token the worker POSTs to ``/api/notifications/action``
   * (it has no sign-in of its own). See ``app/notifications/actions.py``. */
  actions?: { action: string; title: string; token: string }[];
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
      // Platforms without notification buttons (iOS, some desktops) just
      // show the notification; tapping it opens the link as always.
      const maxActions = (Notification as unknown as { maxActions?: number }).maxActions ?? 2;
      const buttons = (payload.actions ?? []).slice(0, maxActions);
      const options = {
        body,
        actions: buttons.map((a) => ({ action: a.action, title: a.title })),
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
          tokens: Object.fromEntries(buttons.map((a) => [a.action, a.token])),
        },
      } as NotificationOptions;
      await self.registration.showNotification(title, options);
    })(),
  );
});

/** A notification's button: do it in the background and say so briefly;
 * if it can't be done (expired, gone, offline), open the app instead. */
async function runAction(token: string, note: Notification): Promise<boolean> {
  try {
    const res = await fetch("/api/notifications/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      credentials: "omit",
    });
    if (!res.ok) return false;
    const out = (await res.json().catch(() => ({}))) as { message?: string };
    const tag = `${note.tag || "promptly"}:done`;
    await self.registration.showNotification(out.message || "Done", {
      tag,
      icon: "/pwa-192.png",
      badge: "/pwa-192.png",
      silent: true,
      data: { url: (note.data?.url as string) || "/" },
    } as NotificationOptions);
    // Clear the confirmation after a moment.
    await new Promise((r) => setTimeout(r, 4000));
    for (const n of await self.registration.getNotifications({ tag })) n.close();
    return true;
  } catch {
    return false;
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data ?? {};
  let url = (data.url as string) || "/";
  const token = event.action ? (data.tokens as Record<string, string> | undefined)?.[event.action] : undefined;
  if (token) {
    event.waitUntil(
      runAction(token, event.notification).then(async (ok) => {
        if (!ok) await self.clients.openWindow(new URL(url, self.location.origin).href);
      }),
    );
    return;
  }

  event.waitUntil(
    (async () => {
      // Prefer focusing an already-open Promptly tab rather than
      // spawning a new one. Match by origin+path so "the tab already
      // on /workspaces" gets reused when a second push arrives.
      const wins = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Rooms, Calendar and Photos install as their own apps: a push for one goes to
      // a window already in that app, else opens fresh (so the installed
      // app, which owns that scope, handles it) — never hijacks Promptly.
      const target0 = new URL(url, self.location.origin);
      const scope = ["/rooms/", "/calendar/", "/photos/", "/passwords/", "/notes/"].find((s) => target0.pathname.startsWith(s) || target0.pathname === s.slice(0, -1)) ?? null;
      // "/calendar?event=…" → "/calendar/?event=…", inside the installed app's scope.
      if (scope && target0.pathname === scope.slice(0, -1)) url = scope + target0.search + target0.hash;
      const inScope = (w: WindowClient | Client) => {
        const p = new URL(w.url).pathname;
        return scope ? p.startsWith(scope) : !p.startsWith("/rooms/") && !p.startsWith("/calendar/") && !p.startsWith("/photos/") && !p.startsWith("/passwords") && !p.startsWith("/notes/");
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
