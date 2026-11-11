import { ChevronDown, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type TouchEvent as ReactTouchEvent } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";

import { calendarApi, type CalEvent, type Calendar, type CalUser } from "@/api/calendar";
import { peopleHubApi } from "@/api/peopleHub";
import { extractError } from "@/components/files/helpers";
import { NetworkStatusToast } from "@/components/layout/NetworkStatusToast";
import { Skeleton } from "@/components/shared/Skeleton";
import { InstallFromLink } from "@/components/pwa/InstallFromLink";
import { useIsMobile } from "@/hooks/useIsMobile";
import { ItemButton, Sheet } from "@/items/ui";
import "@/items/ui/items.css";
import { toast } from "@/store/toastStore";
import { useUIStore } from "@/store/uiStore";
import { cn } from "@/utils/cn";

import { AgendaView } from "./components/AgendaView";
import { CalendarSettingsSheet, NewCalendarSheet } from "./components/CalendarDialog";
import type { OpenEvent } from "./components/EventChip";
import { EventDetail } from "./components/EventDetail";
import { EventEditor, type EditorTarget } from "./components/EventEditor";
import { ExtraDetail, usePlanTask } from "./components/ExtraDetail";
import { BirthdayDetail } from "./components/ExtrasChips";
import { Header } from "./components/Header";
import { MiniMonth } from "./components/MiniMonth";
import { MonthView } from "./components/MonthView";
import { QuickAddBar, QuickAddSheet } from "./components/QuickAdd";
import { QuickCreate, type NewSlot } from "./components/QuickCreate";
import { SearchPanel } from "./components/SearchPanel";
import { SidePanel } from "./components/SidePanel";
import { SubscribeSheet } from "./components/SubscribeDialog";
import { TimeGridView } from "./components/TimeGridView";
import { TravelNotice } from "./components/TravelNotice";
import { Popover, ScopeHost } from "./components/ui";
import { addUsers, useBootstrap, useCalendarsMap, useEvents, useExtras, useLabelsMap, useRefreshEventsAsync } from "./data";
import { applyMoves, commitMove, dragging, useMoved, useTouchDragGuard } from "./drag";
import { addDays, addMonths, fmt, monthGrid, sameDay, startOfDay, startOfMonth, startOfWeek, ymd } from "./dates";
import { onDay, toView, type View, type ViewEvent } from "./model";
import type { QuickEvent } from "./quickadd";

const VIEW_KEY = "calendar:view";
const AGENDA_DAYS = 28;
/** A phone's "week" is three days from the one you're on: seven columns don't fit. */
const PHONE_DAYS = 3;

const KEYS: [string, string][] = [
  ["t", "Go to today"],
  ["n  or  →", "Next"],
  ["p  or  ←", "Previous"],
  ["d  w  m  a", "Day, week, month, schedule"],
  ["c", "New event"],
  ["q", "Quick add"],
  ["/", "Search"],
  ["e", "Edit the open event"],
  ["Delete", "Delete the open event"],
  ["Esc", "Close"],
  ["?", "Show this list"],
];

function readView(phone: boolean): View {
  try {
    const v = localStorage.getItem(`${VIEW_KEY}:${phone ? "phone" : "desktop"}`);
    if (v === "month" || v === "week" || v === "day" || v === "agenda") return v;
  } catch {
    /* storage blocked */
  }
  return phone ? "agenda" : "month";
}

/** A new event's default start on a day: the next hour today, else 9am. */
function defaultStart(day: Date): Date {
  const now = new Date();
  if (sameDay(day, now)) {
    const s = new Date(now);
    s.setHours(now.getHours() + 1, 0, 0, 0);
    return s;
  }
  const s = startOfDay(day);
  s.setHours(9);
  return s;
}

/**
 * ``/calendar`` — Promptly Calendar. Inside Promptly's layout in a browser
 * (``embedded``); on its own when launched as the installed Calendar app.
 */
export function CalendarApp({ embedded = false }: { embedded?: boolean } = {}) {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const isPhone = useIsMobile(767);
  // Below this the calendars panel becomes a sheet (Promptly's own sidebar is beside us).
  const narrow = useIsMobile(1023);
  // Inside Promptly at phone width its sidebar is a drawer (AppLayout's).
  const drawerNav = useIsMobile();
  const openPromptlyNav = useUIStore((s) => s.openMobileNav);
  const { data: b, isLoading, isError, refetch } = useBootstrap();
  const calMap = useCalendarsMap(b?.calendars);
  const labelMap = useLabelsMap(b?.labels);

  const [view, setViewState] = useState<View>(() => readView(isPhone));
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [agendaDays, setAgendaDays] = useState(AGENDA_DAYS);
  const [detail, setDetail] = useState<{ v: ViewEvent; anchor: DOMRect | null } | null>(null);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [newCal, setNewCal] = useState(false);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [subscribe, setSubscribe] = useState(false);
  const [side, setSide] = useState(false);
  const [miniOpen, setMiniOpen] = useState(false);
  const [miniMonth, setMiniMonth] = useState(() => startOfMonth(new Date()));
  const [search, setSearch] = useState(false);
  const [quick, setQuick] = useState(false);
  // The slot just clicked or drawn on the grid, with its quick-add bubble open.
  const [slot, setSlot] = useState<NewSlot | null>(null);
  const [keysHelp, setKeysHelp] = useState(false);
  const weekDays = isPhone ? PHONE_DAYS : 7;
  const quickBox = useRef<HTMLInputElement>(null);
  const dragGuard = useTouchDragGuard();
  const meId = b?.me.id;

  const setView = useCallback(
    (v: View) => {
      setViewState(v);
      if (v === "agenda") setAgendaDays(AGENDA_DAYS);
      try {
        localStorage.setItem(`${VIEW_KEY}:${isPhone ? "phone" : "desktop"}`, v);
      } catch {
        /* storage blocked */
      }
    },
    [isPhone],
  );

  // Accent for the whole page (sheets render in a portal) + item touch sizing.
  useEffect(() => {
    const root = document.documentElement;
    // Buttons, selection and today markers use Promptly's terracotta; the
    // blue stays on the app mark and on each calendar's own colour.
    root.style.setProperty("--item-accent", "var(--accent)");
    root.dataset.itemApp = "";
    const before = document.title;
    document.title = "Calendar";
    return () => {
      root.style.removeProperty("--item-accent");
      delete root.dataset.itemApp;
      document.title = before;
    };
  }, []);

  // The visible range.
  const range = useMemo(() => {
    switch (view) {
      case "month": {
        const { start, weeks } = monthGrid(cursor);
        return { from: start, to: addDays(start, weeks * 7) };
      }
      case "week": {
        const s = isPhone ? cursor : startOfWeek(cursor);
        return { from: s, to: addDays(s, weekDays) };
      }
      case "day":
        return { from: cursor, to: addDays(cursor, 1) };
      case "agenda":
        return { from: cursor, to: addDays(cursor, agendaDays) };
    }
  }, [view, cursor, agendaDays, isPhone, weekDays]);
  const { events: fetched, isLoading: eventsLoading } = useEvents(range.from, range.to, b?.calendars, true, b?.labels);
  // Tasks and birthdays among the events; moved events at their new times while they save.
  const extras = useExtras(range.from, range.to, b?.prefs, !!b);
  const moved = useMoved((st) => st.moved);
  // Nothing to show yet for this stretch: placeholder blocks.
  const firstLoad = eventsLoading;
  const events = useMemo(() => [...applyMoves(fetched, moved), ...extras], [fetched, moved, extras]);
  const refreshAsync = useRefreshEventsAsync();
  const moveEvent = useCallback((v: ViewEvent, start: Date, end: Date) => void commitMove(v, start, end, refreshAsync), [refreshAsync]);
  // A task dragged onto a time: an event for it on my calendar.
  const planTask = usePlanTask();

  // Dots on the phone's mini month.
  const miniGrid = monthGrid(miniMonth);
  const showMini = isPhone && view === "agenda" && miniOpen;
  const { events: miniEvents } = useEvents(miniGrid.start, addDays(miniGrid.start, miniGrid.weeks * 7), b?.calendars, showMini, b?.labels);
  const dots = useMemo(() => {
    const s = new Set<string>();
    for (let i = 0; i < miniGrid.weeks * 7; i++) {
      const d = addDays(miniGrid.start, i);
      if (miniEvents.some((v) => onDay(v, d))) s.add(ymd(d));
    }
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [miniEvents, miniGrid.start.getTime(), miniGrid.weeks]);

  const step = (dir: 1 | -1) => {
    setCursor((c) => {
      switch (view) {
        case "month":
          return startOfMonth(addMonths(c, dir));
        case "week":
          return addDays(c, weekDays * dir);
        case "day":
          return addDays(c, dir);
        case "agenda":
          return addDays(c, AGENDA_DAYS * dir);
      }
    });
    if (view === "agenda") setAgendaDays(AGENDA_DAYS);
  };
  const today = () => {
    setCursor(startOfDay(new Date()));
    setAgendaDays(AGENDA_DAYS);
  };
  const goDay = (d: Date) => {
    setCursor(startOfDay(d));
    setView("day");
  };

  const openEvent: OpenEvent = useCallback(
    (v, anchor) => {
      // Tasks, birthdays and the other apps' items open a small card here
      // (with a way into their own app); events open their details.
      setDetail({ v, anchor: isPhone ? null : anchor });
    },
    [isPhone],
  );
  const openNew = (start: Date, allDay: boolean) => {
    setDetail(null);
    setSlot(null);
    setEditor({ mode: "new", start, allDay });
  };
  // Jump to an event and open it (search results, a quick-added event).
  const showEvent = useCallback(
    (ev: CalEvent) => {
      const v = toView(ev, calMap, meId, labelMap);
      setCursor(startOfDay(v.start));
      if (view === "agenda") setAgendaDays(AGENDA_DAYS);
      setDetail({ v, anchor: null });
    },
    [calMap, meId, view, labelMap],
  );
  // Quick add's "More options": the full editor, filled in.
  const quickMore = (q: QuickEvent | null, text: string) => {
    setDetail(null);
    if (!q) {
      setEditor({ mode: "new", start: defaultStart(cursor), allDay: false, prefill: text.trim() ? { title: text.trim() } : undefined });
      return;
    }
    setEditor({
      mode: "new",
      start: q.start,
      allDay: q.allDay,
      prefill: { title: q.title, end: q.allDay ? addDays(q.end, -1) : q.end, location: q.location, repeat: q.repeat, guests: q.guests },
    });
  };
  const openQuick = () => {
    // The header box when it's showing, else the sheet.
    if (quickBox.current?.offsetParent) quickBox.current.focus();
    else setQuick(true);
  };
  // A click on an empty slot that just dismissed the popover doesn't also start an event.
  const popoverClosedAt = useRef(0);
  // An empty slot was clicked (an hour) or drawn: the small bubble beside it.
  const createAt = (start: Date, allDay: boolean, end?: Date, anchor?: DOMRect) => {
    if (Date.now() - popoverClosedAt.current < 500) return;
    setDetail(null);
    setSlot({ start, end: end ?? (allDay ? addDays(start, 1) : new Date(start.getTime() + 60 * 60_000)), allDay, anchor: anchor ?? null });
  };

  // Stepping slides the view in from that side; switching view fades it in.
  const viewBox = useRef<HTMLDivElement>(null);
  const shownAs = useRef({ view, at: cursor.getTime() });
  useEffect(() => {
    const was = shownAs.current;
    const at = cursor.getTime();
    shownAs.current = { view, at };
    const el = viewBox.current;
    if (!el || typeof el.animate !== "function" || (was.view === view && was.at === at)) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    if (was.view !== view) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
    else if (view !== "agenda") {
      const dx = at > was.at ? 28 : -28;
      el.animate(
        [
          { opacity: 0, transform: `translateX(${dx}px)` },
          { opacity: 1, transform: "none" },
        ],
        { duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      );
    }
  }, [view, cursor]);
  useEffect(() => setSlot(null), [view, cursor]);

  // Phone: swipe left / right for the next / previous period.
  const swipe = useRef<{ x: number; y: number; t: number; ok: boolean } | null>(null);
  const onTouchStart = (e: ReactTouchEvent) => {
    const t = e.touches[0];
    swipe.current = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, t: Date.now(), ok: true } : null;
  };
  const onTouchMove = () => {
    // Not while an event is being dragged.
    if (swipe.current && dragging()) swipe.current.ok = false;
  };
  const onTouchEnd = (e: ReactTouchEvent) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s || !s.ok || dragging()) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 2 || Date.now() - s.t > 600) return;
    step(dx < 0 ? 1 : -1);
  };

  // Open one event by id (a notification's ``?event=``, an invitation).
  const openById = useCallback(
    async (eventId: string) => {
      try {
        const r = await calendarApi.event(eventId);
        addUsers(r.users);
        const v = toView(r.event, calMap, meId, labelMap);
        setCursor(startOfDay(v.start));
        setDetail({ v, anchor: null });
      } catch (err) {
        toast.error(extractError(err) || "That event isn't available.");
      }
    },
    [calMap, meId, labelMap],
  );
  const linkEvent = params.get("event");
  useEffect(() => {
    if (!linkEvent || !b) return;
    void openById(linkEvent);
    const next = new URLSearchParams(params);
    next.delete("event");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkEvent, b ? 1 : 0]);
  // From a person page: ``?invite=<user id>`` starts a new event with them as
  // a guest; ``?share=1`` opens who your own calendar is shared with.
  const inviteId = params.get("invite");
  const shareMine = params.get("share");
  useEffect(() => {
    if ((!inviteId && !shareMine) || !b) return;
    const next = new URLSearchParams(params);
    next.delete("invite");
    next.delete("share");
    setParams(next, { replace: true });
    if (shareMine) {
      const mine = b.calendars.find((c) => c.personal && c.role === "owner");
      if (mine) setSettingsId(mine.id);
    }
    if (inviteId && inviteId !== b.me.id) {
      const go = (u: CalUser) => {
        addUsers({ [u.id]: u });
        setEditor({ mode: "new", start: defaultStart(cursor), allDay: false, prefill: { guests: [u] } });
      };
      const known = (location.state as { inviteUser?: CalUser } | null)?.inviteUser;
      if (known?.id === inviteId) go(known);
      else
        void peopleHubApi
          .get({ kind: "u", userId: inviteId })
          .then((p) => p.user && go(p.user))
          .catch(() => toast.error("Couldn't find that person."));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inviteId, shareMine, b ? 1 : 0]);

  // Made elsewhere — a note's "Make an event", a widget's + —
  // ``?new=1&title=&description=&location=&date=YYYY-MM-DD&start=HH:MM&end=HH:MM&all_day=1``
  // opens the new-event sheet filled in, to check and save.
  const wantNew = params.get("new");
  useEffect(() => {
    if (!wantNew || !b) return;
    const p = new URLSearchParams(params);
    const next = new URLSearchParams(params);
    for (const k of ["new", "title", "description", "location", "date", "start", "end", "all_day"]) next.delete(k);
    setParams(next, { replace: true });
    const clock = (v: string | null) => (v && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(p.get("date") ?? "") ? (p.get("date") as string) : null;
    const day = date ? new Date(`${date}T00:00:00`) : null;
    const from = clock(p.get("start"));
    const to = clock(p.get("end"));
    const valid = day && !Number.isNaN(day.getTime());
    const allDay = !!valid && (p.get("all_day") === "1" || !from);
    const start = valid ? (allDay ? day : new Date(`${date}T${from}:00`)) : defaultStart(cursor);
    const end = valid && !allDay && to ? new Date(`${date}T${to}:00`) : undefined;
    if (valid) setCursor(startOfDay(start));
    const text = (k: string, n: number) => (p.get(k) ?? "").slice(0, n) || undefined;
    setEditor({
      mode: "new",
      start,
      allDay,
      prefill: { title: text("title", 200), description: text("description", 5000), location: text("location", 300), end },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantNew, b ? 1 : 0]);

  // Keyboard (desktop): t d w m a ← → n p c, q quick add, / search, ? the list.
  // (e and Delete act on the open event: see EventDetail.)
  useEffect(() => {
    if (isPhone) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const k = e.key;
      if (k === "Escape") {
        setDetail(null);
        setSearch(false);
        return;
      }
      if (k === "?") {
        setKeysHelp(true);
        e.preventDefault();
        return;
      }
      const views: Record<string, View> = { d: "day", w: "week", m: "month", a: "agenda" };
      if (k === "t") today();
      else if (views[k]) setView(views[k]);
      else if (k === "ArrowLeft" || k === "p") step(-1);
      else if (k === "ArrowRight" || k === "n") step(1);
      else if (k === "c") openNew(defaultStart(cursor), false);
      else if (k === "q") openQuick();
      else if (k === "/") setSearch(true);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (location.pathname === "/calendar") {
    return <Navigate replace to={{ pathname: "/calendar/", search: location.search, hash: location.hash }} />;
  }

  const title = (() => {
    switch (view) {
      case "month":
      case "agenda":
        return fmt(cursor, { month: isPhone ? "short" : "long", year: "numeric" });
      case "week": {
        const s = isPhone ? cursor : startOfWeek(cursor);
        const e = addDays(s, weekDays - 1);
        if (isPhone || s.getMonth() === e.getMonth()) return fmt(s, { month: isPhone ? "short" : "long", year: "numeric" });
        return `${fmt(s, { month: "short" })} – ${fmt(e, { month: "short", year: "numeric" })}`;
      }
      case "day":
        return fmt(cursor, isPhone ? { weekday: "short", month: "short", day: "numeric" } : { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    }
  })();

  const settingsCal: Calendar | null = b?.calendars.find((c) => c.id === settingsId) ?? null;
  const sidePanel = b && (
    <SidePanel
      b={b}
      cursor={cursor}
      onPick={(d) => {
        setCursor(startOfDay(d));
        setSide(false);
      }}
      onNewCalendar={() => {
        setSide(false);
        setNewCal(true);
      }}
      onSettings={(c) => {
        setSide(false);
        setSettingsId(c.id);
      }}
      onSubscribe={() => {
        setSide(false);
        setSubscribe(true);
      }}
      onOpenInvite={(ev: CalEvent) => {
        setSide(false);
        void openById(ev.event_id);
      }}
      standalone={!embedded}
      onPromptlyMenu={
        embedded && drawerNav
          ? () => {
              setSide(false);
              openPromptlyNav();
            }
          : undefined
      }
    />
  );

  let body;
  if (!b) {
    body = isLoading ? (
        <LoadingCalendar />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-[var(--text-muted)]">
          {isError && (
            <>
              Couldn't reach Calendar.
              <ItemButton variant="secondary" onClick={() => void refetch()}>
                Try again
              </ItemButton>
            </>
          )}
        </div>
      );
  } else {
    const viewEl =
      view === "month" ? (
        <MonthView
          cursor={cursor}
          events={events}
          compact={isPhone}
          onOpen={openEvent}
          onCreate={(d, anchor) => createAt(defaultStart(d), false, undefined, anchor)}
          onDay={goDay}
          onMove={moveEvent}
          draftDay={slot?.start ?? null}
          loading={firstLoad}
        />
      ) : view === "week" || view === "day" ? (
        <TimeGridView
          from={view === "week" && !isPhone ? startOfWeek(cursor) : cursor}
          days={view === "week" ? weekDays : 1}
          events={events}
          compact={isPhone}
          onOpen={openEvent}
          onCreate={createAt}
          onDay={goDay}
          onMove={moveEvent}
          draft={slot}
          loading={firstLoad}
          onPlanTask={(t, start, end) => void planTask(t, start, end)}
          secondTz={b.prefs.second_tz}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {isPhone && (
            <div className="shrink-0 border-b border-[var(--border)] px-3 py-2">
              {miniOpen ? (
                <MiniMonth selected={cursor} onPick={(d) => setCursor(startOfDay(d))} dots={dots} onMonthChange={setMiniMonth} />
              ) : (
                <WeekStrip cursor={cursor} onPick={(d) => setCursor(startOfDay(d))} events={events} />
              )}
              <button
                type="button"
                onClick={() => setMiniOpen((x) => !x)}
                aria-label={miniOpen ? "Show less" : "Show the month"}
                aria-expanded={miniOpen}
                className="mx-auto mt-0.5 flex h-5 w-10 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)]"
              >
                <ChevronDown className={cn("h-4 w-4 transition", miniOpen && "rotate-180")} />
              </button>
            </div>
          )}
          <AgendaView
            from={cursor}
            days={agendaDays}
            events={events}
            loading={eventsLoading}
            onOpen={openEvent}
            onMore={() => setAgendaDays((n) => Math.min(n + AGENDA_DAYS, 392))}
            onCreate={() => openNew(defaultStart(cursor), false)}
          />
        </div>
      );

    body = (
      <div className="flex min-h-0 flex-1">
        {!narrow && (
          <aside className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-[var(--border)] bg-[var(--surface)] p-3" aria-label="Calendars">
            {sidePanel}
          </aside>
        )}
        <main id={embedded ? undefined : "main"} data-toast-anchor className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg)]">
          <Header
            title={title}
            view={view}
            onView={setView}
            onPrev={() => step(-1)}
            onNext={() => step(1)}
            onToday={today}
            onNew={() => openNew(defaultStart(cursor), false)}
            onMenu={() => setSide(true)}
            showMenu={narrow}
            isPhone={isPhone}
            onSearch={() => setSearch((x) => !x)}
            searchOpen={search}
            quickAdd={!isPhone && <QuickAddBar ref={quickBox} b={b} onOpen={showEvent} onMore={quickMore} />}
            onQuickAdd={() => setQuick(true)}
            weekLabel={isPhone ? `${PHONE_DAYS} days` : "Week"}
          />
          <TravelNotice b={b} />
          <div
            ref={viewBox}
            className="flex min-h-0 flex-1 flex-col"
            onTouchStart={isPhone ? onTouchStart : undefined}
            onTouchMove={isPhone ? onTouchMove : undefined}
            onTouchEnd={isPhone ? onTouchEnd : undefined}
            onTouchCancel={isPhone ? () => (swipe.current = null) : undefined}
          >
            {viewEl}
          </div>
          <SearchPanel open={search} onClose={() => setSearch(false)} b={b} calMap={calMap} onPick={(v) => showEvent(v.ev)} phone={isPhone} />
          {isPhone && (
            <button
              type="button"
              aria-label="New event"
              onClick={() => setQuick(true)}
              className="absolute bottom-[calc(16px+env(safe-area-inset-bottom,0px))] right-4 z-30 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--item-accent)] text-white shadow-[var(--shadow-lg)] transition active:scale-95"
            >
              <Plus className="h-6 w-6" />
            </button>
          )}
        </main>
      </div>
    );
  }

  const detailBody =
    detail &&
    b &&
    (detail.v.extra?.kind === "birthday" ? (
      <BirthdayDetail b={detail.v.extra.b} onClose={() => setDetail(null)} />
    ) : detail.v.extra ? (
      <ExtraDetail
        v={detail.v}
        onClose={() => setDetail(null)}
        onOpenEvent={(id) => {
          setDetail(null);
          void openById(id);
        }}
      />
    ) : (
      <EventDetail
        v={detail.v}
        b={b}
        onClose={() => setDetail(null)}
        onEdit={() => {
          const v = detail.v;
          setDetail(null);
          setEditor({ mode: "edit", v });
        }}
        onChanged={(ev) => setDetail((d) => (d ? { ...d, v: toView(ev, calMap, meId, labelMap) } : d))}
      />
    ));

  return (
    <div
      ref={dragGuard}
      style={embedded ? undefined : ({ "--item-accent": "var(--accent)" } as CSSProperties)}
      className={cn("flex flex-col overflow-hidden bg-[var(--bg)] text-[var(--text)]", embedded ? "h-full min-h-0" : "h-[100dvh] pl-safe pr-safe pt-safe")}
    >
      {body}
      {detail &&
        (isPhone ? (
          <Sheet open onClose={() => setDetail(null)}>
            <div className="pb-2 pt-1">{detailBody}</div>
          </Sheet>
        ) : (
          <Popover
            anchor={detail.anchor ?? new DOMRect(window.innerWidth / 2 - 188 - 8, window.innerHeight * 0.18, 0, 0)}
            onClose={() => {
              popoverClosedAt.current = Date.now();
              setDetail(null);
            }}
            width={376}
          >
            <div className="p-4">{detailBody}</div>
          </Popover>
        ))}
      {b && (
        <>
          <EventEditor target={editor} b={b} onClose={() => setEditor(null)} onSaved={() => setEditor(null)} />
          {slot && (
            <QuickCreate
              key={`${slot.start.getTime()}:${slot.end.getTime()}:${slot.allDay}`}
              slot={slot}
              b={b}
              phone={isPhone}
              onClose={() => {
                popoverClosedAt.current = Date.now();
                setSlot(null);
              }}
              onSaved={showEvent}
              onMore={(s, d) => {
                setSlot(null);
                setEditor({
                  mode: "new",
                  start: s.start,
                  allDay: s.allDay,
                  prefill: { title: d.title || undefined, end: s.allDay ? addDays(s.end, -1) : s.end, calendarId: d.calendarId || undefined, labelId: d.labelId || undefined },
                });
              }}
            />
          )}
          <Sheet open={keysHelp} onClose={() => setKeysHelp(false)} title="Keyboard shortcuts" size="sm">
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 pb-2 pt-1 text-sm">
              {KEYS.map(([k, what]) => (
                <div key={k} className="contents">
                  <dt>
                    <kbd className="whitespace-pre rounded-md border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 font-mono text-xs text-[var(--text)]">{k}</kbd>
                  </dt>
                  <dd className="text-[var(--text-muted)]">{what}</dd>
                </div>
              ))}
            </dl>
          </Sheet>
          <NewCalendarSheet open={newCal} onClose={() => setNewCal(false)} b={b} />
          <CalendarSettingsSheet cal={settingsCal} onClose={() => setSettingsId(null)} b={b} />
          <SubscribeSheet open={subscribe} onClose={() => setSubscribe(false)} b={b} />
          <QuickAddSheet open={quick} onClose={() => setQuick(false)} b={b} onOpen={showEvent} onMore={quickMore} />
          {narrow && (
            <Sheet open={side} onClose={() => setSide(false)} title="Calendars">
              <div className="pb-2">{sidePanel}</div>
            </Sheet>
          )}
        </>
      )}
      <ScopeHost />
      {!embedded && (
        <>
          <InstallFromLink appName="Promptly Calendar" iconSrc="/item-icons/calendar-192.png" description="Your calendar, shared with family and friends, as its own app." />
          <NetworkStatusToast />
        </>
      )}
    </div>
  );
}

/** Placeholder header and month while Calendar first loads. */
function LoadingCalendar() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="status" aria-label="Loading Calendar">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border)] px-4 md:h-16">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-6 w-40" />
        <div className="flex-1" />
        <Skeleton className="hidden h-9 w-64 md:block" />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-5">
        {Array.from({ length: 35 }, (_, i) => (
          <div key={i} className="flex flex-col gap-1.5 border-b border-r border-[var(--border)] p-1.5">
            <Skeleton className="h-4 w-5 self-center" />
            {i % 3 !== 1 && <Skeleton className="h-4 w-full" />}
            {i % 4 === 2 && <Skeleton className="h-4 w-2/3" />}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The phone's week strip over the schedule (tap a day to start there). */
function WeekStrip({ cursor, onPick, events }: { cursor: Date; onPick: (d: Date) => void; events: ViewEvent[] }) {
  const s = startOfWeek(cursor);
  const now = new Date();
  return (
    <div className="grid grid-cols-7">
      {Array.from({ length: 7 }, (_, i) => {
        const d = addDays(s, i);
        const isToday = sameDay(d, now);
        const isSel = sameDay(d, cursor);
        const has = events.some((v) => onDay(v, d));
        return (
          <button key={i} type="button" onClick={() => onPick(d)} aria-label={fmt(d, { weekday: "long", month: "long", day: "numeric" })} className="flex flex-col items-center gap-0.5 py-0.5">
            <span className="text-xs font-medium uppercase text-[var(--text-muted)]">{fmt(d, { weekday: "narrow" })}</span>
            <span
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold tabular-nums",
                isToday ? "bg-[var(--item-accent)] text-white" : isSel ? "bg-[color-mix(in_srgb,var(--item-accent)_18%,transparent)] text-[var(--text)]" : "text-[var(--text)]",
              )}
            >
              {d.getDate()}
            </span>
            <span className={cn("h-1 w-1 rounded-full", has ? "bg-[var(--item-accent)]" : "bg-transparent")} />
          </button>
        );
      })}
    </div>
  );
}
