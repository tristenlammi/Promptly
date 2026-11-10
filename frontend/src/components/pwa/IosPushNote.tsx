import { BellRing, X } from "lucide-react";
import { useState } from "react";

import { IosHomeScreenSteps } from "@/components/layout/WelcomeDialog";
import { useInstallPrompt } from "@/lib/installPrompt";
import { cn } from "@/utils/cn";

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** iPhone and iPad only send notifications to a web app added to the Home
 *  Screen, so in Safari push is "unsupported". Rather than hide the
 *  notifications prompt silently, say how to get them. Renders nothing
 *  anywhere else (or once dismissed, when ``dismissKey`` is given). */
export function IosPushNote({
  appName = "Promptly",
  what = "message alerts",
  dismissKey,
  className,
}: {
  appName?: string;
  what?: string;
  dismissKey?: string;
  className?: string;
}) {
  const { ios, standalone } = useInstallPrompt();
  const [hidden, setHidden] = useState(() => (dismissKey ? readFlag(dismissKey) : false));
  if (!ios || standalone || hidden) return null;
  return (
    <div
      className={cn("relative rounded-xl bg-[var(--surface-2)] p-3 text-sm text-[var(--text)]", dismissKey && "pr-9", className)}
      data-testid="ios-push-note"
    >
      {dismissKey && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => {
            setHidden(true);
            try {
              localStorage.setItem(dismissKey, "1");
            } catch {
              // Comes back next time in private mode.
            }
          }}
          className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      <p className="flex items-start gap-2">
        <BellRing className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-text)]" aria-hidden />
        <span>
          Add {appName} to your Home Screen to get {what} on this {/ipad/i.test(navigator.userAgent) ? "iPad" : "iPhone"}.
        </span>
      </p>
      <details className="mt-1.5">
        <summary className="cursor-pointer text-xs font-medium text-[var(--accent-text)]">Show me how</summary>
        <div className="mt-2">
          <IosHomeScreenSteps />
          <p className="mt-2 text-xs text-[var(--text-muted)]">Then open it from the Home Screen and turn on notifications.</p>
        </div>
      </details>
    </div>
  );
}
