import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import { ArrowUpRight, CalendarCheck, CalendarX, Check, Clock, MapPin, Repeat as RepeatIcon, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { calendarApi, type CalEvent, type CalUser, type RsvpStatus } from "@/api/calendar";
import type { RoomUser } from "@/api/rooms";
import { addUsers } from "@/calendar/data";
import { addDays, fmt, parseYmd, sameDay, timeLabel } from "@/calendar/dates";
import { CAL_ACCENT, describeRepeat } from "@/calendar/model";
import { RsvpButtons } from "@/calendar/components/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { UserAvatar } from "./ui";

/**
 * An event planned in (or shared to) a room — the message's ``meta.event_id``
 * — drawn as a card: when, where, who's going, and Going / Maybe / Can't go.
 * Anyone in the room can answer; answering puts it on their calendar.
 */

export const eventKey = (id: string) => ["calendar", "event", id] as const;
type EventResp = { event: CalEvent; users: Record<string, CalUser> };

function statusOf(err: unknown): number | null {
  return axios.isAxiosError(err) ? err.response?.status ?? null : null;
}

/** Local start / exclusive end of the (next) occurrence. */
function span(ev: CalEvent): { start: Date; end: Date } {
  if (ev.all_day) return { start: parseYmd(ev.start), end: addDays(parseYmd(ev.end), 1) };
  return { start: new Date(ev.start), end: new Date(ev.end) };
}

/** "Fri, Nov 14 · 7:00 – 9:00 PM", "All day", "Fri 7 PM – Sun 2 PM" — in my time zone. */
function whenText(ev: CalEvent, start: Date, end: Date): string {
  const thisYear = start.getFullYear() === new Date().getFullYear();
  const dayOpts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", ...(thisYear ? {} : { year: "numeric" }) };
  if (ev.all_day) {
    const last = addDays(end, -1);
    return sameDay(start, last) ? `${fmt(start, dayOpts)} · All day` : `${fmt(start, dayOpts)} – ${fmt(last, dayOpts)}`;
  }
  const endsMidnight = end.getHours() === 0 && end.getMinutes() === 0 && sameDay(addDays(start, 1), end);
  if (sameDay(start, end) || endsMidnight) return `${fmt(start, dayOpts)} · ${timeLabel(start)} – ${timeLabel(end)}`;
  return `${fmt(start, dayOpts)}, ${timeLabel(start)} – ${fmt(end, dayOpts)}, ${timeLabel(end)}`;
}

function DateTile({ date, color }: { date: Date; color: string }) {
  return (
    <span
      aria-hidden
      className="flex h-[52px] w-12 shrink-0 flex-col items-center justify-center overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)]"
    >
      <span className="text-[10px] font-bold uppercase leading-none tracking-wide" style={{ color }}>
        {fmt(date, { month: "short" })}
      </span>
      <span className="mt-0.5 text-xl font-semibold leading-none tabular-nums text-[var(--text)]">{date.getDate()}</span>
    </span>
  );
}

const shell = "mt-1 w-full max-w-[440px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)]";

export function EventCard({ eventId, fallback, meId, users }: { eventId: string; fallback: string; meId: string; users: Record<string, RoomUser> }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState<string | null>(null);
  const confirmTimer = useRef<number | null>(null);

  const q = useQuery<EventResp>({
    queryKey: eventKey(eventId),
    queryFn: () => calendarApi.event(eventId),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: (n, err) => {
      const st = statusOf(err);
      return st !== 404 && st !== 403 && n < 2;
    },
  });

  useEffect(() => {
    return () => {
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    };
  }, []);

  const rsvp = useMutation({
    mutationFn: (s: Exclude<RsvpStatus, "invited">) => calendarApi.rsvp(eventId, s),
    onSuccess: (r, s) => {
      const before = q.data?.event.my_status ?? null;
      qc.setQueryData(eventKey(eventId), r);
      addUsers(r.users);
      void qc.invalidateQueries({ queryKey: ["calendar", "events"] });
      void qc.invalidateQueries({ queryKey: ["calendar", "invites"] });
      void qc.invalidateQueries({ queryKey: ["calendar", "room-upcoming"] });
      // The first answer is the one that puts it on your calendar.
      const first = before === null || before === "invited";
      const msg = s === "declined" ? "Got it — you're not going" : first ? "Added to your calendar" : s === "going" ? "You're going" : "Marked as maybe";
      setConfirm(msg);
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirm(null), 4000);
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Couldn't save your answer")),
  });

  if (q.isLoading) return <CardSkeleton />;

  if (q.isError || !q.data) {
    const st = statusOf(q.error);
    const gone = st === 404 || st === 403;
    return (
      <div className={cn(shell, "flex items-center gap-3 px-3 py-3")}>
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-2)] text-[var(--text-muted)]">
          <CalendarX className="h-5 w-5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium text-[var(--text)]">{st === 404 ? "This event was cancelled" : gone ? "This event isn't available" : "Couldn't load this event"}</span>
          <span className={cn("truncate text-xs text-[var(--text-muted)]", gone && "line-through")}>{fallback.replace(/^📅\s*/, "")}</span>
        </span>
        {!gone && (
          <button
            type="button"
            aria-label="Try again"
            onClick={() => void q.refetch()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            <RotateCw className="h-4 w-4" />
          </button>
        )}
      </div>
    );
  }

  const { event: ev, users: calUsers } = q.data;
  const { start, end } = span(ev);
  const color = ev.color ?? CAL_ACCENT;
  const person = (id: string): CalUser | RoomUser | undefined => users[id] ?? calUsers[id];
  const organiser = ev.created_by;
  const mine = organiser === meId;
  // The organiser is going unless they've said otherwise.
  const goingIds = [
    ...(organiser && !ev.attendees.some((a) => a.user_id === organiser) ? [organiser] : []),
    ...ev.attendees.filter((a) => a.status === "going").map((a) => a.user_id),
  ];
  const maybe = ev.attendees.filter((a) => a.status === "maybe").length;
  const shown = goingIds.slice(0, 5);
  const past = end.getTime() < Date.now();

  return (
    <div className={shell}>
      <div className="flex">
        <span className="w-1.5 shrink-0" style={{ background: color }} aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-3 p-3">
          <div className="flex gap-3">
            <DateTile date={start} color={color} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="line-clamp-2 break-words text-[15px] font-semibold leading-snug text-[var(--text)]">{ev.title}</p>
              <p className="flex items-start gap-1.5 text-xs text-[var(--text-muted)]">
                <Clock className="mt-px h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0">{whenText(ev, start, end)}</span>
              </p>
              {ev.repeat && (
                <p className="flex items-start gap-1.5 text-xs text-[var(--text-muted)]">
                  <RepeatIcon className="mt-px h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{describeRepeat(ev.repeat, start)}</span>
                </p>
              )}
              {ev.location && (
                <p className="flex items-start gap-1.5 text-xs text-[var(--text-muted)]">
                  <MapPin className="mt-px h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{ev.location}</span>
                </p>
              )}
            </div>
          </div>

          <div className="flex min-h-7 items-center gap-2">
            {shown.length > 0 && (
              <span className="flex -space-x-1.5">
                {shown.map((id) => (
                  <span key={id} className="rounded-full ring-2 ring-[var(--surface)]" title={id === meId ? "You" : person(id)?.username}>
                    <UserAvatar user={person(id)} size={24} />
                  </span>
                ))}
              </span>
            )}
            <span className="min-w-0 truncate text-xs text-[var(--text-muted)]">
              {goingIds.length ? <b className="font-semibold text-[var(--text)]">{goingIds.length} going</b> : "No one's said yet"}
              {maybe > 0 && ` · ${maybe} maybe`}
            </span>
          </div>

          {mine ? (
            <p className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
              <CalendarCheck className="h-3.5 w-3.5 shrink-0" /> You planned this — it's on your calendar.
            </p>
          ) : past ? (
            <p className="text-xs text-[var(--text-muted)]">This has already happened.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <RsvpButtons value={ev.my_status === "invited" ? null : ev.my_status} busy={rsvp.isPending} onAnswer={(s) => rsvp.mutate(s)} />
              <p
                className={cn(
                  "flex h-4 items-center gap-1 text-[11px] font-medium transition-opacity",
                  confirm ? "opacity-100" : "opacity-0",
                  confirm?.startsWith("Got it") ? "text-[var(--text-muted)]" : "text-[#2f7a48] dark:text-[#7fd09a]",
                )}
                aria-live="polite"
              >
                {confirm && <Check className="h-3 w-3" />}
                {confirm}
              </p>
            </div>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => navigate(`/calendar/?event=${encodeURIComponent(ev.event_id)}`)}
        className="flex h-10 w-full items-center justify-center gap-1.5 border-t border-[var(--border)] text-xs font-semibold text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:bg-[var(--hover)] focus-visible:outline-none"
      >
        Open in Calendar <ArrowUpRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function CardSkeleton() {
  const bar = "animate-pulse rounded bg-[var(--surface-2)]";
  return (
    <div className={shell} aria-busy="true" aria-label="Loading event">
      <div className="flex">
        <span className="w-1.5 shrink-0 bg-[var(--surface-2)]" />
        <div className="flex min-w-0 flex-1 flex-col gap-3 p-3">
          <div className="flex gap-3">
            <span className={cn(bar, "h-[52px] w-12 rounded-xl")} />
            <div className="flex flex-1 flex-col gap-2 pt-1">
              <span className={cn(bar, "h-4 w-3/4")} />
              <span className={cn(bar, "h-3 w-1/2")} />
            </div>
          </div>
          <span className={cn(bar, "h-7 w-32 rounded-full")} />
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-1.5">
              <span className={cn(bar, "h-10 flex-1 rounded-xl")} />
              <span className={cn(bar, "h-10 flex-1 rounded-xl")} />
              <span className={cn(bar, "h-10 flex-1 rounded-xl")} />
            </div>
            <span className="h-4" />
          </div>
        </div>
      </div>
      <span className="block h-10 border-t border-[var(--border)]" />
    </div>
  );
}
