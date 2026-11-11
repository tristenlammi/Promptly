import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { isTopLayer, pushLayer, removeLayer, trapTab } from "@/components/shared/overlayStack";
import { usePresence } from "@/components/shared/usePresence";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/utils/cn";

/**
 * THE sheet (UI plan A3): a panel for one task — add a meal, edit a set,
 * pick a date, a phone action list. Use this one everywhere instead of
 * hand-building a sheet; it is also exported from
 * ``@/components/shared/Sheet``.
 *
 * - Phone: slides up from the bottom; drag the handle down (or flick it),
 *   or tap outside, to close. Desktop: a centred dialog.
 * - Escape closes the top-most layer only. Tab stays inside. Focus moves in
 *   on open and goes back to where it was on close.
 * - Closes with an animation: it stays mounted ~180ms after ``open`` goes
 *   false, showing what it last showed. Reduced motion skips that.
 *
 * Props
 *   open, onClose     controlled, like Modal.
 *   title             heading (optional on a phone; desktop always shows
 *                     the header row with its close button).
 *   footer            pinned action row (safe-area padded).
 *   size              desktop width: "sm" | "md" (default) | "lg" | "full".
 *   dismissible       false = no Escape / tap-outside / drag close (a form
 *                     that must not be lost by accident). Default true.
 *
 * Focus on open: an element with ``data-autofocus`` wins. Otherwise desktop
 * focuses the first field; a phone focuses the panel itself so the
 * keyboard doesn't jump up over the sheet.
 */
export function Sheet(props: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "full";
  dismissible?: boolean;
}) {
  const { open, onClose, dismissible = true } = props;
  // While closing, keep painting the last open content.
  const lastOpen = useRef(props);
  if (open) lastOpen.current = props;
  const { title, children, footer, size = "md" } = open ? props : lastOpen.current;
  const { mounted, closing } = usePresence(open, 190);

  const isPhone = useIsMobile();
  const isPhoneRef = useRef(isPhone);
  isPhoneRef.current = isPhone;
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLElement | null>(null);
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ y: number; t: number } | null>(null);
  // Read through refs: a parent passing a fresh ``onClose`` each render
  // mustn't re-run the open effect (focus jumping back to the first field).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  useEffect(() => {
    if (!open) return;
    back.current = document.activeElement as HTMLElement | null;
    setDrag(0);
    const me = pushLayer();
    const onKey = (e: KeyboardEvent) => {
      if (!isTopLayer(me)) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        if (dismissibleRef.current) closeRef.current();
      } else if (e.key === "Tab") {
        trapTab(e, panel.current);
      }
    };
    document.addEventListener("keydown", onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => {
      // Something inside already took focus (an ``autoFocus`` field).
      if (panel.current?.contains(document.activeElement)) return;
      // On a phone, focusing a text box pops the keyboard over the sheet:
      // focus the panel itself unless the sheet asks for a field.
      const el =
        panel.current?.querySelector<HTMLElement>("[data-autofocus]") ??
        (isPhoneRef.current
          ? panel.current
          : panel.current?.querySelector<HTMLElement>("[autofocus], input, textarea, select, button:not([data-sheet-close])"));
      (el ?? panel.current)?.focus({ preventScroll: true });
    }, 40);
    return () => {
      window.clearTimeout(focusTimer);
      removeLayer(me);
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prev;
      back.current?.focus?.();
    };
  }, [open]);

  if (!mounted) return null;

  const requestClose = () => {
    if (dismissible) onClose();
  };
  const endDrag = (e: ReactPointerEvent) => {
    const from = start.current;
    start.current = null;
    setDragging(false);
    if (!from) return;
    const dy = Math.max(0, e.clientY - from.y);
    const speed = dy / Math.max(1, performance.now() - from.t); // px per ms
    // Far enough, or a quick flick down: close from where the finger left
    // it (the closing animation reads --sheet-from).
    if (dismissible && (dy > 110 || (dy > 30 && speed > 0.6))) {
      setDrag(dy);
      onClose();
    } else {
      setDrag(0);
    }
  };

  let style: CSSProperties | undefined;
  if (isPhone) {
    if (closing) style = { "--sheet-from": `${drag}px` } as CSSProperties;
    else if (drag > 0 || dragging) style = { transform: `translateY(${drag}px)`, transition: dragging ? "none" : undefined };
  }

  return createPortal(
    <div
      className={cn("fixed inset-0 z-[70] flex items-end justify-center md:items-center md:p-6", closing && "pointer-events-none")}
      role="presentation"
    >
      <div
        className={cn("absolute inset-0 bg-black/40 backdrop-blur-[1px]", closing ? "motion-fade-out" : "motion-fade-in")}
        onClick={requestClose}
      />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal={closing ? undefined : "true"}
        aria-hidden={closing || undefined}
        aria-labelledby={title ? titleId : undefined}
        style={style}
        className={cn(
          "relative flex max-h-[92dvh] w-full flex-col bg-[var(--bg)] shadow-[var(--shadow-lg)] outline-none",
          "rounded-t-3xl md:rounded-2xl",
          // Springs back when a drag is let go short of closing.
          isPhone && "transition-transform duration-200 ease-out",
          size === "sm" && "md:max-w-sm",
          size === "md" && "md:max-w-lg",
          size === "lg" && "md:max-w-2xl",
          size === "full" && "md:max-w-4xl md:h-[86vh]",
          isPhone
            ? closing
              ? "motion-sheet-out"
              : "motion-sheet-in"
            : closing
              ? "motion-dialog-out"
              : "motion-dialog-in",
        )}
      >
        {isPhone && (
          <div
            className="flex h-7 shrink-0 cursor-grab touch-none items-center justify-center"
            onPointerDown={(e) => {
              start.current = { y: e.clientY, t: performance.now() };
              setDragging(true);
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (start.current !== null) setDrag(Math.max(0, e.clientY - start.current.y));
            }}
            onPointerUp={endDrag}
            onPointerCancel={() => {
              start.current = null;
              setDragging(false);
              setDrag(0);
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
              className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        <div className="promptly-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4">{children}</div>
        {footer && (
          <div className="flex shrink-0 gap-2 border-t border-[var(--border)] px-5 py-3 pb-safe-toolbar">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
