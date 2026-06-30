import type { ReactNode } from "react";
import { cn } from "@/utils/cn";

/**
 * A tinted notice box on the app's semantic status tokens. Replaces the
 * ad-hoc ``border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400``
 * cards that were copy-pasted across panes, so every error/warning/success
 * notice shares one tunable, theme-aware look.
 */
export type CalloutTone = "danger" | "warning" | "success" | "info";

const TONE: Record<CalloutTone, string> = {
  danger:
    "border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger)]",
  warning:
    "border-[var(--warning-border)] bg-[var(--warning-bg)] text-[var(--warning)]",
  success:
    "border-[var(--success-border)] bg-[var(--success-bg)] text-[var(--success)]",
  info: "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]",
};

export function Callout({
  tone = "danger",
  className,
  children,
}: {
  tone?: CalloutTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-card border px-4 py-3 text-sm",
        TONE[tone],
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * The full-pane centred error state used when a note / sheet / canvas / board
 * fails to load. Wraps {@link Callout} so all the panes share one layout.
 */
export function ErrorState({
  children,
  tone = "danger",
}: {
  children: ReactNode;
  tone?: CalloutTone;
}) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-10">
      <Callout tone={tone}>{children}</Callout>
    </div>
  );
}
