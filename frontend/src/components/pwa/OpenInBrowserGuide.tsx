import { useState } from "react";
import { Check, Copy, ExternalLink, MoreVertical, Share, SquarePlus } from "lucide-react";

import { isIosDevice, openInBrowser } from "@/lib/installPrompt";

/** Installing from inside an installed app: browsers only install from one
 *  of their own tabs, so open the page there and say what to tap next. */
export function OpenInBrowserGuide({ appName, url }: { appName: string; url: string }) {
  const [copied, setCopied] = useState(false);
  const full = new URL(url, location.href).href;
  const ios = isIosDevice();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(full);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link", full);
    }
  };
  return (
    <div className="flex flex-col gap-3 text-sm text-[var(--text)]">
      <p className="text-[var(--text-muted)]">
        You're inside the Promptly app — {appName} installs from your web browser.
      </p>
      <ol className="flex flex-col gap-1.5">
        <li>1. Open this page in your browser{ios ? " (Safari)" : ""}.</li>
        {ios ? (
          <li className="flex flex-wrap items-center gap-1.5">
            2. Tap <Share className="h-4 w-4" aria-label="Share" /> <b>Share</b> → <SquarePlus className="h-4 w-4" aria-hidden />{" "}
            <b>Add to Home Screen</b> → <b>Add</b>.
          </li>
        ) : (
          <li className="flex flex-wrap items-center gap-1">
            2. Tap <b>Install</b> on the card that opens — or the browser menu <MoreVertical className="h-4 w-4" aria-label="menu" /> →{" "}
            <b>Install app</b> / <b>Add to Home screen</b>.
          </li>
        )}
        <li>3. Open {appName} from your home screen.</li>
      </ol>
      <div className="flex flex-wrap gap-2">
        {!ios && (
          <button
            type="button"
            onClick={() => openInBrowser(url)}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-[var(--accent-strong)] px-4 text-sm font-semibold text-white hover:opacity-90"
          >
            <ExternalLink className="h-4 w-4" /> Open in browser
          </button>
        )}
        <button
          type="button"
          onClick={copy}
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--border)] px-4 text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)]"
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? "Copied" : "Copy link"}
        </button>
      </div>
      {ios && <p className="text-xs text-[var(--text-muted)]">iPhone apps can't open Safari for you — copy the link and paste it into Safari.</p>}
    </div>
  );
}
