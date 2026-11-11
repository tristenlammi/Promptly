import { apiClient } from "@/api/client";

/**
 * Calendar — events shared per event (guests) or through shared calendars
 * ("Family"). Everything lives under ``/api/calendar``; see
 * ``backend/app/calendars``.
 *
 * Times on the wire: timed events are UTC ISO instants (``…Z``). All-day
 * events are dates (``YYYY-MM-DD``) and ``end`` is the LAST day, inclusive.
 */

/** editor: make changes · viewer: see all details · busy: see only when (free/busy). */
export type CalendarRole = "owner" | "editor" | "viewer" | "busy";
export type ShareRole = Exclude<CalendarRole, "owner">;
export type RsvpStatus = "invited" | "going" | "maybe" | "declined";
export type RepeatFreq = "daily" | "weekly" | "monthly" | "yearly";
export type EditScope = "all" | "this" | "following";

export interface CalUser {
  id: string;
  username: string;
  avatar_url: string | null;
  color: string | null;
}

export interface Repeat {
  freq: RepeatFreq;
  interval?: number;
  /** Weekly: 0 = Monday … 6 = Sunday. */
  weekdays?: number[];
  /** Monthly: on the same date ("day", default) or the same weekday ("2nd Tuesday"). */
  monthly?: "day" | "weekday";
  /** Last date (YYYY-MM-DD), or ``count`` times. */
  until?: string;
  count?: number;
}

export interface Calendar {
  id: string;
  name: string;
  personal: boolean;
  /** The calendar's own colour (owner sets it). */
  base_color: string;
  /** What to draw it in for me (my override, else ``base_color``). */
  color: string;
  role: CalendarRole;
  /** Unticked in my list. */
  hidden: boolean;
  owner_id: string | null;
  /** user id → role, everyone on the calendar. */
  member_roles: Record<string, CalendarRole>;
}

export interface Attendee {
  user_id: string;
  status: RsvpStatus;
  /** Invited (vs a shared-calendar member who just answered). */
  guest: boolean;
}

/** One occurrence (a one-off event is its only occurrence). */
export interface CalEvent {
  /** ``<event_id>:<occurrence>`` — unique per occurrence. */
  id: string;
  event_id: string;
  /** The occurrence's start key (UTC), for scoped edits / deletes. */
  occurrence: string;
  calendar_id: string;
  title: string;
  description: string;
  location: string;
  all_day: boolean;
  start: string;
  end: string;
  /** The series' first occurrence (for editing "all"). */
  series_start: string;
  series_end: string;
  tz: string;
  repeat: Repeat | null;
  color: string | null;
  created_by: string | null;
  guests_can_edit: boolean;
  /** My reminders (minutes before). */
  reminders: number[];
  event_reminders: number[];
  attendees: Attendee[];
  /** My answer, when I'm a guest. */
  my_status: RsvpStatus | null;
  /** On one of my calendars (vs only invited). */
  on_my_calendar: boolean;
  can_edit: boolean;
  can_delete: boolean;
  /** On someone's calendar shared with me as free/busy only: just "Busy" and the time. */
  busy_only?: boolean;
  /** What it was made from: a task planned into a time slot. */
  source?: EventSource | null;
  /** Rooms (that I'm in) it was planned in or shared to — only on single-event fetches. */
  rooms?: EventRoom[];
  /** My own label on it (only ever mine; nobody else sees it). */
  label_id?: string | null;
  /** Its RSVP form (Forms), for people who can change the event. */
  rsvp_form?: { file_id: string; title: string; answers: number; state: "open" | "closed" | "trashed" } | null;
}

export interface EventRoom {
  room_id: string;
  /** "#general · Family", or a DM's name. */
  name: string;
}

/** Calendar display settings (saved per person). */
export interface CalendarPrefs {
  tasks: boolean;
  birthdays: boolean;
  workouts: boolean;
  meals: boolean;
  bills: boolean;
  trips: boolean;
  /** Appointments from my own Health app. */
  appointments: boolean;
  holidays: boolean;
  /** ISO country code for public holidays ("" = not picked yet). */
  holiday_country: string;
  /** A second time zone column in week / day view ("" = off). */
  second_tz: string;
}

/** A task planned into a time slot (an event's ``source``). */
export interface TaskEventSource {
  kind: "task";
  file_id: string;
  task_id: string;
}

/** "Make this an event" on a Porch post. */
export interface PorchEventSource {
  kind: "porch_post";
  post_id: string;
}

/** What an event was made from. */
export type EventSource = TaskEventSource | PorchEventSource;

/** An open task with a due day, from the Tasks app. Tick it off with
 * ``itemsApi`` action ``complete_tasks`` on ``file_id``. */
export interface CalTask {
  file_id: string;
  task_id: string;
  title: string;
  /** YYYY-MM-DD (local day). */
  due: string;
  /** HH:MM, or null for an all-day task. */
  time: string | null;
  list: string;
  color: string;
  priority: number;
  repeats: boolean;
  /** Planned into a time slot: that event. */
  planned?: { event_id: string; start: string; end: string } | null;
}

/** A planned workout session, or a usual training day with nothing planned yet (``kind: "day"``). */
export interface CalWorkout {
  kind: "session" | "day";
  file_id: string;
  id: string | null;
  day: string;
  time: string | null;
  name: string;
  done: boolean;
  exercises: number;
}

/** One meal on the meal plan. */
export interface CalMeal {
  file_id: string;
  id: string;
  day: string;
  slot: "breakfast" | "lunch" | "dinner" | "snack";
  title: string;
  cooked: boolean;
}

/** A bill / subscription falling due (from Budget). ``amount`` is formatted. */
export interface CalBill {
  file_id: string;
  id: string;
  day: string;
  name: string;
  kind: "bill" | "subscription";
  cadence: string;
  amount: string;
}

/** A trip's dates (``end`` inclusive). */
export interface CalTrip {
  file_id: string;
  trip_id: string;
  title: string;
  emoji: string;
  color: string;
  start: string;
  end: string;
  status: string;
}

/** An appointment from my own Health app (day / time in my time zone). */
export interface CalAppointment {
  file_id: string;
  id: string;
  day: string;
  time: string;
  title: string;
  who: string;
  location: string;
  done: boolean;
}

export interface CalHoliday {
  day: string;
  name: string;
  country: string;
}

/** Everything "Also show" puts beside the events (each empty when switched off). */
export interface CalExtras {
  tasks: CalTask[];
  birthdays: CalBirthday[];
  workouts: CalWorkout[];
  meals: CalMeal[];
  bills: CalBill[];
  trips: CalTrip[];
  appointments: CalAppointment[];
  holidays: CalHoliday[];
}

/** A birthday or anniversary from Contacts. */
export interface CalBirthday {
  kind: "birthday" | "anniversary";
  /** YYYY-MM-DD this year. */
  day: string;
  name: string;
  /** An anniversary's label ("Wedding"). */
  label: string;
  /** The age they turn / years married, when the year is known. */
  years: number | null;
  file_id: string;
  contact_id: string;
  /** Linked person in Photos, and their face (signed URL). */
  person_id: string | null;
  face: string | null;
  /** The contact's own photo (data URL) when there's no face. */
  photo: string | null;
  color: string | null;
}

/** One of my own labels ("Personal", green). Private to me. */
export interface CalLabel {
  id: string;
  name: string;
  color: string;
  position: number;
  /** Unticked: events with it are hidden from my view. */
  hidden: boolean;
}

export interface CalendarBootstrap {
  me: CalUser;
  /** My labels (seeded with Personal and Work the first time). */
  labels: CalLabel[];
  tz: string;
  calendars: Calendar[];
  users: Record<string, CalUser>;
  feed_token: string | null;
  prefs: CalendarPrefs;
  /** Which other apps this person has (so the Tasks / Birthdays toggles only show when useful). */
  apps: { tasks: boolean; contacts: boolean; workout?: boolean; mealplan?: boolean; budget?: boolean; trip?: boolean; health?: boolean };
}

export interface EventInput {
  title: string;
  description?: string;
  location?: string;
  all_day?: boolean;
  start: string;
  end?: string | null;
  tz?: string | null;
  calendar_id?: string | null;
  repeat?: Repeat | null;
  reminders?: number[];
  guests?: string[];
  guests_can_edit?: boolean;
  color?: string | null;
  /** One of my own labels (null takes mine off). */
  label_id?: string | null;
  /** Planned in a room: everyone in it is invited and a card is posted there (create only). */
  room_id?: string | null;
  /** What it's made from: a task planned into a time slot (create only). */
  source?: EventSource | null;
}

export type EventPatch = Partial<Omit<EventInput, "room_id">> & { scope?: EditScope; occurrence?: string };

export const calendarApi = {
  async bootstrap(): Promise<CalendarBootstrap> {
    return (await apiClient.get("/calendar/bootstrap")).data;
  },
  /** Occurrences overlapping [start, end) — dates or ISO instants; max 400 days. */
  async events(start: string, end: string): Promise<{ events: CalEvent[]; users: Record<string, CalUser> }> {
    return (await apiClient.get("/calendar/events", { params: { start, end } })).data;
  },
  /** One event, positioned on its next occurrence (for ``/calendar?event=``). */
  async event(eventId: string): Promise<{ event: CalEvent; users: Record<string, CalUser> }> {
    return (await apiClient.get(`/calendar/events/${eventId}`)).data;
  },
  async create(body: EventInput): Promise<{ event: CalEvent; users: Record<string, CalUser> }> {
    return (await apiClient.post("/calendar/events", body)).data;
  },
  async update(eventId: string, body: EventPatch): Promise<{ event: CalEvent; users: Record<string, CalUser> }> {
    return (await apiClient.patch(`/calendar/events/${eventId}`, body)).data;
  },
  async remove(eventId: string, scope: EditScope = "all", occurrence?: string): Promise<void> {
    await apiClient.delete(`/calendar/events/${eventId}`, { params: { scope, occurrence } });
  },
  async rsvp(eventId: string, status: Exclude<RsvpStatus, "invited">): Promise<{ event: CalEvent; users: Record<string, CalUser> }> {
    return (await apiClient.post(`/calendar/events/${eventId}/rsvp`, { status })).data;
  },
  /** My own settings for an event (a guest's, or a shared calendar member's): my reminders, or removing it from my calendar. */
  async eventMe(eventId: string, body: { reminders?: number[]; use_event_reminders?: boolean; hidden?: boolean }): Promise<unknown> {
    return (await apiClient.patch(`/calendar/events/${eventId}/me`, body)).data;
  },
  async invites(): Promise<{ invites: CalEvent[]; users: Record<string, CalUser> }> {
    return (await apiClient.get("/calendar/invites")).data;
  },
  /** Post an event's card in a room I'm in (``invite_all``: also invite everyone there). */
  async share(eventId: string, roomId: string, inviteAll = false): Promise<{ event: CalEvent; users: Record<string, CalUser> }> {
    return (await apiClient.post(`/calendar/events/${eventId}/share`, { room_id: roomId, invite_all: inviteAll })).data;
  },
  /** Events planned in / shared to a room, from now on (each at its next occurrence). */
  async roomUpcoming(roomId: string): Promise<{ events: CalEvent[]; users: Record<string, CalUser> }> {
    return (await apiClient.get(`/calendar/rooms/${roomId}/upcoming`)).data;
  },
  /** When each person is busy in [start, end) (ISO instants, ≤ 31 days) — times only, never what. */
  async busy(userIds: string[], start: string, end: string): Promise<{ busy: Record<string, [string, string][]> }> {
    return (await apiClient.get("/calendar/busy", { params: { users: userIds.join(","), start, end } })).data;
  },
  /** My events matching ``q`` (title, place, notes): upcoming first at their next occurrence, then past. */
  async search(q: string): Promise<{ events: CalEvent[]; users: Record<string, CalUser> }> {
    return (await apiClient.get("/calendar/search", { params: { q } })).data;
  },
  /** Tasks due and birthdays in [start, end) — local days ``YYYY-MM-DD`` — as my prefs allow. */
  async extras(start: string, end: string): Promise<CalExtras> {
    return (await apiClient.get("/calendar/extras", { params: { start, end } })).data;
  },
  /** A planned task's title and whether it's done (an event's "Done" box). */
  async taskStatus(fileId: string, taskId: string): Promise<{ exists: boolean; done: boolean; title: string; repeats: boolean }> {
    return (await apiClient.get("/calendar/extras/task", { params: { file_id: fileId, task_id: taskId } })).data;
  },
  /** Countries with public holidays, and a guess at mine (from my time zone). */
  async holidayCountries(): Promise<{ countries: { code: string; name: string }[]; guess: string | null }> {
    return (await apiClient.get("/calendar/holiday-countries")).data;
  },
  /** People on this Promptly who are in my Contacts, with what they are to me ("Wife", from Photos). */
  async peopleSuggestions(): Promise<{ people: { user: CalUser; contact_name: string; label: string | null }[] }> {
    return (await apiClient.get("/calendar/people-suggestions")).data;
  },
  async setPrefs(body: Partial<CalendarPrefs>): Promise<CalendarPrefs> {
    return (await apiClient.patch("/calendar/prefs", body)).data;
  },

  async createCalendar(body: { name: string; color: string; member_ids?: string[] }): Promise<Calendar> {
    return (await apiClient.post("/calendar/calendars", body)).data;
  },
  async updateCalendar(id: string, body: { name?: string; color?: string }): Promise<Calendar> {
    return (await apiClient.patch(`/calendar/calendars/${id}`, body)).data;
  },
  /** My own settings for a calendar: my colour for it, ticked or not. */
  async calendarMe(id: string, body: { color?: string; reset_color?: boolean; hidden?: boolean }): Promise<Calendar> {
    return (await apiClient.patch(`/calendar/calendars/${id}/me`, body)).data;
  },
  async deleteCalendar(id: string): Promise<void> {
    await apiClient.delete(`/calendar/calendars/${id}`);
  },
  async addMembers(id: string, user_ids: string[], role: ShareRole = "editor"): Promise<Calendar & { users: Record<string, CalUser> }> {
    return (await apiClient.post(`/calendar/calendars/${id}/members`, { user_ids, role })).data;
  },
  async setRole(id: string, userId: string, role: ShareRole): Promise<Calendar> {
    return (await apiClient.patch(`/calendar/calendars/${id}/members/${userId}`, { role })).data;
  },
  /** The owner removes someone, or pass your own id to leave. */
  async removeMember(id: string, userId: string): Promise<void> {
    await apiClient.delete(`/calendar/calendars/${id}/members/${userId}`);
  },

  /** My labels (private to me). */
  async labels(): Promise<{ labels: CalLabel[] }> {
    return (await apiClient.get("/calendar/labels")).data;
  },
  async createLabel(body: { name: string; color: string }): Promise<CalLabel> {
    return (await apiClient.post("/calendar/labels", body)).data;
  },
  async updateLabel(id: string, body: { name?: string; color?: string; position?: number; hidden?: boolean }): Promise<CalLabel> {
    return (await apiClient.patch(`/calendar/labels/${id}`, body)).data;
  },
  /** Delete one of my labels; the events it was on just lose it. */
  async deleteLabel(id: string): Promise<void> {
    await apiClient.delete(`/calendar/labels/${id}`);
  },
  /** My label on any event I can see (null takes it off). */
  async setEventLabel(eventId: string, labelId: string | null): Promise<{ event_id: string; label_id: string | null }> {
    return (await apiClient.put(`/calendar/events/${eventId}/label`, { label_id: labelId })).data;
  },

  /** Make (or replace) the private subscribe link; returns its token. */
  async makeFeed(): Promise<{ feed_token: string }> {
    return (await apiClient.post("/calendar/feed")).data;
  },
  async dropFeed(): Promise<void> {
    await apiClient.delete("/calendar/feed");
  },
};

/** The subscribe link for a token (https, and the webcal:// form phones prefer). */
export function feedUrls(token: string): { https: string; webcal: string } {
  const https = `${window.location.origin}/api/calendar/feed/${token}.ics`;
  return { https, webcal: https.replace(/^https?:/, "webcal:") };
}
