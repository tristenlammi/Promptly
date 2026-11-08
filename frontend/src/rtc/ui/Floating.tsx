/**
 * A small floating panel (a person's menu, the signal details): next to an
 * element or at the pointer (right-click), kept on screen. Focus moves in
 * and comes back; Escape or a click outside closes it; ↑/↓ move between
 * its buttons.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/utils/cn";

import { VOICE_ACCENT_STYLE } from "./bits";

export function Floating({
  open,
  onClose,
  anchor,
  point,
  width = 280,
  label,
  children,
  className,
  placement = "auto",
  zIndex = 90,
}: {
  open: boolean;
  onClose: () => void;
  anchor?: HTMLElement | null;
  point?: { x: number; y: number } | null;
  width?: number;
  label: string;
  children: ReactNode;
  className?: string;
  /** "right": beside the anchor (lists); "auto": above or below it. */
  placement?: "auto" | "right";
  /** Above something that sits higher (the call screen). */
  zIndex?: number;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const back = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const el = panel.current;
      const h = el?.offsetHeight ?? 240;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.min(width, vw - 16);
      let left: number;
      let top: number;
      if (point) {
        left = point.x;
        top = point.y;
      } else if (anchor) {
        const r = anchor.getBoundingClientRect();
        if (placement === "right" && r.right + 8 + w <= vw) {
          left = r.right + 8;
          top = r.top;
        } else {
          left = r.left;
          top = r.bottom + h + 6 > vh && r.top - h - 6 > 0 ? r.top - h - 6 : r.bottom + 6;
        }
      } else {
        left = (vw - w) / 2;
        top = (vh - h) / 2;
      }
      setPos({ left: Math.max(8, Math.min(vw - w - 8, left)), top: Math.max(8, Math.min(vh - h - 8, top)) });
    };
    place();
    // Again once it has its real height.
    const raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [open, anchor, point, width, placement]);

  useEffect(() => {
    if (!open) return;
    back.current = (document.activeElement as HTMLElement | null) ?? null;
    const t = window.setTimeout(() => {
      const first = panel.current?.querySelector<HTMLElement>("[data-autofocus], button:not([disabled]), input, [tabindex='0']");
      first?.focus();
    }, 0);
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panel.current?.contains(target)) return;
      if (anchor?.contains(target)) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        closeRef.current();
        return;
      }
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && panel.current?.contains(document.activeElement)) {
        const active = document.activeElement as HTMLElement;
        if (active.tagName === "INPUT" && (active as HTMLInputElement).type === "range") return;
        const items = Array.from(panel.current.querySelectorAll<HTMLElement>("button:not([disabled]), input"));
        const at = items.indexOf(active);
        if (at < 0) return;
        e.preventDefault();
        items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      // Back to where you were, if it's still there.
      const el = back.current;
      if (el && document.contains(el)) window.setTimeout(() => el.focus({ preventScroll: true }), 0);
    };
  }, [open, anchor]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      style={{ ...VOICE_ACCENT_STYLE, position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: Math.min(width, window.innerWidth - 16), zIndex }}
      className={cn(
        "overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-lg)]",
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}
