import { mapsSearchLink } from "@/maps/links";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, CalendarDays, ClipboardList, Clock, EyeOff, Hash, Mail, MapPin, Pencil, Repeat as RepeatIcon, Send, Tag as TagIcon, Text, Trash2, Users, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import { calendarApi, type CalendarBootstrap, type RsvpStatus } from "@/api/calendar";
import { calendarReachApi, ROOM_REMIND_OPTIONS, type EventReachFields } from "@/api/calendarReach";
import { formsApi } from "@/api/forms";
import { trashApi } from "@/api/trash";
import { extractError } from "@/components/files/helpers";
import { LinkedSection } from "@/components/links/LinkedSection";
import { confirm } from "@/components/shared/ConfirmDialog";
import { EntityTags } from "@/components/tags/TagPicker";
import { Chip } from "@/items/ui";
import { UserAvatar } from "@/rooms/components/ui";
import { toast } from "@/store/toastStore";

import { zoneNote } from "../dates";
import { addUsers, useCalUsers, useRefreshEvents } from "../data";
import { describeRepeat, describeWhen, REMINDER_OPTIONS, reminderLabel, type ViewEvent } from "../model";
import { EventPhotos } from "./EventPhotos";
import { ShareToRoomSheet } from "./ShareToRoomSheet";
import { TaskSourceBadge } from "./TaskSourceBadge";
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
  // "9 am in Sydney" when the event was set in another time zone.
  const zone = zoneNote(v.start, v.ev.tz, v.allDay);
  const reachFields = (full?.event ?? {}) as EventReachFields;
  const emailGuests = reachFields.email_guests ?? [];
  const roomLinks = new Map((reachFields.room_links ?? []).map((l) => [l.room_id, l]));
  // The room whose "starting soon" post options are open.
  const [roomMenu, setRoomMenu] = useState<string | null>(null);
  const qc = useQueryClient();

  const setRoomReminder = (roomId: string, minutes: number | null) =>
    run(async () => {
      await calendarReachApi.setRoomReminder(ev.event_id, roomId, minutes);
      await qc.invalidateQueries({ queryKey: ["calendar", "event", ev.event_id] });
      setRoomMenu(null);
      toast.success(minutes == null ? "No reminder in the room" : "The room gets a reminder");
    });

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
      // A whole event goes to the Trash, so it can come straight back.
      const eventId = ev.event_id;
      toast.success("Event deleted", {
        action:
          scope === "all"
            ? {
                label: "Undo",
                onClick: () =>
                  void trashApi
                    .restore([{ type: "calendar_event", id: eventId }])
                    .then((r) => {
                      if (!r.done) toast.error(r.results[0]?.error || "Couldn't bring it back.");
                      refresh();
                    })
                    .catch((e) => toast.error(extractError(e))),
              }
            : undefined,
      });
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
        {zone && <div className="text-xs text-[var(--text-muted)]">{zone}</div>}
        {ev.repeat && (
          <div className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
            <RepeatIcon className="h-3 w-3" />
            {describeRepeat(ev.repeat, v.start)}
          </div>
        )}
      </Row>
      {ev.source?.kind === "task" && <TaskSourceBadge source={ev.source} onNavigate={onClose} />}

      {ev.location && (
        <Row icon={<MapPin className="h-4 w-4" />}>
          <a
            href={mapsSearchLink(ev.location)}
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

      {!v.extra && !ev.busy_only && (
        <Row icon={<TagIcon className="h-4 w-4" />}>
          <EntityTags kind="event" id={ev.event_id} />
        </Row>
      )}

      {rooms.length > 0 && (
        <Row icon={<Hash className="h-4 w-4" />}>
          <div className="flex flex-wrap gap-1.5">
            {rooms.map((r) => {
              const link = roomLinks.get(r.room_id);
              return (
                <span key={r.room_id} className="inline-flex h-7 max-w-full items-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-xs text-[var(--text)]">
                  <Link to={`/rooms/r/${r.room_id}`} className="inline-flex h-full min-w-0 items-center gap-1 rounded-full pl-2.5 pr-2 hover:bg-[var(--hover)]">
                    <span className="shrink-0 text-[var(--text-muted)]">{r.name.startsWith("#") ? "Planned in" : "Shared with"}</span>
                    <span className="truncate font-medium">{r.name}</span>
                  </Link>
                  {link?.can_change && (
                    <button
                      type="button"
                      onClick={() => setRoomMenu(roomMenu === r.room_id ? null : r.room_id)}
                      aria-label={`Reminder in ${r.name}`}
                      aria-expanded={roomMenu === r.room_id}
                      title={link.remind_minutes == null ? "No reminder in the room" : `Reminds the room ${roomRemindLabel(link.remind_minutes)} before`}
                      className="flex h-full items-center rounded-full px-2 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                    >
                      {link.remind_minutes == null ? <BellOff className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
                    </button>
                  )}
                </span>
              );
            })}
          </div>
          {roomMenu && roomLinks.get(roomMenu) && (
            <div className="mt-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2.5">
              <div className="mb-1.5 text-xs text-[var(--text-muted)]">Post “Starting soon · who's going” in the room</div>
              <div className="flex flex-wrap gap-1.5">
                {ROOM_REMIND_OPTIONS.map((o) => (
                  <Chip key={String(o.value)} active={roomLinks.get(roomMenu)!.remind_minutes === o.value} onClick={() => !busy && setRoomReminder(roomMenu, o.value)}>
                    {o.value == null ? o.label : `${o.label} before`}
                  </Chip>
                ))}
              </div>
            </div>
          )}
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
                  {a.user_id === b.me.id ? <span className="min-w-0 flex-1 truncate">You</span> : <Link to={`/people/u/${a.user_id}`} className="min-w-0 flex-1 truncate hover:underline">{u?.username ?? "Someone"}</Link>}
                  <StatusBadge status={a.status} />
                </li>
              );
            })}
          </ul>
        </Row>
      )}

      {emailGuests.length > 0 && (
        <Row icon={<Mail className="h-4 w-4" />}>
          <div className="mb-1.5 text-xs text-[var(--text-muted)]">Invited by email</div>
          <ul className="flex flex-col gap-1.5">
            {emailGuests.map((g) => (
              <li key={g.id} className="flex items-center gap-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text-muted)]">
                  <Mail className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1 truncate">{g.name || g.email}</span>
                <StatusBadge status={g.status} />
              </li>
            ))}
          </ul>
        </Row>
      )}

      {!v.extra && !ev.busy_only && <EventPhotos eventId={ev.event_id} occurrence={ev.occurrence} start={v.start} />}

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

      {!v.extra && !ev.busy_only && (
        <LinkedSection thing={{ kind: "event", id: ev.event_id }} className="border-t border-[var(--border)] pt-3" />
      )}

      {ev.can_edit && !v.extra && !ev.busy_only && <RsvpFormAction eventId={ev.event_id} form={full ? full.event.rsvp_form ?? null : undefined} />}

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

/**
 * The event's RSVP form (Forms WP-F1.7), in the event page's action stack
 * (full-width outlined buttons, like "Share to a room"; Calls' "Join call"
 * goes in the same stack): "Add an RSVP form" makes one from the RSVP
 * template with the event's title, time and place, linked to the event;
 * once there it reads "RSVP form · 14 answers" and opens its answers.
 */
function RsvpFormAction({ eventId, form }: { eventId: string; form: CalEventRsvp | null | undefined }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const cls =
    "flex min-h-10 items-center justify-center gap-1.5 rounded-xl border border-[var(--border)] px-3 text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-60";
  if (form === undefined) return null; // still loading the event
  if (form)
    return (
      <Link to={`/files/form/${form.file_id}?tab=responses`} className={cls} data-testid="event-rsvp-form">
        <ClipboardList className="h-4 w-4 text-[#7c3aed]" />
        <span className="truncate">RSVP form · {form.answers === 1 ? "1 answer" : `${form.answers} answers`}</span>
        {form.state === "closed" && <span className="text-xs text-[var(--text-muted)]">· closed</span>}
      </Link>
    );
  const add = async () => {
    setBusy(true);
    try {
      const r = await formsApi.fromEvent(eventId);
      await qc.invalidateQueries({ queryKey: ["calendar", "event", eventId] });
      toast.success("RSVP form made. Check it, then press Send.");
      navigate(`/files/form/${r.file.id}`);
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" onClick={() => void add()} disabled={busy} className={cls}>
      <ClipboardList className="h-4 w-4" />
      {busy ? "Making the form…" : "Add an RSVP form"}
    </button>
  );
}

type CalEventRsvp = { file_id: string; title: string; answers: number; state: "open" | "closed" | "trashed" };

function roomRemindLabel(m: number): string {
  if (m % 1440 === 0) return m === 1440 ? "a day" : `${m / 1440} days`;
  if (m % 60 === 0) return m === 60 ? "an hour" : `${m / 60} hours`;
  return `${m} min`;
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
