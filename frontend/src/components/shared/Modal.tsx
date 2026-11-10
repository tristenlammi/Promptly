import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { cn } from "@/utils/cn";

import { FOCUSABLE_SELECTOR, isTopLayer, pushLayer, removeLayer, trapTab } from "./overlayStack";
import { usePresence } from "./usePresence";

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
  /**
   * "top" lifts the dialog above sheets and menus. For app-wide prompts
   * (confirm, "name it") that can be raised from anywhere, including from
   * inside a Sheet. Defaults to the normal dialog layer.
   */
  layer?: "normal" | "top";
}

/**
 * The shared dialog. Opens with a fade and slight scale and closes the same
 * way (motion set, A1): it stays mounted for ~120ms after ``open`` goes
 * false, showing what it last showed, then unmounts. A caller that renders
 * it conditionally (``{x && <Modal open … />}``) still works; it just skips
 * the closing animation.
 */
export function Modal(props: ModalProps) {
  const { open, onClose, dismissible = true, layer = "normal" } = props;
  // While closing, keep painting the last open content: callers often clear
  // the state their children read in the same breath as closing.
  const lastOpen = useRef(props);
  if (open) lastOpen.current = props;
  const { title, description, children, footer, widthClass = "max-w-lg" } = open ? props : lastOpen.current;
  const { mounted, closing } = usePresence(open);

  const dialogRef = useRef<HTMLDivElement | null>(null);
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
  const layerId = useRef<symbol | null>(null);
  useEffect(() => {
    if (!open) return;
    const id = pushLayer();
    layerId.current = id;
    return () => {
      removeLayer(id);
      layerId.current = null;
    };
  }, [open]);

  // Close on Escape + trap Tab focus inside the dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!layerId.current || !isTopLayer(layerId.current)) return;
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
      // Wrap around at the ends so focus never escapes the dialog.
      trapTab(e, dialogRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, dismissible]);

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

  if (!mounted) return null;

  const scrim = cn(
    "absolute inset-0 bg-black/50 backdrop-blur-sm",
    closing ? "motion-fade-out" : "motion-fade-in",
  );
  return createPortal(
    <div
      className={cn(
        "fixed inset-0 flex items-center justify-center px-4",
        layer === "top" ? "z-[90]" : "z-50",
        closing && "pointer-events-none",
      )}
      role="dialog"
      aria-modal={closing ? undefined : "true"}
      aria-hidden={closing || undefined}
      aria-labelledby={title ? titleId : undefined}
    >
      {dismissible ? (
        <button
          aria-label="Close dialog"
          tabIndex={-1}
          onClick={onClose}
          className={scrim}
        />
      ) : (
        <div
          aria-hidden
          className={scrim}
        />
      )}
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={cn(
          "relative w-full overflow-hidden rounded-card border shadow-xl outline-none",
          "bg-[var(--surface)] text-[var(--text)]",
          "border-[var(--border)]",
          closing ? "motion-dialog-out" : "motion-dialog-in",
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
