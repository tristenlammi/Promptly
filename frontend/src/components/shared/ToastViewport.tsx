import { useEffect, useRef, useState, type CSSProperties } from "react";
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

import { prefersReducedMotion } from "./usePresence";

/**
 * Global toast host. Mounted once at the app root; renders the toast
 * stack at the bottom of the screen (UI plan A6), where it can't cover an
 * app's header or main action:
 *
 * - Phone: bottom-centre, above the safe area and above any bottom bar the
 *   page declares with ``useBottomBarInset`` (a tab bar, a composer).
 * - Desktop: bottom-left of the content area, just right of the sidebar
 *   (measured from ``#main``, so it follows the sidebar collapsing). An
 *   app with a sidebar of its own marks its content column with
 *   ``data-toast-anchor`` and toasts start there instead, in a browser tab
 *   and on its own alike.
 *
 * The newest toast sits lowest. Toasts auto-expire on their own timer,
 * pause while hovered, can be dismissed manually, and can carry one action
 * ("Undo"). Driven by `useToastStore` / the imperative `toast.*` helpers so
 * any code — hooks or not — can raise one.
 */
export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);
  // What's on screen: the store's toasts plus any still fading out.
  const [shown, setShown] = useState<{ toast: Toast; leaving: boolean }[]>([]);
  const [left, setLeft] = useState(0);

  useEffect(() => {
    setShown((prev) => {
      const live = new Map(toasts.map((t) => [t.id, t]));
      const kept = prev.map((p) => {
        const now = live.get(p.toast.id);
        return now ? { toast: now, leaving: false } : { ...p, leaving: true };
      });
      const known = new Set(prev.map((p) => p.toast.id));
      return [...kept, ...toasts.filter((t) => !known.has(t.id)).map((t) => ({ toast: t, leaving: false }))];
    });
  }, [toasts]);

  const anyLeaving = shown.some((p) => p.leaving);
  useEffect(() => {
    if (!anyLeaving) return;
    const drop = () => setShown((prev) => prev.filter((p) => !p.leaving));
    if (prefersReducedMotion()) {
      drop();
      return;
    }
    const t = window.setTimeout(drop, 130);
    return () => window.clearTimeout(t);
  }, [anyLeaving, shown.length]);

  // Desktop: start just right of the sidebar(s). An app's own content
  // column (``data-toast-anchor``) wins over ``#main``, the app layout's;
  // pages with neither (sign-in, shared links) get the plain bottom-left
  // corner. Looked up again for each new toast: the page may have changed.
  const count = shown.length;
  useEffect(() => {
    if (count === 0) return;
    // The innermost one that's showing (a hidden column has no box).
    const anchors = [...document.querySelectorAll<HTMLElement>("[data-toast-anchor]")].filter(
      (el) => el.getClientRects().length > 0,
    );
    const main = anchors[anchors.length - 1] ?? document.getElementById("main");
    const measure = () =>
      setLeft(main?.isConnected ? Math.max(0, Math.round(main.getBoundingClientRect().left)) : 0);
    measure();
    window.addEventListener("resize", measure);
    const ro = main && typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (main) ro?.observe(main);
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, [count]);

  // The live region is always mounted (empty when idle): one that appears
  // together with its first toast isn't announced by many screen readers
  // (R-122).
  return createPortal(
    <div
      className="promptly-toasts pointer-events-none fixed z-[95] flex flex-col gap-2 md:w-96 md:max-w-[calc(100vw-var(--toast-left,0px)-2rem)]"
      style={{ "--toast-left": `${left}px` } as CSSProperties}
      aria-live="polite"
      aria-atomic="false"
    >
      {shown.map((p) => (
        <ToastItem key={p.toast.id} toast={p.toast} leaving={p.leaving} />
      ))}
    </div>,
    document.body,
  );
}

// Pages that have a bar fixed to the bottom of a phone screen, tallest wins.
const bottomBars: { id: symbol; px: number }[] = [];
function applyBottomBar() {
  const px = bottomBars.reduce((max, b) => Math.max(max, b.px), 0);
  if (px > 0) document.documentElement.style.setProperty("--bottom-bar-height", `${px}px`);
  else document.documentElement.style.removeProperty("--bottom-bar-height");
}

/**
 * Tell the app this page has a bar fixed to the bottom of the screen (a
 * phone tab bar, a composer), so toasts rise above it instead of covering
 * it. ``px`` is the bar's height without the safe area; pass 0 (or
 * ``active = false``) when the bar isn't showing. Only matters on phones:
 * desktop toasts sit bottom-left, clear of page content.
 *
 *   useBottomBarInset(64, isPhone && tabs.length > 1);
 */
export function useBottomBarInset(px: number, active = true): void {
  useEffect(() => {
    if (!active || px <= 0) return;
    const entry = { id: Symbol("bar"), px };
    bottomBars.push(entry);
    applyBottomBar();
    return () => {
      const at = bottomBars.indexOf(entry);
      if (at >= 0) bottomBars.splice(at, 1);
      applyBottomBar();
    };
  }, [px, active]);
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
    iconClass: "text-[var(--accent-text)]",
    role: "status",
  },
};

function ToastItem({ toast, leaving }: { toast: Toast; leaving: boolean }) {
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
      // Paused while you're pointing at it, touching it, or tabbed into it.
      onMouseEnter={pause}
      onMouseLeave={resume}
      onPointerDown={pause}
      onFocus={pause}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) resume();
      }}
      aria-hidden={leaving || undefined}
      className={cn(
        "flex w-full max-w-sm items-start gap-2.5 rounded-card border p-3 shadow-lg",
        leaving ? "motion-toast-out pointer-events-none" : "motion-toast-in pointer-events-auto",
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
            "whitespace-pre-line text-sm leading-snug",
            toast.title ? "text-[var(--text-muted)]" : "text-[var(--text)]",
          )}
        >
          {toast.message}
        </div>
        {toast.action && (
          <div className="flex flex-wrap gap-1.5">
            {[toast.action, toast.secondary].map(
              (a) =>
                a && (
                  <button
                    key={a.label}
                    type="button"
                    onClick={() => {
                      a.onClick();
                      dismiss(toast.id);
                    }}
                    className={cn(
                      "mt-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition",
                      "bg-[var(--accent)]/10 text-[var(--accent-text)] hover:bg-[var(--accent)]/20",
                    )}
                  >
                    {a.label}
                  </button>
                ),
            )}
          </div>
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
