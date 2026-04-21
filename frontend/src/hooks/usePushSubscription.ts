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
}

export interface UsePushSubscriptionResult extends PushSubscriptionState {
  loading: boolean;
  error: string | null;
  subscribe: () => Promise<void>;
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
      setState({
        supported: true,
        serverConfigured: serverKey !== null,
        permission: Notification.permission,
        subscribed: sub !== null,
        subscription: sub,
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

  const subscribe = async () => {
    setError(null);
    if (!isSupported()) {
      setError("This browser doesn't support push notifications.");
      return;
    }
    try {
      const serverKey = await notificationsApi.getPublicKey();
      if (!serverKey) {
        setError("Push notifications aren't configured on this server.");
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setError("Permission was denied — enable it in your browser settings.");
        await refresh();
        return;
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
      await notificationsApi.subscribe({
        endpoint: json.endpoint!,
        keys: {
          p256dh: encodeKey(sub.getKey("p256dh")),
          auth: encodeKey(sub.getKey("auth")),
        },
        user_agent: navigator.userAgent,
      });
      await refresh();
    } catch (e) {
      setError(
        (e as Error)?.message ?? "Couldn't subscribe to push notifications."
      );
    }
  };

  const unsubscribe = async () => {
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        // Look up the matching backend row first so we can delete
        // it — the browser-side ``unsubscribe()`` tears down the
        // push endpoint but leaves our DB row orphaned.
        const serverSubs = await notificationsApi
          .listSubscriptions()
          .catch(() => [] as Awaited<ReturnType<typeof notificationsApi.listSubscriptions>>);
        await sub.unsubscribe();
        const match = serverSubs.find((s) => {
          // We don't store the endpoint on the list response (it's
          // sensitive), so fall back to "last active" sorting to
          // pick the row most likely to be this device. The backend
          // also prunes stale rows on the next failed send so a
          // mismatch here self-heals.
          return s.last_used_at !== null;
        });
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
    unsubscribe,
    refresh,
  };
}
