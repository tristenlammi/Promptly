/*
 * Time zones for trips. A booking end is a wall-clock local time
 * (``YYYY-MM-DDTHH:MM``) plus an IANA zone; its instant comes from the
 * browser's zone database (Intl). Resolution matches the backend (Python's
 * ``fold=0``): a time inside a spring-forward gap is read with the offset in
 * force before the change, an ambiguous fall-back time is the first one.
 */

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function partsFmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function validZone(tz: string | null | undefined): boolean {
  if (!tz) return false;
  try {
    partsFmt(tz);
    return true;
  } catch {
    return false;
  }
}

/** The browser's own zone. */
export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/* A time with no zone of its own is read in the person's saved Promptly zone
 * (what the server uses), else this device's. Set by the module's host. */
let savedZone = "";
export function setFallbackZone(tz: string | null | undefined) {
  savedZone = tz && validZone(tz) ? tz : "";
}
export function fallbackZone(): string {
  return savedZone || localZone();
}

/** Wall time (``YYYY-MM-DDTHH:MM``) of instant ``ms`` in ``tz``. */
export function wallAt(ms: number, tz: string): string {
  const p: Record<string, string> = {};
  for (const x of partsFmt(validZone(tz) ? tz : "UTC").formatToParts(new Date(ms))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
}

function naiveMs(local: string): number {
  const [d, t = "00:00"] = local.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  return Date.UTC(y, (m || 1) - 1, day || 1, h || 0, mi || 0);
}

/** Offset (minutes east of UTC) of ``tz`` at instant ``ms``. */
export function offsetAt(ms: number, tz: string): number {
  return Math.round((naiveMs(wallAt(ms, tz)) - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

/** The instant (epoch ms) a local wall time in ``tz`` refers to, or null. */
export function toInstant(local: string | null | undefined, tz: string | null | undefined): number | null {
  if (!local || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(local)) return null;
  const zone = validZone(tz) ? (tz as string) : fallbackZone();
  const naive = naiveMs(local);
  const want = local.slice(0, 16);
  const before = offsetAt(naive - 36 * 3_600_000, zone);
  const offsets = [...new Set([before, offsetAt(naive, zone), offsetAt(naive + 36 * 3_600_000, zone)])];
  const valid = offsets.map((o) => naive - o * 60_000).filter((t) => wallAt(t, zone) === want);
  if (valid.length) return Math.min(...valid);
  return naive - before * 60_000; // a gap: the offset before the change
}

/** Minutes between two local times in their own zones. */
export function minutesBetween(a: string | null, aTz: string | null, b: string | null, bTz: string | null): number | null {
  const x = toInstant(a, aTz);
  const y = toInstant(b, bTz);
  if (x === null || y === null) return null;
  return Math.round((y - x) / 60_000);
}

export function fmtMinutes(mins: number | null | undefined): string {
  if (mins === null || mins === undefined || !Number.isFinite(mins)) return "";
  const neg = mins < 0;
  const m = Math.abs(mins);
  const h = Math.floor(m / 60);
  const r = m % 60;
  const s = h && r ? `${h}h ${String(r).padStart(2, "0")}m` : h ? `${h}h` : `${r}m`;
  return neg ? `-${s}` : s;
}

// Zones without DST whose common abbreviation no English locale prints.
const FIXED_ABBR: Record<string, string> = {
  "Asia/Tokyo": "JST", "Asia/Seoul": "KST", "Asia/Shanghai": "CST", "Asia/Taipei": "CST", "Asia/Hong_Kong": "HKT",
  "Asia/Macau": "CST", "Asia/Manila": "PHT", "Asia/Bangkok": "ICT", "Asia/Ho_Chi_Minh": "ICT", "Asia/Jakarta": "WIB",
  "Asia/Makassar": "WITA", "Asia/Kuala_Lumpur": "MYT", "Asia/Singapore": "SGT", "Asia/Dubai": "GST", "Asia/Kathmandu": "NPT",
  "Asia/Kolkata": "IST", "Asia/Colombo": "IST", "Asia/Qatar": "AST", "Indian/Maldives": "MVT", "Pacific/Fiji": "FJT",
};
const ABBR_LOCALES = ["en-US", "en-GB", "en-AU", "en-NZ", "en-CA", "en-IN", "en-SG"];

/** "AEDT", "JST", "CEST" — or "GMT+9" where nothing names the zone. */
export function zoneAbbr(local: string | null | undefined, tz: string | null | undefined): string {
  if (!local || !tz || !validZone(tz)) return "";
  if (FIXED_ABBR[tz]) return FIXED_ABBR[tz];
  const at = toInstant(local, tz);
  if (at === null) return "";
  let fallback = "";
  for (const loc of [undefined, ...ABBR_LOCALES]) {
    try {
      const name = new Intl.DateTimeFormat(loc, { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(at)).find((x) => x.type === "timeZoneName")?.value ?? "";
      if (name && !/^(GMT|UTC)[+-−]/.test(name)) return name;
      fallback ||= name;
    } catch {
      /* unsupported locale */
    }
  }
  return fallback;
}

/** A friendly city from an IANA name: "Asia/Tokyo" → "Tokyo". */
export function zoneCity(tz: string | null | undefined): string {
  if (!tz) return "";
  return (tz.split("/").pop() ?? tz).replace(/_/g, " ");
}

/** Whether a local time exists in that zone (not inside a clock change). */
export function inGap(local: string, tz: string): boolean {
  const t = toInstant(local, tz);
  return t !== null && wallAt(t, tz) !== local.slice(0, 16);
}

/** All IANA zones the browser knows (for pickers). */
export function allZones(): string[] {
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (f) return f("timeZone");
  } catch {
    /* old browser */
  }
  return [];
}

/* ----------------------------------------------------- clock & dates */

let clock: "auto" | "24h" | "12h" = "auto";
export function setClock(c: "auto" | "24h" | "12h") {
  clock = c;
}

/** "18:45" → "18:45" / "6:45 pm" per the trip's clock setting. */
export function fmtHM(hhmm: string | null | undefined): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  if (clock === "24h") return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const d = new Date(2000, 0, 1, h, m);
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    ...(clock === "12h" ? { hour12: true } : {}),
  });
}

export const dayOf = (local: string | null | undefined) => (local ? local.slice(0, 10) : null);
export const timeOf = (local: string | null | undefined) => (local && local.length >= 16 ? local.slice(11, 16) : "");

export function dateRange(start: string | null, end: string | null, cap = 400): string[] {
  if (!start) return [];
  const out: string[] = [];
  const a = new Date(`${start}T00:00:00Z`);
  const b = new Date(`${end ?? start}T00:00:00Z`);
  for (let t = a.getTime(); t <= b.getTime() && out.length < cap; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const shortDay = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const longDay = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" });
const dayNum = new Intl.DateTimeFormat(undefined, { day: "numeric", timeZone: "UTC" });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" });

export const fmtDate = (day: string, long = false) => (long ? longDay : shortDay).format(new Date(`${day}T00:00:00Z`));
export const fmtWeekday = (day: string) => weekdayFmt.format(new Date(`${day}T00:00:00Z`));
export const fmtDayNum = (day: string) => dayNum.format(new Date(`${day}T00:00:00Z`));
export const fmtMonth = (day: string) => monthFmt.format(new Date(`${day}T00:00:00Z`));

export function fmtRange(start: string | null, end: string | null): string {
  if (!start) return "No dates yet";
  if (!end || end === start) return fmtDate(start);
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  return sameMonth ? `${fmtDayNum(start)} – ${fmtDayNum(end)} ${fmtMonth(end)} ${end.slice(0, 4)}` : `${fmtDate(start)} – ${fmtDate(end)} ${end.slice(0, 4)}`;
}

/** "in 3 d 4 h", "in 25 min", "now". */
export function fmtCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `in ${h} h ${mins % 60} min`;
  const d = Math.floor(h / 24);
  return `in ${d} d ${h % 24} h`;
}
