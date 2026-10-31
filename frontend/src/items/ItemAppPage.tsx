import { useQuery } from "@tanstack/react-query";
import { Download, Share, SquarePlus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { InstallFromLink } from "@/components/pwa/InstallFromLink";
import { useInstallPrompt } from "@/lib/installPrompt";


import { loadItemDoc } from "./api";
import { ItemPage } from "./ItemPage";

/**
 * ``/app/:fileId/`` — one item file as **its own installed app**: its own
 * name, icon and window (manifest scope ``/app/<id>/``), and none of
 * Promptly's navigation. It's the same file, saved in the same place, so
 * Promptly chats and search still see everything.
 *
 * In a normal browser tab it offers to install itself (Chrome/Edge/Android
 * via the browser's prompt; iPhone/iPad with Share → Add to Home Screen).
 */
export function ItemAppPage() {
  const { fileId = "" } = useParams<{ fileId: string }>();
  const { data: doc } = useQuery({
    queryKey: ["item", fileId],
    queryFn: () => loadItemDoc(fileId),
    staleTime: Infinity,
    gcTime: 0,
  });

  // This page's install identity: manifest, iOS icon/title, window colour.
  useEffect(() => {
    if (!doc?.spec) return;
    const kind = doc.kind;
    const q = new URLSearchParams({ id: doc.file_id, name: doc.title });
    setHead('link[rel="manifest"]', "link", { rel: "manifest", href: `/api/items/app/${kind}/manifest.webmanifest?${q}` });
    setHead('link[rel="apple-touch-icon"]', "link", { rel: "apple-touch-icon", href: `/item-icons/${kind}-apple-180.png` });
    setHead('meta[name="apple-mobile-web-app-title"]', "meta", { name: "apple-mobile-web-app-title", content: doc.title.slice(0, 30) });
    setHead('meta[name="apple-mobile-web-app-capable"]', "meta", { name: "apple-mobile-web-app-capable", content: "yes" });
    setHead('meta[name="theme-color"]', "meta", { name: "theme-color", content: doc.spec.color });
    const before = document.title;
    document.title = doc.title;
    return () => {
      document.title = before;
    };
  }, [doc]);

  return (
    <div className="flex h-[100dvh] flex-col bg-[var(--bg)]">
      {doc && <InstallBanner name={doc.title} color={doc.spec?.color ?? "var(--accent)"} kind={doc.kind} />}
      {doc && (
        <InstallFromLink
          appName={doc.title}
          iconSrc={`/item-icons/${doc.kind}-192.png`}
          description="Its own icon and window, with no Promptly menus. It's still saved in your Promptly."
        />
      )}
      <div className="min-h-0 flex-1">
        <ItemPage standalone />
      </div>
    </div>
  );
}

function setHead(selector: string, tag: "link" | "meta", attrs: Record<string, string>) {
  let el = document.head.querySelector<HTMLElement>(selector);
  if (!el) {
    el = document.createElement(tag);
    document.head.appendChild(el);
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (el.getAttribute(k) !== v) el.setAttribute(k, v);
  }
}

const DISMISS_KEY = "promptly.items.installDismissed:";

/** "Install <name>" — only in a browser tab, never inside the installed app. */
function InstallBanner({ name, color, kind }: { name: string; color: string; kind: string }) {
  // The browser's offer is caught at startup (lib/installPrompt) — it can
  // fire before this mounts.
  const { canPrompt, installed, standalone, ios, prompt } = useInstallPrompt();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY + kind) === "1";
    } catch {
      return false;
    }
  });
  const [iosHelp, setIosHelp] = useState(false);

  if (standalone || installed || dismissed) return null;
  if (!canPrompt && !ios) return null;

  const close = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY + kind, "1");
    } catch {
      /* private mode */
    }
  };

  return (
    <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 pt-safe">
      <div className="mx-auto flex max-w-3xl items-center gap-3">
        <img src={`/item-icons/${kind}-192.png`} alt="" className="h-9 w-9 rounded-xl" style={{ background: color }} />
        <div className="min-w-0 flex-1 text-sm">
          <p className="truncate font-semibold text-[var(--text)]">Install {name} as an app</p>
          <p className="truncate text-xs text-[var(--text-muted)]">Its own icon and window — still saved in your Promptly.</p>
        </div>
        {canPrompt ? (
          <button
            type="button"
            onClick={() => void prompt()}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-white"
            style={{ background: color }}
          >
            <Download className="h-4 w-4" /> Install
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setIosHelp((v) => !v)}
            className="inline-flex h-9 items-center rounded-xl px-3 text-sm font-semibold text-white"
            style={{ background: color }}
          >
            How
          </button>
        )}
        <button type="button" onClick={close} aria-label="Not now" className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]">
          <X className="h-4 w-4" />
        </button>
      </div>
      {iosHelp && (
        <ol className="mx-auto mt-2 flex max-w-3xl flex-col gap-1 text-xs text-[var(--text)]">
          <li className="flex items-center gap-1.5">
            1. Tap <Share className="h-3.5 w-3.5" /> Share in Safari's toolbar.
          </li>
          <li className="flex items-center gap-1.5">
            2. Choose <SquarePlus className="h-3.5 w-3.5" /> Add to Home Screen, then Add.
          </li>
        </ol>
      )}
    </div>
  );
}
