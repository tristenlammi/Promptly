import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/utils/cn";

export interface ContextMenuItem {
  icon?: ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

interface ContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  onClose: () => void;
  items: ContextMenuItem[];
}

const MENU_MIN_WIDTH = 176;

/**
 * Floating context menu rendered into a portal so it isn't clipped by parent
 * overflow. Position is clamped to the viewport so it never opens off-screen.
 */
export function ContextMenu({ open, x, y, onClose, items }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    if (!open) return;
    const el = ref.current;
    const margin = 8;
    const w = el?.offsetWidth ?? MENU_MIN_WIDTH;
    const h = el?.offsetHeight ?? 200;
    const maxX = window.innerWidth - w - margin;
    const maxY = window.innerHeight - h - margin;
    setPos({
      x: Math.min(Math.max(margin, x), Math.max(margin, maxX)),
      y: Math.min(Math.max(margin, y), Math.max(margin, maxY)),
    });
  }, [open, x, y]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[60]" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div
        ref={ref}
        role="menu"
        style={{ top: pos.y, left: pos.x, minWidth: MENU_MIN_WIDTH }}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
        className="absolute overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)] py-1 text-sm shadow-xl"
      >
        {items.map((it, i) => (
          <button
            key={`${it.label}-${i}`}
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return;
              onClose();
              it.onClick();
            }}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left transition",
              it.disabled
                ? "cursor-not-allowed text-[var(--text-muted)] opacity-60"
                : it.destructive
                  ? "text-red-600 hover:bg-red-500/10 dark:text-red-400"
                  : "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
            )}
          >
            {it.icon && <span className="shrink-0">{it.icon}</span>}
            <span className="truncate">{it.label}</span>
          </button>
        ))}
      </div>
    </div>,
    document.body
  );
}
