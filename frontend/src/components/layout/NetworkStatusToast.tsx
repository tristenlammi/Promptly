import { useEffect, useState } from "react";
import { CloudOff, Wifi } from "lucide-react";

import { cn } from "@/utils/cn";

/** Phase 5 — slim banner that fades in along the bottom of the
 *  viewport whenever the browser reports we're offline, and shows
 *  a brief "you're back online" pulse when connectivity returns.
 *
 *  Uses ``navigator.onLine`` + the ``online``/``offline`` events.
 *  These are best-effort signals (they reflect physical link state,
 *  not actual reachability of our backend) but are enough to give
 *  the user a heads-up that retries are likely to fail. The toast
 *  sits above the input bar via fixed positioning so it's visible
 *  during a send. Doesn't render at all when online and never
 *  having gone offline during this session, so SSR-style first
 *  paints stay clean. */
export function NetworkStatusToast() {
  const [online, setOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [showRecovered, setShowRecovered] = useState(false);

  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      setShowRecovered(true);
      const t = window.setTimeout(() => setShowRecovered(false), 2500);
      return () => window.clearTimeout(t);
    };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  if (online && !showRecovered) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed inset-x-0 bottom-3 z-40 flex justify-center px-3",
        "pb-safe"
      )}
    >
      <div
        className={cn(
          "pointer-events-auto inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-sm",
          "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
          online
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-amber-600 dark:text-amber-400"
        )}
      >
        {online ? (
          <Wifi className="h-3.5 w-3.5" />
        ) : (
          <CloudOff className="h-3.5 w-3.5" />
        )}
        <span>
          {online
            ? "You're back online."
            : "You're offline. New messages won't send until you're back."}
        </span>
      </div>
    </div>
  );
}
