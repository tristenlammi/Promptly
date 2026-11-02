import { useQuery } from "@tanstack/react-query";
import { Bell, CalendarDays, Clock, EyeOff, Hash, MapPin, Pencil, Repeat as RepeatIcon, Send, Text, Trash2, Users, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { calendarApi, type CalendarBootstrap, type RsvpStatus } from "@/api/calendar";
import { extractError } from "@/components/files/helpers";
import { confirm } from "@/components/shared/ConfirmDialog";
import { Chip } from "@/items/ui";
import { UserAvatar } from "@/rooms/components/ui";
import { toast } from "@/store/toastStore";

import { addUsers, useCalUsers, useRefreshEvents } from "../data";
import { describeRepeat, describeWhen, REMINDER_OPTIONS, reminderLabel, type ViewEvent } from "../model";
import { ShareToRoomSheet } from "./ShareToRoomSheet";
import { askScope, RsvpButtons, StatusBadge } from "./ui";

/** What one event looks like when you open it (popover / bottom sheet body). */
export function EventDetail({
  v,
  b,
  onEdit,
  onClose,
  onChanged,
}: {
  v: ViewEvent;
  b: CalendarBootstrap;
  onEdit: () => void;
  onClose: () => void;
  /** The event came back changed (an answer, reminders). */
  onChanged: (next: ViewEvent["ev"]) => void;
}) {
  const ev = v.ev;
  const users = useCalUsers((s) => s.users);
  const refresh = useRefreshEvents();
  const [busy, setBusy] = useState(false);
  const cal = b.calendars.find((c) => c.id === ev.calendar_id);
  const organiser = ev.created_by ? users[ev.created_by] : null;
  const iOrganise = ev.created_by === b.me.id;
  const myRow = ev.attendees.find((a) => a.user_id === b.me.id);
  // Invited (vs a shared calendar's member, who may also have a row of their own).
  const isGuest = myRow ? myRow.guest : ev.my_status !== null && !ev.on_my_calendar;
  // On a shared calendar, or someone's own calendar they shared with me (not free/busy only).
  const isMember = ev.on_my_calendar && !!cal && !(cal.personal && cal.owner_id === b.me.id) && !iOrganise && !ev.busy_only;
  // Guests answer; so can people on a shared calendar ("who's coming?").
  const canAnswer = !iOrganise && (isGuest || isMember);
  // A member's row with no answer only holds their own reminders — not worth listing.
  const shownAttendees = ev.attendees.filter((a) => a.guest || a.status !== "invited");
  const [sharing, setSharing] = useState(false);
  // Which rooms it was planned in / shared to (only the single-event fetch says).
  const { data: full } = useQuery({
    queryKey: ["calendar", "event", ev.event_id],
    queryFn: () => calendarApi.event(ev.event_id),
    staleTime: 30_000,
    enabled: !v.extra,
  });
  const rooms = full?.event.rooms ?? [];

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.error(extractError(err));
    } finally {
      setBusy(false);
    }
  };

  const answer = (s: Exclude<RsvpStatus, "invited">) =>
    run(async () => {
      const r = await calendarApi.rsvp(ev.event_id, s);
      addUsers(r.users);
      // Keep this occurrence's times; take the rest from the reply.
      onChanged({ ...ev, attendees: r.event.attendees, my_status: r.event.my_status, reminders: r.event.reminders });
      refresh();
    });

  const remove = () =>
    run(async () => {
      let scope: "all" | "this" | "following" = "all";
      if (ev.repeat) {
        const s = await askScope("delete");
        if (!s) return;
        scope = s;
      } else if (!(await confirm({ title: "Delete event?", message: `"${ev.title}" will be deleted${ev.attendees.length ? " and its guests told" : ""}.`, confirmLabel: "Delete", danger: true }))) {
        return;
      }
      await calendarApi.remove(ev.event_id, scope, ev.occurrence);
      toast.success("Event deleted");
      refresh();
      onClose();
    });

  const hide = () =>
    run(async () => {
      await calendarApi.eventMe(ev.event_id, { hidden: true });
      toast.success("Removed from your calendar");
      refresh();
      onClose();
    });

  const toggleReminder = (m: number) =>
    run(async () => {
      const cur = ev.reminders;
      const next = cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m].slice(-5);
      onChanged({ ...ev, reminders: next });
      await calendarApi.eventMe(ev.event_id, { reminders: next });
      refresh();
    });

  const counts = shownAttendees.reduce<Record<string, number>>((m, a) => ({ ...m, [a.status]: (m[a.status] ?? 0) + 1 }), {});

  return (
    <div className="flex flex-col gap-3 text-sm text-[var(--text)]">
      <div className="flex items-start gap-1">
        <span className="mt-1.5 h-3.5 w-3.5 shrink-0 rounded" style={v.look === "pending" ? { border: `2px dashed ${v.color}` } : { background: v.color }} />
        <h2 className={`ml-2 min-w-0 flex-1 break-words text-lg font-semibold leading-snug ${v.look === "declined" ? "line-through opacity-70" : ""}`}>{ev.title}</h2>
        <div className="-mr-2 -mt-1 flex shrink-0">
          {ev.can_edit && <HeadButton label="Edit" onClick={onEdit} icon={<Pencil className="h-4 w-4" />} />}
          {ev.can_delete && <HeadButton label="Delete" onClick={remove} icon={<Trash2 className="h-4 w-4" />} disabled={busy} />}
          <HeadButton label="Close" onClick={onClose} icon={<X className="h-4 w-4" />} />
        </div>
      </div>

      <Row icon={<Clock className="h-4 w-4" />}>
        <div>{describeWhen(v)}</div>
        {ev.repeat && (
          <div className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
            <RepeatIcon className="h-3 w-3" />
            {describeRepeat(ev.repeat, v.start)}
          </div>
        )}
      </Row>

      {ev.location && (
        <Row icon={<MapPin className="h-4 w-4" />}>
          <a
            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.location)}`}
            target="_blank"
            rel="noreferrer noopener"
            className="break-words text-[var(--item-accent)] hover:underline"
          >
            {ev.location}
          </a>
        </Row>
      )}

      {ev.description && (
        <Row icon={<Text className="h-4 w-4" />}>
          <p className="whitespace-pre-wrap break-words">{ev.description}</p>
        </Row>
      )}

      <Row icon={<CalendarDays className="h-4 w-4" />}>
        <div>{cal ? cal.name : "Invited"}</div>
        {organiser && <div className="text-xs text-[var(--text-muted)]">Organised by {organiser.id === b.me.id ? "you" : organiser.username}</div>}
      </Row>

      {rooms.length > 0 && (
        <Row icon={<Hash className="h-4 w-4" />}>
          <div className="flex flex-wrap gap-1.5">
            {rooms.map((r) => (
              <Link
                key={r.room_id}
                to={`/rooms/r/${r.room_id}`}
                className="inline-flex h-7 max-w-full items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 text-xs text-[var(--text)] hover:bg-[var(--hover)]"
              >
                <span className="shrink-0 text-[var(--text-muted)]">{r.name.startsWith("#") ? "Planned in" : "Shared with"}</span>
                <span className="truncate font-medium">{r.name}</span>
              </Link>
            ))}
          </div>
        </Row>
      )}

      {shownAttendees.length > 0 && (
        <Row icon={<Users className="h-4 w-4" />}>
          <div className="mb-1.5 text-xs text-[var(--text-muted)]">
            {shownAttendees.length} {shownAttendees.length === 1 ? (shownAttendees[0].guest ? "guest" : "person") : "people"}
            {counts.going ? ` · ${counts.going} going` : ""}
            {counts.maybe ? ` · ${counts.maybe} maybe` : ""}
            {counts.declined ? ` · ${counts.declined} can't go` : ""}
            {counts.invited ? ` · ${counts.invited} not answered` : ""}
          </div>
          <ul className="flex flex-col gap-1.5">
            {shownAttendees.map((a) => {
              const u = users[a.user_id];
              return (
                <li key={a.user_id} className="flex items-center gap-2">
                  <UserAvatar user={u ?? { id: a.user_id, username: "?", avatar_url: null, color: null }} size={24} />
                  <span className="min-w-0 flex-1 truncate">{a.user_id === b.me.id ? "You" : (u?.username ?? "Someone")}</span>
                  <StatusBadge status={a.status} />
                </li>
              );
            })}
          </ul>
        </Row>
      )}

      {(isGuest || isMember) && (
        <Row icon={<Bell className="h-4 w-4" />}>
          <div className="mb-1.5 text-xs text-[var(--text-muted)]">
            Your reminders{ev.reminders.length ? `: ${ev.reminders.map(reminderLabel).join(", ")}` : " — none"}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {REMINDER_OPTIONS.map((o) => (
              <Chip key={o.value} active={ev.reminders.includes(o.value)} onClick={() => !busy && toggleReminder(o.value)}>
                {o.label}
              </Chip>
            ))}
          </div>
        </Row>
      )}

      {canAnswer && (
        <div className="flex flex-col gap-1.5 border-t border-[var(--border)] pt-3">
          <span className="text-xs font-medium text-[var(--text-muted)]">{isGuest && ev.my_status === "invited" ? "You're invited — going?" : "Going?"}</span>
          <RsvpButtons value={ev.my_status === "invited" ? null : ev.my_status} onAnswer={answer} busy={busy} />
        </div>
      )}

      {ev.can_edit && (
        <button
          type="button"
          onClick={() => setSharing(true)}
          className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-[var(--border)] text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)]"
        >
          <Send className="h-4 w-4" />
          Share to a room
        </button>
      )}

      {((isGuest && !ev.on_my_calendar) || isMember) && (
        <button
          type="button"
          onClick={hide}
          disabled={busy}
          className="flex h-9 items-center justify-center gap-1.5 rounded-xl text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <EyeOff className="h-3.5 w-3.5" />
          Remove from my calendar
        </button>
      )}
      {ev.can_edit && <ShareToRoomSheet ev={ev} open={sharing} onClose={() => setSharing(false)} sharedIds={rooms.map((r) => r.room_id)} />}
    </div>
  );
}

function HeadButton({ label, icon, onClick, disabled }: { label: string; icon: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] disabled:opacity-50"
    >
      {icon}
    </button>
  );
}

function Row({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 shrink-0 text-[var(--text-muted)]">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
