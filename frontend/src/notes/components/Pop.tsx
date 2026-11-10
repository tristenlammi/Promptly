import { Check } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/utils/cn";

/**
 * A small panel under the button that opened it (colours, the ⋯ menu,
 * labels). Escape or a tap outside closes it, and focus goes back to the
 * button. Escape is stopped here, so the note around it stays open.
 */
export function Pop({
  anchor,
  onClose,
  children,
  label,
  width = 240,
  role = "dialog",
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  label: string;
  width?: number;
  role?: "dialog" | "menu";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(width, vw - 16);
    let left = Math.min(Math.max(8, r.left), vw - w - 8);
    let top = r.bottom + 6;
    if (top + h > vh - 8) top = Math.max(8, r.top - h - 6);
    if (vw < 480) left = Math.max(8, (vw - w) / 2);
    setAt({ left, top });
  }, [anchor, width]);

  useEffect(() => {
    const back = anchor;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      closeRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    const raf = requestAnimationFrame(() => {
      const first = ref.current?.querySelector<HTMLElement>("[data-autofocus], [role=menuitem], button, input");
      first?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
      if (back && document.body.contains(back)) back.focus({ preventScroll: true });
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      data-note-pop=""
      role={role}
      aria-label={label}
      onKeyDown={(e) => {
        if (role !== "menu" || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
        const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
        const i = items.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }}
      style={{ left: at?.left ?? -9999, top: at?.top ?? -9999, width: Math.min(width, window.innerWidth - 16) }}
      className={cn("fixed z-[70] rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5 text-[var(--text)] shadow-[var(--shadow-lg)]", at && "note-pop-in")}
    >
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({ icon: Icon, children, onClick, danger, checked }: { icon?: React.ComponentType<{ className?: string }>; children: ReactNode; onClick: () => void; danger?: boolean; checked?: boolean }) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-none",
        danger ? "text-[var(--danger)]" : "text-[var(--text)]",
      )}
    >
      {Icon && <Icon className="h-4 w-4 shrink-0 opacity-80" />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {checked && <Check className="h-4 w-4 shrink-0 text-[var(--accent-text)]" aria-hidden />}
    </button>
  );
}
