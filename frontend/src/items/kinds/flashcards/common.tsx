import { useEffect, useMemo, useRef, useState } from "react";

import { Select } from "@/items/ui";
import { cn } from "@/utils/cn";

import { useAuthStore } from "@/store/authStore";

import { deckPaths, deckTree, type CardStateLabel } from "./cards";
import * as F from "./fsrs";
import { onIntent, take } from "./intents";
import { split, todayBase, type Today } from "./queue";
import type { Data, Deck } from "./types";

/** The person's saved time zone (Account → the server's ``ctx.tz``), so
 *  "today" here is the same study day reminders, ``to_text`` and the AI
 *  use. Falls back to this device's zone when none is saved yet. */
export function useZone(): string | null {
  return useAuthStore((st) => {
    const z = (st.user?.settings as { timezone?: unknown } | undefined)?.timezone;
    return typeof z === "string" && z.trim() ? z.trim() : null;
  });
}

/** The scheduler config for this file (memoised on the settings + zone). */
export function useCfg(data: Data): F.Config {
  const zone = useZone();
  return useMemo(() => F.configFrom(data.settings, zone), [data.settings, zone]);
}

/** Today's queue, rescanned only when the data, deck or study day changes;
 *  the cheap learning split follows ``now``. */
export function useToday(data: Data, now: number, cfg: F.Config, deckIds: Set<string> | null): Today {
  const day = F.dayIndex(now, cfg);
  // ``now`` is deliberately not a dependency: the base only depends on the day.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const base = useMemo(() => todayBase(data, now, cfg, deckIds), [data, cfg, deckIds, day]);
  return useMemo(() => split(base, now), [base, now]);
}

export function usePaths(decks: Deck[]) {
  return useMemo(() => deckPaths(decks), [decks]);
}

/** ``Date.now()`` that ticks (learning cards come due while you look). */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), everyMs);
    const vis = () => !document.hidden && setNow(Date.now());
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [everyMs]);
  return now;
}

export function DeckSelect({
  decks,
  value,
  onChange,
  allLabel,
  className,
  id,
}: {
  decks: Deck[];
  value: string;
  onChange: (v: string) => void;
  allLabel?: string;
  className?: string;
  id?: string;
}) {
  const tree = useMemo(() => deckTree(decks), [decks]);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={className} aria-label="Deck">
      {allLabel !== undefined && <option value="">{allLabel}</option>}
      {tree.map(({ deck, depth }) => (
        <option key={deck.id} value={deck.id}>
          {"  ".repeat(depth) + deck.name}
        </option>
      ))}
    </Select>
  );
}

const STATE_STYLE: Record<CardStateLabel, string> = {
  new: "text-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_12%,transparent)]",
  learning: "text-[var(--danger)] bg-[var(--danger-bg)]",
  review: "text-[var(--success)] bg-[var(--success-bg)]",
  suspended: "text-[var(--warning)] bg-[var(--warning-bg)]",
};

export function StateBadge({ state, className }: { state: CardStateLabel; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-[10px] font-semibold uppercase tracking-wide", STATE_STYLE[state], className)}>
      {state}
    </span>
  );
}

/** Three due numbers, Anki-style: new · learning · review (fixed-width
 *  columns so a list of decks lines up under ``DueHeader``). */
export function DueCounts({ fresh, learning, review, className, compact }: { fresh: number; learning: number; review: number; className?: string; compact?: boolean }) {
  const col = compact ? "min-w-[1.25rem] text-center" : "w-9 text-center";
  return (
    <span className={cn("inline-flex items-center text-sm font-semibold tabular-nums", compact && "gap-1.5", className)} aria-label={`${fresh} new, ${learning} learning, ${review} to review`}>
      <span className={cn(col, fresh ? "text-[var(--item-accent)]" : "text-[var(--text-muted)] opacity-40")} title="New">
        {fresh}
      </span>
      <span className={cn(col, learning ? "text-[var(--danger)]" : "text-[var(--text-muted)] opacity-40")} title="Learning">
        {learning}
      </span>
      <span className={cn(col, review ? "text-[var(--success)]" : "text-[var(--text-muted)] opacity-40")} title="To review">
        {review}
      </span>
    </span>
  );
}

export function DeckDot({ color, size = 10 }: { color: string; size?: number }) {
  return <span aria-hidden className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: color }} />;
}

/** "in 3 d", "now", "in 12 min" for a due moment. */
export function fmtDue(iso: string | null, now: number): string {
  if (!iso) return "";
  const ms = F.parseMoment(iso) - now;
  if (ms <= 0) return "due";
  const m = ms / 60_000;
  if (m < 60) return `in ${Math.max(1, Math.round(m))} min`;
  if (m < 60 * 24) return `in ${Math.round(m / 60)} h`;
  const d = Math.round(m / 1440);
  if (d < 60) return `in ${d} d`;
  if (d < 730) return `in ${Math.round(d / 30.4)} mo`;
  return `in ${(d / 365).toFixed(1)} y`;
}

/** Rough minutes a set of reviews takes (8 s a review, 25 s a new card). */
export function estimateMinutes(reviews: number, fresh: number): number {
  return Math.max(1, Math.round((reviews * 8 + fresh * 25) / 60));
}


/** Open this tab's "add a card" sheet when the header's "Add card" asks
 *  (``request("add")`` in index.tsx), now or when the tab mounts. */
export function useAddIntent(open: (deck?: string) => void) {
  const fn = useRef(open);
  fn.current = open;
  useEffect(() => {
    const a = take("add");
    if (a) fn.current(a.deck);
    return onIntent((k) => {
      if (k !== "add") return;
      const v = take("add");
      if (v) fn.current(v.deck);
    });
  }, []);
}

/** The width of an element, live (ResizeObserver). The desktop content area
 *  shrinks a lot when the AI panel is open, so layouts follow the space
 *  they actually get rather than the viewport. */
export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      setW((prev) => (Math.abs(prev - next) > 1 ? next : prev));
    });
    ro.observe(el);
    setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, [el]);
  return [setEl, w];
}

/** Column captions for ``DueCounts`` (same widths, so they line up). */
export function DueHeader({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]", className)} aria-hidden>
      <span className="w-9 text-center">New</span>
      <span className="w-9 text-center">Learn</span>
      <span className="w-9 text-center">Due</span>
    </span>
  );
}
