import { Suspense, useLayoutEffect, useRef, useState } from "react";
import { Archive, BookImage, Eraser, Heart, Home, Images, Loader2, MapPin, Search, Settings2, Upload, UsersRound } from "lucide-react";
import { Link, Outlet, useLocation, useSearchParams } from "react-router-dom";

import { PhotoSettingsDialog } from "@/components/photos/PhotoSettingsDialog";
import { PhotosAppTabs } from "@/components/photos/PhotosAppTabs";
import { usePhotosBase, usePhotosPath } from "@/components/photos/photosPath";
import { RouteBoundary } from "@/components/system/RouteBoundary";
import { useIsMobile } from "@/hooks/useIsMobile";
import { UnderstandingStatus } from "@/components/photos/UnderstandingStatus";
import { useUploadStore } from "@/store/uploadStore";
import { cn } from "@/utils/cn";

/** The Photos menu, on every Photos page (the timeline, albums, people,
 *  places and the map, clean-up, search…) — it stays put while you move
 *  between them; each page's own title and tools sit below it. */

const VIEWS = [
  { id: "all", label: "Photos", icon: Images },
  { id: "favorites", label: "Favourites", icon: Heart },
  { id: "archive", label: "Archive", icon: Archive },
  { id: "family", label: "Family", icon: Home },
] as const;

// Sub-paths under the Photos base (``/files/photos`` or ``/photos``).
const SECTIONS = [
  { sub: "/albums", label: "Albums", icon: BookImage },
  { sub: "/people", label: "People", icon: UsersRound },
  // The map lives under Places (its List / Map switch).
  { sub: "/places", label: "Places", icon: MapPin, also: "/map" },
  { sub: "/cleanup", label: "Clean up", icon: Eraser },
] as const;

// Search and Settings sit by Upload, always in view.
const iconButton = (active: boolean) =>
  cn(
    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition",
    active ? "bg-[var(--accent-soft)] text-[var(--accent-text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]",
  );

const pill = (active: boolean) =>
  cn(
    "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-xs transition",
    active ? "bg-[var(--accent-soft)] font-medium text-[var(--accent-text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]",
  );

/** ``app``: inside the standalone Promptly Photos app — on a phone the menu
 *  row gives way to bottom tabs (PhotosAppTabs). */
export function PhotosShell({ app = false }: { app?: boolean } = {}) {
  const { pathname } = useLocation();
  const base = usePhotosBase();
  const photosPath = usePhotosPath();
  const isPhone = useIsMobile();
  const phoneApp = app && isPhone;
  const [params] = useSearchParams();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Uploads go into the Photos folder, by the month each was taken.
  const uploadInput = useRef<HTMLInputElement>(null);
  const startUploads = useUploadStore((s) => s.startUploads);
  const onTimeline = pathname === base || pathname === `${base}/`;
  // The menu shows icons only when its labels don't fit the space it has
  // (the sidebar, the window) — then labels again once they would.
  const nav = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  const labelledWidth = useRef(0);
  useLayoutEffect(() => {
    const el = nav.current;
    if (!el) return;
    const check = () => {
      if (!compact && el.scrollWidth > el.clientWidth + 1) {
        labelledWidth.current = el.scrollWidth;
        setCompact(true);
      } else if (compact && labelledWidth.current && el.clientWidth >= labelledWidth.current) {
        setCompact(false);
      }
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [compact, phoneApp]);
  const view = onTimeline ? params.get("view") || "all" : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* One row that never wraps: the title, the menu (scrolling sideways
          on a narrow window), then Upload — in the same place on every page. */}
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
        {/* The page's heading on the timeline; elsewhere the page below has
            its own (Albums, People…). */}
        {onTimeline ? (
          <h1 className="mr-2 shrink-0 text-base font-semibold text-[var(--text)]">Photos</h1>
        ) : (
          <Link to={photosPath()} className="mr-2 shrink-0 text-base font-semibold text-[var(--text)]">
            Photos
          </Link>
        )}
        {phoneApp && <span className="flex-1" />}
        <nav
          ref={nav}
          aria-label="Photos"
          className={cn("min-w-0 flex-1 gap-0.5 overflow-x-auto [scrollbar-width:none]", phoneApp ? "hidden" : "flex")}
        >
          {VIEWS.map((v) => {
            const Icon = v.icon;
            return (
              <Link
                key={v.id}
                to={v.id === "all" ? photosPath() : photosPath(`?view=${v.id}`)}
                aria-current={view === v.id ? "page" : undefined}
                title={v.label}
                className={pill(view === v.id)}
              >
                <Icon className="h-3.5 w-3.5" />
                {/* Icons only when the labels don't fit — every item alike. */}
                <span className={compact ? "sr-only" : undefined}>{v.label}</span>
              </Link>
            );
          })}
          {SECTIONS.map((s) => {
            const to = photosPath(s.sub);
            const active = pathname.startsWith(to) || ("also" in s && pathname.startsWith(photosPath(s.also)));
            const Icon = s.icon;
            return (
              <Link key={s.sub} to={to} aria-current={active ? "page" : undefined} title={s.label} className={pill(active)}>
                <Icon className="h-3.5 w-3.5" />
                <span className={compact ? "sr-only" : undefined}>{s.label}</span>
              </Link>
            );
          })}
        </nav>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <span className="mr-1.5 inline-flex">
            <UnderstandingStatus />
          </span>
          {/* On a phone in the app, Search and Settings live in the tabs. */}
          {!phoneApp && (
            <>
              <Link
                to={photosPath("/search")}
                aria-label="Search photos"
                title="Search photos"
                aria-current={pathname.startsWith(photosPath("/search")) ? "page" : undefined}
                className={iconButton(pathname.startsWith(photosPath("/search")))}
              >
                <Search className="h-4 w-4" />
              </Link>
              <button
                type="button"
                aria-label="Photos settings"
                title="Photos settings"
                onClick={() => setSettingsOpen(true)}
                className={iconButton(false)}
              >
                <Settings2 className="h-4 w-4" />
              </button>
            </>
          )}
          <input
            ref={uploadInput}
            type="file"
            multiple
            accept="image/*,video/*,.heic,.heif,.dng,.mov"
            className="hidden"
            aria-hidden
            tabIndex={-1}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length) startUploads({ files, scope: "mine", folderId: null, route: "camera" });
            }}
          />
          <button
            type="button"
            onClick={() => uploadInput.current?.click()}
            className="flex items-center gap-1.5 whitespace-nowrap rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white"
          >
            <Upload className="h-3.5 w-3.5" /> Upload
          </button>
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* In Files, AppLayout's boundary catches a page's chunk loading;
            the standalone app has none above it, so it brings its own. */}
        {app ? (
          <RouteBoundary>
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading…
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </RouteBoundary>
        ) : (
          <Outlet />
        )}
      </div>
      {phoneApp && <PhotosAppTabs onSettings={() => setSettingsOpen(true)} />}
      {settingsOpen && <PhotoSettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
