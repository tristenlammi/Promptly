import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

const CHECK_EVERY_MS = 10 * 60 * 1000;

/**
 * "Promptly was updated — Reload". After an update, open tabs kept running
 * the old bundle against the new API until someone happened to reload
 * (R-247). This polls the build's ``/version.json`` (on load, every ten
 * minutes, and whenever the tab comes back into view) and offers a reload
 * when it no longer matches the version this tab was built as. Non-blocking
 * — a half-written message isn't lost unless you choose to reload.
 *
 * A lazy-loaded chunk that no longer exists on the server (it was replaced
 * by the update) reloads the page instead of leaving a broken screen.
 */
export function UpdateBanner() {
  const [newVersion, setNewVersion] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const check = async () => {
      try {
        const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
        if (res.ok) {
          const { version } = (await res.json()) as { version?: string };
          if (!stopped && version && version !== __APP_VERSION__) setNewVersion(version);
        }
      } catch {
        // Offline or mid-restart — try again next time.
      }
      navigator.serviceWorker
        ?.getRegistration()
        .then((reg) => reg?.update())
        .catch(() => {});
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    const onPreloadError = (e: Event) => {
      e.preventDefault();
      window.location.reload();
    };
    void check();
    const id = window.setInterval(check, CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("vite:preloadError", onPreloadError);
    return () => {
      stopped = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("vite:preloadError", onPreloadError);
    };
  }, []);

  if (!newVersion) return null;
  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-[80] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-full border border-[var(--border)] bg-[var(--surface)] py-1.5 pl-4 pr-1.5 text-sm text-[var(--text)] shadow-lg"
    >
      <span className="truncate">Promptly was updated to v{newVersion}.</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white hover:opacity-90"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        Reload
      </button>
    </div>
  );
}
