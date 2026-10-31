/** The shape of a ``.habits`` file (backend: app/items/kinds/habits/models.py). */

export type HabitType = "yes_no" | "count" | "duration" | "avoid";
export type ScheduleKind = "daily" | "weekdays" | "per_week" | "per_month" | "every_n_days";
export type TimeOfDay = "morning" | "afternoon" | "evening" | "anytime";

export interface Schedule {
  kind: ScheduleKind;
  /** weekdays: 0 = Monday … 6 = Sunday */
  days: number[];
  times: number;
  every: number;
}

export interface HabitLog {
  day: string;
  value: number;
  note: string;
  skipped: boolean;
  reason: string;
  at: string;
}

/** How a habit was set up before ``until`` (exclusive) — see engine eras. */
export interface Era {
  until: string;
  type: HabitType;
  target: number;
  limit: number;
  schedule: Schedule;
  anchor_date: string | null;
}

/** A running duration timer, stored in the file so it survives closing. */
export interface ActiveTimer {
  started_at: string;
  day: string;
}

export interface Habit {
  id: string;
  name: string;
  emoji: string;
  color: string;
  area: string;
  type: HabitType;
  target: number;
  unit: string;
  limit: number;
  schedule: Schedule;
  time_of_day: TimeOfDay;
  reminders: string[];
  start_date: string | null;
  /** every-N-days counts from here (else start_date); backfills never move it. */
  anchor_date?: string | null;
  /** The last day the habit existed (on archived copies). */
  end_date?: string | null;
  /** X-per-week/month: remind only on these weekdays (empty = any). */
  reminder_days?: number[];
  /** X-per-week/month: remind only when behind pace. */
  remind_when_behind?: boolean;
  active_timer?: ActiveTimer | null;
  /** Earlier set-ups, oldest first. */
  history?: Era[];
  archived: boolean;
  intention: string;
  identity: string;
  why: string;
  notes: string;
  created_at: string;
  logs: HabitLog[];
}

export interface HabitSettings {
  day_ends_at: number;
  week_start: number;
  reminders_on: boolean;
  evening_summary: boolean;
  evening_time: string;
  review_reminder: boolean;
  review_weekday: number;
  review_time: string;
  celebrate: boolean;
  areas: string[];
  onboarded: boolean;
}

export interface Review {
  week: string;
  wins: string;
  misses: string;
  notes: string;
  focus: string;
  insights: string;
  updated_at: string;
}

export interface HabitsData {
  habits: Habit[];
  settings: HabitSettings;
  reviews: Review[];
}
