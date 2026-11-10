import { Suspense, useLayoutEffect, useRef, useState } from "react";
import { Archive, BookImage, ChevronDown, Eraser, Heart, Home, Images, MapPin, Search, Settings2, Upload, UsersRound } from "lucide-react";
import { Link, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { PhotoSettingsDialog } from "@/components/photos/PhotoSettingsDialog";
import { PhotosAppTabs } from "@/components/photos/PhotosAppTabs";
import { PhotosDropZone } from "@/components/photos/photosDrop";
import { PopMenu, PopMenuItem } from "@/components/photos/PopMenu";
import { usePhotosBase, usePhotosPath } from "@/components/photos/photosPath";
import { RouteBoundary } from "@/components/system/RouteBoundary";
import { PromptlyMenuButton } from "@/components/layout/PromptlyNavDrawer";
import { useIsMobile } from "@/hooks/useIsMobile";
import { UnderstandingStatus } from "@/components/photos/UnderstandingStatus";
import { useUploadStore } from "@/store/uploadStore";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";
import { SkeletonTileGrid } from "@/components/shared/Skeleton";

/** The Photos menu, on every Photos page (the timeline, albums, people,
 *  places and the map, clean-up, search…) — it stays put while you move
 *  between them; each page's own title and tools sit below it. */

// Four places in the row; the rest wait under "More".
// Sub-paths under the Photos base (``/files/photos`` or ``/photos``).
const MAIN = [
  { key: "all", label: "Photos", icon: Images, sub: "" },
  { key: "albums", label: "Albums", icon: BookImage, sub: "/albums" },
  { key: "people", label: "Faces", icon: UsersRound, sub: "/people" },
  // The map lives under Places (its List / Map switch).
  { key: "places", label: "Places", icon: MapPin, sub: "/places", also: "/map" },
] as const;

const MORE = [
  { key: "favorites", label: "Favourites", icon: Heart, sub: "?view=favorites" },
  { key: "archive", label: "Archive", icon: Archive, sub: "?view=archive" },
  { key: "family", label: "Family", icon: Home, sub: "?view=family" },
  { key: "cleanup", label: "Clean up", icon: Eraser, sub: "/cleanup" },
] as const;

// Search and Settings sit by Upload, always in view.
const iconButton = (active: boolean) =>
  cn(
    "flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition sm:h-8 sm:w-8",
    active ? "bg-[var(--accent-soft)] text-[var(--accent-text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]",
  );

const pill = (active: boolean) =>
  cn(
    "flex min-h-10 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-xs transition sm:min-h-8",
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
  const navigate = useNavigate();
  const moreButton = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  // Which place you are in, by its key.
  const here =
    view ??
    (pathname.startsWith(photosPath("/albums"))
      ? "albums"
      : pathname.startsWith(photosPath("/people"))
        ? "people"
        : pathname.startsWith(photosPath("/places")) || pathname.startsWith(photosPath("/map"))
          ? "places"
          : pathname.startsWith(photosPath("/cleanup"))
            ? "cleanup"
            : null);
  const inMore = MORE.find((m) => m.key === here);
  const upload = (files: File[]) => {
    if (files.length) startUploads({ files, scope: "mine", folderId: null, route: "camera" });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* One row that never wraps: the title, the menu (scrolling sideways
          on a narrow window), then Upload — in the same place on every page. */}
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
        {/* Inside Promptly, its menu (phones; the sidebar is there on a big screen). */}
        {!app && <PromptlyMenuButton className="-ml-2" />}
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
          {MAIN.map((m) => {
            const Icon = m.icon;
            const active = here === m.key;
            return (
              <Link key={m.key} to={photosPath(m.sub)} aria-current={active ? "page" : undefined} title={m.label} className={pill(active)}>
                <Icon className="h-3.5 w-3.5" />
                {/* Icons only when the labels don't fit: every item alike. */}
                <span className={compact ? "sr-only" : undefined}>{m.label}</span>
              </Link>
            );
          })}
          {/* Favourites, Archive, Family and Clean up. While you're in one
              of them, the button wears its name. */}
          <button
            ref={moreButton}
            type="button"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            title={inMore ? `${inMore.label} (more places)` : "More places"}
            onClick={() => setMoreOpen((v) => !v)}
            className={pill(!!inMore)}
          >
            {inMore && <inMore.icon className="h-3.5 w-3.5" />}
            <span className={compact && inMore ? "sr-only" : undefined}>{inMore ? inMore.label : "More"}</span>
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <PopMenu open={moreOpen} anchor={moreButton} onClose={() => setMoreOpen(false)} label="More places">
            {MORE.map((m) => {
              const Icon = m.icon;
              return (
                <PopMenuItem
                  key={m.key}
                  icon={<Icon className="h-4 w-4" />}
                  current={here === m.key}
                  onSelect={() => {
                    setMoreOpen(false);
                    navigate(photosPath(m.sub));
                  }}
                >
                  {m.label}
                </PopMenuItem>
              );
            })}
          </PopMenu>
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
              upload(files);
            }}
          />
          <button
            type="button"
            onClick={() => uploadInput.current?.click()}
            className="flex min-h-10 items-center gap-1.5 whitespace-nowrap rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white hover:bg-[var(--accent-hover)] sm:min-h-8"
          >
            <Upload className="h-3.5 w-3.5" /> Upload
          </button>
        </span>
      </header>
      {/* Drop photos anywhere below the menu to upload them. */}
      <PhotosDropZone
        className="relative flex min-h-0 flex-1 flex-col"
        onFiles={upload}
        onNothing={() => toast.info("Only photos and videos can go in Photos.")}
      >
        {/* In Files, AppLayout's boundary catches a page's chunk loading;
            the standalone app has none above it, so it brings its own. */}
        {app ? (
          <RouteBoundary>
            <Suspense
              fallback={
<SkeletonTileGrid count={24} className="p-4" label="Loading" />
              }
            >
              <Outlet />
            </Suspense>
          </RouteBoundary>
        ) : (
          <Outlet />
        )}
      </PhotosDropZone>
      {phoneApp && <PhotosAppTabs onSettings={() => setSettingsOpen(true)} />}
      {settingsOpen && <PhotoSettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
