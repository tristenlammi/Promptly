import { useEffect, useState } from "react";

import { cn } from "@/utils/cn";

import { latestCards } from "./store";
import type { DockAction, DockCardData, DockTone } from "./types";

export const TONE_CLASS: Record<DockTone, string> = {
  plain: "bg-[var(--hover)] text-[var(--text-muted)]",
  accent: "bg-[var(--accent)]/10 text-[var(--accent)]",
  live: "bg-[var(--success-bg)] text-[var(--success)]",
  warn: "bg-[var(--warning-bg)] text-[var(--warning)]",
};

/** Run a card's handler from its feed's newest render. */
export function openCard(card: DockCardData): void {
  (latestCards.get(card.id) ?? card).onOpen?.();
}

export function runAction(card: DockCardData, action: DockAction): void {
  const now = latestCards.get(card.id) ?? card;
  (now.actions?.find((a) => a.id === action.id) ?? action).onClick();
}

function elapsed(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A running "12:34" since something started. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <span className="tabular-nums">{elapsed(since, now)}</span>;
}

const ACTION_CLASS =
  "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md transition md:h-8 md:w-8 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]";

export function actionClass(action: DockAction): string {
  return cn(
    ACTION_CLASS,
    action.danger
      ? "text-[var(--danger)] hover:bg-[var(--danger-bg)]"
      : action.pressed
        ? "bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/15"
        : "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]",
  );
}

/**
 * One compact "happening now" card: an icon, a title and one line of
 * detail (with a running timer or a progress bar when the feed gives one),
 * and up to a couple of buttons. Tapping the card goes back to the source.
 * Every feed uses this same card.
 */
export function DockCard({ card }: { card: DockCardData }) {
  const Icon = card.icon;
  const hasProgress = card.progress != null;
  const pct = hasProgress ? Math.round(Math.min(1, Math.max(0, card.progress ?? 0)) * 100) : 0;

  const body = (
    <>
      <span className={cn("inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md", TONE_CLASS[card.tone ?? "plain"])}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium leading-tight text-[var(--text)]">{card.title}</span>
        {(card.detail || card.since) && (
          <span className="mt-0.5 block truncate text-xs leading-tight text-[var(--text-muted)]">
            {card.detail}
            {card.detail && card.since ? " · " : ""}
            {card.since ? <Elapsed since={card.since} /> : null}
          </span>
        )}
      </span>
    </>
  );

  const bodyClass = "flex min-h-[44px] min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left";

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-2)]" data-testid={`dock-card-${card.id}`}>
      <div className="flex items-center gap-0.5 pr-1">
        {card.onOpen ? (
          <button
            type="button"
            onClick={() => openCard(card)}
            title={card.detail ? `${card.title}: ${card.detail}` : card.title}
            className={cn(
              bodyClass,
              "rounded-lg transition hover:bg-[var(--hover)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]",
            )}
          >
            {body}
          </button>
        ) : (
          <div className={bodyClass}>{body}</div>
        )}
        {card.actions?.map((a) => {
          const ActionIcon = a.icon;
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => runAction(card, a)}
              title={a.label}
              aria-label={a.label}
              aria-pressed={a.pressed === undefined ? undefined : a.pressed}
              data-testid={`dock-action-${a.id}`}
              className={actionClass(a)}
            >
              <ActionIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {hasProgress && (
        <div
          role="progressbar"
          aria-label={card.title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="h-1 w-full bg-[var(--border)]"
        >
          <div className="h-full rounded-r-full bg-[var(--accent)] transition-[width] duration-300 ease-out" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
