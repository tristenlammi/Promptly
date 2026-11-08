import { apiClient } from "@/api/client";
import type { PhotoItem } from "@/api/photos";

/**
 * Today — the day across Promptly in one call (``backend/app/today``), the
 * morning summary push setting, and the everyday half of the search box
 * (events, contacts, tasks). Every ``url`` is an in-app route to open.
 */

export interface TodayEvent {
  id: string;
  event_id: string;
  title: string;
  /** UTC instant (``…Z``), or a date for all-day events. */
  start: string;
  end: string;
  all_day: boolean;
  location: string;
  color: string | null;
  url: string;
}

export interface TodayTask {
  id: string;
  title: string;
  due: string | null;
  time: string | null;
  priority: number;
  list: string;
}

export interface TodayHabit {
  id: string;
  name: string;
  emoji: string;
  color: string | null;
  type: string;
  target: number;
  unit: string;
  done: boolean;
  value: number;
}

export interface TodaySections {
  events?: { events: TodayEvent[]; url: string };
  tasks?: {
    file_id: string;
    url: string;
    overdue_count: number;
    today_count: number;
    overdue: TodayTask[];
    today: TodayTask[];
  };
  habits?: { file_id: string; url: string; day: string; habits: TodayHabit[]; left: number };
  workout?: {
    file_id: string;
    url: string;
    sessions: { id: string; name: string; time: string | null; status: "planned" | "done"; exercises: number }[];
  };
  meals?: {
    file_id: string;
    url: string;
    meals: { id: string; slot: string; title: string; cooked: boolean; leftovers: boolean }[];
  };
  photos?: { count: number; items: PhotoItem[]; years: number[]; url: string };
  rooms?: {
    total: number;
    url: string;
    rooms: { id: string; name: string; where: string; dm: boolean; unread: number; url: string }[];
  };
  work?: {
    open_count: number;
    due_count: number;
    url: string;
    cards: { id: string; title: string; workspace: string; board: string | null; due: string | null; overdue: boolean; url: string }[];
    shifts: { date: string; workspace: string; roster: string; start: string | null; end: string | null; hours: number | null; note: string | null; url: string }[];
    /** The coming week's shifts (after today), up to five. */
    upcoming?: { date: string; workspace: string; roster: string; start: string | null; end: string | null; hours: number | null; note: string | null; url: string }[];
  };
}

export interface TodayDose {
  med_id: string;
  name: string;
  dose: string;
  time: string;
  state: "taken" | "late" | "skipped" | "due" | "upcoming";
}

/** One thing on the day's schedule, whichever app it lives in. */
export interface TodayScheduleItem {
  time: string;
  end?: string | null;
  kind: string;
  title: string;
  detail?: string;
  url: string;
  color?: string | null;
  done: boolean;
  due?: boolean;
}

/** Something that needs you now. */
export interface TodayAttention {
  kind: string;
  level: "danger" | "warn" | "info";
  title: string;
  detail: string;
  url: string;
  /** A card on this page to scroll to, instead of leaving. */
  anchor?: string;
}

export interface TodayComing {
  date: string;
  time: string | null;
  kind: string;
  title: string;
  url: string;
  color?: string | null;
}

export interface TodayHub {
  passwords?: { attention: number; updated_at: string | null };
  mail?: {
    url: string;
    unread: number;
    needs_reply: number;
    items: { from: string; subject: string; summary: string; url: string }[];
  };
  health?: {
    file_id: string;
    url: string;
    doses: TodayDose[];
    doses_due: number;
    doses_taken: number;
    numbers: { metric: string; label: string; value: string | null; series?: (number | null)[] }[];
    goals: { metric: string; label: string; today: string; target: string; pct: number; met: boolean; series: (number | null)[] }[];
    /** Daily weights over the last 30 days, oldest first, and the change. */
    weight_series: number[];
    weight_change: string | null;
    weight: string | null;
    weight_day: string | null;
    weight_unit: string;
    appointments: { id: string; title: string; who: string; location: string; date: string; time: string }[];
  };
  nutrition?: {
    file_id: string;
    url: string;
    kcal: number;
    kcal_target: number | null;
    /** The last 14 days, oldest first; null = nothing logged. */
    kcal_series: (number | null)[];
    protein_series: (number | null)[];
    macros: { key: string; label: string; value: number; target: number | null }[];
    water_ml: number;
    water_target: number | null;
    entries: number;
    meals_left: string[];
  };
  budget?: {
    file_id: string;
    url: string;
    label: string;
    spent: string;
    budgeted: string | null;
    left: string | null;
    over: boolean;
    pct: number | null;
    days_left: number;
    projected_over: string | null;
    bills: { name: string; date: string; amount: string }[];
    overspent: { name: string; by: string }[];
  };
  maps?: {
    next: { title: string; place: string; minutes: number; km: number; leave_by: string; leave_by_label: string; soon: boolean; url: string; traffic?: boolean; adds?: number; warning?: string | null } | null;
    parked: { at: string; url: string } | null;
  };
  trip?: {
    file_id: string;
    url: string;
    title: string;
    emoji: string;
    start: string | null;
    end: string | null;
    phase: "before" | "during";
    days_to_go?: number;
    day?: number;
    of?: number;
    next: { what: string; in: string }[];
    packed: number;
    packing_total: number;
  };
  study?: { file_id: string; url: string; due: number; new: number; review: number; done_today: number; streak: number; studied_today: boolean };
  journal?: { file_id: string; url: string; wrote_today: boolean; words_today: number; mood: number | null; streak: number; total: number };
  people?: {
    file_id: string;
    url: string;
    dates: { name: string; kind: string; label: string; date: string; in_days: number; turns: number | null; url: string }[];
    catchup: { name: string; days_since: number | null; overdue_days: number; url: string }[];
    catchup_total: number;
  };
  automations?: { url: string; failed_24h: number; next: { id: string; title: string; at: string }[] };
  /** Porch: new posts in your ticked groups since you last looked, and today's birthdays. */
  porch?: {
    url: string;
    new_posts: { count: number; thumbs: { post_id: string; thumb: string | null; url: string }[]; from: string[]; more_people: number } | null;
    birthdays: { user: { id: string; username: string; name: string; avatar_url: string | null; color: string | null }; profile_url: string; post_url: string }[];
  };
}

export interface MorningSummary {
  on: boolean;
  time: string;
  /** Where the switch lives: the Tasks app's settings, or the account. */
  source: "tasks" | "account";
  file_id: string | null;
}

export interface TodayData {
  date: string;
  tz: string;
  now: string;
  greeting: string;
  sections: TodaySections & TodayHub;
  morning: MorningSummary;
  schedule: { items: TodayScheduleItem[]; all_day: { kind: string; title: string; url: string; color?: string | null; done?: boolean }[] };
  attention: TodayAttention[];
  coming: TodayComing[];
  progress: { done: number; total: number; pct: number } | null;
  discover: { kind: string; name: string; why: string }[];
}

export interface EverydaySearch {
  mail?: { id: string; subject: string; from: string; at: string; url: string }[];
  events: { id: string; event_id: string; title: string; start: string; all_day: boolean; location: string; url: string }[];
  contacts: { id: string; name: string; detail: string; favorite: boolean; url: string }[];
  tasks: { id: string; title: string; done: boolean; due: string | null; time: string | null; list: string; url: string }[];
  /** Shared tags matching the query (#tags). */
  tags?: { id: string; name: string; color: string | null; count?: number; url: string }[];
  /** Porch posts you can see (words, and photos by what's in them). */
  porch?: { id: string; title: string; subtitle: string; thumb: string | null; url: string }[];
}

export interface JournalDay {
  date: string;
  events: (TodayEvent & { time: string; end_time: string })[];
  photos: PhotoItem[];
  photo_count: number;
}

export const todayApi = {
  async get(): Promise<TodayData> {
    const { data } = await apiClient.get<TodayData>("/today");
    return data;
  },
  async setMorning(on: boolean, time: string): Promise<MorningSummary> {
    const { data } = await apiClient.put<MorningSummary>("/today/morning", { on, time });
    return data;
  },
  async search(q: string, signal?: AbortSignal): Promise<EverydaySearch> {
    const { data } = await apiClient.get<EverydaySearch>("/today/search", { params: { q }, signal });
    return data;
  },
  /** That day's events and your photos, for a journal entry. */
  async journalDay(fileId: string, date: string): Promise<JournalDay> {
    const { data } = await apiClient.get<JournalDay>(`/items/k/journal/${fileId}/day`, { params: { date } });
    return data;
  },
};
