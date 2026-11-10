import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/utils/cn";

import { actionClass, DockCard, runAction, TONE_CLASS } from "./DockCard";
import { sortCards, useDockStore } from "./store";
import type { DockCardData } from "./types";

/** At most this many cards show; the rest fold into "+N more". */
const MAX_VISIBLE = 3;
/** Matches the slide's duration below. */
const LEAVE_MS = 220;

function useDockCards(): DockCardData[] {
  const byFeed = useDockStore((s) => s.byFeed);
  return useMemo(() => sortCards(byFeed), [byFeed]);
}

type Phase = "enter" | "in" | "leave";
interface Shown {
  card: DockCardData;
  phase: Phase;
}

/** Keeps a card mounted for a moment after it goes, and marks new ones, so
 *  both can slide. (The global reduced-motion rule makes the slide instant.) */
function usePresence(cards: DockCardData[]): Shown[] {
  const [items, setItems] = useState<Shown[]>(() => cards.map((card) => ({ card, phase: "in" })));

  useEffect(() => {
    setItems((prev) => {
      const before = new Map(prev.map((p) => [p.card.id, p]));
      const ids = new Set(cards.map((c) => c.id));
      const next: Shown[] = cards.map((card) => {
        const was = before.get(card.id);
        return { card, phase: was ? (was.phase === "leave" ? "in" : was.phase) : "enter" };
      });
      // A card that's gone keeps its place while it slides away.
      prev.forEach((p, i) => {
        if (!ids.has(p.card.id)) next.splice(Math.min(i, next.length), 0, { card: p.card, phase: "leave" });
      });
      return next;
    });
  }, [cards]);

  const entering = items.some((i) => i.phase === "enter");
  useEffect(() => {
    if (!entering) return;
    // Two frames: the closed state has to be painted before it can open.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setItems((p) => p.map((i) => (i.phase === "enter" ? { ...i, phase: "in" } : i))));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [entering]);

  const leaving = items
    .filter((i) => i.phase === "leave")
    .map((i) => i.card.id)
    .join("|");
  useEffect(() => {
    if (!leaving) return;
    const gone = new Set(leaving.split("|"));
    const t = window.setTimeout(() => setItems((p) => p.filter((i) => !(i.phase === "leave" && gone.has(i.card.id)))), LEAVE_MS);
    return () => window.clearTimeout(t);
  }, [leaving]);

  return items;
}

/**
 * "Happening now": a short stack of live cards above the account footer in
 * the open sidebar (which is also the phone's menu). The same place every
 * time for a call you're in, uploads, what's up next and the like.
 */
export function Dock() {
  const cards = useDockCards();
  const [showAll, setShowAll] = useState(false);
  const extra = Math.max(0, cards.length - MAX_VISIBLE);
  useEffect(() => {
    if (extra === 0) setShowAll(false);
  }, [extra]);
  const visible = useMemo(() => (showAll ? cards : cards.slice(0, MAX_VISIBLE)), [cards, showAll]);
  const items = usePresence(visible);
  if (items.length === 0) return null;

  return (
    <section aria-label="Happening now" className="promptly-scroll max-h-[45vh] shrink-0 overflow-y-auto border-t border-[var(--border)] px-2 pt-2">
      {items.map(({ card, phase }) => (
        <div
          key={card.id}
          aria-hidden={phase === "leave" ? true : undefined}
          className={cn(
            "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
            phase === "in" ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
            phase === "leave" && "pointer-events-none",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="pb-1.5">
              <DockCard card={card} />
            </div>
          </div>
        </div>
      ))}
      {extra > 0 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
          className="mb-1.5 flex min-h-[40px] w-full items-center justify-center rounded-md px-2 text-xs font-medium text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)] md:min-h-[28px]"
        >
          {showAll ? "Show less" : `+${extra} more`}
        </button>
      )}
    </section>
  );
}

/**
 * The dock on the collapsed rail: one icon per card (three at most), with
 * a card's quick buttons (Mute, Leave) under it. Any icon opens the full
 * cards beside the rail.
 */
export function DockRail() {
  const cards = useDockCards();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const none = cards.length === 0;

  useEffect(() => {
    if (none) setOpen(false);
  }, [none]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (none) return null;
  const top = cards.slice(0, MAX_VISIBLE);
  const extra = cards.length - top.length;

  return (
    <div ref={ref} className="relative mt-auto flex w-full flex-col items-center gap-1 border-t border-[var(--border)] pt-2">
      {top.map((card) => {
        const Icon = card.icon;
        const name = card.detail ? `${card.title}: ${card.detail}` : card.title;
        return (
          <Fragment key={card.id}>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              title={name}
              aria-label={name}
              aria-expanded={open}
              className={cn(
                "inline-flex h-9 w-9 items-center justify-center rounded-md transition hover:brightness-95",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                TONE_CLASS[card.tone ?? "plain"],
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
            </button>
            {card.actions
              ?.filter((a) => a.quick)
              .map((a) => {
                const ActionIcon = a.icon;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => runAction(card, a)}
                    title={a.label}
                    aria-label={a.label}
                    aria-pressed={a.pressed === undefined ? undefined : a.pressed}
                    className={cn(actionClass(a), "h-9 w-9 md:h-9 md:w-9")}
                  >
                    <ActionIcon className="h-4 w-4" aria-hidden="true" />
                  </button>
                );
              })}
          </Fragment>
        );
      })}
      {extra > 0 && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={`${extra} more happening now`}
          className="inline-flex h-7 w-9 items-center justify-center rounded-md text-xs font-medium text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          +{extra}
        </button>
      )}
      {open && (
        <div
          role="dialog"
          aria-label="Happening now"
          className="absolute bottom-0 left-full z-40 ml-2 flex max-h-[70vh] w-72 flex-col gap-1.5 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2 shadow-lg"
        >
          {cards.map((card) => (
            <DockCard key={card.id} card={card} />
          ))}
        </div>
      )}
    </div>
  );
}
