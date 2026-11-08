import { useEffect, useRef } from "react";
import { Menu } from "lucide-react";
import { useLocation } from "react-router-dom";

import { useIsMobile } from "@/hooks/useIsMobile";
import { useUIStore } from "@/store/uiStore";
import { cn } from "@/utils/cn";

import { Sidebar } from "./Sidebar";

/**
 * Promptly's phone menu for an app that draws its own full-screen phone
 * layout (Rooms, Maps) while it's open inside Promptly: the same drawer and
 * sidebar AppLayout slides in, opened by ``PromptlyMenuButton``. Inside
 * AppLayout the button opens AppLayout's own drawer, so this isn't mounted
 * there. Never mounted when the app runs as its own installed app.
 */
export function PromptlyNavDrawer() {
  const isMobile = useIsMobile();
  const open = useUIStore((s) => s.mobileNavOpen);
  const close = useUIStore((s) => s.closeMobileNav);
  const location = useLocation();
  const ref = useRef<HTMLDivElement | null>(null);

  // Following a link in it drops you into the page.
  useEffect(() => {
    close();
  }, [location.pathname, location.search, close]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!open) el.setAttribute("inert", "");
    else el.removeAttribute("inert");
  }, [open, isMobile]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!isMobile) return null;
  return (
    <>
      <div
        onClick={close}
        aria-hidden="true"
        className={cn(
          "fixed inset-0 z-[60] bg-black/40 backdrop-blur-[1px] transition-opacity duration-200",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      />
      <div
        ref={ref}
        role="dialog"
        aria-label="Navigation menu"
        aria-modal
        aria-hidden={!open}
        className={cn(
          "fixed inset-y-0 left-0 z-[61] shadow-xl transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <Sidebar collapsed={false} onToggle={close} />
      </div>
    </>
  );
}

/** Opens Promptly's phone menu (AppLayout's drawer, or PromptlyNavDrawer).
 *  Phones only; the same button TopNav shows. */
export function PromptlyMenuButton({ className }: { className?: string }) {
  const isMobile = useIsMobile();
  const openMobileNav = useUIStore((s) => s.openMobileNav);
  if (!isMobile) return null;
  return (
    <button
      type="button"
      onClick={openMobileNav}
      aria-label="Open navigation menu"
      className={cn(
        "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]",
        className
      )}
    >
      <Menu className="h-5 w-5" />
    </button>
  );
}
