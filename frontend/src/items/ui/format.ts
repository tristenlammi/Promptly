/*
 * Dates, numbers and ids for items. Items store calendar days as
 * ``YYYY-MM-DD`` strings (the person's local day — never shifted by time
 * zones) and moments as ISO strings with an offset.
 */

/** A short random id (unique enough inside one file). */
export function uid(prefix = ""): string {
  const a = crypto.getRandomValues(new Uint32Array(2));
  return prefix + a[0].toString(36) + a[1].toString(36).slice(0, 4);
}

/** Today (local) as ``YYYY-MM-DD``. */
// The person's saved time zone (Account → Personal context), set by the item
// shell — "today" follows it, so a phone on another zone's clock (travelling)
// agrees with reminders and the server. Falls back to the device's zone.
let userZone: string | null = null;

export function setItemTimeZone(zone: string | null | undefined): void {
  try {
    userZone = zone ? (new Intl.DateTimeFormat("en-CA", { timeZone: zone }), zone) : null;
  } catch {
    userZone = null;
  }
}

/** The zone "today" is computed in (the person's saved one, else the device's). */
export function itemTimeZone(): string {
  return userZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Today as ``YYYY-MM-DD`` in the person's time zone; with ``d``, that
 *  Date's local calendar day. */
export function todayISO(d?: Date): string {
  if (!d) {
    if (userZone) {
      // en-CA formats as YYYY-MM-DD.
      return new Intl.DateTimeFormat("en-CA", { timeZone: userZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    }
    d = new Date();
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** ``YYYY-MM-DD`` → a local Date at midnight. */
export function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(day: string, n: number): string {
  const d = parseDay(day);
  d.setDate(d.getDate() + n);
  return todayISO(d);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 86_400_000);
}

/** Monday of the week ``day`` is in. */
export function weekStart(day: string, weekStartsOn: 0 | 1 = 1): string {
  const d = parseDay(day);
  const diff = (d.getDay() - weekStartsOn + 7) % 7;
  d.setDate(d.getDate() - diff);
  return todayISO(d);
}

export function nowISO(): string {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19);
  return `${local}${sign}${hh}:${mm}`;
}

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const longFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** "Today" / "Yesterday" / "Tomorrow" / "Mon 3 Nov". */
export function fmtDay(day: string, { long = false }: { long?: boolean } = {}): string {
  const delta = daysBetween(todayISO(), day);
  if (delta === 0) return "Today";
  if (delta === -1) return "Yesterday";
  if (delta === 1) return "Tomorrow";
  return (long ? longFmt : dayFmt).format(parseDay(day));
}

export function fmtTime(iso: string): string {
  return timeFmt.format(new Date(iso));
}

/** "3 min ago", "2 h ago", "5 d ago". */
export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  return n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function fmtMoney(n: number, currency = "AUD"): string {
  try {
    return n.toLocaleString(undefined, { style: "currency", currency, maximumFractionDigits: 2 });
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

/** "1:05:09" / "4:09". */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

/** A link that's safe to put in ``href``: http(s), mailto, tel — anything
 *  else (``javascript:``, ``data:``) becomes undefined. A bare
 *  "example.com/x" becomes https. */
export function safeHref(url: string | null | undefined): string | undefined {
  const s = (url ?? "").trim();
  if (!s) return undefined;
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return undefined;
  return `https://${s.replace(/^\/+/, "")}`;
}

/** The person's currency / units preference, from their Promptly settings. */
export function userCurrency(settings: Record<string, unknown> | null | undefined): string {
  const c = settings?.currency;
  return typeof c === "string" && c.trim() ? c.trim().toUpperCase() : "AUD";
}
