import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type CSSProperties } from "react";

import { calendarApi, type CalUser } from "@/api/calendar";
import { cn } from "@/utils/cn";

import { addDays, startOfDay } from "../dates";

/**
 * Availability — when people *aren't* free, never what they're doing. The
 * server only ever answers with merged busy stretches; everything here
 * talks about "Not available" and nothing more.
 */

/** user id → busy stretches as [start, end) epoch ms, sorted. */
export type BusyMap = Record<string, [number, number][]>;

/** The server caps a busy question at 31 days, and the id list at ~2000 chars. */
const MAX_DAYS = 31;
const MAX_PEOPLE = 50;

/** Muted diagonal stripes for "Not available" blocks. */
export const BUSY_STRIPES: CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(135deg, color-mix(in srgb, var(--text-muted) 26%, transparent) 0 5px, color-mix(in srgb, var(--text-muted) 12%, transparent) 5px 10px)",
};

export const FREE_COLOR = "#3E8E5A";
export const BUSY_COLOR = "#C08B2C";

export function busyKey(ids: string[], from: string, to: string) {
  return ["calendar", "busy", [...ids].sort().join(","), from, to] as const;
}

/** Fetch + parse busy stretches. ``ignore`` carves out a span (the event being
 *  edited — otherwise its own slot would show everyone on it as busy). */
export async function fetchBusy(ids: string[], from: Date, to: Date): Promise<BusyMap> {
  const r = await calendarApi.busy(ids.slice(0, MAX_PEOPLE), from.toISOString(), to.toISOString());
  const out: BusyMap = {};
  for (const [uid, spans] of Object.entries(r.busy ?? {})) {
    out[uid] = spans.map(([s, e]) => [new Date(s).getTime(), new Date(e).getTime()] as [number, number]).sort((a, b) => a[0] - b[0]);
  }
  return out;
}

export function carve(busy: BusyMap, ignore: [Date, Date] | null | undefined): BusyMap {
  if (!ignore) return busy;
  const [is, ie] = [ignore[0].getTime(), ignore[1].getTime()];
  const out: BusyMap = {};
  for (const [uid, spans] of Object.entries(busy)) {
    const next: [number, number][] = [];
    for (const [s, e] of spans) {
      if (e <= is || s >= ie) next.push([s, e]);
      else {
        // Merged stretches: keep whatever sticks out either side.
        if (s < is) next.push([s, is]);
        if (e > ie) next.push([ie, e]);
      }
    }
    out[uid] = next;
  }
  return out;
}

export function overlaps(spans: [number, number][] | undefined, s: number, e: number): boolean {
  return !!spans?.some(([a, b]) => a < e && b > s);
}

/** Busy stretches for ``ids`` over the local days [from, to] (whole days, so
 *  nudging the time reuses the cache). Debounced so typing a date doesn't fire
 *  a request per keystroke. */
export function useBusy(ids: string[], from: Date, to: Date, { enabled = true, ignore }: { enabled?: boolean; ignore?: [Date, Date] | null } = {}) {
  const d0 = startOfDay(from);
  let d1 = addDays(startOfDay(to), 1);
  if (d1 <= d0) d1 = addDays(d0, 1);
  if ((d1.getTime() - d0.getTime()) / 86_400_000 > MAX_DAYS) d1 = addDays(d0, MAX_DAYS);
  const want = `${ids.slice().sort().join(",")}|${d0.toISOString()}|${d1.toISOString()}`;
  const [key, setKey] = useState(want);
  useEffect(() => {
    const t = window.setTimeout(() => setKey(want), 350);
    return () => {
      window.clearTimeout(t);
    };
  }, [want]);
  const [idStr, fromIso, toIso] = key.split("|");
  const keyIds = useMemo(() => (idStr ? idStr.split(",") : []), [idStr]);
  const q = useQuery({
    queryKey: busyKey(keyIds, fromIso, toIso),
    queryFn: () => fetchBusy(keyIds, new Date(fromIso), new Date(toIso)),
    enabled: enabled && keyIds.length > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const ignoreS = ignore?.[0].getTime();
  const ignoreE = ignore?.[1].getTime();
  const busy = useMemo(
    () => (q.data ? carve(q.data, ignoreS != null && ignoreE != null ? [new Date(ignoreS), new Date(ignoreE)] : null) : null),
    [q.data, ignoreS, ignoreE],
  );
  // Still waiting on the debounce, or the request.
  const pending = enabled && ids.length > 0 && (key !== want || q.isLoading);
  /** Does the loaded data cover [s, e) for everyone asked about? (While the
   *  debounce runs, the last answer still counts for times inside it.) */
  const covers = (s: Date, e: Date) => {
    if (!busy || !fromIso || !toIso) return false;
    if (s.getTime() < new Date(fromIso).getTime() || e.getTime() > new Date(toIso).getTime()) return false;
    const asked = new Set(keyIds);
    return ids.every((id) => asked.has(id));
  };
  return { busy, pending, covers, isError: q.isError };
}

/** "Sam isn't available then — you can still invite them" / "Everyone's free then". */
export function availabilityText(busyPeople: CalUser[], total: number, meBusy: boolean): { text: string; ok: boolean } {
  if (busyPeople.length === 0) {
    if (meBusy) return { text: total ? "Everyone else is free — you already have something then" : "You already have something then", ok: false };
    return { text: total === 1 ? "They're free then" : "Everyone's free then", ok: true };
  }
  const names =
    busyPeople.length === 1
      ? busyPeople[0].username
      : busyPeople.length === 2
        ? `${busyPeople[0].username} and ${busyPeople[1].username}`
        : `${busyPeople[0].username} and ${busyPeople.length - 1} others`;
  const verb = busyPeople.length === 1 ? "isn't" : "aren't";
  const them = busyPeople.length === 1 ? "them" : "them anyway";
  return { text: `${names} ${verb} available then — you can still invite ${them}`, ok: false };
}

/** A small free / "Not available" marker for a person. */
export function AvailabilityTag({ busy, compact }: { busy: boolean | null; compact?: boolean }) {
  if (busy == null) return null;
  if (!busy) {
    return (
      <span className="inline-flex shrink-0 items-center" title="Free then">
        <span className="h-2 w-2 rounded-full" style={{ background: FREE_COLOR }} aria-hidden />
        <span className="sr-only">Free then</span>
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium",
        "bg-[color-mix(in_srgb,#C08B2C_18%,transparent)] text-[#9a6c12] dark:text-[#e2b65e]",
      )}
      title="Not available then"
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: BUSY_COLOR }} aria-hidden />
      {compact ? "Busy" : "Not available"}
    </span>
  );
}
