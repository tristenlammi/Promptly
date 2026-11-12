import { useEffect, useState } from "react";

import { notificationsApi } from "@/api/notifications";

/** State of the browser's push-subscription machinery on this device.
 *
 * Covers the full permission + subscription lifecycle so the
 * Notifications panel can render one of a small set of obvious UI
 * states rather than juggling raw ``Notification.permission`` and
 * ``PushManager`` calls at render time.
 */
export interface PushSubscriptionState {
  supported: boolean;
  serverConfigured: boolean | null;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
  /** The raw browser ``PushSubscription`` — kept mostly so the caller
   * can call ``.endpoint`` if we ever surface "this device is id=
   * ..." diagnostics. */
  subscription: PushSubscription | null;
  /** This device's row in the device list (null: not subscribed, or the
   * server doesn't know it). */
  deviceId: string | null;
  /** This device's own switch. Phones and tablets start on, computers
   * start off; null when there's no row to read it from. */
  deviceEnabled: boolean | null;
}

/** What to say when a computer has allowed notifications but its switch
 * is still off. */
export const DEVICE_OFF_HINT =
  "Notifications are allowed here, but computers start switched off. Turn this one on in Account → Notifications.";

export interface UsePushSubscriptionResult extends PushSubscriptionState {
  loading: boolean;
  error: string | null;
  /** Resolves "on" when this device will now get notifications, "off"
   * when it's set up but its switch is off (a computer: see
   * ``DEVICE_OFF_HINT``), null when it couldn't be set up (``error``
   * says why). Never rejects. */
  subscribe: () => Promise<"on" | "off" | null>;
  /** Flip this device's own switch. */
  setDeviceEnabled: (enabled: boolean) => Promise<void>;
  unsubscribe: () => Promise<void>;
  /** Re-check the browser state after an external change (e.g. user
   * flipped site permission in chrome://settings). Not usually
   * needed but handy for debugging. */
  refresh: () => Promise<void>;
}

const isSupported = () =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

// Convert a base64url VAPID public key (what the server sends) into
// the raw ``Uint8Array`` the browser's ``pushManager.subscribe``
// needs.
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) output[i] = rawData.charCodeAt(i);
  return output;
}

/** SHA-256 hex of a push endpoint: how a page finds its own row in the
 * device list (the server never hands endpoints back). */
async function endpointHash(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(endpoint)
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** This device's row on the server, if it has one. */
async function ownRow(sub: PushSubscription | null) {
  if (!sub) return null;
  try {
    const [hash, rows] = await Promise.all([
      endpointHash(sub.endpoint),
      notificationsApi.listSubscriptions(),
    ]);
    return rows.find((r) => r.endpoint_hash === hash) ?? null;
  } catch {
    return null;
  }
}

function encodeKey(buf: ArrayBuffer | null | undefined): string {
  if (!buf) return "";
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function usePushSubscription(): UsePushSubscriptionResult {
  const [state, setState] = useState<PushSubscriptionState>({
    supported: false,
    serverConfigured: null,
    permission: "default",
    subscribed: false,
    subscription: null,
    deviceId: null,
    deviceEnabled: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!isSupported()) {
      setState((s) => ({ ...s, supported: false, permission: "unsupported" }));
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      // Probe the server once — a null return means "feature
      // unavailable" (VAPID not configured). We cache the flag so
      // repeated renders don't hammer the endpoint.
      const serverKey = await notificationsApi.getPublicKey().catch(() => null);
      const row = serverKey !== null ? await ownRow(sub) : null;
      setState({
        supported: true,
        serverConfigured: serverKey !== null,
        permission: Notification.permission,
        subscribed: sub !== null,
        subscription: sub,
        deviceId: row?.id ?? null,
        deviceEnabled: row ? row.enabled : null,
      });
    } catch (e) {
      setError(
        (e as Error)?.message ?? "Couldn't read notification state."
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // We don't subscribe to permission-change events because they
    // aren't reliably fired across browsers; the Notifications
    // panel re-queries on mount which is sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const subscribe = async (): Promise<"on" | "off" | null> => {
    setError(null);
    if (!isSupported()) {
      setError("This browser doesn't support push notifications.");
      return null;
    }
    try {
      const serverKey = await notificationsApi.getPublicKey();
      if (!serverKey) {
        setError("Push notifications aren't configured on this server.");
        return null;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setError("Permission was denied — enable it in your browser settings.");
        await refresh();
        return null;
      }
      const reg = await navigator.serviceWorker.ready;
      // Cast via ``BufferSource`` — TS 5.x tightened ``ArrayBufferLike``
      // vs ``ArrayBuffer`` in the DOM lib, which trips on the
      // ``Uint8Array`` we build from the VAPID key even though it's
      // the canonical shape browsers accept.
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(
          serverKey
        ) as unknown as BufferSource,
      });
      const json = sub.toJSON();
      const row = await notificationsApi.subscribe({
        endpoint: json.endpoint!,
        keys: {
          p256dh: encodeKey(sub.getKey("p256dh")),
          auth: encodeKey(sub.getKey("auth")),
        },
        user_agent: navigator.userAgent,
      });
      await refresh();
      return row.enabled === false ? "off" : "on";
    } catch (e) {
      setError(
        (e as Error)?.message ?? "Couldn't subscribe to push notifications."
      );
      return null;
    }
  };

  const setDeviceEnabled = async (enabled: boolean) => {
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const row = await ownRow(await reg.pushManager.getSubscription());
      if (!row) {
        setError("This device isn't set up for notifications yet.");
        return;
      }
      await notificationsApi.setSubscriptionEnabled(row.id, enabled);
      await refresh();
    } catch (e) {
      setError((e as Error)?.message ?? "Couldn't change this device.");
    }
  };

  const unsubscribe = async () => {
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        // Look up this device's own row first so we can delete it —
        // the browser-side ``unsubscribe()`` tears down the push
        // endpoint but leaves our DB row orphaned. (This used to guess
        // by "last used", which could remove a different device.)
        const match = await ownRow(sub);
        await sub.unsubscribe();
        if (match) {
          await notificationsApi.deleteSubscription(match.id);
        }
      }
      await refresh();
    } catch (e) {
      setError(
        (e as Error)?.message ?? "Couldn't unsubscribe from notifications."
      );
    }
  };

  return {
    ...state,
    loading,
    error,
    subscribe,
    setDeviceEnabled,
    unsubscribe,
    refresh,
  };
}
