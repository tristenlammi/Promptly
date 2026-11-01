import { firstDue, makeRepeat, plusDays, toUTC, weekday, fromUTC, addMonths, daysInMonth } from "./recur";
import type { Repeat, TaskList } from "./types";

/*
 * Quick add: "Pay rent every month on the 1st #home !3" → the fields. Each
 * rule removes what it understood from the text; what's left is the
 * title. Dates are the person's local days (``today`` comes in).
 *
 *   dates   today, tonight, tomorrow/tmr, Mon…Sun, next week, this weekend,
 *           in 3 days/weeks/months, 12 Mar, Mar 12, 12/3 (day first unless
 *           the locale is US), on the 15th, in March, next month
 *   times   9am, 9:30pm, 21:00, at 5 (→ 17:00), noon, midnight,
 *           tomorrow morning / this evening
 *   repeats every day/week/month/year, daily, weekly, fortnightly,
 *           every 2 weeks, every weekday, every Mon and Thu, every 15th,
 *           every 3 days after done
 *   other   #list (or a #tag if no list has that name), @tag, !1–!3 / p1–p3
 */

export interface Parsed {
  title: string;
  due: string | null;
  time: string | null;
  repeat: Repeat | null;
  priority: number | null;
  listId: string | null;
  tags: string[];
}

const WD_WORDS: [string, number][] = [
  ["monday", 0], ["tuesday", 1], ["wednesday", 2], ["thursday", 3], ["friday", 4], ["saturday", 5], ["sunday", 6],
  ["tues", 1], ["weds", 2], ["thurs", 3], ["thur", 3],
  ["mon", 0], ["tue", 1], ["wed", 2], ["thu", 3], ["fri", 4], ["sat", 5], ["sun", 6],
];
const WD = `(?:${WD_WORDS.map((w) => w[0]).join("|")})`;
const wdOf = (w: string) => WD_WORDS.find((x) => x[0] === w.toLowerCase())?.[1] ?? 0;

const MONTH_WORDS: [string, number][] = [
  ["january", 0], ["february", 1], ["march", 2], ["april", 3], ["may", 4], ["june", 5], ["july", 6], ["august", 7],
  ["september", 8], ["october", 9], ["november", 10], ["december", 11],
  ["sept", 8], ["jan", 0], ["feb", 1], ["mar", 2], ["apr", 3], ["jun", 5], ["jul", 6], ["aug", 7], ["sep", 8], ["oct", 9], ["nov", 10], ["dec", 11],
];
const MON = `(?:${MONTH_WORDS.map((m) => m[0]).join("|")})`;
const monOf = (w: string) => MONTH_WORDS.find((x) => x[0] === w.toLowerCase())?.[1] ?? 0;

const NUM_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const ORD = "(?:st|nd|rd|th)?";
const PRE = "(?:(?:on|by|due|for)\\s+)?";

function dayFirst(): boolean {
  try {
    return !/^en-US$/i.test(navigator.language);
  } catch {
    return true;
  }
}

function clock(h: number, m: number): string {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** A date with no year that's already gone this year means next year's. */
function ymd(today: string, m0: number, d: number, year?: number): string | null {
  const ty = Number(today.slice(0, 4));
  let y = year ?? ty;
  if (y < 100) y += 2000;
  if (d < 1 || d > daysInMonth(y, m0)) return null;
  let iso = fromUTC(new Date(Date.UTC(y, m0, d)));
  if (year === undefined && iso < today) iso = fromUTC(new Date(Date.UTC(y + 1, m0, Math.min(d, daysInMonth(y + 1, m0)))));
  return iso;
}

function nextWeekday(today: string, wd: number, allowToday = false): string {
  const delta = (wd - weekday(today) + 7) % 7;
  return plusDays(today, delta === 0 && !allowToday ? 7 : delta);
}

export function parseQuick(input: string, lists: TaskList[], today: string, weekStart = 0): Parsed {
  let s = ` ${input} `;
  const out: Parsed = { title: "", due: null, time: null, repeat: null, priority: null, listId: null, tags: [] };
  const take = (re: RegExp, fn: (m: RegExpExecArray) => boolean | void) => {
    const m = re.exec(s);
    if (!m) return false;
    if (fn(m) === false) return false;
    s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length);
    return true;
  };

  // ---- repeats (before dates: "every Monday" isn't "Monday")
  const after = "(\\s+after\\s+(?:it'?s\\s+)?(?:done|completed|completion|finished))?";
  take(new RegExp(`\\s(?:every|each)\\s+(other\\s+)?(day|week|month|year)\\b${after}`, "i"), (m) => {
    const freq = ({ day: "daily", week: "weekly", month: "monthly", year: "yearly" } as const)[m[2].toLowerCase() as "day"];
    out.repeat = makeRepeat({ freq, interval: m[1] ? 2 : 1, from_completion: !!m[3] });
  });
  if (!out.repeat)
    take(new RegExp(`\\s(?:every|each)\\s+(\\d+|${Object.keys(NUM_WORDS).join("|")})\\s+(day|week|month|year)s?\\b${after}`, "i"), (m) => {
      const n = Number(m[1]) || NUM_WORDS[m[1].toLowerCase()] || 1;
      const freq = ({ day: "daily", week: "weekly", month: "monthly", year: "yearly" } as const)[m[2].toLowerCase() as "day"];
      out.repeat = makeRepeat({ freq, interval: Math.max(1, Math.min(365, n)), from_completion: !!m[3] });
    });
  if (!out.repeat)
    take(/\s(daily|weekly|fortnightly|monthly|yearly|annually)\b/i, (m) => {
      const w = m[1].toLowerCase();
      out.repeat = makeRepeat({ freq: w === "daily" ? "daily" : w === "monthly" ? "monthly" : w === "yearly" || w === "annually" ? "yearly" : "weekly", interval: w === "fortnightly" ? 2 : 1 });
    });
  if (!out.repeat)
    take(/\s(?:every|each)\s+(weekday|weekdays|workday|work\s+day|weekend|weekends)\b/i, (m) => {
      out.repeat = makeRepeat({ freq: "weekly", weekdays: /end/i.test(m[1]) ? [5, 6] : [0, 1, 2, 3, 4] });
    });
  if (!out.repeat)
    take(new RegExp(`\\s(?:every|each)\\s+(other\\s+)?(${WD}(?:\\s*(?:,|and|&|\\+)\\s*${WD})*)\\b`, "i"), (m) => {
      const days = Array.from(m[2].matchAll(new RegExp(WD, "gi")), (x) => wdOf(x[0]));
      out.repeat = makeRepeat({ freq: "weekly", interval: m[1] ? 2 : 1, weekdays: Array.from(new Set(days)).sort() });
    });
  if (!out.repeat)
    take(new RegExp(`\\s(?:every|each)\\s+(\\d{1,2})${ORD}\\s+(?:of\\s+)?(${MON})\\b`, "i"), (m) => {
      out.repeat = makeRepeat({ freq: "yearly" });
      out.due = ymd(today, monOf(m[2]), Number(m[1]));
    }) ||
    take(new RegExp(`\\s(?:every|each)\\s+(${MON})\\s+(\\d{1,2})${ORD}\\b`, "i"), (m) => {
      out.repeat = makeRepeat({ freq: "yearly" });
      out.due = ymd(today, monOf(m[1]), Number(m[2]));
    });
  if (!out.repeat)
    take(new RegExp(`\\s(?:every|each)\\s+(?:month\\s+on\\s+)?(?:the\\s+)?(\\d{1,2})${ORD}(?:\\s+of\\s+(?:the|every)\\s+month)?\\b`, "i"), (m) => {
      const d = Number(m[1]);
      if (d < 1 || d > 31) return false;
      out.repeat = makeRepeat({ freq: "monthly", month_day: d });
    });
  // "every month on the 1st" — the "on the 1st" after a monthly repeat.
  if (out.repeat?.freq === "monthly" && !out.repeat.month_day)
    take(new RegExp(`\\s(?:on\\s+)?the\\s+(\\d{1,2})${ORD}\\b`, "i"), (m) => {
      const d = Number(m[1]);
      if (d < 1 || d > 31) return false;
      out.repeat!.month_day = d;
    });
  if (out.repeat?.freq === "weekly" && !out.repeat.weekdays.length)
    take(new RegExp(`\\s(?:on\\s+)(${WD}(?:\\s*(?:,|and|&)\\s*${WD})*)\\b`, "i"), (m) => {
      out.repeat!.weekdays = Array.from(new Set(Array.from(m[1].matchAll(new RegExp(WD, "gi")), (x) => wdOf(x[0])))).sort();
    });

  // ---- part-of-day phrases ("tomorrow morning" sets both)
  const PARTS: Record<string, string> = { morning: "09:00", afternoon: "15:00", evening: "18:00", night: "20:00" };
  take(/\s(today|tomorrow|tmrw?|tmr)\s+(morning|afternoon|evening|night)\b/i, (m) => {
    out.due = /^tod/i.test(m[1]) ? today : plusDays(today, 1);
    out.time = PARTS[m[2].toLowerCase()];
  });
  take(/\s(?:this|in\s+the)\s+(morning|afternoon|evening)\b/i, (m) => {
    out.time = PARTS[m[1].toLowerCase()];
    out.due ??= today;
  });

  // ---- dates
  if (!out.due) {
    const rules: [RegExp, (m: RegExpExecArray) => string | null][] = [
      [new RegExp(`\\s${PRE}(\\d{1,2})${ORD}\\s+(?:of\\s+)?(${MON})\\.?(?:,?\\s+(\\d{4}))?\\b`, "i"), (m) => ymd(today, monOf(m[2]), Number(m[1]), m[3] ? Number(m[3]) : undefined)],
      [new RegExp(`\\s${PRE}(${MON})\\.?\\s+(\\d{1,2})${ORD}(?:,?\\s+(\\d{4}))?\\b`, "i"), (m) => ymd(today, monOf(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined)],
      [new RegExp(`\\s${PRE}(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?(?=\\s)`, "i"), (m) => {
        const [a, b] = [Number(m[1]), Number(m[2])];
        const [d, mo] = dayFirst() ? [a, b] : [b, a];
        return mo >= 1 && mo <= 12 ? ymd(today, mo - 1, d, m[3] ? Number(m[3]) : undefined) : null;
      }],
      [/\s(?:(?:due|by|for)\s+)?(today|tod)\b/i, () => today],
      [/\s(tonight)\b/i, () => {
        out.time ??= "19:00";
        return today;
      }],
      [/\s(?:(?:due|by|for)\s+)?(tomorrow|tmrw|tmr|tmw)\b/i, () => plusDays(today, 1)],
      [/\s(?:the\s+)?day\s+after\s+tomorrow\b/i, () => plusDays(today, 2)],
      [/\s(?:(?:by|for)\s+)?next\s+week\b/i, () => nextWeekday(today, weekStart)],
      [/\s(?:(?:by|for)\s+)?next\s+month\b/i, () => addMonths(today.slice(0, 8) + "01", 1, 1)],
      [/\s(?:(?:by|for)\s+)?(?:this\s+)?weekend\b/i, () => nextWeekday(today, 5, true)],
      [new RegExp(`\\s(?:in\\s+)(\\d+|${Object.keys(NUM_WORDS).join("|")})\\s+(day|week|month|year)s?\\b`, "i"), (m) => {
        const n = Number(m[1]) || NUM_WORDS[m[1].toLowerCase()] || 1;
        const u = m[2].toLowerCase();
        if (u === "day") return plusDays(today, n);
        if (u === "week") return plusDays(today, 7 * n);
        return addMonths(today, u === "month" ? n : 12 * n, Number(today.slice(8, 10)));
      }],
      // A bare "sun" / "sat" / "wed" is usually a word ("sun cream"), not a day.
      [new RegExp(`\\s(?:(on|by|due|for|next|this)\\s+)?(${WD})\\b`, "i"), (m) =>
        !m[1] && /^(sun|sat|wed)$/i.test(m[2]) ? null : nextWeekday(today, wdOf(m[2]))],
      [new RegExp(`\\s(?:on\\s+)?the\\s+(\\d{1,2})${ORD}\\b`, "i"), (m) => {
        const d = Number(m[1]);
        if (d < 1 || d > 31) return null;
        const here = ymd(today, toUTC(today).getUTCMonth(), d, Number(today.slice(0, 4)));
        return here && here >= today ? here : addMonths(today.slice(0, 8) + "01", 1, d);
      }],
      [new RegExp(`\\s(?:in|by|during)\\s+(${MON})\\b`, "i"), (m) => {
        const mo = monOf(m[1]);
        const cur = toUTC(today).getUTCMonth();
        return mo === cur ? today : ymd(today, mo, 1);
      }],
    ];
    for (const [re, fn] of rules) {
      let got: string | null = null;
      if (take(re, (m) => ((got = fn(m)), got !== null))) {
        out.due = got;
        break;
      }
    }
  }

  // ---- times
  if (!out.time) {
    take(/\s(?:at\s+|@\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?=\s|[,.]|$)/i, (m) => {
      let h = Number(m[1]);
      const mm = Number(m[2] || 0);
      if (h < 1 || h > 12 || mm > 59) return false;
      const pm = /^p/i.test(m[3]);
      if (pm && h < 12) h += 12;
      if (!pm && h === 12) h = 0;
      out.time = clock(h, mm);
    }) ||
      take(/\s(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/i, (m) => {
        out.time = clock(Number(m[1]), Number(m[2]));
      }) ||
      take(/\s(?:at\s+)(noon|midday|midnight)\b|\s(noon|midday)\b/i, (m) => {
        out.time = /night/i.test(m[1] ?? m[2]) ? "00:00" : "12:00";
      }) ||
      take(/\sat\s+(\d{1,2})(?=\s|$)/i, (m) => {
        let h = Number(m[1]);
        if (h > 23) return false;
        if (h >= 1 && h <= 7) h += 12; // "at 5" means 5 pm
        out.time = clock(h, 0);
      });
  }

  // ---- priority, list, tags
  take(/\s!([1-3])(?=\s)/, (m) => {
    out.priority = Number(m[1]);
  }) ||
    take(/\s(!{1,3})(?=\s)/, (m) => {
      out.priority = m[1].length;
    }) ||
    take(/\sp([1-3])(?=\s)/i, (m) => {
      out.priority = 4 - Number(m[1]); // Todoist: p1 is the most urgent
    });
  const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  for (let guard = 0; guard < 10; guard++) {
    const hit = take(/\s#([\p{L}\p{N}_-]+)/u, (m) => {
      const lst = lists.find((l) => norm(l.name) === norm(m[1]) || l.id === m[1].toLowerCase());
      if (lst && !out.listId) out.listId = lst.id;
      else if (!out.tags.includes(m[1])) out.tags.push(m[1]);
    });
    if (!hit) break;
  }
  for (let guard = 0; guard < 10; guard++) {
    if (!take(/\s@([\p{L}\p{N}_-]+)/u, (m) => void (out.tags.includes(m[1]) || out.tags.push(m[1])))) break;
  }

  if (out.repeat && !out.due) out.due = firstDue(out.repeat, today);
  if (out.time && !out.due) out.due = today;
  out.title = s
    .replace(/\s+/g, " ")
    .replace(/\s+(?:on|at|by|due|for|every)\s*$/i, "")
    .replace(/^\s*(?:remind\s+me\s+to|remember\s+to)\s+/i, "")
    .trim()
    .replace(/[,;]\s*$/, "");
  return out;
}
