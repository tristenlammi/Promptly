import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { cn } from "@/utils/cn";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  widthClass?: string; // Tailwind class(es) for max-width; default max-w-lg.
  /**
   * When false, the modal can only be dismissed via the explicit close
   * button (the X / footer action) — clicking the backdrop and pressing
   * Escape are ignored. Use for forms where an accidental outside-click
   * would discard in-progress input. Defaults to true.
   */
  dismissible?: boolean;
}

/** Open dialogs, oldest first; the last one is on top. */
const openLayers: number[] = [];
let layerSeq = 0;

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  widthClass = "max-w-lg",
  dismissible = true,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [layerId] = useState(() => ++layerSeq);
  // Where focus was before opening — captured during the render that opens
  // the dialog, before React's ``autoFocus`` moves focus inside it (an
  // effect-time capture saw the dialog's own button and restored nothing).
  const returnFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== "undefined") {
    returnFocus.current = document.activeElement as HTMLElement | null;
  }
  wasOpen.current = open;

  // Each dialog its own title id — two open at once used to share one.
  const titleId = useId();

  // Only the top-most dialog answers Escape and traps Tab — one Escape used
  // to close every open layer at once (R-088).
  useEffect(() => {
    if (!open) return;
    openLayers.push(layerId);
    return () => {
      const i = openLayers.lastIndexOf(layerId);
      if (i >= 0) openLayers.splice(i, 1);
    };
  }, [open, layerId]);

  // Close on Escape + trap Tab focus inside the dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (openLayers[openLayers.length - 1] !== layerId) return;
      if (e.key === "Escape") {
        // Something inside (a menu, a picker) already handled it.
        if (e.defaultPrevented) return;
        if (dismissible) {
          e.preventDefault();
          onClose();
        }
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // Wrap around at the ends so focus never escapes the dialog.
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, dismissible, layerId]);

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Move focus into the dialog on open; restore it to the previously
  // focused element on close (so keyboard users aren't dumped at the
  // top of the page).
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = returnFocus.current;
    // Defer to next frame so the portal content is mounted first.
    const raf = requestAnimationFrame(() => {
      const root = dialogRef.current;
      if (!root) return;
      // A field with ``autoFocus`` already has focus — keep it. (React
      // doesn't leave an ``autofocus`` attribute in the DOM, so the lookup
      // below never saw it and moved focus to the close button instead.)
      if (root.contains(document.activeElement)) return;
      const target =
        root.querySelector<HTMLElement>("[autofocus]") ??
        root.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ??
        root;
      target.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
    >
      {dismissible ? (
        <button
          aria-label="Close dialog"
          onClick={onClose}
          className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        />
      ) : (
        <div
          aria-hidden
          className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        />
      )}
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={cn(
          "relative w-full overflow-hidden rounded-card border shadow-xl outline-none",
          "bg-[var(--surface)] text-[var(--text)]",
          "border-[var(--border)]",
          widthClass
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
          <div className="min-w-0 flex-1">
            {title && (
              <h2 id={titleId} className="truncate text-lg font-semibold">
                {title}
              </h2>
            )}
            {description && (
              <p className="mt-1 text-sm text-[var(--text-muted)]">{description}</p>
            )}
          </div>
          <button
            aria-label="Close"
            onClick={onClose}
            className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
