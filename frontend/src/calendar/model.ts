import type { CSSProperties } from "react";

import type { CalBill, CalBirthday, CalEvent, CalExtras, CalHoliday, Calendar, CalMeal, CalTask, CalTrip, CalWorkout, Repeat, RsvpStatus } from "@/api/calendar";

import { addDays, DAY_MS, dayDiff, fmt, ordinal, parseYmd, sameDay, shortTime, startOfDay, timeLabel, WEEKDAYS_MON, weekdayIndexMon } from "./dates";

export const CAL_ACCENT = "#4F7FE0";
/** Events I'm only invited to (not on one of my calendars). */
const INVITED_COLOR = "#7C83A0";

export const PALETTE = ["#4F7FE0", "#2F9E8F", "#4E9F5B", "#D9902F", "#E2725B", "#D9506A", "#9B6CD9", "#7C83A0"];

export type View = "month" | "week" | "day" | "agenda";

export type Look = "solid" | "invited" | "pending" | "declined";

/** Something from another app drawn among the events (not an event itself).
 *  Meals come one chip per day (``meals``: that day's, in slot order). */
export type Extra =
  | { kind: "task"; task: CalTask }
  | { kind: "birthday"; b: CalBirthday }
  | { kind: "workout"; w: CalWorkout }
  | { kind: "meals"; day: string; meals: CalMeal[] }
  | { kind: "bill"; bill: CalBill }
  | { kind: "trip"; trip: CalTrip }
  | { kind: "holiday"; h: CalHoliday };

/** The colours of the other apps on the calendar. */
export const EXTRA_COLORS = { workout: "#E2725B", meals: "#4E9F5B", bill: "#D9902F", holiday: "#7C83A0" } as const;

/** An occurrence ready to draw: local Dates, ``end`` exclusive. */
export interface ViewEvent {
  ev: CalEvent;
  /** Set for tasks / birthdays (``ev`` is then a read-only stand-in). */
  extra?: Extra;
  start: Date;
  end: Date;
  allDay: boolean;
  /** Drawn in the all-day row / as a bar (all-day, or a day or longer). */
  spanning: boolean;
  color: string;
  look: Look;
}

/** ``meId``: a shared calendar's member who only set their own reminders
 *  has an (unanswered, non-guest) row — that isn't an invitation. */
export function toView(ev: CalEvent, cals: Map<string, Calendar>, meId?: string): ViewEvent {
  let start: Date;
  let end: Date;
  if (ev.all_day) {
    start = parseYmd(ev.start);
    end = addDays(parseYmd(ev.end), 1);
  } else {
    start = new Date(ev.start);
    end = new Date(ev.end);
    if (end <= start) end = new Date(start.getTime() + 30 * 60_000);
  }
  const cal = cals.get(ev.calendar_id);
  const mine = ev.on_my_calendar && !!cal;
  const color = ev.color ?? (mine ? cal!.color : INVITED_COLOR);
  let look: Look = mine ? "solid" : "invited";
  const myRow = meId ? ev.attendees.find((a) => a.user_id === meId) : undefined;
  const memberRow = mine && !!myRow && !myRow.guest;
  if (ev.my_status === "invited" && !memberRow) look = "pending";
  if (ev.my_status === "declined") look = "declined";
  const spanning = ev.all_day || end.getTime() - start.getTime() >= DAY_MS;
  return { ev, start, end, allDay: ev.all_day, spanning, color, look };
}

// ------------------------------------------------------------------ extras

function standIn(id: string, title: string, allDay: boolean, start: string, end: string): CalEvent {
  return {
    id,
    event_id: id,
    occurrence: "",
    calendar_id: "",
    title,
    description: "",
    location: "",
    all_day: allDay,
    start,
    end,
    series_start: start,
    series_end: end,
    tz: "",
    repeat: null,
    color: null,
    created_by: null,
    guests_can_edit: false,
    reminders: [],
    event_reminders: [],
    attendees: [],
    my_status: null,
    on_my_calendar: false,
    can_edit: false,
    can_delete: false,
  };
}

/** "Sam turns 36" / "Sam's birthday" / "Jo's wedding anniversary (11 years)". */
export function birthdayLabel(b: CalBirthday): string {
  if (b.kind === "birthday") return b.years ? `${b.name} turns ${b.years}` : `${b.name}'s birthday`;
  const what = b.label ? `${b.label.toLowerCase()} anniversary` : "anniversary";
  return `${b.name}'s ${what}${b.years ? ` (${b.years} ${b.years === 1 ? "year" : "years"})` : ""}`;
}

/** "Lower A" / "Legs · training day" / "Dinner: Lasagne" / "Netflix · $15.99" — a chip's words. */
export function extraLabel(x: Extra): string {
  switch (x.kind) {
    case "task":
      return x.task.title;
    case "birthday":
      return birthdayLabel(x.b);
    case "workout":
      return x.w.kind === "day" ? (x.w.name === "Training day" ? "Training day" : `${x.w.name} · training day`) : x.w.name;
    case "meals":
      return x.meals.length === 1 ? `${slotLabel(x.meals[0].slot)}: ${x.meals[0].title}` : x.meals.map((m) => m.title).join(" · ");
    case "bill":
      return `${x.bill.name} · ${x.bill.amount}`;
    case "trip":
      return x.trip.title;
    case "holiday":
      return x.h.name;
  }
}

export function slotLabel(slot: string): string {
  return slot.charAt(0).toUpperCase() + slot.slice(1);
}

/** Every "Also show" item as drawable items: all-day ones in the all-day
 *  row, a timed task as a 30-minute marker, a trip as a bar over its days. */
export function extrasToView(x: Partial<CalExtras>): ViewEvent[] {
  const { tasks = [], birthdays = [], workouts = [], meals = [], bills = [], trips = [], holidays = [] } = x;
  const out: ViewEvent[] = [];
  const allDay = (id: string, extra: Extra, day: string, color: string, last = day) => {
    const start = parseYmd(day);
    out.push({ ev: standIn(id, extraLabel(extra), true, day, last), extra, start, end: addDays(parseYmd(last), 1), allDay: true, spanning: true, color, look: "solid" });
  };
  for (const h of holidays) allDay(`hol:${h.country}:${h.day}:${h.name}`, { kind: "holiday", h }, h.day, EXTRA_COLORS.holiday);
  for (const t of trips) allDay(`trip:${t.file_id}:${t.trip_id}`, { kind: "trip", trip: t }, t.start, t.color || "#2C9CC8", t.end < t.start ? t.start : t.end);
  for (const w of workouts) allDay(`wo:${w.file_id}:${w.id ?? "day"}:${w.day}`, { kind: "workout", w }, w.day, EXTRA_COLORS.workout);
  const byDay = new Map<string, CalMeal[]>();
  for (const m of meals) byDay.set(m.day, [...(byDay.get(m.day) ?? []), m]);
  for (const [day, list] of byDay) allDay(`meals:${day}`, { kind: "meals", day, meals: list }, day, EXTRA_COLORS.meals);
  for (const b of bills) allDay(`bill:${b.file_id}:${b.id}:${b.day}`, { kind: "bill", bill: b }, b.day, EXTRA_COLORS.bill);
  for (const b of birthdays) {
    const start = parseYmd(b.day);
    const id = `bday:${b.file_id}:${b.contact_id}:${b.kind}:${b.label}:${b.day}`;
    out.push({ ev: standIn(id, birthdayLabel(b), true, b.day, b.day), extra: { kind: "birthday", b }, start, end: addDays(start, 1), allDay: true, spanning: true, color: b.color || "#D9506A", look: "solid" });
  }
  for (const t of tasks) {
    const day = parseYmd(t.due);
    const id = `task:${t.file_id}:${t.task_id}:${t.due}`;
    if (t.time) {
      const [h, m] = t.time.split(":").map(Number);
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h || 0, m || 0);
      const end = new Date(start.getTime() + 30 * 60_000);
      out.push({ ev: standIn(id, t.title, false, start.toISOString(), end.toISOString()), extra: { kind: "task", task: t }, start, end, allDay: false, spanning: false, color: t.color, look: "solid" });
    } else {
      out.push({ ev: standIn(id, t.title, true, t.due, t.due), extra: { kind: "task", task: t }, start: day, end: addDays(day, 1), allDay: true, spanning: true, color: t.color, look: "solid" });
    }
  }
  return out;
}

/** An event moved to new times (a drag in progress, or one saving). */
export function withTimes(v: ViewEvent, start: Date, end: Date): ViewEvent {
  return { ...v, start, end, spanning: v.allDay || end.getTime() - start.getTime() >= DAY_MS };
}

/** Chip / block styling for an event's look. */
export function lookStyle(v: ViewEvent): { style: CSSProperties; className: string } {
  const c = v.color;
  switch (v.look) {
    case "solid":
      return { style: { background: c, color: "#fff" }, className: "" };
    case "invited":
      return {
        style: { background: `color-mix(in srgb, ${c} 18%, var(--surface))`, borderColor: c, color: "var(--text)" },
        className: "border border-dashed",
      };
    case "pending":
      return {
        style: { background: "var(--surface)", borderColor: c, color: "var(--text)" },
        className: "border border-dashed",
      };
    case "declined":
      return {
        style: { background: `color-mix(in srgb, ${c} 10%, var(--surface))`, color: "var(--text-muted)" },
        className: "line-through opacity-60",
      };
  }
}

/** Does the event touch the day [day, day+1)? */
export function onDay(v: ViewEvent, day: Date): boolean {
  const s = startOfDay(day);
  const e = addDays(s, 1);
  return v.start < e && v.end > s;
}

// All-day order: holidays and trips, birthdays, events, the other apps, tasks.
const EXTRA_RANK: Record<Extra["kind"], number> = { holiday: 0, trip: 1, birthday: 2, workout: 4, meals: 4, bill: 4, task: 5 };
const extraRank = (v: ViewEvent) => (v.extra ? EXTRA_RANK[v.extra.kind] : 3);

export function sortEvents(a: ViewEvent, b: ViewEvent): number {
  if (a.spanning !== b.spanning) return a.spanning ? -1 : 1;
  // All-day: holidays, trips, birthdays, then events, then the other apps and tasks.
  const r = a.spanning ? extraRank(a) - extraRank(b) : 0;
  if (r) return r;
  const d = a.start.getTime() - b.start.getTime();
  if (d) return d;
  const len = b.end.getTime() - b.start.getTime() - (a.end.getTime() - a.start.getTime());
  return len || a.ev.title.localeCompare(b.ev.title);
}

// ------------------------------------------------------------------ layout

/** Lanes for bars across a run of ``days`` days from ``from`` (month rows, the all-day row). */
export function layoutSpans(events: ViewEvent[], from: Date, days: number): { v: ViewEvent; col: number; span: number; lane: number }[] {
  const to = addDays(from, days);
  const items = events
    .filter((v) => v.start < to && v.end > from)
    .sort(sortEvents)
    .map((v) => {
      const col = Math.max(0, dayDiff(from, v.start));
      // Last day the event touches (end is exclusive).
      const lastDay = new Date(v.end.getTime() - 1);
      const endCol = Math.min(days - 1, dayDiff(from, lastDay));
      return { v, col: v.start < from ? 0 : col, span: Math.max(1, endCol - (v.start < from ? 0 : col) + 1), lane: 0 };
    });
  const lanes: number[] = []; // lane → first free column
  for (const it of items) {
    let lane = lanes.findIndex((free) => free <= it.col);
    if (lane < 0) {
      lane = lanes.length;
      lanes.push(0);
    }
    lanes[lane] = it.col + it.span;
    it.lane = lane;
  }
  return items;
}

/** Side-by-side columns for overlapping timed events on one day. */
export function layoutDay(events: ViewEvent[], day: Date): { v: ViewEvent; top: number; bottom: number; col: number; cols: number }[] {
  const s = startOfDay(day).getTime();
  const e = addDays(startOfDay(day), 1).getTime();
  const items = events
    .filter((v) => !v.spanning && v.start.getTime() < e && v.end.getTime() > s)
    .map((v) => {
      const top = (Math.max(v.start.getTime(), s) - s) / 60_000;
      // At least 20 minutes tall so a short event stays clickable.
      const bottom = Math.max(top + 20, (Math.min(v.end.getTime(), e) - s) / 60_000);
      return { v, top, bottom, col: 0, cols: 1 };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  let cluster: typeof items = [];
  let clusterEnd = -1;
  const flush = () => {
    const ends: number[] = [];
    for (const it of cluster) {
      let c = ends.findIndex((end) => end <= it.top);
      if (c < 0) {
        c = ends.length;
        ends.push(0);
      }
      ends[c] = it.bottom;
      it.col = c;
    }
    for (const it of cluster) it.cols = ends.length;
    cluster = [];
  };
  for (const it of items) {
    if (cluster.length && it.top >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.bottom);
  }
  flush();
  return items;
}

// ------------------------------------------------------------------ words

export function describeRepeat(r: Repeat | null, start: Date): string {
  if (!r) return "";
  const n = r.interval && r.interval > 1 ? r.interval : 1;
  let s: string;
  switch (r.freq) {
    case "daily":
      s = n > 1 ? `Every ${n} days` : "Every day";
      break;
    case "weekly": {
      const days = r.weekdays?.length ? r.weekdays : [weekdayIndexMon(start)];
      const weekdaysOnly = days.length === 5 && [0, 1, 2, 3, 4].every((d) => days.includes(d));
      if (weekdaysOnly && n === 1) s = "Every weekday (Mon–Fri)";
      else s = `${n > 1 ? `Every ${n} weeks` : "Every week"} on ${days.map((d) => WEEKDAYS_MON[d].short).join(", ")}`;
      break;
    }
    case "monthly":
      s = `${n > 1 ? `Every ${n} months` : "Every month"} on ${r.monthly === "weekday" ? `the ${nthWeekday(start)}` : `day ${start.getDate()}`}`;
      break;
    case "yearly":
      s = `${n > 1 ? `Every ${n} years` : "Every year"} on ${fmt(start, { month: "long", day: "numeric" })}`;
      break;
  }
  if (r.until) s += `, until ${fmt(parseYmd(r.until), { month: "short", day: "numeric", year: "numeric" })}`;
  else if (r.count) s += `, ${r.count} times`;
  return s;
}

/** "2nd Tuesday" / "last Friday" for a date. */
export function nthWeekday(d: Date): string {
  const n = Math.floor((d.getDate() - 1) / 7) + 1;
  const wd = WEEKDAYS_MON[weekdayIndexMon(d)].long;
  return n === 5 ? `last ${wd}` : `${ordinal(n)} ${wd}`;
}

/** "Tuesday, November 3 · 9:00 – 10:00 AM" etc. */
export function describeWhen(v: ViewEvent): string {
  const longDay = (d: Date) => fmt(d, { weekday: "long", month: "long", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
  if (v.allDay) {
    const last = addDays(v.end, -1);
    return sameDay(v.start, last) ? longDay(v.start) : `${longDay(v.start)} – ${longDay(last)}`;
  }
  if (sameDay(v.start, v.end) || (v.end.getTime() - startOfDay(v.end).getTime() === 0 && dayDiff(v.start, v.end) === 1)) {
    return `${longDay(v.start)} · ${timeLabel(v.start)} – ${timeLabel(v.end)}`;
  }
  return `${longDay(v.start)}, ${timeLabel(v.start)} – ${longDay(v.end)}, ${timeLabel(v.end)}`;
}

export function chipTime(v: ViewEvent): string {
  return v.allDay ? "" : shortTime(v.start);
}

export const REMINDER_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "At time" },
  { value: 5, label: "5 min" },
  { value: 10, label: "10 min" },
  { value: 30, label: "30 min" },
  { value: 60, label: "1 hour" },
  { value: 1440, label: "1 day" },
  { value: 10080, label: "1 week" },
];

export function reminderLabel(m: number): string {
  const o = REMINDER_OPTIONS.find((x) => x.value === m);
  if (o) return o.value === 0 ? o.label : `${o.label} before`;
  if (m % 1440 === 0) return `${m / 1440} days before`;
  if (m % 60 === 0) return `${m / 60} hours before`;
  return `${m} min before`;
}

export const STATUS_LABEL: Record<RsvpStatus, string> = {
  going: "Going",
  maybe: "Maybe",
  declined: "Can't go",
  invited: "Not answered",
};
