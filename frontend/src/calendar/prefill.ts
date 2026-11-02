import type { CalUser, Repeat } from "@/api/calendar";

/** What a new event starts with, beyond its start: from quick add ("Dinner
 * with Sam Fri 7–9pm at Mum's"), or planning one in a room. */
export interface EventPrefill {
  title?: string;
  location?: string;
  description?: string;
  /** Exclusive end (timed), or the last day (all-day). */
  end?: Date;
  repeat?: Repeat | null;
  guests?: CalUser[];
  calendarId?: string;
  /** Planned in a room: everyone in it is invited and a card is posted there. */
  room?: { id: string; name: string };
}
