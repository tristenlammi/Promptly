import { CalendarSearch, Loader2, Plus, Users, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { calendarReachApi } from "@/api/calendarReach";
import { calendarApi, type CalEvent, type CalendarBootstrap, type CalUser, type EditScope, type EventPatch, type Repeat, type RsvpStatus } from "@/api/calendar";
import { extractError } from "@/components/files/helpers";
import { LocationInput } from "@/components/maps/LocationInput";
import { Chip, Field, ItemButton, Select, Sheet, TextArea, TextInput, Toggle } from "@/items/ui";
import { PeoplePicker } from "@/rooms/components/PeoplePicker";
import { UserAvatar } from "@/rooms/components/ui";
import { toast } from "@/store/toastStore";

import { addDays, combine, dayDiff, hm, localZone, parseYmd, startOfDay, weekdayIndexMon, ymd } from "../dates";
import { addUsers, useCalUsers, useRefreshEvents } from "../data";
import { REMINDER_OPTIONS, type ViewEvent } from "../model";
import type { EventPrefill } from "../prefill";
import { EmailGuestsField, type DraftEmailGuest } from "./EmailGuestsField";
import { AvailabilityTag, availabilityText, FREE_COLOR, BUSY_COLOR, overlaps, useBusy } from "./Availability";
import { FindTime } from "./FindTime";
import { RepeatPicker } from "./RepeatPicker";
import { askScope, StatusBadge } from "./ui";

export type EditorTarget = { mode: "new"; start: Date; allDay: boolean; prefill?: EventPrefill } | { mode: "edit"; v: ViewEvent };

interface Draft {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  repeat: Repeat | null;
  calendarId: string;
  guests: CalUser[];
  location: string;
  description: string;
  reminders: number[];
  guestsCanEdit: boolean;
}

function initial(t: EditorTarget, b: CalendarBootstrap, users: Record<string, CalUser>): Draft {
  if (t.mode === "new") {
    const p = t.prefill ?? {};
    const s = t.start;
    // Timed: ``end`` is exclusive; all-day: it's the last day. Ignore one
    // that doesn't come after the start.
    let e = new Date(s.getTime() + 60 * 60_000);
    if (p.end && (t.allDay ? p.end >= startOfDay(s) : p.end > s)) e = p.end;
    const personal = b.calendars.find((c) => c.personal)?.id ?? b.calendars[0]?.id ?? "";
    // A room's event goes on my own calendar; quick add may name one I can write to.
    const named = !p.room && p.calendarId && b.calendars.some((c) => c.id === p.calendarId && (c.role === "owner" || c.role === "editor")) ? p.calendarId : null;
    return {
      title: p.title ?? "",
      allDay: t.allDay,
      startDate: ymd(s),
      startTime: t.allDay ? "09:00" : hm(s),
      endDate: t.allDay ? ymd(p.end && p.end >= startOfDay(s) ? p.end : s) : ymd(e),
      endTime: t.allDay ? "10:00" : hm(e),
      repeat: p.repeat ?? null,
      calendarId: named ?? personal,
      guests: (p.guests ?? []).filter((g) => g.id !== b.me.id),
      location: p.location ?? "",
      description: p.description ?? "",
      reminders: t.allDay ? [] : [10],
      guestsCanEdit: false,
    };
  }
  const { v } = t;
  const ev = v.ev;
  const lastDay = addDays(v.end, -1);
  return {
    title: ev.title,
    allDay: ev.all_day,
    startDate: ymd(v.start),
    startTime: ev.all_day ? "09:00" : hm(v.start),
    endDate: ev.all_day ? ymd(lastDay) : ymd(v.end),
    endTime: ev.all_day ? "10:00" : hm(v.end),
    repeat: ev.repeat,
    calendarId: ev.calendar_id,
    guests: ev.attendees.filter((a) => a.guest).map((a) => users[a.user_id] ?? { id: a.user_id, username: "Someone", avatar_url: null, color: null }),
    location: ev.location,
    description: ev.description,
    reminders: [...ev.event_reminders],
    guestsCanEdit: ev.guests_can_edit,
  };
}

const sameRepeat = (a: Repeat | null, b: Repeat | null) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
function norm(r: Repeat | null) {
  if (!r) return null;
  return { f: r.freq, i: r.interval ?? 1, w: r.freq === "weekly" ? [...(r.weekdays ?? [])].sort() : [], m: r.freq === "monthly" ? (r.monthly ?? "day") : "", u: r.until ?? "", c: r.until ? 0 : (r.count ?? 0) };
}

export function EventEditor({ target, b, onClose, onSaved }: { target: EditorTarget | null; b: CalendarBootstrap; onClose: () => void; onSaved: (ev: CalEvent) => void }) {
  if (!target) return null;
  return <EditorBody key={target.mode === "edit" ? target.v.ev.id : `new:${target.start.getTime()}`} target={target} b={b} onClose={onClose} onSaved={onSaved} />;
}

function EditorBody({ target, b, onClose, onSaved }: { target: EditorTarget; b: CalendarBootstrap; onClose: () => void; onSaved: (ev: CalEvent) => void }) {
  const users = useCalUsers((s) => s.users);
  const refresh = useRefreshEvents();
  const [d, setD] = useState<Draft>(() => initial(target, b, users));
  const [customRepeat, setCustomRepeat] = useState(false);
  const [remindersTouched, setRemindersTouched] = useState(target.mode === "edit");
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const ev = target.mode === "edit" ? target.v.ev : null;

  // Guests invited by email (people not on Promptly): saved ones load in.
  const [emailGuests, setEmailGuests] = useState<DraftEmailGuest[]>([]);
  const { data: savedEmail } = useQuery({
    queryKey: ["calendar", "email-guests", ev?.event_id],
    queryFn: () => calendarReachApi.emailGuests(ev!.event_id),
    enabled: !!ev && ev.can_edit,
  });
  const emailLoaded = useRef(false);
  useEffect(() => {
    if (savedEmail && !emailLoaded.current) {
      emailLoaded.current = true;
      setEmailGuests(savedEmail.guests.map((g) => ({ id: g.id, email: g.email, status: g.status })));
    }
  }, [savedEmail]);

  /** After the event is saved: email the new ones, uninvite the removed. */
  const syncEmailGuests = async (eventId: string) => {
    const fresh = emailGuests.filter((g) => !g.id).map((g) => g.email);
    const keep = new Set(emailGuests.map((g) => g.id).filter(Boolean));
    const gone = (savedEmail?.guests ?? []).filter((g) => !keep.has(g.id));
    try {
      for (const g of gone) await calendarReachApi.removeEmailGuest(eventId, g.id);
      if (fresh.length) {
        await calendarReachApi.inviteByEmail(eventId, fresh);
        toast.success(fresh.length === 1 ? `Invitation emailed to ${fresh[0]}` : `Invitations emailed to ${fresh.length} people`);
      }
    } catch (err) {
      toast.error(`The event is saved, but: ${extractError(err)}`);
    }
  };

  const writable = b.calendars.filter((c) => c.role === "owner" || c.role === "editor" || c.id === ev?.calendar_id);
  const canMove = !ev || (ev.on_my_calendar && ev.can_delete);
  const statusOf = useMemo(() => new Map<string, RsvpStatus>((ev?.attendees ?? []).map((a) => [a.user_id, a.status])), [ev]);
  const organiserId = ev?.created_by ?? b.me.id;

  const start = d.allDay ? parseYmd(d.startDate) : combine(d.startDate, d.startTime);
  const end = d.allDay ? parseYmd(d.endDate) : combine(d.endDate, d.endTime);
  const invalid = d.allDay ? end < start : end <= start;

  // Planned in a room: everyone there is invited, and a card is posted in it.
  const room = target.mode === "new" ? target.prefill?.room ?? null : null;

  // Who's free then (timed events with guests). Only ever "Not available" —
  // never what anyone's doing. Saving is never blocked by it.
  const [finding, setFinding] = useState(false);
  const checkFree = d.guests.length > 0 && !d.allDay && !invalid;
  const busyIds = useMemo(() => [b.me.id, ...d.guests.map((g) => g.id)], [b.me.id, d.guests]);
  // Editing: the event's own slot would show everyone on it as busy.
  const editSpan = target.mode === "edit" && !target.v.allDay ? ([target.v.start, target.v.end] as [Date, Date]) : null;
  const avail = useBusy(busyIds, start, end, { enabled: checkFree, ignore: editSpan });
  const known = checkFree && avail.covers(start, end);
  const busyAt = (id: string): boolean | null => (known ? overlaps(avail.busy![id], start.getTime(), end.getTime()) : null);
  const busyGuests = known ? d.guests.filter((g) => busyAt(g.id)) : [];
  const verdict = known ? availabilityText(busyGuests, d.guests.length, !!busyAt(b.me.id)) : null;

  // "Use this time" from Find a time.
  const pickTime = (s: Date, e: Date) => {
    const patch: Partial<Draft> = { startDate: ymd(s), startTime: hm(s), endDate: ymd(e), endTime: hm(e) };
    const r = d.repeat;
    if (r?.freq === "weekly" && r.weekdays?.length === 1 && r.weekdays[0] === weekdayIndexMon(start)) {
      patch.repeat = { ...r, weekdays: [weekdayIndexMon(s)] };
    }
    set(patch);
  };

  useEffect(() => {
    if (!remindersTouched) set({ reminders: d.allDay ? [] : [10] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.allDay]);

  // The start moves the end with it, keeping the length.
  const moveStart = (date: string, time: string) => {
    const oldStart = d.allDay ? parseYmd(d.startDate) : combine(d.startDate, d.startTime);
    const newStart = d.allDay ? parseYmd(date) : combine(date, time);
    const patch: Partial<Draft> = { startDate: date, startTime: time };
    if (d.allDay) {
      patch.endDate = ymd(addDays(parseYmd(d.endDate), dayDiff(oldStart, newStart)));
    } else {
      const len = Math.max(15 * 60_000, end.getTime() - oldStart.getTime());
      const e = new Date(newStart.getTime() + len);
      patch.endDate = ymd(e);
      patch.endTime = hm(e);
    }
    // "Weekly on <day>" follows the start's weekday.
    const r = d.repeat;
    if (r?.freq === "weekly" && r.weekdays?.length === 1 && r.weekdays[0] === weekdayIndexMon(oldStart)) {
      patch.repeat = { ...r, weekdays: [weekdayIndexMon(newStart)] };
    }
    set(patch);
  };

  const toggleReminder = (m: number) => {
    setRemindersTouched(true);
    set({ reminders: d.reminders.includes(m) ? d.reminders.filter((x) => x !== m) : [...d.reminders, m].slice(-5) });
  };

  const wireTimes = (s: Date, e: Date, allDay: boolean) => (allDay ? { start: ymd(s), end: ymd(e) } : { start: s.toISOString(), end: e.toISOString() });

  const save = async () => {
    if (!d.title.trim()) {
      toast.error("Give the event a title.");
      return;
    }
    if (invalid) {
      toast.error("The event ends before it starts.");
      return;
    }
    const guestIds = d.guests.map((g) => g.id);
    setSaving(true);
    try {
      if (!ev) {
        const r = await calendarApi.create({
          title: d.title.trim(),
          description: d.description,
          location: d.location.trim(),
          all_day: d.allDay,
          ...wireTimes(start, end, d.allDay),
          tz: localZone(),
          calendar_id: d.calendarId || null,
          repeat: d.repeat,
          reminders: d.reminders,
          guests: guestIds,
          guests_can_edit: guestIds.length ? d.guestsCanEdit : false,
          room_id: room?.id ?? null,
        });
        addUsers(r.users);
        toast.success(room ? `Event posted in ${room.name}` : guestIds.length ? "Event saved — guests invited" : "Event saved");
        await syncEmailGuests(r.event.event_id);
        refresh();
        onSaved(r.event);
        return;
      }

      const v = (target as { v: ViewEvent }).v;
      const patch: EventPatch = {};
      if (d.title.trim() !== ev.title) patch.title = d.title.trim();
      if (d.description !== ev.description) patch.description = d.description;
      if (d.location.trim() !== ev.location) patch.location = d.location.trim();
      if (d.calendarId !== ev.calendar_id && canMove) patch.calendar_id = d.calendarId;
      if (JSON.stringify([...d.reminders].sort()) !== JSON.stringify([...ev.event_reminders].sort())) patch.reminders = d.reminders;
      const oldGuests = ev.attendees.filter((a) => a.guest).map((a) => a.user_id).sort();
      if (JSON.stringify([...guestIds].sort()) !== JSON.stringify(oldGuests)) patch.guests = guestIds;
      if (d.guestsCanEdit !== ev.guests_can_edit) patch.guests_can_edit = d.guestsCanEdit;
      const repeatChanged = !sameRepeat(d.repeat, ev.repeat);
      const newEndExcl = d.allDay ? addDays(end, 1) : end;
      const timesChanged = d.allDay !== ev.all_day || start.getTime() !== v.start.getTime() || newEndExcl.getTime() !== v.end.getTime();

      // Email guests belong to the whole event (saved separately, below).
      const emailChanged =
        emailGuests.some((g) => !g.id) || (savedEmail?.guests ?? []).some((g) => !emailGuests.some((x) => x.id === g.id));
      let scope: EditScope = "all";
      if (ev.repeat) {
        if (!timesChanged && !repeatChanged && Object.keys(patch).length === 0) {
          if (emailChanged) {
            await syncEmailGuests(ev.event_id);
            refresh();
          }
          onClose();
          return;
        }
        const s = await askScope("edit", !repeatChanged);
        if (!s) return;
        scope = s;
      }
      if (repeatChanged && scope !== "this") patch.repeat = d.repeat;
      if (timesChanged) {
        patch.all_day = d.allDay;
        patch.tz = localZone();
        if (scope === "all" && ev.repeat) {
          // Move the whole series by the same change, from its first occurrence.
          const shift = dayDiff(v.start, start);
          const first = ev.all_day ? parseYmd(ev.series_start) : new Date(ev.series_start);
          if (d.allDay) {
            const s0 = addDays(new Date(first.getFullYear(), first.getMonth(), first.getDate()), shift);
            Object.assign(patch, wireTimes(s0, addDays(s0, dayDiff(start, end)), true));
          } else {
            const s0 = addDays(new Date(first.getFullYear(), first.getMonth(), first.getDate()), shift);
            s0.setHours(start.getHours(), start.getMinutes(), 0, 0);
            Object.assign(patch, wireTimes(s0, new Date(s0.getTime() + (end.getTime() - start.getTime())), false));
          }
        } else {
          Object.assign(patch, wireTimes(start, end, d.allDay));
        }
      }
      if (Object.keys(patch).length === 0) {
        if (emailChanged) {
          await syncEmailGuests(ev.event_id);
          refresh();
        }
        onClose();
        return;
      }
      if (ev.repeat) {
        patch.scope = scope;
        patch.occurrence = ev.occurrence;
      }
      const r = await calendarApi.update(ev.event_id, patch);
      addUsers(r.users);
      toast.success("Event updated");
      if (emailChanged) await syncEmailGuests(ev.event_id);
      refresh();
      onSaved(r.event);
    } catch (err) {
      toast.error(extractError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={ev ? "Edit event" : room ? `Plan an event in ${room.name}` : "New event"}
      size="lg"
      footer={
        <>
          <ItemButton block onClick={onClose}>
            Cancel
          </ItemButton>
          <ItemButton block variant="primary" type="submit" form="cal-event-form" disabled={saving || invalid || !d.title.trim()}>
            {saving ? "Saving…" : room ? "Post" : "Save"}
          </ItemButton>
        </>
      }
    >
      <form
        id="cal-event-form"
        className="flex flex-col gap-4 pt-1"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextInput
          data-autofocus
          autoFocus
          value={d.title}
          onChange={(e) => set({ title: e.target.value })}
          placeholder="Add title"
          aria-label="Title"
          maxLength={200}
          className="!h-12 !text-lg font-semibold"
        />

        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-[var(--text)]">All day</span>
          <Toggle checked={d.allDay} onChange={(v) => set({ allDay: v, endDate: v && d.endDate < d.startDate ? d.startDate : d.endDate })} label="All day" />
        </div>

        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Field label="Starts">
            <TextInput type="date" value={d.startDate} onChange={(e) => e.target.value && moveStart(e.target.value, d.startTime)} required />
          </Field>
          {!d.allDay && (
            <Field label="&nbsp;">
              <TextInput type="time" value={d.startTime} onChange={(e) => e.target.value && moveStart(d.startDate, e.target.value)} aria-label="Start time" className="!w-32" />
            </Field>
          )}
          <Field label="Ends">
            <TextInput type="date" value={d.endDate} min={d.startDate} onChange={(e) => e.target.value && set({ endDate: e.target.value })} required />
          </Field>
          {!d.allDay && (
            <Field label="&nbsp;">
              <TextInput type="time" value={d.endTime} onChange={(e) => e.target.value && set({ endTime: e.target.value })} aria-label="End time" className="!w-32" />
            </Field>
          )}
        </div>
        {invalid && <p className="-mt-2 text-xs text-[var(--danger)]">The end must be after the start.</p>}

        <RepeatPicker value={d.repeat} onChange={(r) => set({ repeat: r })} start={start} custom={customRepeat} onCustom={setCustomRepeat} />

        {canMove ? (
          writable.length > 1 && (
            <Field label="Calendar">
              <Select value={d.calendarId} onChange={(e) => set({ calendarId: e.target.value })}>
                {writable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.personal ? `${c.name} (personal)` : c.name}
                  </option>
                ))}
              </Select>
            </Field>
          )
        ) : null}

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--text-muted)]">Guests</span>
            {!room && (
              <ItemButton size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setPicking(true)}>
                Add guests
              </ItemButton>
            )}
          </div>
          {room ? (
            <RoomGuests roomName={room.name} me={b.me} guests={d.guests} busyAt={busyAt} />
          ) : d.guests.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)]">Invite people on this Promptly — they'll be notified and can answer.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--surface)]">
              {d.guests.map((g) => (
                <li key={g.id} className="flex h-11 items-center gap-2 px-3">
                  <UserAvatar user={g} size={26} />
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{g.username}</span>
                  <AvailabilityTag busy={busyAt(g.id)} compact={ev != null} />
                  {ev && <StatusBadge status={statusOf.get(g.id) ?? "invited"} />}
                  <button
                    type="button"
                    aria-label={`Remove ${g.username}`}
                    onClick={() => set({ guests: d.guests.filter((x) => x.id !== g.id) })}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!room && (!ev || ev.can_edit) && (
            <EmailGuestsField
              guests={emailGuests}
              onChange={setEmailGuests}
              onAddUser={(u) => set({ guests: [...d.guests, u] })}
              takenUserIds={[b.me.id, organiserId, ...d.guests.map((g) => g.id)]}
            />
          )}
          {d.guests.length > 0 && !d.allDay && (
            <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <p className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-[var(--text-muted)]" aria-live="polite">
                {invalid ? null : avail.isError ? (
                  "Couldn't check who's free."
                ) : !verdict ? (
                  <>
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> Checking who's free…
                  </>
                ) : (
                  <>
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: verdict.ok ? FREE_COLOR : BUSY_COLOR }} aria-hidden />
                    <span className={verdict.ok ? "text-[var(--text)]" : undefined}>{verdict.text}</span>
                  </>
                )}
              </p>
              <ItemButton size="sm" icon={<CalendarSearch className="h-3.5 w-3.5" />} onClick={() => setFinding(true)} disabled={invalid}>
                Find a time
              </ItemButton>
            </div>
          )}
          {d.guests.length > 0 && (
            <div className="flex items-center justify-between pt-1">
              <span className="text-sm text-[var(--text)]">Guests can edit</span>
              <Toggle checked={d.guestsCanEdit} onChange={(v) => set({ guestsCanEdit: v })} label="Guests can edit" />
            </div>
          )}
        </div>

        <Field label="Location">
          <LocationInput value={d.location} onChange={(location) => set({ location })} placeholder="Add a place" maxLength={300} aria-label="Location" />
        </Field>

        <Field label="Notes">
          <TextArea value={d.description} onChange={(e) => set({ description: e.target.value })} placeholder="Add notes" maxLength={5000} rows={3} />
        </Field>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-[var(--text-muted)]">Reminders</span>
          <div className="flex flex-wrap gap-1.5">
            <Chip
              active={d.reminders.length === 0}
              onClick={() => {
                setRemindersTouched(true);
                set({ reminders: [] });
              }}
            >
              None
            </Chip>
            {REMINDER_OPTIONS.map((o) => (
              <Chip key={o.value} active={d.reminders.includes(o.value)} onClick={() => toggleReminder(o.value)}>
                {o.label}
              </Chip>
            ))}
          </div>
        </div>

      </form>
      <FindTime open={finding} onClose={() => setFinding(false)} me={b.me} people={d.guests} start={start} end={end} ignore={editSpan} onPick={pickTime} />
      <Sheet open={picking} onClose={() => setPicking(false)} title="Add guests" size="md" footer={<ItemButton block variant="primary" onClick={() => setPicking(false)}>Done</ItemButton>}>
        <PeoplePicker selected={d.guests} onChange={(next) => set({ guests: next })} exclude={[b.me.id, organiserId]} />
      </Sheet>
    </Sheet>
  );
}

/** Room mode: everyone in the room, as a compact avatar row (with who's free). */
function RoomGuests({ roomName, me, guests, busyAt }: { roomName: string; me: CalUser; guests: CalUser[]; busyAt: (id: string) => boolean | null }) {
  const people = [me, ...guests];
  const shown = people.slice(0, 8);
  const more = people.length - shown.length;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
      <div className="flex items-center">
        <div className="flex -space-x-2">
          {shown.map((u) => {
            const busy = busyAt(u.id);
            return (
              <span key={u.id} className="relative rounded-full ring-2 ring-[var(--surface)]" title={`${u.id === me.id ? "You" : u.username}${busy ? " — not available then" : ""}`}>
                <UserAvatar user={u} size={30} />
                {busy != null && (
                  <span
                    className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--surface)]"
                    style={{ background: busy ? BUSY_COLOR : FREE_COLOR }}
                    aria-hidden
                  />
                )}
              </span>
            );
          })}
        </div>
        {more > 0 && <span className="ml-2 text-xs font-medium text-[var(--text-muted)]">+{more}</span>}
      </div>
      <p className="flex items-start gap-1.5 text-sm text-[var(--text)]">
        <Users className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
        <span>
          Everyone in <b className="font-semibold">{roomName}</b> ({people.length}) gets it on their calendar
        </span>
      </p>
    </div>
  );
}
