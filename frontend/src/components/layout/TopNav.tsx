import type { ReactNode } from "react";
import { Menu } from "lucide-react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { useUIStore } from "@/store/uiStore";
import { cn } from "@/utils/cn";

interface TopNavProps {
  /** Rendered inside an <h1>. Strings are truncated; pass a ReactNode for
   *  interactive titles (e.g. an inline-editable input). */
  title: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
}

export function TopNav({ title, subtitle, actions, className }: TopNavProps) {
  const titleIsString = typeof title === "string";
  const isMobile = useIsMobile();
  const openMobileNav = useUIStore((s) => s.openMobileNav);

  return (
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
            aria-label="Open navigation menu"
            className={cn(
              "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
              "text-[var(--text-muted)] transition",
              "hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
            )}
          >
            <Menu className="h-5 w-5" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h1
            className={cn(
              "text-sm font-semibold tracking-tight",
              titleIsString && "truncate"
            )}
          >
            {title}
          </h1>
          {subtitle && (
            <p className="truncate text-xs text-[var(--text-muted)]">{subtitle}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
