import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/utils/cn";

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A dialog over a note (the recorder, the Photos picker, a picture full
 * size). It answers Escape and Tab itself, before the note around it does,
 * so closing it never closes the note; and it counts as "inside" for the
 * composer (``data-note-pop``). A sheet from the bottom on a phone.
 */
export function Sheet({
  title,
  onClose,
  children,
  footer,
  width = "max-w-md",
  bare = false,
  className,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  /** No header or padding (the picture viewer draws its own). */
  bare?: boolean;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => {
      if (box.current?.contains(document.activeElement)) return;
      (box.current?.querySelector<HTMLElement>("[data-autofocus]") ?? box.current?.querySelector<HTMLElement>(FOCUSABLE) ?? box.current)?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      // A menu inside this sheet handles its own Escape.
      // Only while focus is in this sheet (a menu or confirm over it answers its own keys).
      const active = document.activeElement;
      if (active && active !== document.body && !box.current?.parentElement?.contains(active)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !box.current) return;
      e.stopPropagation();
      const els = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (!els.length) {
        e.preventDefault();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      const at = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (at === first || !box.current.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey, true);
      if (back && document.body.contains(back)) back.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div data-note-pop="" className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:px-4">
      <button type="button" aria-label="Close" tabIndex={-1} onClick={() => closeRef.current()} className="note-fade-in absolute inset-0 bg-black/50" />
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={bare ? undefined : titleId}
        aria-label={bare ? title : undefined}
        tabIndex={-1}
        className={cn(
          "note-sheet-in relative flex max-h-[92dvh] w-full flex-col overflow-hidden bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-lg)] outline-none",
          "rounded-t-2xl pb-[env(safe-area-inset-bottom,0px)] sm:rounded-2xl sm:pb-0",
          width,
          className,
        )}
      >
        {!bare && (
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-5 py-3">
            <h2 id={titleId} className="min-w-0 flex-1 truncate text-base font-semibold">
              {title}
            </h2>
            <button type="button" onClick={() => closeRef.current()} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        <div className={cn("min-h-0 flex-1 overflow-y-auto", !bare && "px-5 py-4")}>{children}</div>
        {footer && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border)] px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
