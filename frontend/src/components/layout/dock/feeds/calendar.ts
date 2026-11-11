import { CalendarClock } from "lucide-react";
import { useNavigate } from "react-router-dom";

import type { DockCardData, DockFeed } from "../types";
import { go, useDockToday } from "../useDockToday";
import { clock, useNow } from "../useNow";

const SOON_MS = 2 * 60 * 60_000;
/** An event that has just started still counts as "now" for this long. */
const STARTED_MS = 10 * 60_000;

/** Calendar "Up next": the next event starting within about two hours. */
function useCards(): DockCardData[] {
  const today = useDockToday();
  const now = useNow();
  const navigate = useNavigate();
  const events = today?.sections.events;
  if (!events) return [];

  const next = events.events
    .filter((e) => !e.all_day)
    .map((e) => ({ e, start: Date.parse(e.start), end: Date.parse(e.end) }))
    .filter((x) => Number.isFinite(x.start) && x.start - now <= SOON_MS && x.start > now - STARTED_MS && !(x.end <= now))
    .sort((a, b) => a.start - b.start)[0];
  if (!next) return [];

  const mins = Math.round((next.start - now) / 60_000);
  const when = mins <= 0 ? "Starting now" : mins < 60 ? `In ${mins} min` : `At ${clock(next.start)}`;
  return [
    {
      id: `calendar:${next.e.id}`,
      priority: 50,
      icon: CalendarClock,
      tone: mins <= 10 ? "accent" : "plain",
      title: next.e.title || "Event",
      detail: next.e.location ? `${when} · ${next.e.location}` : when,
      onOpen: () => go(navigate, next.e.url || events.url, "/calendar"),
    },
  ];
}

export const calendarFeed: DockFeed = { id: "calendar", useCards };
