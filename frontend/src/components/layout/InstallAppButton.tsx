import { Download } from "lucide-react";
import { Link } from "react-router-dom";

import { useInstallPrompt } from "@/lib/installPrompt";
import { cn } from "@/utils/cn";

const CLS = cn(
  "mb-1 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-[var(--accent-text)] transition",
  "hover:bg-[var(--accent)]/10"
);

/** Phase 5 — "Install Promptly" PWA prompt button.
 *
 *  Shown once the browser has offered installation (its
 *  ``beforeinstallprompt``, caught at startup by ``lib/installPrompt`` —
 *  it can fire before this mounts). Safari/iOS never offers it, so there
 *  it's a link to Install apps, which shows the Share → Add to Home Screen
 *  steps (only in the browser, not in the Home Screen app). */
export function InstallAppButton() {
  const { canPrompt, installed, standalone, ios, prompt } = useInstallPrompt();
  if (installed || standalone) return null;
  if (ios) {
    return (
      <Link to="/apps/install#this-device" className={CLS} title="Add Promptly to your Home Screen">
        <Download className="h-4 w-4" />
        <span className="font-medium">Add to Home Screen</span>
      </Link>
    );
  }
  if (!canPrompt) return null;

  return (
    <button
      type="button"
      onClick={() => void prompt()}
      title="Install Promptly as an app"
      aria-label="Install Promptly"
      className={CLS}
    >
      <Download className="h-4 w-4" />
      <span className="font-medium">Install app</span>
    </button>
  );
}
