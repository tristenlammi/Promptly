import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
  XCircle,
} from "lucide-react";

import { useToastStore, type Toast, type ToastType } from "@/store/toastStore";
import { cn } from "@/utils/cn";

/**
 * Global toast host. Mounted once at the app root; renders the toast
 * stack fixed at the top-centre of the viewport (clear of the bottom
 * composer + the NetworkStatusToast, which both live at the bottom).
 *
 * Toasts auto-expire on their own timer, pause while hovered, and can
 * be dismissed manually. Driven by `useToastStore` / the imperative
 * `toast.*` helpers so any code — hooks or not — can raise one.
 */
export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);

  if (toasts.length === 0) return null;

  return createPortal(
    <div
      className={cn(
        "pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 px-3 pt-3",
        "pt-safe",
      )}
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>,
    document.body,
  );
}

const TYPE_META: Record<
  ToastType,
  { icon: typeof Info; accent: string; iconClass: string; role: "status" | "alert" }
> = {
  success: {
    icon: CheckCircle2,
    accent: "var(--success)",
    iconClass: "text-[var(--success)]",
    role: "status",
  },
  error: {
    icon: XCircle,
    accent: "var(--danger)",
    iconClass: "text-[var(--danger)]",
    role: "alert",
  },
  warning: {
    icon: AlertTriangle,
    accent: "var(--warning)",
    iconClass: "text-[var(--warning)]",
    role: "alert",
  },
  info: {
    icon: Info,
    accent: "var(--accent)",
    iconClass: "text-[var(--accent)]",
    role: "status",
  },
};

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const meta = TYPE_META[toast.type];
  const Icon = meta.icon;
  // Track the remaining time so hovering pauses the countdown rather
  // than restarting it from scratch on every mouse move.
  const remainingRef = useRef(toast.duration);
  const startedRef = useRef<number>(performance.now());
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (toast.duration <= 0) return; // sticky
    const startTimer = () => {
      startedRef.current = performance.now();
      timerRef.current = window.setTimeout(() => {
        dismiss(toast.id);
      }, remainingRef.current);
    };
    startTimer();
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
    // Re-arm only if the toast identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id, toast.duration]);

  const pause = () => {
    if (toast.duration <= 0 || timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
    remainingRef.current -= performance.now() - startedRef.current;
  };

  const resume = () => {
    if (toast.duration <= 0 || timerRef.current !== null) return;
    if (remainingRef.current <= 0) {
      dismiss(toast.id);
      return;
    }
    startedRef.current = performance.now();
    timerRef.current = window.setTimeout(
      () => dismiss(toast.id),
      remainingRef.current,
    );
  };

  return (
    <div
      role={meta.role}
      onMouseEnter={pause}
      onMouseLeave={resume}
      className={cn(
        "promptly-toast-in pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-card border p-3 shadow-lg",
        "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
      )}
      style={{ borderInlineStartWidth: 3, borderInlineStartColor: meta.accent }}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", meta.iconClass)} aria-hidden />
      <div className="min-w-0 flex-1">
        {toast.title && (
          <div className="text-sm font-semibold leading-snug">
            {toast.title}
          </div>
        )}
        <div
          className={cn(
            "text-sm leading-snug",
            toast.title ? "text-[var(--text-muted)]" : "text-[var(--text)]",
          )}
        >
          {toast.message}
        </div>
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action!.onClick();
              dismiss(toast.id);
            }}
            className={cn(
              "mt-1.5 rounded-md px-2 py-1 text-xs font-semibold transition",
              "bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20",
            )}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        aria-label="Dismiss notification"
        className={cn(
          "-m-1 shrink-0 rounded-md p-1 text-[var(--text-muted)] transition",
          "hover:bg-[var(--hover)] hover:text-[var(--text)]",
        )}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
