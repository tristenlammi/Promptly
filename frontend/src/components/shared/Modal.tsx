import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { cn } from "@/utils/cn";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  widthClass?: string; // Tailwind class(es) for max-width; default max-w-lg.
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  widthClass = "max-w-lg",
}: ModalProps) {
  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? "modal-title" : undefined}
    >
      <button
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />
      <div
        className={cn(
          "relative w-full overflow-hidden rounded-card border shadow-xl",
          "bg-[var(--surface)] text-[var(--text)]",
          "border-[var(--border)]",
          widthClass
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
          <div className="min-w-0 flex-1">
            {title && (
              <h2 id="modal-title" className="truncate text-lg font-semibold">
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
            className="rounded-md p-1 text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
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
