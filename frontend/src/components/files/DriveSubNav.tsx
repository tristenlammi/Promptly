import { useLocation, useSearchParams, NavLink } from "react-router-dom";

import { DRIVE_SUBNAV_ITEMS } from "@/components/layout/navItems";
import { cn } from "@/utils/cn";

import { StorageUsageIndicator } from "./StorageUsageIndicator";

/**
 * Sub-nav strip rendered under ``TopNav`` on every Drive surface.
 * Each tab is a plain ``NavLink`` so URLs are deep-linkable — the
 * separate "Promptly Files" PWA uses this component verbatim and
 * just points ``start_url`` at ``/files``.
 *
 * On the right side this strip also hosts the live storage-usage
 * pill (compact on mobile, verbose on desktop — see
 * ``StorageUsageIndicator``). A separate "install Files as its
 * own PWA" indicator used to live here too but was removed as
 * redundant with the main Promptly install prompt; the manifest
 * infrastructure is still in place so Chrome's overflow-menu
 * "Install app" still targets the Files PWA on ``/files*``.
 *
 * On mobile the whole row scrolls horizontally so both the tabs and
 * the right-side chips always stay reachable instead of truncating.
 */
export function DriveSubNav({ className }: { className?: string }) {
  const location = useLocation();
  const [params] = useSearchParams();
  // Always reveal the Search tab on mobile so touch users have a
  // single-tap entrypoint to search (the desktop TopNav search box
  // is hidden at ``md-``). On desktop we also show it whenever the
  // user is on the search surface or has a pending query.
  const onSearchPage = location.pathname.startsWith("/files/search");
  const hasQuery = !!params.get("q");
  const items = DRIVE_SUBNAV_ITEMS.filter((it) => {
    if (it.to !== "/files/search") return true;
    return onSearchPage || hasQuery;
  });
  return (
    <div
      className={cn(
        // ``pl/pr-safe`` ensures the row clears the iOS notch / rounded
        // corners when the user opens Drive in landscape on a phone.
        "flex items-center gap-1 overflow-x-auto border-b border-[var(--border)] py-2",
        "pl-[max(env(safe-area-inset-left,0),0.75rem)] pr-[max(env(safe-area-inset-right,0),0.75rem)] md:px-6",
        "bg-[var(--surface)]/50 backdrop-blur-sm",
        "[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden",
        className
      )}
    >
      {/* Dedicated mobile Search tab that never filters out — ensures
          touch users always have a visible entrypoint to the search
          surface even before any query is present. Hidden on md+ to
          keep the desktop rhythm identical to before. */}
      <NavLink
        to="/files/search"
        className={({ isActive }) =>
          cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition md:hidden",
            isActive
              ? "bg-[var(--accent)]/10 text-[var(--text)] font-medium"
              : "text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
          )
        }
        aria-label="Search Drive"
      >
        <DriveSearchIcon />
        <span className="sr-only">Search</span>
      </NavLink>

      {items.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.exact}
            className={({ isActive }) =>
              cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition",
                isActive
                  ? "bg-[var(--accent)]/10 text-[var(--text)] font-medium"
                  : "text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
              )
            }
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{item.label}</span>
          </NavLink>
        );
      })}
      {/* Pushes the right-side chips to the far edge. ``ml-auto`` on
          the spacer rather than the chips themselves keeps the
          overflow scroller behaving correctly on tight screens. */}
      <div className="ml-auto" />
      <StorageUsageIndicator />
    </div>
  );
}

/** Inline Search icon — import inlined to avoid adding a top-level
 *  dependency on lucide when the rest of the file would otherwise
 *  only use ``NavLink``. */
function DriveSearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}
