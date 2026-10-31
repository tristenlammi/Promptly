import { Download } from "lucide-react";

import { useInstallPrompt } from "@/lib/installPrompt";
import { cn } from "@/utils/cn";

/** Phase 5 — "Install Promptly" PWA prompt button.
 *
 *  Shown once the browser has offered installation (its
 *  ``beforeinstallprompt``, caught at startup by ``lib/installPrompt`` —
 *  it can fire before this mounts). Safari/iOS never offers it; those
 *  users install via Share -> Add to Home Screen (or Apps › Install
 *  apps), so the button simply never renders for them. */
export function InstallAppButton() {
  const { canPrompt, installed, prompt } = useInstallPrompt();
  if (installed || !canPrompt) return null;

  return (
    <button
      type="button"
      onClick={() => void prompt()}
      title="Install Promptly as an app"
      aria-label="Install Promptly"
      className={cn(
        "mb-1 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-[var(--accent-text)] transition",
        "hover:bg-[var(--accent)]/10"
      )}
    >
      <Download className="h-4 w-4" />
      <span className="font-medium">Install app</span>
    </button>
  );
}
