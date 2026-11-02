import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Cake, Check, CircleCheck, Dumbbell, Globe, Mail, MoreHorizontal, PartyPopper, Plane, Plus, Receipt, Rss, Share2, UtensilsCrossed } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { calendarApi, type CalEvent, type Calendar, type CalendarBootstrap, type CalendarPrefs, type RsvpStatus } from "@/api/calendar";
import { extractError } from "@/components/files/helpers";
import { Toggle } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { addUsers, useCalUsers, useInvites, useRefreshCalendars, useRefreshEvents, useSetPrefs } from "../data";
import { allZones, fmt, parseYmd, shortTime } from "../dates";
import { PALETTE } from "../model";
import { MiniMonth } from "./MiniMonth";
import { Popover, RsvpButtons } from "./ui";

export function SidePanel({
  b,
  cursor,
  onPick,
  onNewCalendar,
  onSettings,
  onSubscribe,
  onOpenInvite,
  standalone,
}: {
  b: CalendarBootstrap;
  cursor: Date;
  onPick: (d: Date) => void;
  onNewCalendar: () => void;
  onSettings: (c: Calendar) => void;
  onSubscribe: () => void;
  onOpenInvite: (ev: CalEvent) => void;
  standalone: boolean;
}) {
  // Someone's own calendar they shared with me goes under "Other people's".
  const theirs = (c: Calendar) => c.personal && c.owner_id !== b.me.id;
  const mine = b.calendars.filter((c) => !theirs(c));
  const others = b.calendars.filter(theirs);
  const own = b.calendars.find((c) => c.personal && c.owner_id === b.me.id);
  return (
    <div className="flex flex-col gap-5">
      <MiniMonth selected={cursor} onPick={onPick} />
      <section className="flex flex-col gap-0.5">
        <div className="flex items-center justify-between pl-1">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">My calendars</h3>
          <button
            type="button"
            onClick={onNewCalendar}
            aria-label="New shared calendar"
            title="New shared calendar"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        {mine.map((c) => (
          <CalendarRow key={c.id} cal={c} onSettings={() => onSettings(c)} />
        ))}
        <button type="button" onClick={onNewCalendar} className="mt-1 flex h-9 items-center gap-2 rounded-lg px-2 text-left text-sm text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]">
          <Plus className="h-4 w-4" />
          New shared calendar
        </button>
        {own && (
          <button type="button" onClick={() => onSettings(own)} className="flex h-9 items-center gap-2 rounded-lg px-2 text-left text-sm text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]">
            <Share2 className="h-4 w-4" />
            Share my calendar
          </button>
        )}
      </section>
      {others.length > 0 && (
        <section className="flex flex-col gap-0.5">
          <h3 className="pl-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Other people's</h3>
          {others.map((c) => (
            <CalendarRow key={c.id} cal={c} onSettings={() => onSettings(c)} />
          ))}
        </section>
      )}
      <AlsoShow b={b} />
      <Invitations onOpen={onOpenInvite} />
      <section className="flex flex-col gap-0.5">
        <button type="button" onClick={onSubscribe} className="flex h-9 items-center gap-2 rounded-lg px-2 text-left text-sm text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]">
          <Rss className="h-4 w-4" />
          Subscribe in your phone's calendar
        </button>
        {standalone && (
          <a href="/chat" className="flex h-9 items-center gap-2 rounded-lg px-2 text-sm text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]">
            <ArrowLeft className="h-4 w-4" />
            Back to Promptly
          </a>
        )}
      </section>
    </div>
  );
}

function CalendarRow({ cal, onSettings }: { cal: Calendar; onSettings: () => void }) {
  const refresh = useRefreshCalendars();
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [busy, setBusy] = useState(false);
  const me = async (body: { color?: string; reset_color?: boolean; hidden?: boolean }) => {
    setBusy(true);
    try {
      await calendarApi.calendarMe(cal.id, body);
      refresh();
    } catch (err) {
      toast.error(extractError(err));
    } finally {
      setBusy(false);
    }
  };
  const members = Object.keys(cal.member_roles).length;
  return (
    <div className="group flex h-9 items-center gap-1 rounded-lg pr-1 hover:bg-[var(--hover)]">
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-2">
        <input type="checkbox" className="sr-only" checked={!cal.hidden} disabled={busy} onChange={() => void me({ hidden: !cal.hidden })} />
        <span
          aria-hidden
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border-2"
          style={{ borderColor: cal.color, background: cal.hidden ? "transparent" : cal.color }}
        >
          {!cal.hidden && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{cal.name}</span>
        {members > 1 && <span className="shrink-0 text-[10px] text-[var(--text-muted)]">{cal.personal && cal.role === "owner" ? "Shared" : members}</span>}
      </label>
      <button
        type="button"
        aria-label={`Options for ${cal.name}`}
        data-cal-keep-popover
        onClick={(e) => setMenu(menu ? null : e.currentTarget.getBoundingClientRect())}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] opacity-100 hover:bg-[var(--hover-strong,var(--hover))] hover:text-[var(--text)] md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)} width={248} z={80}>
          <div className="flex flex-col gap-2 p-3">
            <span className="text-xs font-medium text-[var(--text-muted)]">My colour for it</span>
            <div className="flex flex-wrap gap-1.5">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  onClick={() => void me({ color: c })}
                  className="flex h-7 w-7 items-center justify-center rounded-full"
                  style={{ background: c }}
                >
                  {cal.color.toLowerCase() === c.toLowerCase() && <Check className="h-3.5 w-3.5 text-white" />}
                </button>
              ))}
            </div>
            {cal.color.toLowerCase() !== cal.base_color.toLowerCase() && (
              <button type="button" onClick={() => void me({ reset_color: true })} className="self-start text-xs text-[var(--item-accent)] hover:underline">
                Use the calendar's colour
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setMenu(null);
                onSettings();
              }}
              className="-mx-1 mt-1 flex h-9 items-center rounded-lg px-2 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)]"
            >
              {cal.personal ? (cal.role === "owner" ? "Share my calendar…" : "Sharing · remove") : cal.role === "owner" ? "Settings and people" : "People · leave"}
            </button>
          </div>
        </Popover>
      )}
    </div>
  );
}

function Invitations({ onOpen }: { onOpen: (ev: CalEvent) => void }) {
  const { data } = useInvites();
  const users = useCalUsers((s) => s.users);
  const refresh = useRefreshEvents();
  const [busy, setBusy] = useState<string | null>(null);
  const invites = data?.invites ?? [];
  if (!invites.length) return null;

  const answer = async (ev: CalEvent, s: Exclude<RsvpStatus, "invited">) => {
    setBusy(ev.event_id);
    try {
      const r = await calendarApi.rsvp(ev.event_id, s);
      addUsers(r.users);
      refresh();
    } catch (err) {
      toast.error(extractError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="flex items-center gap-1.5 pl-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        <Mail className="h-3.5 w-3.5" />
        Invitations
        <span className="rounded-full bg-[var(--item-accent)] px-1.5 text-[10px] font-bold text-white">{invites.length}</span>
      </h3>
      {invites.map((ev) => {
        const start = ev.all_day ? parseYmd(ev.start) : new Date(ev.start);
        const from = ev.created_by ? users[ev.created_by]?.username : null;
        return (
          <div key={ev.event_id} className={cn("flex flex-col gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2.5", busy === ev.event_id && "opacity-60")}>
            <button type="button" onClick={() => onOpen(ev)} className="flex flex-col text-left">
              <span className="truncate text-sm font-medium text-[var(--text)]">{ev.title}</span>
              <span className="truncate text-xs text-[var(--text-muted)]">
                {fmt(start, { weekday: "short", month: "short", day: "numeric" })}
                {ev.all_day ? "" : ` · ${shortTime(start)}`}
                {from ? ` · from ${from}` : ""}
              </span>
            </button>
            <RsvpButtons size="sm" value={null} busy={busy === ev.event_id} onAnswer={(s) => void answer(ev, s)} />
          </div>
        );
      })}
    </section>
  );
}

/** What else shows on the calendar, each with its own switch: tasks,
 *  birthdays, workouts, the meal plan, bills, trips (only for apps this
 *  person has) and public holidays (with a country) — plus an optional
 *  second time zone for week / day view. */
function AlsoShow({ b }: { b: CalendarBootstrap }) {
  const setPrefs = useSetPrefs();
  const p = b.prefs;
  const [picking, setPicking] = useState(false);
  const wantCountries = picking || p.holidays;
  const { data: countries } = useQuery({ queryKey: ["calendar", "holiday-countries"], queryFn: calendarApi.holidayCountries, staleTime: Infinity, enabled: wantCountries });
  const [zonePick, setZonePick] = useState(false);
  const zones = useMemo(() => (zonePick || p.second_tz ? allZones() : []), [zonePick, p.second_tz]);
  const flip = (patch: Partial<CalendarPrefs>) => {
    setPrefs(patch).catch((err) => toast.error(extractError(err)));
  };
  const holidaysOn = async (on: boolean) => {
    if (!on || p.holiday_country) return flip({ holidays: on });
    // First time on: the country from my time zone, else ask.
    try {
      const c = countries ?? (await calendarApi.holidayCountries());
      if (c.guess) return flip({ holidays: true, holiday_country: c.guess });
    } catch {
      /* ask instead */
    }
    setPicking(true);
    flip({ holidays: true });
  };
  const row = (icon: ReactNode, label: string, checked: boolean, onChange: (v: boolean) => void) => (
    <div className="flex h-10 items-center gap-2.5 rounded-lg px-2">
      <span className="shrink-0 text-[var(--text-muted)]">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{label}</span>
      <Toggle checked={checked} onChange={onChange} label={`Show ${label.toLowerCase()}`} />
    </div>
  );
  const selectCls = "h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)]";
  return (
    <section className="flex flex-col gap-0.5">
      <h3 className="pl-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Also show</h3>
      {b.apps.tasks && row(<CircleCheck className="h-4 w-4" />, "Tasks", p.tasks, (v) => flip({ tasks: v }))}
      {b.apps.contacts && row(<Cake className="h-4 w-4" />, "Birthdays", p.birthdays, (v) => flip({ birthdays: v }))}
      {b.apps.workout && row(<Dumbbell className="h-4 w-4" />, "Workouts", p.workouts, (v) => flip({ workouts: v }))}
      {b.apps.mealplan && row(<UtensilsCrossed className="h-4 w-4" />, "Meal plan", p.meals, (v) => flip({ meals: v }))}
      {b.apps.budget && row(<Receipt className="h-4 w-4" />, "Bills", p.bills, (v) => flip({ bills: v }))}
      {b.apps.trip && row(<Plane className="h-4 w-4" />, "Trips", p.trips, (v) => flip({ trips: v }))}
      {row(<PartyPopper className="h-4 w-4" />, "Holidays", p.holidays, (v) => void holidaysOn(v))}
      {p.holidays && (
        <div className="flex flex-col gap-1 px-2 pb-1 pl-[34px]">
          {!p.holiday_country && <span className="text-xs text-[var(--text-muted)]">Which country's public holidays?</span>}
          <select
            aria-label="Country for public holidays"
            className={selectCls}
            value={p.holiday_country}
            onChange={(e) => {
              setPicking(false);
              flip({ holiday_country: e.target.value });
            }}
          >
            {!p.holiday_country && <option value="">Pick a country…</option>}
            {!countries && p.holiday_country && <option value={p.holiday_country}>{p.holiday_country}</option>}
            {countries?.countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex h-10 items-center gap-2.5 rounded-lg px-2">
        <span className="shrink-0 text-[var(--text-muted)]">
          <Globe className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">Second time zone</span>
        <Toggle
          checked={!!p.second_tz || zonePick}
          onChange={(v) => {
            if (v) setZonePick(true);
            else {
              setZonePick(false);
              if (p.second_tz) flip({ second_tz: "" });
            }
          }}
          label="Show a second time zone"
        />
      </div>
      {(zonePick || p.second_tz) && (
        <div className="flex flex-col gap-1 px-2 pb-1 pl-[34px]">
          <select
            aria-label="Second time zone"
            className={selectCls}
            value={p.second_tz}
            onChange={(e) => {
              setZonePick(false);
              flip({ second_tz: e.target.value });
            }}
          >
            {!p.second_tz && <option value="">Pick a time zone…</option>}
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-[var(--text-muted)]">Shown beside the hours in week and day view.</span>
        </div>
      )}
    </section>
  );
}
