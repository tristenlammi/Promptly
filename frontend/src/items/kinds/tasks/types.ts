/* The Tasks file — mirrors backend/app/items/kinds/tasks/models.py. */

export type Freq = "daily" | "weekly" | "monthly" | "yearly";

export interface Repeat {
  freq: Freq;
  interval: number;
  /** Weekly: Mon=0 … Sun=6; empty = the due day's weekday. */
  weekdays: number[];
  month_day: number | null;
  from_completion: boolean;
  until: string | null;
}

export interface Step {
  id: string;
  title: string;
  done: boolean;
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  list_id: string;
  due: string | null;
  time: string | null;
  /** Minutes before the due moment. */
  alerts: number[];
  repeat: Repeat | null;
  /** 0 none · 1 low · 2 medium · 3 high */
  priority: number;
  tags: string[];
  steps: Step[];
  done: boolean;
  done_at: string | null;
  created_at: string | null;
  order: number;
}

export interface TaskList {
  id: string;
  name: string;
  color: string;
  emoji: string;
  order: number;
}

export interface Done {
  id: string;
  task_id: string;
  title: string;
  list_id: string;
  at: string;
  due: string | null;
}

export interface Settings {
  default_time: string;
  alert_timed: boolean;
  digest: boolean;
  digest_time: string;
  week_start: number;
  show_done: boolean;
  onboarded: boolean;
}

export interface TasksData {
  lists: TaskList[];
  tasks: Task[];
  log: Done[];
  settings: Settings;
}

export const INBOX = "inbox";
