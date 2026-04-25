import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";

import { SearchPalette } from "@/components/chat/SearchPalette";
import { UploadProgressPanel } from "@/components/files/UploadProgressPanel";
import { UploadQueueWatcher } from "@/components/files/UploadQueueWatcher";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useUIStore } from "@/store/uiStore";
import { cn } from "@/utils/cn";

import { NetworkStatusToast } from "./NetworkStatusToast";
import { Sidebar } from "./Sidebar";

export function AppLayout() {
  const isMobile = useIsMobile();
  // Desktop-only collapse state. Untouched on mobile so the desktop UX
  // stays exactly as it was before the mobile work.
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();

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

  // Global Ctrl/Cmd+K to open the search palette. We intentionally
  // *don't* suppress the shortcut while the user is typing in an
  // input/textarea — Cmd+K inside the composer should still pop the
  // palette the same way it does in ChatGPT / Linear, and we verify
  // the key + modifier in one place rather than per-component.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        if (e.key === "k" || e.key === "K") {
          e.preventDefault();
          openSearchPalette();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openSearchPalette]);

  // Desktop path is byte-identical to the pre-mobile layout: static
  // sidebar with its own collapse toggle, sitting next to the outlet.
  if (!isMobile) {
    return (
      <div className="flex h-screen w-screen overflow-hidden bg-[var(--bg)] text-[var(--text)]">
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <Outlet />
        </div>
        <NetworkStatusToast />
        <SearchPalette
          open={searchPaletteOpen}
          onClose={closeSearchPalette}
        />
        {/* Drive upload panel only renders on ``/files*`` routes —
            the panel itself short-circuits when no uploads are in
            flight, so these two tags are zero-cost everywhere else.
            The watcher is always mounted so completion events fire
            query invalidations even if the user is on ``/chat`` when
            an upload finishes. */}
        <UploadQueueWatcher />
        <UploadProgressPanel />
      </div>
    );
  }

  // Mobile: sidebar is hidden out of the flow entirely. The hamburger
  // lives inside the page TopNav (rendered by each page) and writes to
  // useUIStore. The drawer overlays the content from the left when open.
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <Outlet />
      </div>

      {/* Backdrop — click to dismiss. ``aria-hidden`` because focus
          trapping is handled by the drawer itself. */}
      <div
        onClick={closeMobileNav}
        aria-hidden="true"
        className={cn(
          "fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px]",
          "transition-opacity duration-200",
          mobileNavOpen ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      />

      {/* Drawer panel. Reuses the existing Sidebar component verbatim
          so the mobile menu and desktop sidebar stay in lockstep. The
          on-board collapse button is rebound to ``closeMobileNav`` so
          tapping it dismisses the drawer instead of switching to the
          (irrelevant on mobile) icon-only mode. */}
      <aside
        role="dialog"
        aria-label="Navigation menu"
        aria-modal="true"
        aria-hidden={!mobileNavOpen}
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-[85vw] max-w-[320px] shadow-xl",
          "transition-transform duration-200 ease-out",
          mobileNavOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <Sidebar collapsed={false} onToggle={closeMobileNav} />
      </aside>

      <NetworkStatusToast />
      <SearchPalette open={searchPaletteOpen} onClose={closeSearchPalette} />
      <UploadQueueWatcher />
      <UploadProgressPanel />
    </div>
  );
}
