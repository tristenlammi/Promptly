import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/utils/cn";

/**
 * A panel for one task — add a meal, edit a set, pick a date. On a phone it
 * slides up from the bottom (drag the handle down, or tap outside, to
 * close); on desktop it's a centred dialog. Escape closes it; focus moves in
 * and comes back.
 */
// Open sheets, oldest first: Escape closes only the top one (a sheet opened
// from a sheet used to close both).
const openStack: symbol[] = [];

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "full";
}) {
  const isPhone = useIsMobile();
  const isPhoneRef = useRef(isPhone);
  isPhoneRef.current = isPhone;
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLElement | null>(null);
  const [drag, setDrag] = useState(0);
  const startY = useRef<number | null>(null);
  // Read through a ref: a parent passing a fresh ``onClose`` each render
  // mustn't re-run the open effect (focus jumping back to the first field).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    back.current = document.activeElement as HTMLElement | null;
    const me = Symbol("sheet");
    openStack.push(me);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && openStack[openStack.length - 1] === me) {
        e.stopPropagation();
        closeRef.current();
      }
    };
    document.addEventListener("keydown", onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.setTimeout(() => {
      // On a phone, focusing a text box pops the keyboard over the sheet:
      // focus the panel itself unless the sheet asks for a field.
      const el =
        panel.current?.querySelector<HTMLElement>("[data-autofocus]") ??
        (isPhoneRef.current
          ? panel.current
          : panel.current?.querySelector<HTMLElement>("[autofocus], input, textarea, select, button:not([data-sheet-close])"));
      el?.focus({ preventScroll: true });
    }, 40);
    return () => {
      const at = openStack.indexOf(me);
      if (at >= 0) openStack.splice(at, 1);
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prev;
      back.current?.focus?.();
      setDrag(0);
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center md:items-center md:p-6" role="presentation">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px] animate-[fadeIn_120ms_ease-out]" onClick={onClose} />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        style={isPhone && drag > 0 ? { transform: `translateY(${drag}px)` } : undefined}
        className={cn(
          "relative flex max-h-[92dvh] w-full flex-col bg-[var(--bg)] shadow-[var(--shadow-lg)] outline-none",
          "rounded-t-3xl md:rounded-2xl",
          size === "sm" && "md:max-w-sm",
          size === "md" && "md:max-w-lg",
          size === "lg" && "md:max-w-2xl",
          size === "full" && "md:max-w-4xl md:h-[86vh]",
          isPhone ? "animate-[sheetUp_200ms_cubic-bezier(.2,.8,.2,1)]" : "animate-[fadeIn_120ms_ease-out]",
        )}
      >
        {isPhone && (
          <div
            className="flex h-6 shrink-0 cursor-grab items-center justify-center touch-none"
            onPointerDown={(e) => {
              startY.current = e.clientY;
              (e.target as HTMLElement).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (startY.current !== null) setDrag(Math.max(0, e.clientY - startY.current));
            }}
            onPointerUp={() => {
              if (drag > 110) onClose();
              setDrag(0);
              startY.current = null;
            }}
          >
            <span className="h-1.5 w-10 rounded-full bg-[var(--border)]" />
          </div>
        )}
        {(title || !isPhone) && (
          <div className="flex shrink-0 items-center justify-between gap-2 px-5 pb-2 pt-1 md:pt-4">
            <h2 id={titleId} className="truncate text-base font-semibold text-[var(--text)]">
              {title}
            </h2>
            <button
              type="button"
              data-sheet-close
              aria-label="Close"
              onClick={onClose}
              className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4">{children}</div>
        {footer && (
          <div className="flex shrink-0 gap-2 border-t border-[var(--border)] px-5 py-3 pb-safe-toolbar">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
