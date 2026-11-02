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
    shifts: { workspace: string; roster: string; start: string | null; end: string | null; hours: number | null; note: string | null; url: string }[];
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
  sections: TodaySections;
  morning: MorningSummary;
}

export interface EverydaySearch {
  events: { id: string; event_id: string; title: string; start: string; all_day: boolean; location: string; url: string }[];
  contacts: { id: string; name: string; detail: string; favorite: boolean; url: string }[];
  tasks: { id: string; title: string; done: boolean; due: string | null; time: string | null; list: string; url: string }[];
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
