import type { CalUser, EventSource, Repeat } from "@/api/calendar";

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
  /** What it's made from (saved with the event). */
  source?: EventSource;
  /** Guests can only come from these people ("Make this an event" on a
   *  Porch post: the people who can see it); ``note`` says why. */
  guestPool?: { people: CalUser[]; note: string };
  /** Porch (WP-P3.2): planned in a group — a post there carries it, and the
   *  whole group can be invited at once (on by default, not for Everyone). */
  porchGroup?: { id: string; name: string; members: CalUser[]; count: number; inviteAll: boolean; body?: string; onPosted?: (postId: string) => void };
}
