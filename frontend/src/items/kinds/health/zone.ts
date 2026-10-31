import { useAuthStore } from "@/store/authStore";

/*
 * "Now", "today" and local moments in the person's saved time zone
 * (Account → personal context), so the app and the server (which uses the
 * same zone for reminders, adherence and "today") agree even when this
 * browser is set to another zone. Falls back to the browser's zone.
 */

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat | null {
  let f = fmtCache.get(zone);
  if (f) return f;
  try {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return null;
  }
  fmtCache.set(zone, f);
  return f;
}

/** The person's IANA zone ("Australia/Sydney"), or "" for the browser's. */
export function userZone(): string {
  try {
    const z = (useAuthStore.getState().user?.settings as { timezone?: string } | undefined)?.timezone;
    if (typeof z === "string" && z.trim() && formatter(z.trim())) return z.trim();
  } catch {
    // no store (tests) — use the browser's zone
  }
  return "";
}

/** Minutes east of UTC in the person's zone at ``ms``. */
export function offsetAt(ms: number, zone = userZone()): number {
  if (!zone) return -new Date(ms).getTimezoneOffset();
  const f = formatter(zone);
  if (!f) return -new Date(ms).getTimezoneOffset();
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = Number(part.value);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60_000);
}

const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");

function offsetText(off: number): string {
  return `${off >= 0 ? "+" : "-"}${pad(Math.abs(off) / 60)}:${pad(Math.abs(off) % 60)}`;
}

/** ``ms`` as an ISO moment in the person's zone ("2026-10-31T09:00:00+11:00"). */
export function isoAt(ms: number, zone = userZone()): string {
  const off = offsetAt(ms, zone);
  const local = new Date(Math.floor(ms / 1000) * 1000 + off * 60_000).toISOString().slice(0, 19);
  return `${local}${offsetText(off)}`;
}

/** Now, in the person's zone. */
export function nowISO(): string {
  return isoAt(Date.now());
}

/** The person's calendar day of ``d`` (default now) — ``YYYY-MM-DD``. */
export function todayISO(d: Date = new Date()): string {
  return isoAt(d.getTime()).slice(0, 10);
}

/** ISO moment for a wall-clock day + HH:MM in the person's zone. */
export function momentAt(day: string, hhmm: string, zone = userZone()): string {
  const [y, mo, d] = day.split("-").map(Number);
  const [h, m] = hhmm.split(":").map(Number);
  const wall = Date.UTC(y, (mo || 1) - 1, d || 1, h || 0, m || 0);
  let off = offsetAt(wall, zone);
  const second = offsetAt(wall - off * 60_000, zone);
  if (second !== off) off = second;
  return `${day}T${pad(h || 0)}:${pad(m || 0)}:00${offsetText(off)}`;
}

/** ``HH:MM`` now in the person's zone. */
export function nowHHMM(): string {
  return nowISO().slice(11, 16);
}
