import type { CalUser, Repeat } from "@/api/calendar";
import { parseQuick } from "@/items/kinds/tasks/quickadd";
import type { Repeat as TaskRepeat } from "@/items/kinds/tasks/types";

import { addDays, parseYmd, startOfDay, WEEK_START, ymd } from "./dates";

/*
 * Quick add for events: "Dinner with Sam Fri 7-9pm at Mum's" → an event.
 * Dates, times and repeats come from the Tasks app's parser (so both apps
 * read "next Tue", "every other week", "at 5" the same way); on top of it:
 *
 *   ranges     7-9pm, 7pm–9:30pm, 7 to 9, from 10 until 11:30, 14:00-15:30
 *   lengths    for 2 hours, for 90 min, for an hour, for half an hour
 *   all day    "all day" / "all-day"
 *   place      at Mum's, @ the pub ("at 5" / "at 5pm" / "at noon" are times)
 *   guests     with Sam and Jo — matched by username prefix; the words stay
 *              in the title ("Dinner with Sam") either way
 *
 * No time at all → an all-day event (as Google does); a length but no time
 * → it starts at the next hour today (9am on another day). No date → today.
 */

export interface QuickEvent {
  title: string;
  allDay: boolean;
  start: Date;
  /** Exclusive end (timed), or the day after the last (all-day). */
  end: Date;
  repeat: Repeat | null;
  location: string;
  guests: CalUser[];
  /** What was actually understood (for the preview). */
  saw: { date: boolean; time: boolean };
}

// Characters the Tasks parser treats as lists / tags / priorities — kept as
// plain text here ("Drinks @ Joe's", "Launch!!!").
const MASK: [string, string][] = [
  ["#", ""],
  ["@", ""],
  ["!", ""],
];
const mask = (s: string) => MASK.reduce((x, [a, b]) => x.split(a).join(b), s);
const unmask = (s: string) => MASK.reduce((x, [a, b]) => x.split(b).join(a), s);

const NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

/** Hour + am/pm → 0–23 (``mer`` null: as written). */
function to24(h: number, mer: string | null): number {
  if (!mer) return h;
  const pm = /^p/i.test(mer);
  if (pm && h < 12) return h + 12;
  if (!pm && h === 12) return 0;
  return h;
}

/** "7-9pm" style ranges → minutes from midnight (end may pass midnight). */
function readRange(m: RegExpExecArray): { from: number; to: number } | null {
  const [h1, m1, a1, h2, m2, a2] = [Number(m[1]), Number(m[2] || 0), m[3] || null, Number(m[4]), Number(m[5] || 0), m[6] || null];
  if (h1 > 24 || h2 > 24 || m1 > 59 || m2 > 59) return null;
  if ((a1 && (h1 < 1 || h1 > 12)) || (a2 && (h2 < 1 || h2 > 12))) return null;
  let s: number;
  let e: number;
  if (a1 || a2) {
    // One am/pm covers both ("7-9pm"), unless that puts the start after the end ("11-1pm").
    e = to24(h2, a2 ?? a1);
    s = to24(h1, a1 ?? a2);
    if (!a1 && s * 60 + m1 >= e * 60 + m2) s = to24(h1, /^p/i.test(a2!) ? "am" : "pm");
  } else {
    // Bare hours read like "at 5": 1–7 are afternoon; the end is the next such hour after the start.
    s = h1 >= 1 && h1 <= 7 && !m[2] ? h1 + 12 : h1;
    e = h2;
    if (h2 <= 12) {
      while (e * 60 + m2 <= s * 60 + m1 && e < 24) e += 12;
    }
  }
  const from = s * 60 + m1;
  let to = e * 60 + m2;
  if (to <= from) to += 24 * 60;
  return { from, to };
}

function toCalRepeat(r: TaskRepeat | null): Repeat | null {
  if (!r) return null;
  const out: Repeat = { freq: r.freq };
  if (r.interval > 1) out.interval = r.interval;
  if (r.freq === "weekly" && r.weekdays.length) out.weekdays = [...r.weekdays];
  if (r.until) out.until = r.until;
  return out;
}

/** People named after "with": "with Sam, Jo and Alex". */
function matchGuests(text: string, users: CalUser[]): CalUser[] {
  const m = /\bwith\s+([\p{L}\p{N}_.'-]+(?:\s*(?:,|and|&|\+)\s*[\p{L}\p{N}_.'-]+)*)/iu.exec(text);
  if (!m) return [];
  const out: CalUser[] = [];
  for (const raw of m[1].split(/\s*(?:,|\band\b|&|\+)\s*/i)) {
    const name = raw.replace(/'s$/i, "").toLowerCase();
    if (name.length < 2) continue;
    const hit = users.find((u) => u.username.toLowerCase() === name) ?? users.find((u) => u.username.toLowerCase().startsWith(name));
    if (hit && !out.some((g) => g.id === hit.id)) out.push(hit);
  }
  return out;
}

/** A new event's start when only a length was given: the next hour today, else 9am. */
function nextHour(day: Date, now: Date): Date {
  if (ymd(day) === ymd(now)) {
    const s = new Date(now);
    s.setHours(now.getHours() + 1, 0, 0, 0);
    return s;
  }
  const s = startOfDay(day);
  s.setHours(9);
  return s;
}

export function parseEvent(input: string, opts: { now?: Date; users?: CalUser[]; meId?: string } = {}): QuickEvent {
  const now = opts.now ?? new Date();
  const users = (opts.users ?? []).filter((u) => u.id !== opts.meId);
  let s = ` ${mask(input)} `;
  const take = (re: RegExp, fn: (m: RegExpExecArray) => boolean | void) => {
    const m = re.exec(s);
    if (!m || fn(m) === false) return false;
    s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length);
    return true;
  };

  // Filled in by the rules below (an object: they assign from callbacks).
  const got: { allDay: boolean; range: { from: number; to: number } | null; length: number | null } = { allDay: false, range: null, length: null };

  take(/\sall[\s-]?day\b/i, () => {
    got.allDay = true;
  });
  const MER = "(am|pm|a\\.m\\.|p\\.m\\.)";
  take(
    new RegExp(`\\s(?:from\\s+|at\\s+)?(\\d{1,2})(?:[:.](\\d{2}))?\\s*${MER}?\\s*(?:-|–|—|to|until|till|til)\\s*(\\d{1,2})(?:[:.](\\d{2}))?\\s*${MER}?(?=\\s|[,.;]|$)`, "i"),
    (m) => {
      got.range = readRange(m);
      return got.range !== null;
    },
  );
  take(/\sfor\s+(half\s+an?\s+hour|(\d+(?:\.\d+)?|an?|one|two|three|four|five|six)\s*(hours?|hrs?|h|minutes?|mins?|m)\b(?:\s+and\s+a\s+half)?)/i, (m) => {
    if (/^half/i.test(m[1])) {
      got.length = 30;
      return;
    }
    const n = Number(m[2]) || NUM[m[2].toLowerCase()] || 1;
    const len = Math.round(/^h/i.test(m[3]) ? n * 60 : n) + (/and\s+a\s+half/i.test(m[0]) ? 30 : 0);
    if (len < 5 || len > 14 * 24 * 60) return false;
    got.length = len;
  });

  const today = ymd(now);
  // The Tasks parser's weeks start on Monday = 0.
  const p = parseQuick(s, [], today, (WEEK_START + 6) % 7);
  let title = unmask(p.title);

  // "at <place>" — what's left after the date and time came out.
  let location = "";
  const at = /(?:^|\s)(?:at|@)\s+(?!\d)(\S.*)$/i.exec(` ${title}`);
  if (at) {
    location = at[1].trim().replace(/[,.;]$/, "");
    title = ` ${title}`.slice(0, at.index).trim().replace(/[,;]$/, "");
  }

  const guests = matchGuests(title, users);
  const day = p.due ? parseYmd(p.due) : startOfDay(now);
  const { range, length } = got;
  const saw = { date: p.due !== null, time: range !== null || p.time !== null };

  let allDay = got.allDay;
  let start: Date;
  let end: Date;
  if (allDay || (!range && !p.time && length === null)) {
    allDay = true;
    start = day;
    end = addDays(day, 1);
  } else if (range) {
    start = new Date(day);
    start.setMinutes(range.from);
    end = new Date(day);
    end.setMinutes(range.to);
  } else {
    if (p.time) {
      const [h, mi] = p.time.split(":").map(Number);
      start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, mi);
    } else {
      start = nextHour(day, now);
    }
    end = new Date(start.getTime() + (length ?? 60) * 60_000);
  }

  return { title: title.replace(/\s+/g, " ").trim(), allDay, start, end, repeat: toCalRepeat(p.repeat), location, guests, saw };
}
