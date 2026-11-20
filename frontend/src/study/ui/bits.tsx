import type { ReactNode } from "react";

import { cn } from "@/utils/cn";

/** Three dots while the teacher is thinking. */
export function Thinking({ label = "The teacher is thinking", className }: { label?: string; className?: string }) {
  return (
    <span role="status" className={cn("inline-flex items-center gap-2 text-sm text-[var(--text-muted)]", className)}>
      <span className="study-dots" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      {label}
    </span>
  );
}

/** A ring that fills with mastery (0..1). */
export function Ring({
  value,
  size = 56,
  stroke = 5,
  color = "var(--st-accent)",
  dashed,
  children,
}: {
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
  dashed?: boolean;
  children?: ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <span className="study-ring relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--st-line)" strokeWidth={stroke} strokeDasharray={dashed ? "3 5" : undefined} />
        <circle
          className="fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
        />
      </svg>
      <span className="relative">{children}</span>
    </span>
  );
}

/** A slim progress bar. */
export function Bar({ value, color = "var(--st-accent)", className, label }: { value: number; color?: string; className?: string; label?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={label}
      className={cn("study-bar block h-2 w-full overflow-hidden rounded-full bg-[var(--hover-strong)]", className)}
    >
      <i style={{ width: `${pct}%`, background: color }} />
    </span>
  );
}

export const LEVEL_WORDS = {
  child: { name: "A child", detail: "About 8 to 11" },
  teen: { name: "A teenager", detail: "About 12 to 16" },
  adult: { name: "An adult", detail: "Plain and precise" },
} as const;

export const DEPTH_WORDS = {
  overview: { name: "The big picture", detail: "What matters most. A few short lessons." },
  solid: { name: "A working understanding", detail: "Enough to really use it." },
  deep: { name: "Thorough", detail: "Everything, including the hard parts." },
} as const;
