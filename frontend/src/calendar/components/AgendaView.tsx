import { CalendarDays, MapPin } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { EmptyState, ItemButton } from "@/items/ui";
import { cn } from "@/utils/cn";

import { addDays, dayDiff, fmt, sameDay, shortDay, shortTime, startOfDay, ymd, zoneNote } from "../dates";
import { birthdayLabel, extraLabel, lookStyle, onDay, sortEvents, type ViewEvent } from "../model";
import { openFrom, type OpenEvent } from "./EventChip";
import { extraEmoji } from "./ExtraDetail";
import { BirthdayAvatar, TaskCheck } from "./ExtrasChips";

/** Upcoming days with their events, from ``from`` for ``days`` days. */
export function AgendaView({
  from,
  days,
  events,
  loading,
  onOpen,
  onMore,
  onCreate,
}: {
  from: Date;
  days: number;
  events: ViewEvent[];
  loading: boolean;
  onOpen: OpenEvent;
  onMore: () => void;
  onCreate: () => void;
}) {
  const today = new Date();
  const list = useMemo(() => {
    const out: { day: Date; items: ViewEvent[] }[] = [];
    for (let i = 0; i < days; i++) {
      const d = addDays(from, i);
      const items = events.filter((v) => onDay(v, d)).sort(sortEvents);
      if (items.length || sameDay(d, today)) out.push({ day: d, items });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, from.getTime(), days]);
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    top.current?.scrollTo({ top: 0 });
  }, [from]);

  return (
    <div ref={top} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-24 pt-2 md:px-6 md:pb-8">
      <div className="mx-auto flex max-w-3xl flex-col">
        {list.map(({ day, items }) => {
          const isToday = sameDay(day, today);
          return (
            <section key={ymd(day)} aria-label={fmt(day, { weekday: "long", month: "long", day: "numeric" })} className="flex gap-3 border-b border-[var(--border)] py-2.5 last:border-b-0">
              <div className="flex w-12 shrink-0 flex-col items-center pt-0.5">
                <span className={cn("text-[11px] font-medium uppercase", isToday ? "text-[var(--item-accent)]" : "text-[var(--text-muted)]")}>{fmt(day, { weekday: "short" })}</span>
                <span className={cn("flex h-8 w-8 items-center justify-center rounded-full text-base font-semibold tabular-nums", isToday ? "bg-[var(--item-accent)] text-white" : "text-[var(--text)]")}>
                  {day.getDate()}
                </span>
                {day.getDate() === 1 || dayDiff(from, day) === 0 ? (
                  <span className="text-[10px] uppercase text-[var(--text-muted)]">{fmt(day, { month: "short" })}</span>
                ) : null}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                {items.length === 0 && <p className="py-2 text-sm text-[var(--text-muted)]">Nothing planned today.</p>}
                {items.map((v) => (
                  <AgendaRow key={v.ev.id} v={v} day={day} onOpen={onOpen} />
                ))}
              </div>
            </section>
          );
        })}
        {!loading && list.every((d) => d.items.length === 0) && (
          <EmptyState
            className="mt-6"
            icon={CalendarDays}
            title="Nothing coming up"
            text="Events you add, and ones you're invited to, show up here."
            action={
              <ItemButton variant="primary" onClick={onCreate}>
                New event
              </ItemButton>
            }
          />
        )}
        <div className="flex justify-center py-4">
          <ItemButton variant="ghost" size="sm" onClick={onMore}>
            Show more
          </ItemButton>
        </div>
      </div>
    </div>
  );
}

function AgendaRow({ v, day, onOpen }: { v: ViewEvent; day: Date; onOpen: OpenEvent }) {
  if (v.extra) return <ExtraRow v={v} onOpen={onOpen} />;
  const { style, className } = lookStyle(v);
  const d0 = startOfDay(day);
  let when: string;
  if (v.allDay) when = "All day";
  else if (v.start < d0 && v.end > addDays(d0, 1)) when = "All day";
  else if (v.start < d0) when = `Until ${shortTime(v.end)}`;
  else if (v.end > addDays(d0, 1)) when = `From ${shortTime(v.start)}`;
  else when = `${shortTime(v.start)} – ${shortTime(v.end)}`;
  // Its own time zone too, when that isn't mine ("9:00 AM Tokyo time · …").
  const zone = zoneNote(v.start, v.ev.tz, v.allDay);
  const solid = v.look === "solid";
  return (
    <button
      type="button"
      onClick={(e) => openFrom(e, v, onOpen)}
      className={cn("flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition hover:brightness-[0.97]", className)}
      style={solid ? { background: `color-mix(in srgb, ${v.color} 14%, var(--surface))` } : style}
    >
      <span className="w-1 self-stretch rounded-full" style={{ background: v.color }} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate text-sm font-medium", v.look === "declined" ? "text-[var(--text-muted)]" : "text-[var(--text)]")}>{v.ev.title}</span>
        <span className="flex min-w-0 items-center gap-2 text-xs text-[var(--text-muted)]">
          <span className="shrink-0 tabular-nums">{when}</span>
          {v.ev.location && (
            <span className="flex min-w-0 items-center gap-0.5">
              <MapPin className="h-3 w-3 shrink-0" />
              <span className="truncate">{v.ev.location}</span>
            </span>
          )}
          {v.look === "pending" && <span className="shrink-0 font-medium text-[var(--item-accent)]">Invited</span>}
        </span>
        {zone && <span className="truncate text-[11px] text-[var(--text-muted)]">{zone}</span>}
      </span>
    </button>
  );
}

/** A task (tick it off here) or a birthday, among the day's events. */
function ExtraRow({ v, onOpen }: { v: ViewEvent; onOpen: OpenEvent }) {
  const x = v.extra!;
  if (x.kind === "task") {
    const t = x.task;
    return (
      <div className={cn("flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-1.5 hover:bg-[var(--hover)]", t.planned && "opacity-60")}>
        <span className="flex w-1 justify-center">
          <TaskCheck task={t} size={18} />
        </span>
        <button type="button" onClick={(e) => openFrom(e, v, onOpen)} className="flex min-w-0 flex-1 flex-col text-left">
          <span className="truncate text-sm text-[var(--text)]">{t.title}</span>
          <span className="flex min-w-0 items-center gap-2 text-xs text-[var(--text-muted)]">
            <span className="shrink-0 tabular-nums">{t.time ? shortTime(v.start) : "Task"}</span>
            <span className="flex min-w-0 items-center gap-1">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: t.color }} />
              <span className="truncate">{t.list}</span>
            </span>
            {t.planned && <span className="shrink-0">· Planned {shortDay(new Date(t.planned.start))}, {shortTime(new Date(t.planned.start))}</span>}
          </span>
        </button>
      </div>
    );
  }
  if (x.kind !== "birthday") {
    let sub: string;
    if (x.kind === "workout") sub = x.w.kind === "day" ? "Training day · from Workout" : x.w.time ? `${shortTime(v.start)} · Workout` : "Workout";
    else if (x.kind === "meals") sub = "Meal plan";
    else if (x.kind === "bill") sub = `${x.bill.kind === "bill" ? "Bill" : "Subscription"} due · from Budget`;
    else if (x.kind === "appointment") sub = `${shortTime(v.start)} · Health appointment${x.a.location ? ` · ${x.a.location}` : ""}`;
    else if (x.kind === "trip") sub = `${fmt(v.start, { month: "short", day: "numeric" })} – ${fmt(addDays(v.end, -1), { month: "short", day: "numeric" })} · Trip`;
    else sub = "Public holiday";
    return (
      <button
        type="button"
        onClick={(e) => openFrom(e, v, onOpen)}
        className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-1.5 text-left transition hover:brightness-[0.97]"
        style={{ background: `color-mix(in srgb, ${v.color} 9%, var(--surface))` }}
      >
        <span aria-hidden className="flex w-[26px] shrink-0 justify-center text-lg leading-none">
          {extraEmoji(x)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-[var(--text)]">{extraLabel(x)}</span>
          <span className="truncate text-xs text-[var(--text-muted)]">{sub}</span>
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => openFrom(e, v, onOpen)}
      className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-1.5 text-left transition hover:brightness-[0.97]"
      style={{ background: `color-mix(in srgb, ${v.color} 9%, var(--surface))` }}
    >
      <BirthdayAvatar b={x.b} size={26} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-[var(--text)]">
          <span aria-hidden>{x.b.kind === "birthday" ? "🎂 " : "💍 "}</span>
          {birthdayLabel(x.b)}
        </span>
        <span className="text-xs text-[var(--text-muted)]">{x.b.kind === "birthday" ? "Birthday" : "Anniversary"} · from Contacts</span>
      </span>
    </button>
  );
}
