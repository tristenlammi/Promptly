import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/utils/cn";

import "./photos.css";

/**
 * A small menu that opens under a button (Photos' "More" menus). Escape or
 * a click outside closes it; the arrow keys move through it. It is drawn
 * above everything (the photo viewer included), so a scrolling row never
 * clips it. A stand-in until the shared Menu arrives.
 */
export function PopMenu({
  open,
  anchor,
  onClose,
  label,
  children,
  dark = false,
}: {
  open: boolean;
  /** The button it hangs from. */
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  label: string;
  children: ReactNode;
  /** Over the photo viewer: always dark. */
  dark?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    if (!open) {
      setAt(null);
      return;
    }
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (r) setAt({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, anchor]);

  useEffect(() => {
    if (!open) return;
    const back = anchor.current;
    const items = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    const t = window.setTimeout(() => items()[0]?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Only the menu closes, not the dialog or viewer behind it.
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        back?.focus?.();
        return;
      }
      if (e.key === "Tab") {
        closeRef.current();
        return;
      }
      const move = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (!move && e.key !== "Home" && e.key !== "End") return;
      const list = items();
      if (!list.length) return;
      e.preventDefault();
      e.stopPropagation();
      const i = list.indexOf(document.activeElement as HTMLElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : (i + move + list.length) % list.length;
      list[next]?.focus();
    };
    const onDown = (e: PointerEvent) => {
      const el = e.target as Node;
      if (ref.current?.contains(el) || anchor.current?.contains(el)) return;
      closeRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [open, anchor]);

  if (!open || !at) return null;
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      style={{ top: at.top, right: at.right }}
      className={cn(
        "photos-pop-in fixed z-[80] min-w-48 max-w-[calc(100vw-16px)] origin-top-right rounded-xl border py-1 text-sm shadow-xl",
        dark ? "border-white/15 bg-neutral-900 text-white" : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
      )}
    >
      {children}
    </div>,
    document.body,
  );
}

/** One row of a PopMenu: 40px tall, so it is easy to tap. */
export function PopMenuItem({
  icon,
  children,
  onSelect,
  danger = false,
  current = false,
  dark = false,
  disabled = false,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  /** The page you are on. */
  current?: boolean;
  dark?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      aria-current={current ? "page" : undefined}
      onClick={onSelect}
      className={cn(
        "flex min-h-10 w-full items-center gap-2.5 px-3 text-left outline-none disabled:opacity-50",
        dark ? "hover:bg-white/10 focus-visible:bg-white/10" : "hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)]",
        danger && "text-red-500",
        current && "font-medium",
      )}
    >
      {icon && (
        <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center", !danger && (dark ? "text-white/70" : "text-[var(--text-muted)]"))}>
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}
