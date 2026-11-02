import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { create } from "zustand";

import { calendarApi, type CalUser, type Calendar, type CalendarBootstrap, type CalendarPrefs } from "@/api/calendar";

import { ymd } from "./dates";
import { extrasToView, toView, type ViewEvent } from "./model";

export const BOOTSTRAP_KEY = ["calendar", "bootstrap"] as const;
export const INVITES_KEY = ["calendar", "invites"] as const;
export const EXTRAS_KEY = ["calendar", "extras"] as const;

/** Everyone any response told us about (id → user), merged. */
interface UsersState {
  users: Record<string, CalUser>;
  add: (more: Record<string, CalUser> | undefined) => void;
}
export const useCalUsers = create<UsersState>((set, get) => ({
  users: {},
  add: (more) => {
    if (!more) return;
    const cur = get().users;
    if (Object.keys(more).every((k) => cur[k] === more[k])) return;
    set({ users: { ...cur, ...more } });
  },
}));

export function addUsers(more: Record<string, CalUser> | undefined) {
  useCalUsers.getState().add(more);
}

export function useBootstrap() {
  const q = useQuery({ queryKey: BOOTSTRAP_KEY, queryFn: calendarApi.bootstrap, staleTime: 30_000 });
  useEffect(() => {
    addUsers(q.data?.users);
  }, [q.data]);
  return q;
}

export function useCalendarsMap(cals: Calendar[] | undefined) {
  return useMemo(() => new Map((cals ?? []).map((c) => [c.id, c])), [cals]);
}

/** Occurrences in [from, to) as drawable events, hidden calendars left out. */
export function useEvents(from: Date, to: Date, cals: Calendar[] | undefined, enabled = true) {
  // Local midnights as instants: a bare date would be read as UTC midnight,
  // losing events early in the day for anyone east of UTC.
  const start = from.toISOString();
  const end = to.toISOString();
  const q = useQuery({
    queryKey: ["calendar", "events", start, end],
    queryFn: () => calendarApi.events(start, end),
    enabled: enabled && !!cals,
    staleTime: 15_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  });
  useEffect(() => {
    addUsers(q.data?.users);
  }, [q.data]);
  const qc = useQueryClient();
  const meId = qc.getQueryData<CalendarBootstrap>(BOOTSTRAP_KEY)?.me.id;
  const map = useCalendarsMap(cals);
  const events: ViewEvent[] = useMemo(() => {
    if (!q.data) return [];
    return q.data.events
      .filter((e) => {
        const c = map.get(e.calendar_id);
        return !(e.on_my_calendar && c?.hidden);
      })
      .map((e) => toView(e, map, meId));
  }, [q.data, map, meId]);
  return { ...q, events };
}

export function useInvites() {
  const q = useQuery({ queryKey: INVITES_KEY, queryFn: calendarApi.invites, staleTime: 30_000, refetchInterval: 60_000 });
  useEffect(() => {
    addUsers(q.data?.users);
  }, [q.data]);
  return q;
}

/** Which "Also show" switches are on (holidays only once a country is picked). */
function shownExtras(prefs: CalendarPrefs | undefined) {
  return {
    tasks: !!prefs?.tasks,
    birthdays: !!prefs?.birthdays,
    workouts: !!prefs?.workouts,
    meals: !!prefs?.meals,
    bills: !!prefs?.bills,
    trips: !!prefs?.trips,
    holidays: !!prefs?.holidays && !!prefs?.holiday_country,
  };
}

/** Tasks due, birthdays, workouts, meals, bills, trips and holidays in
 *  [from, to) (local days), as my "Also show" switches allow. */
export function useExtras(from: Date, to: Date, prefs: CalendarPrefs | undefined, enabled = true) {
  const start = ymd(from);
  const end = ymd(to);
  const shown = shownExtras(prefs);
  const key = Object.values(shown).map(Number).join("");
  const on = enabled && !!prefs && key.includes("1");
  const q = useQuery({
    queryKey: [...EXTRAS_KEY, start, end],
    queryFn: () => calendarApi.extras(start, end),
    enabled: on,
    staleTime: 30_000,
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  });
  const items: ViewEvent[] = useMemo(() => {
    if (!on || !q.data) return [];
    // Switched off a moment ago: hidden at once, before the refetch.
    const d = q.data;
    const pick = <T,>(flag: boolean, list: T[] | undefined) => (flag ? (list ?? []) : []);
    const s = shownExtras(prefs);
    return extrasToView({
      tasks: pick(s.tasks, d.tasks),
      birthdays: pick(s.birthdays, d.birthdays),
      workouts: pick(s.workouts, d.workouts),
      meals: pick(s.meals, d.meals),
      bills: pick(s.bills, d.bills),
      trips: pick(s.trips, d.trips),
      holidays: pick(s.holidays, d.holidays),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, q.data, key]);
  return items;
}

/** Refresh everything event-shaped after a change. */
export function useRefreshEvents() {
  const go = useRefreshEventsAsync();
  return useCallback(() => {
    void go();
  }, [go]);
}

/** The same, resolving once refetched (to drop an optimistic override then). */
export function useRefreshEventsAsync() {
  const qc = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["calendar", "events"] }),
      qc.invalidateQueries({ queryKey: INVITES_KEY }),
      qc.invalidateQueries({ queryKey: ["calendar", "event"] }),
      qc.invalidateQueries({ queryKey: EXTRAS_KEY }),
    ]);
  }, [qc]);
}

export function useRefreshCalendars() {
  const qc = useQueryClient();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
    void qc.invalidateQueries({ queryKey: ["calendar", "events"] });
  }, [qc]);
}

/** Change what "Also show" shows, or the second time zone (applies at once). */
export function useSetPrefs() {
  const qc = useQueryClient();
  return useCallback(
    async (patch: Partial<CalendarPrefs>) => {
      const put = (prefs: Partial<CalendarPrefs>) =>
        qc.setQueryData<CalendarBootstrap>(BOOTSTRAP_KEY, (old) => (old ? { ...old, prefs: { ...old.prefs, ...prefs } } : old));
      const before = qc.getQueryData<CalendarBootstrap>(BOOTSTRAP_KEY)?.prefs;
      put(patch);
      try {
        put(await calendarApi.setPrefs(patch));
        void qc.invalidateQueries({ queryKey: EXTRAS_KEY });
      } catch (err) {
        if (before) put(before);
        throw err;
      }
    },
    [qc],
  );
}
