import { Check, Flame, Minus, SkipForward, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/utils/cn";

import { type DayState } from "./engine";
import type { Habit } from "./types";
import { buzz, reducedMotion } from "./util";

/* -------------------------------------------------------------- long press */

/** Tap → ``onTap``; hold (or right-click) → ``onLong``. Keyboard Enter /
 *  Space is a tap (it's a real button). */
export function useLongPress(onTap: () => void, onLong: () => void, ms = 430) {
  const timer = useRef<number | null>(null);
  const fired = useRef(false);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const clear = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      fired.current = false;
      origin.current = { x: e.clientX, y: e.clientY };
      clear();
      timer.current = window.setTimeout(() => {
        fired.current = true;
        buzz(18);
        onLong();
      }, ms);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const o = origin.current;
      if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > 10) clear();
    },
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      clear();
      if (!fired.current) {
        fired.current = true;
        onLong();
      }
    },
    onClick: () => {
      if (fired.current) {
        fired.current = false;
        return;
      }
      onTap();
    },
  };
}

/* -------------------------------------------------------------- the check */

const BURST = Array.from({ length: 10 }, (_, i) => {
  const a = (i / 10) * Math.PI * 2;
  const r = 30 + (i % 2) * 8;
  return { dx: `${Math.cos(a) * r}px`, dy: `${Math.sin(a) * r}px` };
});

export function CheckButton({
  habit,
  state,
  size = 48,
  label,
  handlers,
  celebrate = true,
  disabled,
}: {
  habit: Habit;
  state: DayState;
  size?: number;
  label: string;
  handlers: ReturnType<typeof useLongPress>;
  celebrate?: boolean;
  disabled?: boolean;
}) {
  const color = habit.color || "var(--item-accent)";
  const done = state.done;
  const prev = useRef(done);
  const [pop, setPop] = useState(0);
  useEffect(() => {
    if (done && !prev.current && celebrate) setPop((p) => p + 1);
    prev.current = done;
  }, [done, celebrate]);

  const stroke = 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const progress =
    habit.type === "count" || habit.type === "duration" ? Math.max(0, Math.min(1, state.value / (habit.target || 1))) : done ? 1 : 0;
  const filled = done;
  const failed = state.failed;
  const showNumber = habit.type === "count" && !done && state.value > 0;

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={done}
      disabled={disabled}
      {...handlers}
      style={{ width: size, height: size, ["--hb" as string]: color } as CSSProperties}
      className={cn(
        "hb-check relative flex shrink-0 select-none items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)] disabled:cursor-default",
        pop > 0 && done && "hb-check-done",
      )}
    >
      <svg width={size} height={size} className="absolute inset-0 -rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill={filled ? color : failed ? "color-mix(in srgb, var(--danger) 14%, transparent)" : "transparent"}
          stroke={failed ? "var(--danger)" : `color-mix(in srgb, ${color} 32%, var(--border))`}
          strokeWidth={stroke}
          strokeDasharray={state.skipped ? "4 5" : undefined}
        />
        {!filled && !failed && progress > 0 && (
          <circle
            className="hb-ring"
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - progress)}
          />
        )}
      </svg>
      <span className="relative flex items-center justify-center">
        {filled ? (
          <svg width={size * 0.46} height={size * 0.46} viewBox="0 0 24 24" aria-hidden>
            <path className="hb-tick" d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="white" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : failed ? (
          <X className="h-5 w-5 text-[var(--danger)]" />
        ) : state.skipped ? (
          <SkipForward className="h-4 w-4 text-[var(--text-muted)]" />
        ) : showNumber ? (
          <span className="text-sm font-bold tabular-nums" style={{ color }}>
            {state.value}
          </span>
        ) : habit.type === "avoid" ? (
          <Minus className="h-4 w-4" style={{ color }} />
        ) : habit.emoji ? (
          <span className="text-[20px] leading-none opacity-90" aria-hidden>
            {habit.emoji}
          </span>
        ) : (
          <Check className="h-5 w-5 opacity-40" style={{ color }} />
        )}
      </span>
      {pop > 0 && done && !reducedMotion() && (
        <span className="hb-burst" aria-hidden>
          {BURST.map((b, i) => (
            <i key={i} style={{ ["--dx" as string]: b.dx, ["--dy" as string]: b.dy } as CSSProperties} />
          ))}
        </span>
      )}
    </button>
  );
}

/* ------------------------------------------------------------- small bits */

export function HabitBadge({ habit, size = 40 }: { habit: Habit; size?: number }) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-2xl"
      style={{
        width: size,
        height: size,
        background: `color-mix(in srgb, ${habit.color} 16%, transparent)`,
        fontSize: size * 0.5,
      }}
    >
      {habit.emoji || <span className="h-3 w-3 rounded-full" style={{ background: habit.color }} />}
    </span>
  );
}

export function StreakBadge({ n, unit, hot }: { n: number; unit: string; hot?: boolean }) {
  if (n <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums",
        hot ? "bg-[color-mix(in_srgb,#E2725B_16%,transparent)] text-[color-mix(in_srgb,#E2725B_75%,var(--text))]" : "bg-[var(--surface-2)] text-[var(--text-muted)]",
      )}
      title={`${n} ${unit} streak`}
    >
      <Flame className="h-3 w-3" aria-hidden />
      {n}
      <span className="sr-only"> {unit} streak</span>
    </span>
  );
}

/** A full-screen burst of confetti for a perfect day. */
export function Confetti({ run }: { run: number }) {
  const pieces = useMemo(
    () =>
      Array.from({ length: 46 }, (_, i) => ({
        left: `${(i * 37) % 100}%`,
        x: `${((i * 53) % 60) - 30}vw`,
        r: `${360 + ((i * 97) % 540)}deg`,
        d: `${(i * 23) % 260}ms`,
        t: `${1300 + ((i * 41) % 900)}ms`,
        color: ["#7B6CD9", "#E2725B", "#4E9F5B", "#D9902F", "#3B7DD8", "#C2557A"][i % 6],
      })),
    [],
  );
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!run || reducedMotion()) return;
    setShow(true);
    const t = window.setTimeout(() => setShow(false), 2400);
    return () => window.clearTimeout(t);
  }, [run]);
  if (!show) return null;
  return createPortal(
    <div className="hb-confetti" aria-hidden key={run}>
      {pieces.map((p, i) => (
        <i
          key={i}
          style={{ left: p.left, background: p.color, ["--x" as string]: p.x, ["--r" as string]: p.r, ["--d" as string]: p.d, ["--t" as string]: p.t } as CSSProperties}
        />
      ))}
    </div>,
    document.body,
  );
}

/** A bottom snackbar with an Undo, above the phone tab bar. */
export function Snackbar({ text, onUndo, onDone }: { text: ReactNode; onUndo?: () => void; onDone: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onDone, 5000);
    return () => window.clearTimeout(t);
  }, [onDone, text]);
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="hb-snack fixed inset-x-3 bottom-[calc(84px+env(safe-area-inset-bottom,0px))] z-[75] mx-auto flex max-w-md items-center gap-3 rounded-2xl bg-[var(--text)] px-4 py-3 text-sm text-[var(--bg)] shadow-[var(--shadow-lg)] md:bottom-6"
    >
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {onUndo && (
        <button
          type="button"
          onClick={() => {
            onUndo();
            onDone();
          }}
          className="shrink-0 rounded-lg px-2 py-1 text-sm font-semibold text-[var(--item-accent)] brightness-125 hover:underline"
        >
          Undo
        </button>
      )}
    </div>,
    document.body,
  );
}
