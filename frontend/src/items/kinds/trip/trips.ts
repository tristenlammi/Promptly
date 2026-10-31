/* Many trips in one file (mirrors backend trips.py).
 *
 * The tabs were written for one trip and read ``trip.settings`` — so each tab
 * gets a *scoped handle*: ``data`` is the selected trip's view (the trip plus
 * the file's preferences with the trip's own home currency) and ``update``
 * runs the tab's mutator on that trip inside the file draft, then writes back
 * what changed (home currency → the trip, preferences → the file). Server
 * actions get ``trip: <id>``.
 *
 * Which trip is open is kept per file in memory (shared by every tab): the
 * phone starts on the trips list; desktop opens the current / next trip. */

import { useMemo, useSyncExternalStore } from "react";

import { uid } from "@/items/ui";
import type { ItemHandle } from "@/items/useItem";

import { dayDiff } from "./tz";
import type { Trip, TripFile, TripRecord, TripSettings } from "./types";

export const DEFAULT_SETTINGS: TripSettings = { home_currency: "AUD", passport_months: 6, onboarded: false, clock: "auto", distance: "km" };
const FILE_PREFS = ["passport_months", "onboarded", "clock", "distance"] as const;
export const MAX_TRIPS = 100;

export function fileSettings(f: TripFile): TripSettings {
  return { ...DEFAULT_SETTINGS, ...(f.settings ?? {}) };
}

export function viewOf(f: TripFile, t: TripRecord): Trip {
  const s = fileSettings(f);
  return { ...t, settings: { ...s, home_currency: t.home_currency || s.home_currency } };
}

/** Run ``fn`` on trip ``id`` of the draft file ``d`` as a view (in place). */
export function onTrip(d: TripFile, id: string, fn: (t: Trip) => void): void {
  const rec = d.trips?.find((x) => x.id === id);
  if (!rec) return;
  const fs = fileSettings(d);
  const entered: TripSettings = { ...fs, home_currency: rec.home_currency || fs.home_currency };
  const v = rec as Trip;
  v.settings = { ...entered };
  try {
    fn(v);
  } finally {
    const s = v.settings;
    delete (v as Partial<Trip>).settings;
    if (s) {
      if (s.home_currency) rec.home_currency = s.home_currency;
      d.settings ??= { ...DEFAULT_SETTINGS };
      for (const k of FILE_PREFS) if (s[k] !== entered[k]) (d.settings as unknown as Record<string, unknown>)[k] = s[k];
    }
  }
}

/* --------------------------------------------------------------- order */

export type Bucket = "now" | "upcoming" | "undated" | "past";

export function titleOf(t: Pick<TripRecord, "title" | "destinations">): string {
  if (t.title.trim()) return t.title.trim();
  const names = t.destinations.slice(0, 3).map((d) => d.name);
  return names.length ? names.join(" & ") : "Untitled trip";
}

export function bucketOf(t: TripRecord, today: string): Bucket {
  const end = t.end ?? t.start;
  if (t.status === "done" && (!end || end < today || !t.start)) return "past";
  if (!t.start || !end) return "undated";
  if (end < today) return "past";
  if (t.start <= today) return "now";
  return "upcoming";
}

/** now, upcoming (soonest first), undated, past (most recent first). */
export function ordered(trips: TripRecord[], today: string): { bucket: Bucket; trip: TripRecord }[] {
  const g: Record<Bucket, TripRecord[]> = { now: [], upcoming: [], undated: [], past: [] };
  for (const t of trips) g[bucketOf(t, today)].push(t);
  const byStart = (a: TripRecord, b: TripRecord) => (a.start ?? "9999").localeCompare(b.start ?? "9999") || titleOf(a).localeCompare(titleOf(b));
  g.now.sort(byStart);
  g.upcoming.sort(byStart);
  g.undated.sort(byStart);
  g.past.sort((a, b) => (b.end ?? b.start ?? "").localeCompare(a.end ?? a.start ?? ""));
  return (["now", "upcoming", "undated", "past"] as Bucket[]).flatMap((bucket) => g[bucket].map((trip) => ({ bucket, trip })));
}

/** The trip to open when none is picked: happening now, else the next one. */
export function defaultTripId(trips: TripRecord[], today: string): string | null {
  const rows = ordered(trips, today);
  return (rows.find((r) => r.bucket === "now") ?? rows.find((r) => r.bucket === "upcoming") ?? rows[0])?.trip.id ?? null;
}

export function countdownText(t: TripRecord, today: string): string {
  const b = bucketOf(t, today);
  if (b === "undated") return "No dates yet";
  if (b === "now") {
    const day = dayDiff(t.start!, today) + 1;
    const of = dayDiff(t.start!, t.end ?? t.start!) + 1;
    return `Day ${day} of ${of}`;
  }
  if (b === "upcoming") {
    const n = dayDiff(today, t.start!);
    if (n === 1) return "Tomorrow";
    if (n <= 45) return `In ${n} days`;
    return `In ${Math.round(n / 30.4)} months`;
  }
  return "";
}

/* ------------------------------------------------------------ selection */

const selected = new Map<string, string | null>();
const listeners = new Set<() => void>();
let version = 0;

export function selectTrip(fileId: string, tripId: string | null) {
  selected.set(fileId, tripId);
  version++;
  listeners.forEach((f) => f());
}

/** The picked trip id for this file: undefined = never picked (use the
 *  default), null = the trips list. */
export function useSelectedTrip(fileId: string): string | null | undefined {
  useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => void listeners.delete(f);
    },
    () => version,
  );
  return selected.has(fileId) ? selected.get(fileId) : undefined;
}

/* ---------------------------------------------------------- the handle */

/** A handle on one trip of the file, for the tabs (null when it's gone). */
export function useTripHandle(file: ItemHandle<TripFile>, tripId: string | null): ItemHandle<Trip> | null {
  const rec = tripId ? file.data.trips?.find((t) => t.id === tripId) : undefined;
  const settings = file.data.settings;
  const data = useMemo(() => (rec ? viewOf(file.data, rec) : null), [rec, settings]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => {
    if (!data || !tripId) return null;
    const h: ItemHandle<Trip> = {
      fileId: file.fileId,
      data,
      revision: file.revision,
      canEdit: file.canEdit,
      status: file.status,
      connected: file.connected,
      update: (fn) => file.update((d) => onTrip(d, tripId, fn)),
      runAction: (name, args = {}) => file.runAction(name, { ...args, trip: tripId }),
      undo: file.undo,
      canUndo: file.canUndo,
      accept: () => undefined,
      refresh: file.refresh,
    };
    return h;
  }, [data, file, tripId]);
}

/* -------------------------------------------------------- new / copy */

export function blankTrip(id: string, title: string, home: string): TripRecord {
  return {
    id, title, home_currency: home, emoji: "✈️", color: "#2C9CC8", start: null, end: null, status: "planning", notes: "",
    destinations: [], travellers: [], currencies: [], budget: { total_minor: null, lines: [] }, bookings: [], days: [],
    ideas: [], packing: [], expenses: [], settlements: [], documents: [], me_by_user: {},
  };
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** A copy to plan the next trip from: places, travellers, plan, ideas,
 *  packing (unticked), budget, rates — not bookings, money or visas.
 *  ``start`` shifts the dates and plan; without it the copy is undated. */
export function copyTrip(src: TripRecord, id: string, title: string, start: string | null): TripRecord {
  const c = structuredClone(src);
  const out: TripRecord = {
    ...blankTrip(id, title, src.home_currency),
    emoji: c.emoji, color: c.color, notes: c.notes, travellers: c.travellers, me_by_user: c.me_by_user, currencies: c.currencies,
    budget: c.budget, ideas: c.ideas,
    packing: c.packing.map((p) => ({ ...p, checked: false })),
    documents: c.documents.filter((d) => ["passport", "id_card", "driving_permit"].includes(d.type)).map((d) => ({ ...d, remind_on: null })),
  };
  const days = c.days.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, booking_id: null, status: i.status === "booked" || i.status === "done" ? ("planned" as const) : i.status })) }));
  const ref = src.start ?? days[0]?.date ?? null;
  if (start) {
    const off = ref ? dayDiff(ref, start) : 0;
    out.start = start;
    out.end = src.start && src.end ? addDays(src.end, off) : null;
    out.destinations = c.destinations.map((d) => ({ ...d, start: d.start ? addDays(d.start, off) : null, end: d.end ? addDays(d.end, off) : null }));
    out.days = days.map((d) => ({ ...d, date: addDays(d.date, off) }));
  } else {
    out.destinations = c.destinations.map((d) => ({ ...d, start: null, end: null }));
    const have = new Set(out.ideas.map((i) => i.title.toLowerCase()));
    for (const it of days.flatMap((d) => d.items)) {
      if (have.has(it.title.toLowerCase()) || out.ideas.length >= 500 || it.type === "flight" || it.type === "stay" || it.type === "note") continue;
      have.add(it.title.toLowerCase());
      out.ideas.push({
        id: uid("idea-"), title: it.title, type: it.type, place: it.place, address: it.address, area: it.area, lat: it.lat, lng: it.lng,
        tags: [], priority: "want", duration_min: it.duration_min, cost_minor: it.cost_minor, currency: it.currency, hours: "",
        book_ahead: false, link: it.link, notes: it.notes,
      });
    }
  }
  return out;
}
