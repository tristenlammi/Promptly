import { useQuery } from "@tanstack/react-query";
import { Loader2, MapPin, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { calendarApi, type Calendar, type CalendarBootstrap } from "@/api/calendar";
import { Sheet } from "@/items/ui";
import { cn } from "@/utils/cn";

import { addUsers, useLabelsMap } from "../data";
import { addDays, fmt, sameDay, shortTime } from "../dates";
import { toView, type ViewEvent } from "../model";

function useDebounced(value: string, ms: number): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Search my events — a panel under the header (desktop) or a full sheet (phone). */
export function SearchPanel({
  open,
  onClose,
  b,
  calMap,
  onPick,
  phone,
}: {
  open: boolean;
  onClose: () => void;
  b: CalendarBootstrap;
  calMap: Map<string, Calendar>;
  onPick: (v: ViewEvent) => void;
  phone: boolean;
}) {
  if (!open) return null;
  if (phone) {
    return (
      <Sheet open onClose={onClose} title="Search" size="full">
        <SearchBody b={b} calMap={calMap} onPick={onPick} onClose={onClose} phone />
      </Sheet>
    );
  }
  return <DesktopPanel onClose={onClose} b={b} calMap={calMap} onPick={onPick} />;
}

function DesktopPanel({ onClose, b, calMap, onPick }: { onClose: () => void; b: CalendarBootstrap; calMap: Map<string, Calendar>; onPick: (v: ViewEvent) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest("[data-cal-search-toggle]") || t.closest('[role="dialog"][aria-modal="true"]')) return;
      closeRef.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, []);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Search events"
      className="absolute right-4 top-[60px] z-40 flex max-h-[min(70vh,640px)] w-[min(440px,calc(100%-32px))] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg)] shadow-[var(--shadow-lg)] animate-[fadeIn_100ms_ease-out]"
    >
      <SearchBody b={b} calMap={calMap} onPick={onPick} onClose={onClose} phone={false} />
    </div>
  );
}

function SearchBody({
  b,
  calMap,
  onPick,
  onClose,
  phone,
}: {
  b: CalendarBootstrap;
  calMap: Map<string, Calendar>;
  onPick: (v: ViewEvent) => void;
  onClose: () => void;
  phone: boolean;
}) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 250);
  const { data, isFetching, isError } = useQuery({
    queryKey: ["calendar", "search", dq],
    queryFn: () => calendarApi.search(dq),
    enabled: dq.length > 0,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
  useEffect(() => {
    addUsers(data?.users);
  }, [data]);

  const labelMap = useLabelsMap(b.labels);
  const groups = useMemo(() => {
    if (!data || !dq) return null;
    const now = new Date();
    const all = data.events.map((e) => toView(e, calMap, b.me.id, labelMap));
    return { upcoming: all.filter((v) => v.end > now), past: all.filter((v) => v.end <= now) };
  }, [data, dq, calMap, b.me.id, labelMap]);
  const flat = groups ? [...groups.upcoming, ...groups.past] : [];
  const [active, setActive] = useState(0);
  useEffect(() => {
    setActive(0);
  }, [data]);

  const pick = (v: ViewEvent) => {
    onPick(v);
    onClose();
  };

  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  let idx = 0;
  const section = (label: string, items: ViewEvent[]) =>
    items.length > 0 && (
      <section className="flex flex-col">
        <h3 className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{label}</h3>
        {items.map((v) => {
          const i = idx++;
          return <ResultRow key={`${v.ev.id}`} v={v} i={i} active={!phone && i === active} onPick={pick} onHover={() => setActive(i)} />;
        })}
      </section>
    );

  return (
    <div className={cn("flex min-h-0 flex-col", phone ? "gap-2 pb-2" : "")}>
      <div className={cn("relative shrink-0", phone ? "" : "border-b border-[var(--border)] p-2")}>
        <Search className={cn("pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]", phone ? "left-3" : "left-5")} />
        <input
          data-autofocus
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !phone) {
              e.stopPropagation();
              onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(flat.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter" && flat[active]) {
              e.preventDefault();
              pick(flat[active]);
            }
          }}
          type="search"
          enterKeyHint="search"
          placeholder="Search events, places, notes"
          aria-label="Search events"
          maxLength={200}
          className={cn(
            "w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] pr-9 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--item-accent)] [&::-webkit-search-cancel-button]:hidden",
            phone ? "h-12 pl-9 text-base" : "h-10 pl-9",
          )}
        />
        {isFetching ? (
          <Loader2 className={cn("absolute top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-[var(--text-muted)]", phone ? "right-3" : "right-5")} />
        ) : (
          q && (
            <button
              type="button"
              aria-label="Clear"
              onClick={() => setQ("")}
              className={cn("absolute top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)]", phone ? "right-2" : "right-4")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )
        )}
      </div>
      <div ref={list} className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", phone ? "" : "p-2 pt-0")}>
        {!dq ? (
          <p className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">Find an event by its title, place or notes.</p>
        ) : isError ? (
          <p className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">Search isn't working right now.</p>
        ) : groups && flat.length === 0 && !isFetching ? (
          <p className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">No events match “{dq}”.</p>
        ) : groups ? (
          <>
            {section("Upcoming", groups.upcoming)}
            {section("Past", groups.past)}
          </>
        ) : null}
      </div>
    </div>
  );
}

function ResultRow({ v, i, active, onPick, onHover }: { v: ViewEvent; i: number; active: boolean; onPick: (v: ViewEvent) => void; onHover: () => void }) {
  const now = new Date();
  const multiDay = v.allDay && !sameDay(v.start, addDays(v.end, -1));
  const when = v.allDay ? (multiDay ? `Until ${fmt(addDays(v.end, -1), { month: "short", day: "numeric" })}` : "All day") : `${shortTime(v.start)} – ${shortTime(v.end)}`;
  return (
    <button
      type="button"
      data-row={i}
      onClick={() => onPick(v)}
      onMouseMove={onHover}
      className={cn("flex min-h-14 w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition", active ? "bg-[var(--hover)]" : "hover:bg-[var(--hover)]")}
    >
      <span className="flex w-11 shrink-0 flex-col items-center leading-tight">
        <span className="text-xs font-medium uppercase text-[var(--text-muted)]">{fmt(v.start, { month: "short" })}</span>
        <span className="text-lg font-semibold tabular-nums text-[var(--text)]">{v.start.getDate()}</span>
        <span className="text-xs uppercase text-[var(--text-muted)]">{v.start.getFullYear() !== now.getFullYear() ? v.start.getFullYear() : fmt(v.start, { weekday: "short" })}</span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: v.color }} />
          <span className={cn("truncate text-sm font-medium", v.look === "declined" ? "text-[var(--text-muted)] line-through" : "text-[var(--text)]")}>{v.ev.title}</span>
        </span>
        <span className="flex min-w-0 items-center gap-2 pl-4 text-xs text-[var(--text-muted)]">
          <span className="shrink-0 tabular-nums">{when}</span>
          {v.ev.location && (
            <span className="flex min-w-0 items-center gap-0.5">
              <MapPin className="h-3 w-3 shrink-0" />
              <span className="truncate">{v.ev.location}</span>
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
