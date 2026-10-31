/* The Journal file's shape (backend: app/items/kinds/journal/models.py). */

export interface Entry {
  id: string;
  /** The person's local day, YYYY-MM-DD. */
  date: string;
  /** HH:MM local. */
  time: string;
  created_at?: string | null;
  updated_at?: string | null;
  title: string;
  /** Markdown. */
  body: string;
  mood: number | null;
  emotions: string[];
  energy: number | null;
  tags: string[];
  gratitude: string[];
  location: string;
  weather: string;
  starred: boolean;
  template_id: string | null;
  prompt: string;
  ai_drafted: boolean;
  /** The assistant rewrote or added to the text (at the person's request). */
  ai_edited?: boolean;
  word_count: number;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  body: string;
  prompts: string[];
  gratitude_slots: number;
  target_words: number | null;
  default_tags: string[];
  builtin: boolean;
  hidden: boolean;
}

export interface Settings {
  onboarded: boolean;
  daily_reminder: boolean;
  reminder_time: string;
  weekly_reminder: boolean;
  weekly_day: number; // 0 = Monday … 6 = Sunday
  weekly_time: string;
  week_starts_on: 0 | 1;
  default_template_id: string | null;
  show_prompt: boolean;
  /** Normal chats / search / Drive AI see a short excerpt per recent entry
   *  (off by default — they otherwise see only the outline). */
  share_excerpts: boolean;
  hide_previews: boolean;
  custom_prompts: string[];
}

export interface JournalData {
  entries: Entry[];
  templates: Template[];
  settings: Settings;
}

/** Limits mirrored from the backend model. */
export const MAX_ENTRIES = 20_000;
export const MAX_BODY = 100_000;
export const MAX_BYTES = 8 * 1024 * 1024;
