import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Download, Loader2, Share } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { extractError } from "@/components/files/helpers";
import { TopNav } from "@/components/layout/TopNav";
import { OpenInBrowserGuide } from "@/components/pwa/OpenInBrowserGuide";
import { isStandaloneDisplay } from "@/lib/installPrompt";
import { toast } from "@/store/toastStore";

import { itemsApi } from "./api";
import "./ui/items.css";

/** ``/apps/install`` — every part of Promptly that installs as its own app
 *  (Promptly itself, Photos, and each app in the launcher), in one
 *  place.
 *
 *  A browser only offers to install the app whose page is open (its
 *  manifest and scope), so "Install" opens that app's own page with
 *  ``?install=1``; the install card there does the rest (Chrome / Edge /
 *  Android prompt, iPhone "Add to Home Screen" steps). */

interface Installable {
  id: string;
  name: string;
  blurb: string;
  icon: string;
  /** A page inside the app's scope; ``install=1`` is added for the card. */
  href: string | (() => Promise<string>);
}

const CORE: Installable[] = [
  {
    id: "promptly",
    name: "Promptly",
    blurb: "Chat, workspaces and everything else — the whole of Promptly.",
    icon: "/pwa-192.png",
    href: "/chat",
  },
  {
    id: "photos",
    name: "Promptly Photos",
    blurb: "Your photo library — albums, people, places and search.",
    icon: "/pwa-photos-192.png",
    href: "/photos/",
  },
  {
    id: "rooms",
    name: "Promptly Rooms",
    blurb: "Chat with your family and friends — spaces, rooms and messages.",
    icon: "/item-icons/rooms-192.png",
    href: "/rooms/",
  },
  {
    id: "calendar",
    name: "Promptly Calendar",
    blurb: "Your calendar, shared with family and friends — events, invites and reminders.",
    icon: "/item-icons/calendar-192.png",
    href: "/calendar/",
  },
];

function withInstall(href: string): string {
  return href + (href.includes("?") ? "&" : "?") + "install=1";
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function InstallAppsPage() {
  const navigate = useNavigate();
  const { data: apps, isLoading } = useQuery({ queryKey: ["apps-launcher"], queryFn: itemsApi.launcher });
  const [busy, setBusy] = useState<string | null>(null);
  // Inside an installed app a page just opens in the same app window, where
  // the browser won't offer an install: hand it to the browser instead.
  const [handoff, setHandoff] = useState<{ row: Installable; url: string } | null>(null);

  const appRows: Installable[] = (apps ?? []).map((a) => ({
    id: `item:${a.kind}`,
    name: a.name,
    blurb: a.tagline,
    icon: `/item-icons/${a.kind}-192.png`,
    // Each app installs from its own file's page (/app/<file>/).
    href: async () => `/app/${(await itemsApi.openApp(a.kind)).file_id}/`,
  }));

  const go = async (row: Installable, install: boolean) => {
    setBusy(row.id + (install ? ":i" : ":o"));
    try {
      const href = typeof row.href === "string" ? row.href : await row.href();
      if (install && isStandaloneDisplay()) {
        setHandoff({ row, url: withInstall(href) });
        setBusy(null);
        return;
      }
      // A full page load: the browser must read that app's manifest.
      window.location.assign(install ? withInstall(href) : href);
    } catch (err) {
      toast.error(extractError(err));
      setBusy(null);
    }
  };

  const rowEl = (row: Installable) => (
    <li key={row.id} className="flex items-center gap-3 px-4 py-3">
      <img src={row.icon} alt="" className="h-12 w-12 shrink-0 rounded-2xl shadow-[var(--shadow-sm)]" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-[var(--text)]">{row.name}</p>
        <p className="line-clamp-2 text-xs text-[var(--text-muted)]">{row.blurb}</p>
      </div>
      <button
        type="button"
        onClick={() => go(row, false)}
        aria-label={`Open ${row.name}`}
        title="Open"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
      >
        <ArrowUpRight className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => go(row, true)}
        disabled={busy !== null}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 text-sm font-semibold text-white disabled:opacity-60"
      >
        {busy === row.id + ":i" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        Install
      </button>
    </li>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopNav title="Install apps" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
          <p className="text-sm text-[var(--text-muted)]">
            Put any part of Promptly on your home screen or desktop as its own app — its own icon and window, with no
            Promptly menus around it. Everything stays in your Promptly, so search and chats still see it.
          </p>
          {isIos() && (
            <p className="flex items-start gap-2 rounded-2xl bg-[var(--surface)] px-4 py-3 text-sm text-[var(--text)]">
              <Share className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" />
              <span>
                On iPhone and iPad: tap Install, then in Safari tap <b>Share</b> → <b>Add to Home Screen</b> on the page
                that opens.
              </span>
            </p>
          )}

          <section className="flex flex-col gap-2">
            <h2 className="px-1 text-sm font-semibold text-[var(--text)]">Promptly</h2>
            <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
              {CORE.map(rowEl)}
            </ul>
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="px-1 text-sm font-semibold text-[var(--text)]">Your apps</h2>
            {isLoading ? (
              <div className="flex justify-center py-8 text-[var(--text-muted)]">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : appRows.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[var(--border)] px-4 py-6 text-center text-sm text-[var(--text-muted)]">
                Apps you add from the store show up here too.{" "}
                <button type="button" onClick={() => navigate("/apps/store")} className="font-medium text-[var(--accent-text)]">
                  Get apps
                </button>
              </div>
            ) : (
              <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
                {appRows.map(rowEl)}
              </ul>
            )}
          </section>
        </div>
      </div>
      {handoff && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={() => setHandoff(null)}>
          <div
            role="dialog"
            aria-label={`Install ${handoff.row.name}`}
            className="flex w-full max-w-md flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <img src={handoff.row.icon} alt="" className="h-12 w-12 shrink-0 rounded-2xl" />
              <h2 className="flex-1 text-base font-semibold text-[var(--text)]">Install {handoff.row.name}</h2>
              <button type="button" onClick={() => setHandoff(null)} className="rounded-lg px-2 py-1 text-sm text-[var(--text-muted)] hover:bg-[var(--hover)]">
                Close
              </button>
            </div>
            <OpenInBrowserGuide appName={handoff.row.name} url={handoff.url} />
          </div>
        </div>
      )}
    </div>
  );
}
