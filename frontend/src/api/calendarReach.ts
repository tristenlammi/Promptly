import axios from "axios";

import { apiClient } from "@/api/client";
import type { CalUser, RsvpStatus } from "@/api/calendar";
import type { PhotoItem } from "@/api/photos";

/**
 * Calendar events reaching out (``backend/app/calendars/reach.py``): photos
 * from an event, each room's "starting soon" post, and guests invited by
 * email — plus the public page they answer from.
 */

/** Someone invited by email (not on Promptly). Non-organisers see a hint of the address. */
export interface EmailGuest {
  id: string;
  email: string;
  name: string;
  status: RsvpStatus;
}

/** A room the event is in: its "Starting in 1 hour" post (minutes before; null = off). */
export interface RoomLink {
  room_id: string;
  remind_minutes: number | null;
  can_change: boolean;
}

/** Extra fields on a single-event fetch (``calendarApi.event``). */
export interface EventReachFields {
  email_guests?: EmailGuest[];
  room_links?: RoomLink[];
}

export interface EventAlbum {
  id: string;
  title: string;
  mine: boolean;
  count?: number;
}

export interface EventPhotos {
  /** False until the event (that occurrence) has started. */
  started: boolean;
  count: number;
  /** The first few, oldest first. */
  items: PhotoItem[];
  occurrence?: string;
  /** The span searched (timed: an hour before to two after; all-day: its days). */
  window?: { start: string; end: string };
  album: EventAlbum | null;
}

export interface EmailCheck {
  email: string;
  valid: boolean;
  /** On this Promptly — add them as a guest instead. */
  user: CalUser | null;
  /** This server can send email (SMTP set up). */
  can_email: boolean;
}

/** What the public answer page shows. */
export interface InviteAnswer {
  title: string;
  when: string;
  repeats: string | null;
  location: string;
  description: string;
  organiser: string | null;
  email: string;
  status: RsvpStatus;
  over: boolean;
}

export const ROOM_REMIND_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: "Off" },
  { value: 15, label: "15 min" },
  { value: 60, label: "1 hour" },
  { value: 120, label: "2 hours" },
  { value: 1440, label: "1 day" },
];

export const calendarReachApi = {
  async photos(eventId: string, occurrence?: string): Promise<EventPhotos> {
    return (await apiClient.get(`/calendar/events/${eventId}/photos`, { params: { occurrence } })).data;
  },
  async makeAlbum(eventId: string, occurrence?: string): Promise<{ album: EventAlbum }> {
    return (await apiClient.post(`/calendar/events/${eventId}/album`, { occurrence: occurrence ?? null })).data;
  },
  async setRoomReminder(eventId: string, roomId: string, minutes: number | null): Promise<{ room_id: string; remind_minutes: number | null }> {
    return (await apiClient.patch(`/calendar/events/${eventId}/rooms/${roomId}`, { remind_minutes: minutes })).data;
  },
  async emailCheck(email: string): Promise<EmailCheck> {
    return (await apiClient.get("/calendar/email-check", { params: { email } })).data;
  },
  async emailGuests(eventId: string): Promise<{ guests: EmailGuest[]; can_email: boolean }> {
    return (await apiClient.get(`/calendar/events/${eventId}/email-guests`)).data;
  },
  async inviteByEmail(eventId: string, emails: string[]): Promise<{ guests: EmailGuest[] }> {
    return (await apiClient.post(`/calendar/events/${eventId}/email-guests`, { emails })).data;
  },
  async removeEmailGuest(eventId: string, guestId: string): Promise<void> {
    await apiClient.delete(`/calendar/events/${eventId}/email-guests/${guestId}`);
  },
};

/** The public answer page — no sign-in, so a bare client (no auth refresh / redirects). */
export const inviteAnswerApi = {
  async get(token: string): Promise<InviteAnswer> {
    return (await axios.get(`/api/calendar/answer/${encodeURIComponent(token)}`)).data;
  },
  async answer(token: string, status: Exclude<RsvpStatus, "invited">): Promise<InviteAnswer> {
    return (await axios.post(`/api/calendar/answer/${encodeURIComponent(token)}`, { status })).data;
  },
};

/** A plausible email address (the server checks properly). */
export const looksLikeEmail = (s: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s.trim());
