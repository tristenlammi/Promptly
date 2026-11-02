/** Small date helpers — everything in the browser's local zone. */

export const DAY_MS = 86_400_000;

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  // Calendar days (not 24h steps), so clock changes don't drift the time.
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}

export function addMonths(d: Date, n: number): Date {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), last));
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Whole calendar days from a to b (both taken at midnight). */
export function dayDiff(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday — the locale's first day of the week. */
export const WEEK_START: number = (() => {
  try {
    const loc = new Intl.Locale(navigator.language) as Intl.Locale & {
      weekInfo?: { firstDay: number };
      getWeekInfo?: () => { firstDay: number };
    };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info?.firstDay) return info.firstDay % 7;
  } catch {
    /* older browsers */
  }
  return 0;
})();

export function startOfWeek(d: Date): Date {
  const s = startOfDay(d);
  return addDays(s, -((s.getDay() - WEEK_START + 7) % 7));
}

/** The six-ish weeks a month grid shows. */
export function monthGrid(d: Date): { start: Date; weeks: number } {
  const first = startOfMonth(d);
  const start = startOfWeek(first);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const weeks = Math.ceil((dayDiff(start, last) + 1) / 7);
  return { start, weeks };
}

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseYmd(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** "HH:MM" for a time input. */
export function hm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** A date input + a time input → a local Date. */
export function combine(dateStr: string, timeStr: string): Date {
  const d = parseYmd(dateStr);
  const [h, m] = (timeStr || "00:00").split(":").map(Number);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function weekdayIndexMon(d: Date): number {
  // The API's weekdays: 0 = Monday … 6 = Sunday.
  return (d.getDay() + 6) % 7;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
export function fmt(d: Date, opts: Intl.DateTimeFormatOptions): string {
  const key = JSON.stringify(opts);
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, opts);
    fmtCache.set(key, f);
  }
  return f.format(d);
}

export function timeLabel(d: Date): string {
  return fmt(d, { hour: "numeric", minute: "2-digit" });
}

/** Short time for chips: "9am", "9:30am" (locale-ish). */
export function shortTime(d: Date): string {
  const s = fmt(d, d.getMinutes() ? { hour: "numeric", minute: "2-digit" } : { hour: "numeric" });
  return s.replace(/\s?([AP])M$/i, (_m, p: string) => p.toLowerCase() + "m");
}

export function hourLabel(h: number): string {
  return shortTime(new Date(2000, 0, 1, h));
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Weekday names in the locale, Monday first (API order). */
export const WEEKDAYS_MON: { short: string; long: string; narrow: string }[] = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(2024, 0, 1 + i); // 2024-01-01 was a Monday
  return { short: fmt(d, { weekday: "short" }), long: fmt(d, { weekday: "long" }), narrow: fmt(d, { weekday: "narrow" }) };
});

/** Column headers starting from WEEK_START. */
export function weekdayHeaders(): { short: string; narrow: string }[] {
  return Array.from({ length: 7 }, (_, i) => {
    const sun0 = (WEEK_START + i) % 7;
    const w = WEEKDAYS_MON[(sun0 + 6) % 7];
    return { short: w.short, narrow: w.narrow };
  });
}

/** "3:00 – 4:30pm" (the first half drops a shared am/pm). */
export function timeRange(a: Date, b: Date): string {
  const lower = (s: string) => s.replace(/\s?([AP])M$/i, (_m, p: string) => p.toLowerCase() + "m");
  const fa = lower(timeLabel(a));
  const fb = lower(timeLabel(b));
  const sa = /[ap]m$/.exec(fa)?.[0];
  const sb = /[ap]m$/.exec(fb)?.[0];
  return `${sa && sa === sb ? fa.slice(0, -2) : fa} – ${fb}`;
}

/** "Fri 7 Nov" (the locale's order), with the year when it isn't this year's. */
export function shortDay(d: Date): string {
  return fmt(d, { weekday: "short", month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}

// ------------------------------------------------------------------ time zones

/** "Asia/Tokyo" → "Tokyo"; "America/Argentina/Buenos_Aires" → "Buenos Aires". */
export function zoneCity(tz: string): string {
  if (!tz || tz === "UTC" || tz === "Etc/UTC") return "UTC";
  return (tz.split("/").pop() || tz).replace(/_/g, " ");
}

const zoneFmt = new Map<string, Intl.DateTimeFormat>();

/** Minutes ``tz`` is ahead of UTC at ``at`` (0 for an unknown zone). */
export function zoneOffset(tz: string, at: Date): number {
  try {
    let f = zoneFmt.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
      zoneFmt.set(tz, f);
    }
    const p: Record<string, number> = {};
    for (const x of f.formatToParts(at)) if (x.type !== "literal") p[x.type] = Number(x.value);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute);
    return Math.round((asUtc - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
  } catch {
    return 0;
  }
}

/** Is ``tz`` on a different clock from this browser at ``at``? */
export function differsFromLocal(tz: string | null | undefined, at: Date = new Date()): boolean {
  if (!tz) return false;
  return zoneOffset(tz, at) !== -at.getTimezoneOffset();
}

/** A time as the clock reads in ``tz``: "9:00 AM" (with the weekday when ``withDay``). */
export function timeInZone(d: Date, tz: string, withDay = false): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit", ...(withDay ? { weekday: "short" } : {}) }).format(d);
  } catch {
    return timeLabel(d);
  }
}

/** An event in its own time zone, when that isn't the viewer's:
 *  "9:00 AM Tokyo time · 1:00 AM your time" (weekdays added when the days
 *  differ). ``null`` when the clocks agree, for all-day events, or no zone.
 *  For event chips' tooltips, the agenda and the event's details. */
export function zoneNote(start: Date, tz: string | null | undefined, allDay = false): string | null {
  if (allDay || !tz || !differsFromLocal(tz, start)) return null;
  const local = new Date(start.getTime() + (zoneOffset(tz, start) + start.getTimezoneOffset()) * 60_000);
  const otherDay = !sameDay(local, start);
  return `${timeInZone(start, tz, otherDay)} ${zoneCity(tz)} time · ${otherDay ? fmt(start, { weekday: "short", hour: "numeric", minute: "2-digit" }) : timeLabel(start)} your time`;
}

/** Short zone name for a column header: "GMT+9", "PST" (the locale's choice). */
export function zoneShort(tz: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: tz, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? zoneCity(tz);
  } catch {
    return zoneCity(tz);
  }
}

/** Every IANA zone the browser knows (for a picker), or a short fallback list. */
export function allZones(): string[] {
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (f) return f("timeZone");
  } catch {
    /* older browsers */
  }
  return ["UTC", "Europe/London", "Europe/Paris", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Asia/Tokyo", "Asia/Singapore", "Asia/Kolkata", "Australia/Sydney", "Australia/Perth", "Pacific/Auckland"];
}
