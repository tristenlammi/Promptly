import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";

import { SearchPalette } from "@/components/chat/SearchPalette";
import { UploadProgressPanel } from "@/components/files/UploadProgressPanel";
import { UploadQueueWatcher } from "@/components/files/UploadQueueWatcher";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useComposerStore } from "@/store/composerStore";
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
          onToggle={isMobile ? closeMobileNav : () => setCollapsed((v) => !v)}
        />
      </div>

      <div className="flex h-full min-w-0 flex-1 flex-col">
        <Outlet />
      </div>

      <NetworkStatusToast />
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
