import type { ReactNode } from "react";
import { Menu } from "lucide-react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { useUIStore } from "@/store/uiStore";
import { VoicePill } from "@/rtc/ui/VoicePill";
import { cn } from "@/utils/cn";

import { useDockCount } from "./dock/store";

interface TopNavProps {
  /** Rendered inside an <h1>. Strings are truncated; pass a ReactNode for
   *  interactive titles (e.g. an inline-editable input). */
  title: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
  /** ``"lg"`` gives the title real page-heading prominence — used where the
   *  header IS the page's primary title (e.g. a workspace), so the title
   *  doesn't have to be re-printed larger further down the page. Defaults to
   *  the compact size every other surface uses. */
  titleSize?: "default" | "lg";
}

export function TopNav({
  title,
  subtitle,
  actions,
  className,
  titleSize = "default",
}: TopNavProps) {
  const titleIsString = typeof title === "string";
  const isMobile = useIsMobile();
  const openMobileNav = useUIStore((s) => s.openMobileNav);
  // Something's happening now (a call, uploads, an event soon): the menu
  // button carries a dot, since the cards themselves are inside the menu.
  const happening = useDockCount();

  return (
    <>
    {/* Calls: on a phone, the "you're in voice" bar above every page. */}
    {isMobile && <VoicePill />}
    <header
      className={cn(
        // Phase 5 — pad the top safe-area inset (notch / status bar)
        // and the horizontal insets so the title stays readable in
        // landscape on devices with rounded corners. Uses padding
        // rather than translate so child layouts stay flush against
        // the bar without overlap.
        "flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4 pt-safe pl-safe pr-safe md:px-6",
        "border-[var(--border)] bg-[var(--bg)]",
        className
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {/* Hamburger is mobile-only. We deliberately render nothing at
            all on desktop so the existing layout is byte-identical. */}
        {isMobile && (
          <button
            type="button"
            onClick={openMobileNav}
            aria-label={happening > 0 ? "Open navigation menu. Something is happening now" : "Open navigation menu"}
            className={cn(
              "relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
              "text-[var(--text-muted)] transition",
              "hover:bg-[var(--hover)] hover:text-[var(--text)]"
            )}
          >
            <Menu className="h-5 w-5" />
            {happening > 0 && (
              <span aria-hidden="true" className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[var(--accent-strong)] ring-2 ring-[var(--bg)]" />
            )}
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h1
            className={cn(
              "font-semibold tracking-tight",
              titleSize === "lg"
                ? "text-lg leading-tight"
                : "text-sm",
              titleIsString && "truncate"
            )}
          >
            {title}
          </h1>
          {subtitle && (
            // Hidden on mobile — the active model is already represented
            // by the chevron in the top-right and a second header line
            // wastes vertical space on phones. Desktop still gets the
            // long "Provider · Model · Routing" subtitle.
            <p className="hidden truncate text-xs text-[var(--text-muted)] md:block">
              {subtitle}
            </p>
          )}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
    </>
  );
}
