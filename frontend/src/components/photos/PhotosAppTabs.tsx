import { useEffect, useState } from "react";
import {
  Archive,
  BookImage,
  Download,
  Eraser,
  FolderOpen,
  Heart,
  Home,
  Images,
  MapPin,
  Menu,
  MessageSquare,
  Search,
  Settings2,
  Smartphone,
  Sparkles,
  UsersRound,
  X,
} from "lucide-react";
import { Link, useLocation, useSearchParams } from "react-router-dom";

import { usePhotosBase, usePhotosPath } from "@/components/photos/photosPath";
import { cn } from "@/utils/cn";

/** Phone bottom tabs of the standalone Promptly Photos app:
 *  Photos · Albums · People · Search · More (everything else). */
export function PhotosAppTabs({ onSettings }: { onSettings: () => void }) {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const base = usePhotosBase();
  const photosPath = usePhotosPath();
  const [moreOpen, setMoreOpen] = useState(false);

  // Close the sheet on navigation.
  const search = params.toString();
  useEffect(() => setMoreOpen(false), [pathname, search]);
  // Escape closes it too.
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setMoreOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  const onTimeline = pathname === base || pathname === `${base}/`;
  const view = onTimeline ? params.get("view") || "all" : null;
  const under = (sub: string) => pathname.startsWith(photosPath(sub));
  const tabs = [
    { to: photosPath(), label: "Photos", icon: Images, active: view === "all" },
    { to: photosPath("/albums"), label: "Albums", icon: BookImage, active: under("/albums") },
    { to: photosPath("/people"), label: "People", icon: UsersRound, active: under("/people") },
    { to: photosPath("/search"), label: "Search", icon: Search, active: under("/search") },
  ];
  const anyTab = tabs.some((t) => t.active);
  const tab = "flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-xs";

  const more = [
    { to: photosPath("?view=favorites"), label: "Favourites", icon: Heart },
    { to: photosPath("?view=archive"), label: "Archive", icon: Archive },
    { to: photosPath("?view=family"), label: "Family", icon: Home },
    { to: photosPath("/places"), label: "Places & map", icon: MapPin },
    { to: photosPath("/cleanup"), label: "Clean up", icon: Eraser },
    { to: photosPath("/setup"), label: "Set up Photos", icon: Sparkles },
    { to: photosPath("?install=1"), label: "Install app", icon: Download },
  ];
  // Leaving Photos: these open the rest of Promptly.
  const elsewhere = [
    { to: "/files/home", label: "Promptly Files", icon: FolderOpen },
    { to: "/chat", label: "Promptly", icon: MessageSquare },
  ];
  const row = "flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-[var(--text)] hover:bg-[var(--hover)]";

  return (
    <>
      <nav
        aria-label="Photos tabs"
        className="flex shrink-0 items-end border-t border-[var(--border)] bg-[var(--surface)] pb-safe pl-safe pr-safe"
      >
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <Link
              key={t.label}
              to={t.to}
              aria-current={t.active ? "page" : undefined}
              className={cn(tab, t.active ? "text-[var(--accent-text)]" : "text-[var(--text-muted)]")}
            >
              <Icon className="h-5 w-5" />
              {t.label}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          className={cn(tab, !anyTab ? "text-[var(--accent-text)]" : "text-[var(--text-muted)]")}
        >
          <Menu className="h-5 w-5" />
          More
        </button>
      </nav>
      {moreOpen && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/40" onClick={() => setMoreOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label="More"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85dvh] w-full overflow-y-auto rounded-t-2xl border-t border-[var(--border)] bg-[var(--surface)] p-2 pb-safe"
          >
            <div className="flex items-center justify-between px-3 py-2">
              <h2 className="text-sm font-semibold text-[var(--text)]">More</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setMoreOpen(false)}
                className="flex h-10 w-10 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <ul className="flex flex-col">
              {more.map((m) => {
                const Icon = m.icon;
                return (
                  <li key={m.label}>
                    <Link to={m.to} className={row}>
                      <Icon className="h-4 w-4 text-[var(--text-muted)]" /> {m.label}
                    </Link>
                  </li>
                );
              })}
              <li>
                <button
                  type="button"
                  className={cn(row, "w-full text-left")}
                  onClick={() => {
                    setMoreOpen(false);
                    onSettings();
                  }}
                >
                  <Settings2 className="h-4 w-4 text-[var(--text-muted)]" /> Photos settings
                </button>
              </li>
              <li>
                <button
                  type="button"
                  className={cn(row, "w-full text-left")}
                  onClick={() => {
                    setMoreOpen(false);
                    onSettings();
                  }}
                >
                  <Smartphone className="h-4 w-4 text-[var(--text-muted)]" /> Phone backup
                </button>
              </li>
            </ul>
            <p className="px-3 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Open</p>
            <ul className="flex flex-col">
              {elsewhere.map((m) => {
                const Icon = m.icon;
                return (
                  <li key={m.label}>
                    <Link to={m.to} className={row}>
                      <Icon className="h-4 w-4 text-[var(--text-muted)]" /> {m.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
