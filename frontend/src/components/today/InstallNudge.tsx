import { Download, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useInstallPrompt } from "@/lib/installPrompt";

const KEY = "promptly.today.install-nudge.dismissed";

function dismissedBefore(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Today's "put Promptly on this device" link, for people using it in a
 *  browser tab. Never shown inside the installed app; hides for good on ×. */
export function InstallNudge() {
  const { standalone, installed, ios } = useInstallPrompt();
  const [hidden, setHidden] = useState(dismissedBefore);
  if (standalone || installed || hidden) return null;

  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      // Private mode: it just comes back next time.
    }
  };

  return (
    <div
      className="mb-4 flex items-center gap-3 rounded-card border border-[var(--accent)]/40 bg-[var(--surface)] px-4 py-3"
      data-testid="today-install-nudge"
    >
      <Download className="h-5 w-5 shrink-0 text-[var(--accent-text)]" aria-hidden />
      <p className="min-w-0 flex-1 text-sm text-[var(--text)]">
        {ios ? "Add Promptly to your Home Screen" : "Install Promptly on this device"} — it opens like an app and can
        send you message alerts.{" "}
        <Link to="/apps/install#this-device" className="font-medium text-[var(--accent-text)] hover:underline">
          Show me how
        </Link>
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Hide this"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--hover)]"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
