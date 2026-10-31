import { addDays, parseDay, todayISO } from "@/items/ui";

import { ALL_PROMPTS, FAMILY_OF, moodInfo } from "./constants";
import type { Entry, JournalData, Template } from "./types";

/* Pure helpers: ordering, counting, streaks, search, prompts. */

const WORD_RE = /[\p{L}\p{N}_’'-]+/gu;

export function countWords(...texts: string[]): number {
  let n = 0;
  for (const t of texts) n += (t || "").match(WORD_RE)?.length ?? 0;
  return n;
}

export function entryWords(e: Pick<Entry, "title" | "body" | "gratitude">): number {
  return countWords(e.title, e.body, ...(e.gratitude ?? []));
}

const key = (e: Entry) => `${e.date} ${e.time} ${e.created_at ?? ""} ${e.id}`;

export function newestFirst(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
}

export function nowHHMM(d: Date = new Date()): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function normTag(t: string): string {
  return t.trim().replace(/^#+/, "").toLowerCase().replace(/\s+/g, "-").slice(0, 40);
}

/** A plain-text excerpt of Markdown (headings, emphasis and links stripped). */
export function plain(md: string): string {
  return (md || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Markdown flattened for previews, keeping a template's structure
 *  readable: "Highlights: • a • b What was hard: …". */
function flat(body: string): string {
  return plain(
    (body || "")
      .replace(/^#{1,6}\s+(.+?)\s*$/gm, (_, h: string) => `· ${/[:?.!]$/.test(h) ? h : `${h}:`}`)
      .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/gm, "• "),
  ).replace(/^·\s*/, "");
}

export function excerptOf(e: Entry, n = 180): string {
  let t = flat(e.body);
  // Untitled: the heading already shows the first sentence — don't repeat it.
  if (t && !e.title.trim()) {
    const first = t.split(/(?<=[.!?])\s/)[0];
    if (first.length <= 70) t = t.slice(first.length).trim();
  }
  if (!t) t = e.gratitude.join(" · ");
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
}

/** The entry's heading: its title, else the first words. */
export function headingOf(e: Entry): string {
  if (e.title.trim()) return e.title.trim();
  const t = flat(e.body);
  if (!t) {
    if (e.gratitude.length) return "Grateful for…";
    const m = moodInfo(e.mood);
    return m ? `Feeling ${m.label.toLowerCase()}${e.emotions.length ? ` — ${e.emotions.slice(0, 2).join(", ")}` : ""}` : "Untitled entry";
  }
  const first = t.split(/(?<=[.!?])\s/)[0];
  return first.length > 70 ? `${first.slice(0, 69).trimEnd()}…` : first;
}

// ------------------------------------------------------------------ streaks

export interface StreakInfo {
  current: number;
  longest: number;
  daysWritten: number;
  wroteToday: boolean;
}

export function streaks(entries: Entry[], today = todayISO()): StreakInfo {
  const days = new Set(entries.map((e) => e.date));
  const sorted = [...days].sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of sorted) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  }
  let cur = 0;
  let probe = days.has(today) ? today : addDays(today, -1);
  while (days.has(probe)) {
    cur += 1;
    probe = addDays(probe, -1);
  }
  return { current: cur, longest, daysWritten: days.size, wroteToday: days.has(today) };
}

// ------------------------------------------------------------------- search

export interface Filters {
  query: string;
  tags: string[];
  moods: number[];
  starred: boolean;
}

export const NO_FILTERS: Filters = { query: "", tags: [], moods: [], starred: false };

export function hasFilters(f: Filters): boolean {
  return !!f.query.trim() || f.tags.length > 0 || f.moods.length > 0 || f.starred;
}

/** Lower-cased search text per entry, cached by object identity. */
const hayCache = new WeakMap<Entry, string>();
function hay(e: Entry): string {
  let h = hayCache.get(e);
  if (h === undefined) {
    h = [e.title, e.body, e.tags.join(" "), e.emotions.join(" "), e.gratitude.join(" "), e.location, e.weather, e.prompt]
      .join(" ")
      .toLowerCase();
    hayCache.set(e, h);
  }
  return h;
}

export function filterEntries(entries: Entry[], f: Filters): Entry[] {
  const words = f.query.toLowerCase().replace(/#/g, "").split(/\s+/).filter(Boolean);
  return entries.filter((e) => {
    if (f.starred && !e.starred) return false;
    if (f.tags.length && !f.tags.some((t) => e.tags.includes(t))) return false;
    if (f.moods.length && !(e.mood && f.moods.includes(e.mood))) return false;
    if (words.length) {
      const h = hay(e);
      if (!words.every((w) => h.includes(w))) return false;
    }
    return true;
  });
}

export function tagCounts(entries: Entry[]): [string, number][] {
  const m = new Map<string, number>();
  for (const e of entries) for (const t of e.tags) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// ------------------------------------------------------------------ by day

export function byDay(entries: Entry[]): Map<string, Entry[]> {
  const m = new Map<string, Entry[]>();
  for (const e of entries) {
    const list = m.get(e.date);
    if (list) list.push(e);
    else m.set(e.date, [e]);
  }
  for (const list of m.values()) list.sort((a, b) => a.time.localeCompare(b.time));
  return m;
}

export function avgMood(entries: Entry[]): number | null {
  const ms = entries.map((e) => e.mood).filter((m): m is number => !!m);
  return ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null;
}

/** Entries on this calendar day in earlier years, newest first. */
export function onThisDay(entries: Entry[], today = todayISO()): { years: number; entry: Entry }[] {
  const md = today.slice(4);
  const y = Number(today.slice(0, 4));
  return newestFirst(entries.filter((e) => e.date.slice(4) === md && e.date < today)).map((entry) => ({
    years: y - Number(entry.date.slice(0, 4)),
    entry,
  }));
}

// ------------------------------------------------------------------ prompts

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

export function promptPool(data: JournalData): string[] {
  return [...ALL_PROMPTS, ...(data.settings.custom_prompts ?? [])];
}

/** The prompt of the day: stable for the day, skipping ones answered lately. */
export function promptOfDay(data: JournalData, day = todayISO(), shuffle = 0): string {
  const pool = promptPool(data);
  const recent = new Set(
    data.entries.filter((e) => e.prompt && e.date >= addDays(day, -60)).map((e) => e.prompt),
  );
  const fresh = pool.filter((p) => !recent.has(p));
  const list = fresh.length ? fresh : pool;
  return list[(hash(day) + shuffle) % list.length];
}

export function visibleTemplates(data: JournalData): Template[] {
  return data.templates.filter((t) => !t.hidden);
}

export function familyCounts(entries: Entry[]): { id: string; n: number }[] {
  const m = new Map<string, number>();
  for (const e of entries)
    for (const w of e.emotions) {
      const id = FAMILY_OF[w]?.id ?? "other";
      m.set(id, (m.get(id) ?? 0) + 1);
    }
  return [...m.entries()].map(([id, n]) => ({ id, n })).sort((a, b) => b.n - a.n);
}

export function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 5) return "Still up";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

const monthFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
export function fmtMonth(ym: string): string {
  return monthFmt.format(parseDay(`${ym}-01`));
}

const dowFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
/** "Sat" */
export function fmtDow(day: string): string {
  return dowFmt.format(parseDay(day));
}

const shortDayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
/** "Sat 31 Oct" (the person's locale order). */
export function fmtShortDay(day: string): string {
  return shortDayFmt.format(parseDay(day));
}

const fullFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
export function fmtFullDay(day: string): string {
  return fullFmt.format(parseDay(day));
}

/** "21:05" → the person's clock format. */
export function fmtClock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h || 0, m || 0, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function approxBytes(data: JournalData): number {
  try {
    return new Blob([JSON.stringify(data)]).size;
  } catch {
    return JSON.stringify(data).length;
  }
}
