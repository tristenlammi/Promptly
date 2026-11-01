import { useState, type ReactNode } from "react";
import { CheckCircle2, Download, MoreVertical, Share, SquarePlus, X } from "lucide-react";

import { OpenInBrowserGuide } from "@/components/pwa/OpenInBrowserGuide";
import { appKeyFor, launchedAppKey, useInstallPrompt } from "@/lib/installPrompt";
import { cn } from "@/utils/cn";

export interface InstallPromptCardProps {
  /** e.g. "Promptly Photos". */
  appName: string;
  /** The app's home-screen icon (a 192px PNG is plenty). */
  iconSrc: string;
  /** One line under the title. */
  description?: string;
  /** Shows a close button when given. */
  onClose?: () => void;
  className?: string;
}

/**
 * "Install <app>" — works for any of Promptly's installable apps. The
 * caller makes sure the page's ``<link rel="manifest">`` is the app's own
 * (the browser installs whatever manifest the page links).
 *
 *  - inside this app, installed          → "You're using the app"
 *  - inside another installed app        → open it in the browser (guide)
 *  - the browser offered an install      → Install button (its dialog)
 *  - iPhone / iPad                       → Share → Add to Home Screen steps
 *  - otherwise (already installed, or the browser hasn't offered yet)
 *                                        → where to find it / browser menu
 */
export function InstallPromptCard({ appName, iconSrc, description, onClose, className }: InstallPromptCardProps) {
  const { canPrompt, installed, standalone, ios, prompt } = useInstallPrompt();
  const [outcome, setOutcome] = useState<"accepted" | "dismissed" | null>(null);

  let body: ReactNode;
  if (standalone && launchedAppKey() !== appKeyFor(location.pathname)) {
    // Inside a different installed app (e.g. Photos opened in Promptly's window).
    const here = new URL(location.href);
    here.searchParams.set("install", "1");
    body = <OpenInBrowserGuide appName={appName} url={here.pathname + here.search} />;
  } else if (standalone) {
    body = (
      <p className="flex items-center gap-1.5 text-sm text-[var(--text)]">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--accent-text)]" />
        You're using {appName} as an app.
      </p>
    );
  } else if (installed || outcome === "accepted") {
    body = (
      <p className="flex items-center gap-1.5 text-sm text-[var(--text)]">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--accent-text)]" />
        Installed. Open {appName} from your home screen or app list.
      </p>
    );
  } else if (canPrompt) {
    body = (
      <button
        type="button"
        onClick={async () => {
          const r = await prompt();
          if (r !== "unavailable") setOutcome(r);
        }}
        className="inline-flex h-10 items-center gap-2 rounded-xl bg-[var(--accent)] px-4 text-sm font-semibold text-white hover:opacity-90"
      >
        <Download className="h-4 w-4" /> Install {appName}
      </button>
    );
  } else if (ios) {
    body = (
      <ol className="flex flex-col gap-1.5 text-sm text-[var(--text)]">
        <li className="flex flex-wrap items-center gap-1.5">
          1. In Safari, tap <Share className="h-4 w-4" aria-label="Share" /> <b>Share</b>.
        </li>
        <li className="flex flex-wrap items-center gap-1.5">
          2. Choose <SquarePlus className="h-4 w-4" aria-hidden /> <b>Add to Home Screen</b>, then <b>Add</b>.
        </li>
      </ol>
    );
  } else {
    body = (
      <div className="flex flex-col gap-1.5 text-sm text-[var(--text-muted)]">
        <p>
          {outcome === "dismissed" ? "Changed your mind? " : ""}
          If {appName} is already installed, open it from your home screen or app list — or use your
          browser's <q>Open in app</q> button in the address bar.
        </p>
        <p className="flex flex-wrap items-center gap-1">
          Otherwise open the browser menu <MoreVertical className="h-4 w-4" aria-label="menu" /> and choose{" "}
          <b className="text-[var(--text)]">Install app</b> or <b className="text-[var(--text)]">Add to Home screen</b>.
        </p>
      </div>
    );
  }

  return (
    <section
      aria-label={`Install ${appName}`}
      className={cn("relative flex gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm", className)}
    >
      <img src={iconSrc} alt="" className="h-14 w-14 shrink-0 rounded-2xl" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="pr-6">
          <h2 className="text-base font-semibold text-[var(--text)]">Install {appName}</h2>
          <p className="text-xs text-[var(--text-muted)]">
            {description ?? "Its own icon and window, straight from your home screen."}
          </p>
        </div>
        {body}
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </section>
  );
}
