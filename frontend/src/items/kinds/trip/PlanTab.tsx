import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDownUp,
  BedDouble,
  CalendarDays,
  CalendarPlus,
  Check,
  ChevronRight,
  Clock,
  Footprints,
  GripVertical,
  Lightbulb,
  ListOrdered,
  MapPin,
  Pencil,
  Plus,
  Send,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { SendToSheet } from "@/components/share/SendToSheet";

import type { ItemViewProps } from "@/items/types";
import type { ItemHandle } from "@/items/useItem";
import { Avatar, Card, Chip, EmptyState, Fab, IconButton, ItemButton, List, Page, ScrollRow, Section, Segmented, Sheet, TextInput, todayISO, uid } from "@/items/ui";
import { cn } from "@/utils/cn";

import { requestBooking, takeDay } from "./bus";
import { TripAlbumStrip } from "./CrossApp";
import {
  bookingEvents,
  bookingLabel,
  bookingMinutes,
  dayRows,
  dayZone,
  destinationOn,
  isJourney,
  money,
  nextUp,
  nightsWithoutStay,
  phaseOf,
  stayFor,
  toHome,
  tripDates,
  type BookingEvent,
  type Phase,
} from "./logic";
import { assignChanged } from "./ops";
import { PlanItemSheet, applyDraft, draftFrom, type PlanDraft } from "./PlanItemSheet";
import { BookingQuickView } from "./QuickView";
import { STATUS_LABEL, TripSheet } from "./TripSheet";
import type { Booking, Idea, PlanItem, Trip } from "./types";
import { fmtCountdown, fmtDate, fmtDayNum, fmtHM, fmtMinutes, fmtRange, fmtWeekday, zoneAbbr, zoneCity } from "./tz";
import { SeverityDot, TypeBadge, useIssues, useNow, type Issue } from "./ui";
import { THREE_COL, TWO_COL, useTripWidth } from "./layout";

/* ================================================================ hero */

function phaseText(p: Phase): string {
  switch (p.phase) {
    case "undated":
      return "Add dates to start the countdown";
    case "before":
      return p.days === 0 ? "Leaving today" : p.days === 1 ? "Leaving tomorrow" : `Leaving in ${p.days} days`;
    case "during":
      return `Day ${p.day} of ${p.of}`;
    case "after":
      return p.days === 0 ? "Home today" : `Back ${p.days} day${p.days === 1 ? "" : "s"} ago`;
  }
}

export function TripHero({ item, title, issues, onIssues, compact }: { item: ItemHandle<Trip>; title: string; issues: Issue[]; onIssues: () => void; compact?: boolean }) {
  const t = item.data;
  const [edit, setEdit] = useState(false);
  const [sending, setSending] = useState(false);
  const p = phaseOf(t, todayISO());
  const serious = issues.filter((i) => i.severity !== "info").length;
  return (
    <>
      <div
        className="relative overflow-hidden rounded-3xl p-4 text-white shadow-[var(--shadow-sm)] md:p-5"
        style={{ background: `linear-gradient(135deg, ${t.color} 0%, color-mix(in srgb, ${t.color} 62%, #000) 100%)` }}
      >
        <span aria-hidden className="pointer-events-none absolute -right-3 -top-4 select-none text-[88px] leading-none opacity-25 md:text-[110px]">
          {t.emoji}
        </span>
        <div className="relative flex flex-col gap-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wider text-white/80">{STATUS_LABEL[t.status]}</p>
              <h1 className={cn("truncate font-semibold", compact ? "text-lg" : "text-2xl")}>
                <span aria-hidden className="mr-1.5">
                  {t.emoji}
                </span>
                {t.title || title}
              </h1>
              <p className="text-sm text-white/90 tabular-nums">{fmtRange(t.start, t.end)}</p>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <button type="button" aria-label="Send to a room or person" title="Send to…" onClick={() => setSending(true)} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/15 hover:bg-white/25">
                <Send className="h-4 w-4" />
              </button>
              {item.canEdit && (
                <button type="button" aria-label="Edit trip details" onClick={() => setEdit(true)} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/15 hover:bg-white/25">
                  <Pencil className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
          <p className="text-base font-semibold" aria-live="polite">
            {phaseText(p)}
          </p>
          {t.destinations.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {t.destinations.map((d) => (
                <span key={d.id} className="inline-flex h-7 items-center gap-1 rounded-full bg-white/15 px-2.5 text-xs font-medium">
                  <MapPin className="h-3 w-3" /> {d.name}
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <div className="flex -space-x-2">
              {t.travellers.slice(0, 6).map((x) => (
                <span key={x.id} title={x.name} className="rounded-full ring-2 ring-white/40">
                  <Avatar name={x.name} size={28} />
                </span>
              ))}
            </div>
            {issues.length > 0 && (
              <button type="button" onClick={onIssues} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-white/20 px-3 text-xs font-semibold hover:bg-white/30">
                <TriangleAlert className="h-3.5 w-3.5" />
                {serious ? `${serious} to check` : `${issues.length} note${issues.length === 1 ? "" : "s"}`}
              </button>
            )}
          </div>
        </div>
      </div>
      <TripAlbumStrip item={item} />
      {item.canEdit && <TripSheet item={item} open={edit} onClose={() => setEdit(false)} fallbackTitle={title} />}
      <SendToSheet open={sending} onClose={() => setSending(false)} target={{ kind: "trip", id: t.id, file_id: item.fileId, title: t.title || title }} />
    </>
  );
}

export function IssuesSheet({ open, onClose, issues, onDay, ask }: { open: boolean; onClose: () => void; issues: Issue[]; onDay?: (d: string) => void; ask: (p: string) => void }) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Things to check"
      footer={
        <ItemButton
          variant="primary"
          block
          icon={<Sparkles className="h-4 w-4" />}
          onClick={() => {
            onClose();
            ask("Look at the conflicts check for this trip and fix what you can; tell me what I need to decide.");
          }}
        >
          Ask the assistant to sort these out
        </ItemButton>
      }
    >
      <ul className="flex flex-col gap-3">
        {issues.map((i, n) => (
          <li key={n} className="flex gap-2.5 text-sm text-[var(--text)]">
            <SeverityDot severity={i.severity} />
            <div className="min-w-0 flex-1">
              <p>{i.message}</p>
              {i.dates && onDay && (
                <button
                  type="button"
                  className="mt-0.5 text-xs font-medium text-[var(--item-accent)]"
                  onClick={() => {
                    onDay(i.dates![0]);
                    onClose();
                  }}
                >
                  Go to {fmtDate(i.dates[0])}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

/* ============================================================ next up */

function NextUpCard({ trip, now, onOpen, onShow }: { trip: Trip; now: number; onOpen: (n: ReturnType<typeof nextUp>[number]) => void; onShow: (b: Booking) => void }) {
  const list = useMemo(() => nextUp(trip, now, 3), [trip, now]);
  const p = phaseOf(trip, todayISO());
  const first = list[0];
  if (!first) return null;
  const soon = first.at - now < 3 * 86_400_000;
  if (p.phase !== "during" && !soon) return null;
  const abbr = zoneAbbr(`${first.day}T${first.time || "00:00"}`, first.tz);
  return (
    <Card className="flex flex-col gap-3 border-[color-mix(in_srgb,var(--item-accent)_45%,var(--border))]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--item-accent)]">Next up</span>
        <span className="text-xs font-semibold tabular-nums text-[var(--text)]" aria-live="polite">
          {fmtCountdown(first.at - now)}
        </span>
      </div>
      <button type="button" onClick={() => onOpen(first)} className="flex items-center gap-3 text-left">
        <TypeBadge type={first.booking?.type ?? first.item?.type ?? "activity"} size={44} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-[var(--text)]">{first.title}</p>
          <p className="truncate text-sm tabular-nums text-[var(--text-muted)]">
            {fmtDate(first.day)} · {fmtHM(first.time)}
            {abbr ? ` ${abbr}` : ""}
            {first.sub ? ` · ${first.sub}` : ""}
          </p>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
      </button>
      {first.booking && (
        <div className="flex flex-wrap items-center gap-2">
          {first.booking.confirmation && <span className="font-mono text-sm font-semibold tracking-wider text-[var(--text)]">{first.booking.confirmation}</span>}
          <ItemButton size="sm" variant="secondary" className="ml-auto" onClick={() => onShow(first.booking!)}>
            Show booking
          </ItemButton>
        </div>
      )}
      {list.length > 1 && (
        <div className="flex flex-col gap-1 border-t border-[var(--border)] pt-2">
          {list.slice(1).map((n) => (
            <button key={`${n.at}${n.title}`} type="button" onClick={() => onOpen(n)} className="flex min-h-[36px] items-center justify-between gap-2 text-left text-sm">
              <span className="truncate text-[var(--text)]">{n.title}</span>
              <span className="shrink-0 tabular-nums text-[var(--text-muted)]">
                {n.day === first.day ? fmtHM(n.time) : `${fmtWeekday(n.day)} ${fmtHM(n.time)}`}
              </span>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ============================================================== rows */

function eventLine(e: BookingEvent): { title: string; sub: string } {
  const b = e.booking;
  if (isJourney(b.type)) {
    const from = b.from_code || b.from_place;
    const to = b.to_code || b.to_place;
    const mins = bookingMinutes(b);
    if (e.edge === "start") {
      const zone = zoneAbbr(b.start, b.start_tz);
      const arr = b.end ? `${fmtHM(e.until || b.end.slice(11, 16))} ${zoneAbbr(b.end, b.end_tz)}`.trim() : "";
      return {
        title: `${bookingLabel(b)}`,
        sub: [`${from ?? ""} ${fmtHM(e.time)} ${zone}`.trim(), arr && `→ ${to ?? ""} ${arr}`.trim(), mins !== null && fmtMinutes(mins), b.terminal_from && `T${b.terminal_from}`, b.seat && `Seat ${b.seat}`]
          .filter(Boolean)
          .join("  ·  "),
      };
    }
    return { title: `Arrive ${to ?? ""}`.trim(), sub: `${bookingLabel(b)} · ${fmtHM(e.time)} ${zoneAbbr(b.end, b.end_tz)}`.trim() };
  }
  const where = b.address || b.from_place;
  return { title: `${e.word}: ${bookingLabel(b)}`, sub: [fmtHM(e.time), e.until && `– ${fmtHM(e.until)}`, where].filter(Boolean).join(" ") };
}

function EventRow({ e, onOpen }: { e: BookingEvent; onOpen: () => void }) {
  const { title, sub } = eventLine(e);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-h-[60px] w-full items-center gap-3 rounded-2xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--item-accent)_6%,var(--surface))] px-3 py-2 text-left transition hover:border-[var(--item-accent)]"
    >
      <span className="w-12 shrink-0 text-right text-xs font-semibold tabular-nums text-[var(--text)]">{fmtHM(e.time) || "—"}</span>
      <TypeBadge type={e.booking.type} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-[var(--text)]">{title}</p>
        <p className="truncate text-xs tabular-nums text-[var(--text-muted)]">{sub}</p>
      </div>
      {e.booking.confirmation && (
        <span className="hidden max-w-[6.5rem] shrink-0 truncate rounded-md border border-dashed sm:block border-[var(--border)] px-1.5 py-0.5 font-mono text-[11px] font-semibold text-[var(--text)]" aria-label={`Booking ref ${e.booking.confirmation}`}>
          {e.booking.confirmation}
        </span>
      )}
    </button>
  );
}

function ItemRow({ trip, it, canEdit, onOpen, onToggleDone, dragHandle, dragging }: {
  trip: Trip;
  it: PlanItem;
  canEdit: boolean;
  onOpen: () => void;
  onToggleDone: () => void;
  dragHandle?: React.ReactNode;
  dragging?: boolean;
}) {
  const cost = it.cost_minor ? money(it.cost_minor, it.currency || trip.settings.home_currency, { compact: true }) : "";
  const sub = [it.place, it.area && it.area !== it.place ? it.area : "", it.duration_min ? fmtMinutes(it.duration_min) : "", cost].filter(Boolean).join(" · ");
  const done = it.status === "done";
  return (
    <div
      className={cn(
        "flex min-h-[60px] w-full items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] py-2 pl-3 pr-1.5 shadow-[var(--shadow-sm)]",
        dragging && "opacity-70 ring-2 ring-[var(--item-accent)]",
      )}
    >
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="w-12 shrink-0 text-right text-xs font-semibold tabular-nums text-[var(--text)]">{it.time ? fmtHM(it.time) : <span className="font-medium text-[var(--text-muted)]">Any</span>}</span>
        <TypeBadge type={it.type} />
        <div className="min-w-0 flex-1">
          <p className={cn("truncate text-sm font-semibold text-[var(--text)]", done && "text-[var(--text-muted)] line-through")}>{it.title}</p>
          {sub && <p className="truncate text-xs tabular-nums text-[var(--text-muted)]">{sub}</p>}
        </div>
        {it.status === "booked" && <span className="rounded-full bg-[color-mix(in_srgb,var(--success)_16%,transparent)] px-2 py-0.5 text-[11px] font-semibold text-[var(--success)]">Booked</span>}
        {it.status === "idea" && <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[11px] font-semibold text-[var(--text-muted)]">Idea</span>}
      </button>
      {canEdit && (
        <button
          type="button"
          aria-label={done ? `Mark ${it.title} not done` : `Mark ${it.title} done`}
          aria-pressed={done}
          onClick={onToggleDone}
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition",
            done ? "text-[var(--success)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]",
          )}
        >
          <span className={cn("flex h-6 w-6 items-center justify-center rounded-full border-2", done ? "border-[var(--success)] bg-[var(--success)] text-white" : "border-[var(--border)]")}>
            {done && <Check className="h-3.5 w-3.5" />}
          </span>
        </button>
      )}
      {dragHandle}
    </div>
  );
}

function SortableItem(props: { trip: Trip; it: PlanItem; canEdit: boolean; onOpen: () => void; onToggleDone: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `it:${props.it.id}`, disabled: !props.canEdit });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn(isDragging && "relative z-10")}>
      <ItemRow
        {...props}
        dragging={isDragging}
        dragHandle={
          props.canEdit ? (
            <button
              type="button"
              aria-label={`Drag ${props.it.title}`}
              {...attributes}
              {...listeners}
              className="flex h-11 w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] active:cursor-grabbing"
            >
              <GripVertical className="h-4 w-4" />
            </button>
          ) : undefined
        }
      />
    </div>
  );
}

function Connector({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5 pl-[4.25rem] text-xs text-[var(--text-muted)]">
      <span aria-hidden className="h-5 border-l-2 border-dotted border-[var(--border)]" />
      <Footprints className="h-3.5 w-3.5" />
      <span className="truncate">{text}</span>
    </div>
  );
}

/* ============================================================ days nav */

function DayTarget({ day, children, className }: { day: string; children: (over: boolean) => React.ReactNode; className?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${day}` });
  return (
    <div ref={setNodeRef} className={className}>
      {children(isOver)}
    </div>
  );
}

function DayList({ trip, dates, selected, onSelect, today, noStay }: { trip: Trip; dates: string[]; selected: string; onSelect: (d: string) => void; today: string; noStay: Set<string> }) {
  return (
    <nav aria-label="Days" className="flex flex-col gap-1">
      {dates.map((d, n) => {
        const entry = trip.days.find((x) => x.date === d);
        const count = entry?.items.length ?? 0;
        const dest = destinationOn(trip, d);
        return (
          <DayTarget key={d} day={d}>
            {(over) => (
              <button
                type="button"
                onClick={() => onSelect(d)}
                aria-current={d === selected ? "date" : undefined}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition",
                  d === selected ? "bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)]" : "hover:bg-[var(--hover)]",
                  over && "ring-2 ring-[var(--item-accent)]",
                )}
              >
                <span className={cn("flex w-9 shrink-0 flex-col items-center rounded-lg py-0.5 text-center", d === today && "bg-[var(--item-accent-fill)] text-white")}>
                  <span className="text-[10px] font-semibold uppercase leading-tight">{fmtWeekday(d)}</span>
                  <span className="text-sm font-semibold leading-tight tabular-nums">{fmtDayNum(d)}</span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--text)]">{entry?.title || dest?.name || `Day ${n + 1}`}</span>
                  <span className="block truncate text-xs text-[var(--text-muted)]">
                    {count ? `${count} planned` : "Nothing yet"}
                    {noStay.has(d) ? " · no stay" : ""}
                  </span>
                </span>
              </button>
            )}
          </DayTarget>
        );
      })}
    </nav>
  );
}

function DayStrip({ dates, selected, onSelect, today }: { dates: string[]; selected: string; onSelect: (d: string) => void; today: string }) {
  useEffect(() => {
    document.getElementById(`trip-day-${selected}`)?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [selected]);
  return (
    <ScrollRow>
      {dates.map((d) => (
        <button
          key={d}
          id={`trip-day-${d}`}
          type="button"
          onClick={() => onSelect(d)}
          aria-current={d === selected ? "date" : undefined}
          className={cn(
            "flex h-14 w-12 shrink-0 flex-col items-center justify-center rounded-2xl border text-center transition",
            d === selected ? "border-[var(--item-accent)] bg-[var(--item-accent-fill)] text-white" : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)]",
          )}
        >
          <span className="text-[10px] font-semibold uppercase">{fmtWeekday(d)}</span>
          <span className="text-base font-semibold tabular-nums">{fmtDayNum(d)}</span>
          {d === today && d !== selected && <span className="mt-0.5 h-1 w-1 rounded-full bg-[var(--item-accent-fill)]" />}
        </button>
      ))}
    </ScrollRow>
  );
}

/* ============================================================ the day */

type EditTarget = { kind: "item"; day: string; item: PlanItem | null } | { kind: "idea"; idea: Idea | null } | null;

function DayView({ item, day, index, events, onEdit, ask, goTo, isPhone, onShow }: {
  item: ItemHandle<Trip>;
  day: string;
  index: number;
  events: BookingEvent[];
  onEdit: (t: EditTarget) => void;
  ask: (p: string) => void;
  goTo: (tab: string) => void;
  isPhone: boolean;
  onShow: (b: Booking) => void;
}) {
  const t = item.data;
  const entry = t.days.find((d) => d.date === day);
  const rows = useMemo(() => dayRows(t, day, events), [t, day, events]);
  const items = entry?.items ?? [];
  const zone = dayZone(t, day);
  const dest = destinationOn(t, day);
  const stay = stayFor(t, day);
  const homeless = useMemo(() => nightsWithoutStay(t).includes(day), [t, day]);
  const total = items.reduce((a, it) => a + (toHome(t, it.cost_minor, it.currency) ?? 0), 0);
  const [titleText, setTitleText] = useState(entry?.title ?? "");
  useEffect(() => setTitleText(entry?.title ?? ""), [entry?.title, day]);

  const saveTitle = () => {
    if ((entry?.title ?? "") === titleText.trim()) return;
    item.update((d) => {
      let e = d.days.find((x) => x.date === day);
      if (!e) {
        e = { date: day, title: "", notes: "", tz: "", items: [] };
        d.days.push(e);
        d.days.sort((a, b) => a.date.localeCompare(b.date));
      }
      e.title = titleText.trim();
    });
  };

  const toggleDone = (id: string) => {
    // Decided from what's on screen, so a replay can't flip it back.
    const target = items.find((x) => x.id === id)?.status === "done" ? "planned" : "done";
    item.update((d) => {
      const it = d.days.find((x) => x.date === day)?.items.find((x) => x.id === id);
      if (it) it.status = target;
    });
  };

  return (
    <section className="flex flex-col gap-3" aria-label={fmtDate(day, true)}>
      <div className="flex items-start justify-between gap-2 px-1">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            {index >= 0 ? `Day ${index + 1} · ` : ""}
            {fmtDate(day, true)}
          </p>
          {item.canEdit ? (
            <input
              aria-label="Day title"
              value={titleText}
              placeholder={dest?.name ? `${dest.name} — add a theme` : "Add a theme for the day"}
              onChange={(e) => setTitleText(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              className="-ml-1 w-full rounded-lg bg-transparent px-1 py-0.5 text-lg font-semibold text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] placeholder:font-normal hover:bg-[var(--hover)] focus:bg-[var(--surface)] focus:ring-2 focus:ring-[var(--item-accent)]"
            />
          ) : (
            <h2 className="text-lg font-semibold text-[var(--text)]">{entry?.title || dest?.name || " "}</h2>
          )}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-[var(--text-muted)]">
            {zone && (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" /> {zoneCity(zone)} time {zoneAbbr(`${day}T12:00`, zone)}
              </span>
            )}
            {stay ? (
              <button type="button" className="inline-flex items-center gap-1 hover:text-[var(--text)]" onClick={() => { requestBooking(stay.id); goTo("bookings"); }}>
                <BedDouble className="h-3 w-3" /> {bookingLabel(stay)}
              </button>
            ) : (
              homeless && (
                <span className="inline-flex items-center gap-1 text-[var(--warning)]">
                  <BedDouble className="h-3 w-3" /> No stay booked tonight
                </span>
              )
            )}
            {total > 0 && <span className="tabular-nums">≈ {money(total, t.settings.home_currency, { compact: true })}</span>}
          </p>
        </div>
        {item.canEdit && !isPhone && (
          <div className="flex shrink-0 gap-1.5">
            <ItemButton size="sm" variant="ghost" icon={<ArrowDownUp className="h-3.5 w-3.5" />} onClick={() => item.update((d) => {
              const e = d.days.find((x) => x.date === day);
              if (e) e.items = [...e.items.filter((i) => i.time).sort((a, b) => a.time!.localeCompare(b.time!)), ...e.items.filter((i) => !i.time)];
            })} disabled={items.length < 2}>
              Sort by time
            </ItemButton>
            <ItemButton size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => onEdit({ kind: "item", day, item: null })}>
              Add
            </ItemButton>
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="Nothing planned yet"
          text="Add things to do, drag ideas in, or let the assistant plan a realistic day around what's nearby."
          action={
            item.canEdit && (
              <div className="flex flex-wrap justify-center gap-2">
                <ItemButton
                  variant="primary"
                  icon={<Sparkles className="h-4 w-4" />}
                  onClick={() => ask(`Plan ${fmtDate(day, true)} (${day})${dest ? ` in ${dest.name}` : ""}: 2–3 highlights clustered by area, meals, and travel times between stops. Use my ideas list where it fits.`)}
                >
                  Plan this day
                </ItemButton>
                <ItemButton onClick={() => onEdit({ kind: "item", day, item: null })}>Add something</ItemButton>
              </div>
            )
          }
        />
      ) : (
        <SortableContext items={items.map((i) => `it:${i.id}`)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-1.5">
            {rows.map((r) =>
              r.kind === "event" ? (
                <EventRow
                  key={r.event.key}
                  e={r.event}
                  onOpen={() => {
                    if (isPhone) return onShow(r.event.booking);
                    requestBooking(r.event.booking.id);
                    goTo("bookings");
                  }}
                />
              ) : (
                <div key={r.item.id}>
                  <SortableItem
                    trip={t}
                    it={r.item}
                    canEdit={item.canEdit}
                    onOpen={() => onEdit({ kind: "item", day, item: r.item })}
                    onToggleDone={() => toggleDone(r.item.id)}
                  />
                  {r.item.travel_after && <Connector text={r.item.travel_after} />}
                </div>
              ),
            )}
          </div>
        </SortableContext>
      )}
      {rows.length > 0 && item.canEdit && (
        <div className="flex flex-wrap gap-2">
          <ItemButton size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => onEdit({ kind: "item", day, item: null })}>
            Add to this day
          </ItemButton>
          <ItemButton size="sm" variant="ghost" icon={<Sparkles className="h-4 w-4" />} onClick={() => ask(`Review ${day}: is the pacing realistic, are opening hours and travel times OK, and what would you change?`)}>
            Check this day
          </ItemButton>
        </div>
      )}
    </section>
  );
}

/* ============================================================== ideas */

function DraggableIdea({ idea, children, disabled }: { idea: Idea; children: React.ReactNode; disabled: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `idea:${idea.id}`, disabled });
  return (
    <div ref={setNodeRef} className={cn("flex items-stretch", isDragging && "opacity-40")}>
      {!disabled && (
        <button
          type="button"
          aria-label={`Drag ${idea.title} to a day`}
          {...attributes}
          {...listeners}
          className="hidden w-7 shrink-0 cursor-grab touch-none items-center justify-center text-[var(--text-muted)] hover:text-[var(--text)] md:flex"
        >
          <GripVertical className="h-4 w-4" />
        </button>
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

const PRIORITY_LABEL = { must: "Must", want: "Want", maybe: "Maybe" } as const;

function IdeasPanel({ item, dates, onEdit, onSchedule, ask, compact }: {
  item: ItemHandle<Trip>;
  dates: string[];
  onEdit: (t: EditTarget) => void;
  onSchedule: (idea: Idea) => void;
  ask: (p: string) => void;
  compact?: boolean;
}) {
  const t = item.data;
  const [tag, setTag] = useState<string | null>(null);
  const [prio, setPrio] = useState<"all" | "must" | "want" | "maybe">("all");
  const tags = useMemo(() => [...new Set(t.ideas.flatMap((i) => i.tags))].sort().slice(0, 30), [t.ideas]);
  const groups = useMemo(() => {
    const list = t.ideas.filter((i) => (!tag || i.tags.includes(tag)) && (prio === "all" || i.priority === prio));
    const m = new Map<string, Idea[]>();
    for (const i of list) {
      const k = i.area || "Anywhere";
      m.set(k, [...(m.get(k) ?? []), i]);
    }
    const rank = { must: 0, want: 1, maybe: 2 };
    return [...m.entries()]
      .map(([k, v]) => [k, v.sort((a, b) => rank[a.priority] - rank[b.priority])] as const)
      .sort((a, b) => (a[0] === "Anywhere" ? 1 : b[0] === "Anywhere" ? -1 : b[1].length - a[1].length || a[0].localeCompare(b[0])));
  }, [t.ideas, tag, prio]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 px-1">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text)]">Ideas</h2>
          <p className="text-xs text-[var(--text-muted)]">{t.ideas.length ? `${t.ideas.length} places · grouped by area${dates.length ? " · drag onto a day" : ""}` : "Places you might visit"}</p>
        </div>
        {item.canEdit && (
          <ItemButton size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => onEdit({ kind: "idea", idea: null })}>
            Idea
          </ItemButton>
        )}
      </div>
      {t.ideas.length > 0 && (
        <ScrollRow>
          {(["all", "must", "want", "maybe"] as const).map((p) => (
            <Chip key={p} active={prio === p} onClick={() => setPrio(p)}>
              {p === "all" ? "All" : PRIORITY_LABEL[p]}
            </Chip>
          ))}
          {tags.map((x) => (
            <Chip key={x} active={tag === x} onClick={() => setTag(tag === x ? null : x)}>
              #{x}
            </Chip>
          ))}
        </ScrollRow>
      )}
      {t.ideas.length === 0 ? (
        <EmptyState
          icon={Lightbulb}
          title="Collect ideas first"
          text="Save places you might visit — sights, food, day trips. They're grouped by area so planning days is easy."
          action={
            item.canEdit && (
              <ItemButton variant="primary" icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Suggest 15 great ideas for this trip (sights, food, experiences, a rainy-day option), with area, tags, priority, opening hours and whether to book ahead. Check facts on the web.")}>
                Suggest ideas
              </ItemButton>
            )
          }
        />
      ) : (
        groups.map(([area, list]) => (
          <div key={area} className="flex flex-col gap-1.5">
            <p className="flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              <MapPin className="h-3 w-3" /> {area} <span className="font-normal normal-case">· {list.length}</span>
            </p>
            <List>
              {list.map((i) => (
                <DraggableIdea key={i.id} idea={i} disabled={!item.canEdit || dates.length === 0}>
                  <div className="flex min-h-[52px] items-center">
                    <button type="button" onClick={() => onEdit({ kind: "idea", idea: i })} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]">
                      <TypeBadge type={i.type} size={32} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-sm font-medium text-[var(--text)]">
                          <span className="truncate">{i.title}</span>
                          {i.priority === "must" && <span className="shrink-0 rounded-full bg-[color-mix(in_srgb,var(--item-accent)_16%,transparent)] px-1.5 text-[10px] font-semibold text-[var(--item-accent)]">MUST</span>}
                        </span>
                        <span className="block truncate text-xs text-[var(--text-muted)]">
                          {[i.hours, i.book_ahead ? "Book ahead" : "", i.duration_min ? fmtMinutes(i.duration_min) : "", i.tags.map((x) => `#${x}`).join(" ")].filter(Boolean).join(" · ") || i.place || PRIORITY_LABEL[i.priority]}
                        </span>
                      </span>
                    </button>
                    {item.canEdit && dates.length > 0 && !compact && (
                      <IconButton label={`Add ${i.title} to a day`} icon={CalendarPlus} onClick={() => onSchedule(i)} className="mr-1 text-[var(--item-accent)]" />
                    )}
                  </div>
                </DraggableIdea>
              ))}
            </List>
          </div>
        ))
      )}
    </div>
  );
}

function ScheduleSheet({ idea, dates, trip, onClose, onPick }: { idea: Idea | null; dates: string[]; trip: Trip; onClose: () => void; onPick: (day: string, time: string | null) => void }) {
  const [day, setDay] = useState(dates[0] ?? "");
  const [time, setTime] = useState("");
  useEffect(() => {
    if (idea) {
      setDay((d) => (dates.includes(d) ? d : dates[0] ?? ""));
      setTime("");
    }
  }, [idea, dates]);
  return (
    <Sheet
      open={!!idea}
      onClose={onClose}
      title={idea ? `Add “${idea.title}” to…` : ""}
      footer={
        <ItemButton variant="primary" block disabled={!day} onClick={() => onPick(day, time || null)}>
          Add to {day ? fmtDate(day) : "day"}
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
          {dates.map((d) => {
            const n = trip.days.find((x) => x.date === d)?.items.length ?? 0;
            return (
              <button
                key={d}
                type="button"
                onClick={() => setDay(d)}
                aria-pressed={d === day}
                className={cn(
                  "flex flex-col items-center rounded-xl border py-2 text-center",
                  d === day ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)]" : "border-[var(--border)]",
                )}
              >
                <span className="text-[10px] font-semibold uppercase text-[var(--text-muted)]">{fmtWeekday(d)}</span>
                <span className="text-base font-semibold tabular-nums text-[var(--text)]">{fmtDayNum(d)}</span>
                <span className="text-[10px] text-[var(--text-muted)]">{n ? `${n} planned` : "free"}</span>
              </button>
            );
          })}
        </div>
        <label className="flex items-center justify-between gap-3 text-sm text-[var(--text)]">
          Time (optional)
          <TextInput type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-36" />
        </label>
      </div>
    </Sheet>
  );
}

/* ============================================================== tab */

// Pointer drags land only where the pointer is (dropping back on the ideas
// list does nothing); keyboard drags use the nearest target.
const collide: CollisionDetection = (args) => (args.pointerCoordinates ? pointerWithin(args) : closestCenter(args));

export function PlanTab({ item, isPhone, ask, goTo, doc }: ItemViewProps<Trip>) {
  const t = item.data;
  const width = useTripWidth();
  const narrow = isPhone || width < TWO_COL;
  const three = !isPhone && width >= THREE_COL;
  const today = todayISO();
  const now = useNow(30_000);
  const dates = useMemo(() => tripDates(t), [t]);
  const events = useMemo(() => bookingEvents(t), [t]);
  const noStay = useMemo(() => new Set(nightsWithoutStay(t)), [t]);
  const issues = useIssues(item);
  const [showIssues, setShowIssues] = useState(false);
  const [view, setView] = useState<"days" | "ideas">("days");
  const [selected, setSelected] = useState<string>(() => {
    const asked = takeDay();
    if (asked) return asked;
    if (dates.includes(today)) return today;
    return dates[0] ?? today;
  });
  useEffect(() => {
    if (dates.length && !dates.includes(selected)) setSelected(dates.includes(today) ? today : dates[0]);
  }, [dates, selected, today]);
  const [edit, setEdit] = useState<EditTarget>(null);
  const [scheduling, setScheduling] = useState<Idea | null>(null);
  const [dragIdea, setDragIdea] = useState<Idea | null>(null);
  const [showing, setShowing] = useState<string | null>(null);
  const showBooking = t.bookings.find((b) => b.id === showing) ?? null;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const ensureDay = (d: Trip, day: string) => {
    let e = d.days.find((x) => x.date === day);
    if (!e) {
      e = { date: day, title: "", notes: "", tz: "", items: [] };
      d.days.push(e);
      d.days.sort((a, b) => a.date.localeCompare(b.date));
    }
    return e;
  };

  const insertByTime = (list: PlanItem[], it: PlanItem, index?: number) => {
    if (index !== undefined) return list.splice(Math.max(0, Math.min(index, list.length)), 0, it);
    if (it.time) {
      const at = list.findIndex((o) => o.time && o.time > it.time!);
      if (at >= 0) return list.splice(at, 0, it);
    }
    list.push(it);
  };

  const scheduleIdea = (ideaId: string, day: string, time: string | null, index?: number) => {
    const newId = uid("i-");
    item.update((d) => {
      const idea = d.ideas.find((i) => i.id === ideaId);
      if (!idea) return;
      const e = ensureDay(d, day);
      if (e.items.length >= 40) return;
      const extra = [idea.hours && `Hours: ${idea.hours}`, idea.book_ahead && "Book ahead"].filter(Boolean).join("; ");
      insertByTime(
        e.items,
        {
          id: newId, time, duration_min: idea.duration_min, type: idea.type, title: idea.title, place: idea.place,
          address: idea.address, area: idea.area, lat: idea.lat, lng: idea.lng, cost_minor: idea.cost_minor, currency: idea.currency,
          link: idea.link, status: "planned", notes: [idea.notes, extra].filter(Boolean).join("\n").slice(0, 2000), booking_id: null, travel_after: "",
        },
        index,
      );
      d.ideas = d.ideas.filter((i) => i.id !== ideaId);
    });
  };

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    setDragIdea(id.startsWith("idea:") ? t.ideas.find((i) => `idea:${i.id}` === id) ?? null : null);
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDragIdea(null);
    const a = String(e.active.id);
    const o = e.over ? String(e.over.id) : null;
    if (!o || !item.canEdit) return;
    if (a.startsWith("idea:")) {
      const ideaId = a.slice(5);
      if (o.startsWith("day:")) scheduleIdea(ideaId, o.slice(4), null);
      else if (o.startsWith("it:")) {
        const idx = t.days.find((x) => x.date === selected)?.items.findIndex((i) => `it:${i.id}` === o) ?? -1;
        scheduleIdea(ideaId, selected, null, idx >= 0 ? idx : undefined);
      }
      return;
    }
    if (a.startsWith("it:")) {
      const itemId = a.slice(3);
      if (o.startsWith("day:")) {
        const to = o.slice(4);
        if (to === selected) return;
        item.update((d) => {
          const src = d.days.find((x) => x.items.some((i) => i.id === itemId));
          const it = src?.items.find((i) => i.id === itemId);
          if (!src || !it) return;
          const dst = ensureDay(d, to);
          if (dst.items.length >= 40) return;
          src.items = src.items.filter((i) => i.id !== itemId);
          insertByTime(dst.items, it);
        });
      } else if (o.startsWith("it:") && o !== a) {
        item.update((d) => {
          const e2 = d.days.find((x) => x.date === selected);
          if (!e2) return;
          const from = e2.items.findIndex((i) => `it:${i.id}` === a);
          const to = e2.items.findIndex((i) => `it:${i.id}` === o);
          if (from >= 0 && to >= 0) e2.items = arrayMove(e2.items, from, to);
        });
      }
    }
  };

  const saveEdit = (d: PlanDraft) => {
    const target = edit;
    if (!target) return;
    const newId = uid(target.kind === "item" ? "i-" : "idea-");
    // Edits assign only the fields changed in the sheet (what it opened with
    // vs what it saves), so a companion's change to another field survives.
    const mode = target.kind;
    const opened = target.kind === "item" ? draftFrom(t, target.item, target.day) : draftFrom(t, target.idea, selected);
    const before = applyDraft(t, {} as Partial<PlanItem & Idea>, opened, mode);
    const after = applyDraft(t, {} as Partial<PlanItem & Idea>, d, mode);
    item.update((x) => {
      if (target.kind === "item") {
        if (target.item) {
          const src = x.days.find((z) => z.items.some((i) => i.id === target.item!.id));
          const it = src?.items.find((i) => i.id === target.item!.id);
          if (!src || !it) return;
          assignChanged(it, before as Partial<PlanItem>, after as Partial<PlanItem>);
          if (d.date !== opened.date && d.date !== src.date) {
            src.items = src.items.filter((i) => i.id !== it.id);
            insertByTime(ensureDay(x, d.date).items, it);
          }
        } else if (!x.days.some((z) => z.items.some((i) => i.id === newId))) {
          const it = applyDraft(x, { id: newId, booking_id: null } as PlanItem, d, "item");
          const e = ensureDay(x, d.date);
          if (e.items.length < 40) insertByTime(e.items, it);
        }
      } else if (target.idea) {
        const i = x.ideas.find((z) => z.id === target.idea!.id);
        if (i) assignChanged(i, before as Partial<Idea>, after as Partial<Idea>);
      } else if (x.ideas.length < 500 && !x.ideas.some((z) => z.id === newId)) {
        x.ideas.push(applyDraft(x, { id: newId } as Idea, d, "idea"));
      }
    });
    setEdit(null);
  };

  const removeEdit = () => {
    const target = edit;
    if (!target) return;
    item.update((x) => {
      if (target.kind === "item" && target.item) for (const day of x.days) day.items = day.items.filter((i) => i.id !== target.item!.id);
      if (target.kind === "idea" && target.idea) x.ideas = x.ideas.filter((i) => i.id !== target.idea!.id);
    });
    setEdit(null);
  };

  const backToIdeas = () => {
    const target = edit;
    if (!target || target.kind !== "item" || !target.item) return;
    const newId = uid("idea-");
    item.update((x) => {
      const it = x.days.flatMap((day) => day.items).find((i) => i.id === target.item!.id);
      if (!it) return;
      for (const day of x.days) day.items = day.items.filter((i) => i.id !== it.id);
      x.ideas.push({
        id: newId, title: it.title, type: it.type, place: it.place, address: it.address, area: it.area, lat: it.lat, lng: it.lng,
        tags: [], priority: "want", duration_min: it.duration_min, cost_minor: it.cost_minor, currency: it.currency, hours: "",
        book_ahead: false, link: it.link, notes: it.notes,
      });
    });
    setEdit(null);
  };

  const openNext = (n: ReturnType<typeof nextUp>[number]) => {
    if (n.booking && narrow) setShowing(n.booking.id);
    else if (n.booking) {
      requestBooking(n.booking.id);
      goTo("bookings");
    } else {
      setSelected(n.day);
      setView("days");
    }
  };

  const dayIndex = t.start ? dates.indexOf(selected) - Math.max(0, dates.indexOf(t.start)) : -1;
  const sheetInitial = edit
    ? edit.kind === "item"
      ? draftFrom(t, edit.item, edit.day)
      : draftFrom(t, edit.idea, selected)
    : draftFrom(t, null, selected);

  const ideasPanel = (
    <IdeasPanel item={item} dates={dates} onEdit={setEdit} onSchedule={setScheduling} ask={ask} />
  );
  const dayView = dates.length ? (
    <DayView item={item} day={selected} index={dayIndex} events={events} onEdit={setEdit} ask={ask} goTo={goTo} isPhone={isPhone} onShow={(b) => setShowing(b.id)} />
  ) : (
    <EmptyState
      icon={CalendarDays}
      title="When are you going?"
      text="Add the trip's dates to get a day-by-day plan. Bookings you add show up on their days automatically."
      action={
        item.canEdit && (
          <ItemButton variant="primary" icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Help me pick dates for this trip and set them.")}>
            Ask the assistant
          </ItemButton>
        )
      }
    />
  );

  const hero = <TripHero item={item} title={doc.title} issues={issues} onIssues={() => setShowIssues(true)} compact={false} />;
  const next = <NextUpCard trip={t} now={now} onOpen={openNext} onShow={(b) => setShowing(b.id)} />;

  return (
    <DndContext sensors={sensors} collisionDetection={collide} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragIdea(null)}>
      {narrow ? (
        <Page>
          {hero}
          {next}
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: "days", label: <span className="inline-flex items-center gap-1.5"><ListOrdered className="h-4 w-4" /> Itinerary</span> },
              { value: "ideas", label: <span className="inline-flex items-center gap-1.5"><Lightbulb className="h-4 w-4" /> Ideas{t.ideas.length ? ` · ${t.ideas.length}` : ""}</span> },
            ]}
          />
          {view === "days" ? (
            <>
              {dates.length > 0 && <DayStrip dates={dates} selected={selected} onSelect={setSelected} today={today} />}
              {dayView}
            </>
          ) : (
            ideasPanel
          )}
          {item.canEdit && (
            <Fab
              label={view === "ideas" ? "Idea" : "Add"}
              icon={Plus}
              onClick={() => setEdit(view === "ideas" ? { kind: "idea", idea: null } : { kind: "item", day: selected, item: null })}
            />
          )}
        </Page>
      ) : (
        <Page wide className="max-w-[1400px]">
          {hero}
          <div className={cn("grid gap-6", three ? "grid-cols-[232px_minmax(0,1fr)_320px]" : "grid-cols-[220px_minmax(0,1fr)]")}>
            <aside className="flex flex-col gap-4">
              {dates.length > 0 && (
                <Section title="Days">
                  <DayList trip={t} dates={dates} selected={view === "days" || three ? selected : ""} onSelect={(d) => { setSelected(d); setView("days"); }} today={today} noStay={noStay} />
                </Section>
              )}
              {!three && (
                <button
                  type="button"
                  onClick={() => setView("ideas")}
                  className={cn(
                    "flex items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm font-medium transition",
                    view === "ideas" ? "bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]",
                  )}
                >
                  <Lightbulb className="h-4 w-4" /> Ideas {t.ideas.length ? `· ${t.ideas.length}` : ""}
                </button>
              )}
            </aside>
            <main className="flex min-w-0 flex-col gap-4">
              {next}
              {three || view === "days" ? dayView : ideasPanel}
            </main>
            {three && <aside className="flex flex-col gap-4">{ideasPanel}</aside>}
          </div>
        </Page>
      )}
      <DragOverlay>
        {dragIdea ? (
          <div className="flex items-center gap-2 rounded-xl border border-[var(--item-accent)] bg-[var(--surface)] px-3 py-2 text-sm font-medium text-[var(--text)] shadow-[var(--shadow-lg)]">
            <TypeBadge type={dragIdea.type} size={28} /> {dragIdea.title}
          </div>
        ) : null}
      </DragOverlay>

      <PlanItemSheet
        open={!!edit}
        onClose={() => setEdit(null)}
        trip={t}
        mode={edit?.kind === "idea" ? "idea" : "item"}
        initial={sheetInitial}
        title={edit?.kind === "idea" ? (edit.idea ? "Idea" : "New idea") : edit?.item ? "Edit plan" : `Add to ${fmtDate(edit?.kind === "item" ? edit.day : selected)}`}
        dates={dates}
        onSave={saveEdit}
        onDelete={edit && ((edit.kind === "item" && edit.item) || (edit.kind === "idea" && edit.idea)) && item.canEdit ? removeEdit : undefined}
        extra={
          edit?.kind === "item" && edit.item && item.canEdit ? (
            <ItemButton variant="ghost" size="sm" className="self-start" icon={<Lightbulb className="h-4 w-4" />} onClick={backToIdeas}>
              Move back to Ideas
            </ItemButton>
          ) : edit?.kind === "idea" && edit.idea && dates.length > 0 && item.canEdit ? (
            <ItemButton
              variant="secondary"
              size="sm"
              className="self-start"
              icon={<CalendarPlus className="h-4 w-4" />}
              onClick={() => {
                const i = edit.idea;
                setEdit(null);
                setScheduling(i);
              }}
            >
              Add to a day
            </ItemButton>
          ) : undefined
        }
      />
      <ScheduleSheet
        idea={scheduling}
        dates={dates}
        trip={t}
        onClose={() => setScheduling(null)}
        onPick={(day, time) => {
          if (scheduling) scheduleIdea(scheduling.id, day, time);
          setScheduling(null);
          setSelected(day);
        }}
      />
      <BookingQuickView
        trip={t}
        booking={showBooking}
        onClose={() => setShowing(null)}
        onOpenFull={() => {
          if (showBooking) requestBooking(showBooking.id);
          setShowing(null);
          goTo("bookings");
        }}
      />
      <IssuesSheet open={showIssues} onClose={() => setShowIssues(false)} issues={issues} onDay={(d) => { setSelected(d); setView("days"); }} ask={ask} />
    </DndContext>
  );
}
