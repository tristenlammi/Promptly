/**
 * The Promptly Android app showing notifications itself.
 *
 * On a linked phone the app registers with the push service on its own
 * (``android/app/.../push/NativePush.kt``) and shows what arrives as
 * "Promptly", with its own icon and sounds. Chrome on that phone may hold a
 * subscription too (from before, or from this page), and the phone would then
 * get everything twice. So the app's launchers open Promptly with
 * ``?np=<sha-256 of the app's push address>``, and this page marks Chrome's
 * own subscription as covered by it: the server sends to the app's only,
 * for as long as the app's is there (``notifications/devices.py::covered``).
 *
 * Imported early (``main.tsx``) to read the address before the router tidies it.
 */
import { notificationsApi } from "@/api/notifications";

const KEY = "promptly.android.push";
const HASH = /^[0-9a-f]{64}$/;

function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
}

/** Read what the app's launcher said about its own notifications. A launch
 *  from the app without ``np`` means it isn't doing them (any more). */
export function captureNativePush(): void {
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get("source") !== "android") return;
    const np = q.get("np") ?? "";
    if (HASH.test(np)) window.localStorage.setItem(KEY, np);
    else window.localStorage.removeItem(KEY);
  } catch {
    /* no storage: Chrome's notifications carry on */
  }
}

/** The app's registration on this phone (its address's SHA-256), or null. */
export function nativePushHash(): string | null {
  if (!isAndroid()) return null;
  try {
    const v = window.localStorage.getItem(KEY);
    return v && HASH.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** The page learned of the app's registration some other way (it just
 *  appeared in the device list after "Turn on"). */
export function rememberNativePush(hash: string): void {
  try {
    if (HASH.test(hash)) window.localStorage.setItem(KEY, hash);
  } catch {
    /* fine */
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Bring this browser's own subscription in line: covered by the app's while
 * the app shows notifications on this phone, on its own again when it
 * doesn't. Does nothing on anything but an Android phone, or when this
 * browser was never set up for notifications. Never throws.
 */
export async function syncNativePushCover(): Promise<void> {
  try {
    if (!isAndroid() || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const [mine, rows] = await Promise.all([sha256(sub.endpoint), notificationsApi.listSubscriptions()]);
    const row = rows.find((r) => r.endpoint_hash === mine);
    if (!row) return;
    const app = nativePushHash();
    if (app && !row.covered && rows.some((r) => r.app && r.endpoint_hash === app)) {
      await notificationsApi.setSubscriptionCover(row.id, app);
    } else if (!app && row.covered) {
      await notificationsApi.setSubscriptionCover(row.id, "");
    }
  } catch {
    /* offline, signed out: next time */
  }
}

/** ``intent://notifications?…``: hand a one-time code to the app, which
 *  asks, links the phone if it isn't, and registers. */
export function nativePushLink(code: string): string {
  const q = new URLSearchParams({ server: window.location.origin, code });
  return `intent://notifications?${q.toString()}#Intent;scheme=promptly;package=org.promptly.app;end`;
}

captureNativePush();
