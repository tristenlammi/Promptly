import type { CalUser, Repeat } from "@/api/calendar";
import { parseQuick } from "@/items/kinds/tasks/quickadd";
import type { Repeat as TaskRepeat } from "@/items/kinds/tasks/types";
import { parseSpan } from "@/lib/quickdate";

import { addDays, parseYmd, startOfDay, WEEK_START, ymd } from "./dates";

/*
 * Quick add for events: "Dinner with Sam Fri 7-9pm at Mum's" → an event.
 * Dates, times, repeats and spans are Promptly's shared wording
 * (``lib/quickdate``, through the Tasks parser — so both apps read "next
 * Tue", "every other week", "at 5" the same way):
 *
 *   ranges     7-9pm, 7pm–9:30pm, 7 to 9, from 10 until 11:30, 14:00-15:30
 *   lengths    for 2 hours, for 90 min, for an hour, for half an hour
 *   all day    "all day" / "all-day"
 *
 * and on top of it:
 *
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
  const { rest: s, ...got } = parseSpan(` ${mask(input)} `);

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
