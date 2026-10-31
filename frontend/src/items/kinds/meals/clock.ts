import { useEffect, useState } from "react";

import { useAuthStore } from "@/store/authStore";

/*
 * "Today" and "now" for the food diary, in the person's saved time zone
 * (Account → the zone the server also uses for reminders and the AI's
 * "today"), falling back to the device's zone. Calendar days are
 * ``YYYY-MM-DD`` strings in that zone.
 */

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function partsFmt(tz: string): Intl.DateTimeFormat | null {
  let f = fmtCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    } catch {
      return null;
    }
    fmtCache.set(tz, f);
  }
  return f;
}

/** The person's saved IANA zone, or undefined (= the device's own). */
export function userZone(): string | undefined {
  const z = (useAuthStore.getState().user?.settings as { timezone?: string } | undefined)?.timezone;
  return z && partsFmt(z) ? z : undefined;
}

export interface ZonedNow {
  day: string; // YYYY-MM-DD
  hour: number;
  minute: number;
  hm: string; // HH:MM
}

export function zonedNow(d: Date = new Date()): ZonedNow {
  const tz = userZone();
  const f = tz ? partsFmt(tz) : null;
  let y: number, mo: number, da: number, h: number, mi: number;
  if (f) {
    const get = (t: string) => Number(f.formatToParts(d).find((p) => p.type === t)?.value ?? 0);
    y = get("year");
    mo = get("month");
    da = get("day");
    h = get("hour") % 24;
    mi = get("minute");
  } else {
    y = d.getFullYear();
    mo = d.getMonth() + 1;
    da = d.getDate();
    h = d.getHours();
    mi = d.getMinutes();
  }
  const p2 = (n: number) => String(n).padStart(2, "0");
  return { day: `${y}-${p2(mo)}-${p2(da)}`, hour: h, minute: mi, hm: `${p2(h)}:${p2(mi)}` };
}

export const today = () => zonedNow().day;
export const nowHM = () => zonedNow().hm;

/** Today's date, kept current: re-checked every 30 s and whenever the app
 *  comes back to the foreground (a phone left open overnight). */
export function useToday(): string {
  const [day, setDay] = useState(today);
  useEffect(() => {
    const check = () => setDay((cur) => (cur === today() ? cur : today()));
    const timer = window.setInterval(check, 30_000);
    const onVis = () => document.visibilityState === "visible" && check();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  return day;
}
