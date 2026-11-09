import { Suspense, useEffect, useRef, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { InstallFromLink } from "@/components/pwa/InstallFromLink";
import { RouteBoundary } from "@/components/system/RouteBoundary";

import { SearchPalette } from "@/components/chat/SearchPalette";
import { UploadProgressPanel } from "@/components/files/UploadProgressPanel";
import { UploadQueueWatcher } from "@/components/files/UploadQueueWatcher";
import { useIsMobile } from "@/hooks/useIsMobile";
import { appKeyFor } from "@/lib/appLaunch";
import { useComposerStore } from "@/store/composerStore";
import { authApi } from "@/api/auth";
import { useAuthStore } from "@/store/authStore";
import { useUIStore } from "@/store/uiStore";
import { cn } from "@/utils/cn";

import { NetworkStatusToast } from "./NetworkStatusToast";
import { WelcomeAppsDialog } from "./WelcomeAppsDialog";
import { Sidebar } from "./Sidebar";

/** ``children`` stands in for the route's ``<Outlet>`` — for a page that
 *  also runs on its own as an installed app and is wrapped here only when
 *  it's open inside Promptly (App.tsx's gates). */
export function AppLayout({ children }: { children?: ReactNode } = {}) {
  const isMobile = useIsMobile();
  // Desktop-only: the sidebar stays as you left it, on every page and device
  // (saved to your account), until you change it.
  const collapsed = useAuthStore((s) => !!s.user?.settings?.sidebar_collapsed);
  const patchSettings = useAuthStore((s) => s.patchSettings);
  const toggleCollapsed = () => {
    const next = !collapsed;
    patchSettings({ sidebar_collapsed: next });
    void authApi.updatePreferences({ sidebar_collapsed: next }).catch(() => patchSettings({ sidebar_collapsed: !next }));
  };
  const location = useLocation();
  const navigate = useNavigate();

  const mobileNavOpen = useUIStore((s) => s.mobileNavOpen);
  const closeMobileNav = useUIStore((s) => s.closeMobileNav);
  const searchPaletteOpen = useUIStore((s) => s.searchPaletteOpen);
  const openSearchPalette = useUIStore((s) => s.openSearchPalette);
  const closeSearchPalette = useUIStore((s) => s.closeSearchPalette);

  // Auto-close the drawer whenever navigation actually happens, so
  // tapping a chat / nav item drops the user back into the content.
  useEffect(() => {
    if (isMobile) closeMobileNav();
  }, [location.pathname, location.search, isMobile, closeMobileNav]);

  // ``?search=1`` opens the search palette on arrival: the Passwords page's
  // copy of the sidebar can't run it, so its Search links here.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get("search") !== "1") return;
    openSearchPalette();
    const next = new URLSearchParams(searchParams);
    next.delete("search");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, openSearchPalette]);

  // Global Ctrl/Cmd+K to open the search palette. We intentionally
  // *don't* suppress the shortcut while the user is typing in an
  // input/textarea — Cmd+K inside the composer should still pop the
  // palette the same way it does in ChatGPT / Linear, and we verify
  // the key + modifier in one place rather than per-component.
  useEffect(() => {
    const isEditableTarget = (el: EventTarget | null): boolean => {
      const node = el as HTMLElement | null;
      if (!node) return false;
      const tag = node.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        node.isContentEditable
      );
    };
    const handler = (e: KeyboardEvent) => {
      // A more specific surface (e.g. the workspace command palette)
      // may have claimed the shortcut in the capture phase — yield.
      if (e.defaultPrevented) return;
      const mod = e.ctrlKey || e.metaKey;
      // Ctrl/Cmd+K — global search palette (works even while typing).
      if (mod && !e.shiftKey && !e.altKey) {
        if (e.key === "k" || e.key === "K") {
          e.preventDefault();
          openSearchPalette();
          return;
        }
      }
      // Ctrl/Cmd+Shift+O — start a new chat (mirrors ChatGPT).
      if (mod && e.shiftKey && !e.altKey && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        navigate("/chat");
        // Focus the composer right after the new-chat route mounts.
        window.setTimeout(
          () => useComposerStore.getState().requestComposerFocus(),
          0
        );
        return;
      }
      // "/" — jump focus to the composer (unless already typing in a
      // field). preventDefault so the slash itself isn't inserted; the
      // user can then type their message or a "/" slash command.
      if (
        !mod &&
        !e.altKey &&
        e.key === "/" &&
        !isEditableTarget(e.target)
      ) {
        e.preventDefault();
        useComposerStore.getState().requestComposerFocus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openSearchPalette, navigate]);

  // Single layout tree for both form factors. Only class names (and a
  // couple of a11y attrs) differ between mobile and desktop — the
  // ``<Outlet>`` and the ``<Sidebar>`` keep the *same* position in the
  // element tree across the 768px breakpoint, so crossing it (phone
  // rotation, desktop window resize) re-styles rather than remounts.
  // That preserves chat scroll position and in-flight component state
  // that the old two-tree split used to wipe.
  // The phone drawer: Escape closes it, and while closed it's inert — its
  // links were still reachable by Tab and screen readers (R-095).
  const drawerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = drawerRef.current;
    if (!el) return;
    if (isMobile && !mobileNavOpen) el.setAttribute("inert", "");
    else el.removeAttribute("inert");
  }, [isMobile, mobileNavOpen]);
  useEffect(() => {
    if (!isMobile || !mobileNavOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) closeMobileNav();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, mobileNavOpen]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      {/* Mobile-only backdrop. Inert (and hidden) on desktop. */}
      <div
        onClick={closeMobileNav}
        aria-hidden="true"
        className={cn(
          "fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px] transition-opacity duration-200",
          isMobile && mobileNavOpen
            ? "opacity-100"
            : "pointer-events-none opacity-0",
          !isMobile && "hidden"
        )}
      />

      {/* Sidebar host. Desktop: an in-flow flex column that takes the
          sidebar's own width. Mobile: a fixed slide-in drawer that
          overlays the content. The hosted <Sidebar> is the same element
          either way, so it never remounts on a breakpoint change. */}
      <div
        ref={drawerRef}
        role={isMobile ? "dialog" : undefined}
        aria-label={isMobile ? "Navigation menu" : undefined}
        aria-modal={isMobile ? true : undefined}
        aria-hidden={isMobile ? !mobileNavOpen : undefined}
        className={cn(
          isMobile
            ? cn(
                "fixed inset-y-0 left-0 z-50 shadow-xl transition-transform duration-200 ease-out",
                mobileNavOpen ? "translate-x-0" : "-translate-x-full"
              )
            : "relative h-full shrink-0"
        )}
      >
        <Sidebar
          collapsed={isMobile ? false : collapsed}
          onToggle={isMobile ? closeMobileNav : toggleCollapsed}
        />
      </div>

      {/* The page's own content — the one "main" landmark (PH-7 a11y). */}
      <main id="main" className="flex h-full min-w-0 flex-1 flex-col">
        {/* Route components are code-split (see App.tsx), so a first visit
            to a page fetches its chunk. The boundary sits *here* rather
            than around the whole router on purpose: the sidebar stays put
            and only the content area shows the pending state, so navigation
            doesn't blank the app. */}
        <RouteBoundary>
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading…
              </div>
            }
          >
            {children ?? <Outlet />}
            <LayoutInstallCard />
          </Suspense>
        </RouteBoundary>
      </main>

      <NetworkStatusToast />
      <WelcomeAppsDialog />
      <SearchPalette open={searchPaletteOpen} onClose={closeSearchPalette} />
      {/* Drive upload panel only renders on ``/files*`` routes — it
          short-circuits when no uploads are in flight, so it's zero-cost
          elsewhere. The watcher is always mounted so completion events
          fire query invalidations even from other routes. */}
      <UploadQueueWatcher />
      <UploadProgressPanel />
    </div>
  );
}

/** The install card for ``?install=1``, named for whichever app this
 *  address installs as (the page links that app's manifest, and the browser
 *  installs whatever it links). An Item Store app's page shows its own. */
const INSTALL_CARDS: Record<string, { appName: string; iconSrc: string; description: string }> = {
  promptly: { appName: "Promptly", iconSrc: "/pwa-192.png", description: "Promptly as its own app, with its own icon and window." },
  rooms: {
    appName: "Promptly Rooms",
    iconSrc: "/item-icons/rooms-192.png",
    description: "Chat with your family and friends — spaces, rooms and messages as their own app.",
  },
  calendar: {
    appName: "Promptly Calendar",
    iconSrc: "/item-icons/calendar-192.png",
    description: "Your calendar, shared with family and friends, as its own app.",
  },
  mail: { appName: "Mail", iconSrc: "/item-icons/mail-192.png", description: "All your mailboxes in one calm place, as its own app." },
  maps: { appName: "P Maps", iconSrc: "/item-icons/maps-192.png", description: "Maps and directions on your own Promptly, as its own app." },
  photos: {
    appName: "Promptly Photos",
    iconSrc: "/pwa-photos-192.png",
    description: "Your photo library as its own app — its own icon and window, no Promptly menus.",
  },
};

function LayoutInstallCard() {
  const { pathname } = useLocation();
  const card = INSTALL_CARDS[appKeyFor(pathname)];
  return card ? <InstallFromLink {...card} /> : null;
}
