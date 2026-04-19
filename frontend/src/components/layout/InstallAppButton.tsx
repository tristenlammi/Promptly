import { useEffect, useState } from "react";
import { Download } from "lucide-react";

import { cn } from "@/utils/cn";

/** Phase 5 — "Install Promptly" PWA prompt button.
 *
 *  Browsers fire ``beforeinstallprompt`` when the page meets the
 *  install criteria (manifest present, served over HTTPS, not
 *  already installed, etc.). We capture and stash the event,
 *  expose a button that calls ``.prompt()`` on it, and then hide
 *  the button after the user accepts or dismisses the native
 *  dialog. Safari/iOS doesn't fire the event at all — those
 *  users install via Share -> Add to Home Screen, so the button
 *  simply never renders for them, which is the right outcome.
 */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function InstallAppButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null
  );
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt as EventListener);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener(
        "beforeinstallprompt",
        onPrompt as EventListener
      );
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed || !deferred) return null;

  const onClick = async () => {
    try {
      await deferred.prompt();
      await deferred.userChoice;
    } finally {
      // Once the native dialog has been shown, the same event
      // can't be re-prompted; clear it so the button hides.
      setDeferred(null);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      title="Install Promptly as an app"
      aria-label="Install Promptly"
      className={cn(
        "mb-1 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-[var(--accent)] transition",
        "hover:bg-[var(--accent)]/10"
      )}
    >
      <Download className="h-4 w-4" />
      <span className="font-medium">Install app</span>
    </button>
  );
}
