/* The shape of a .cards file — mirrors backend/.../flashcards/models.py. */

export type CardType = "basic" | "reversed" | "cloze" | "typein";
export type SrsState = "new" | "learning" | "review" | "relearning";

export interface Srs {
  k: string;
  state: SrsState;
  stability: number | null;
  difficulty: number | null;
  due: string | null;
  last_review: string | null;
  reps: number;
  lapses: number;
  step: number | null;
}

export interface Card {
  id: string;
  deck_id: string;
  type: CardType;
  front: string;
  back: string;
  note: string;
  tags: string[];
  flagged: boolean;
  suspended: boolean;
  buried_until: string | null;
  created: string;
  modified: string;
  srs: Srs[];
}

export interface Deck {
  id: string;
  name: string;
  parent_id: string | null;
  description: string;
  color: string;
  created: string;
  /** Own daily limits (Anki-style; cover subdecks). null = file-wide only. */
  new_per_day?: number | null;
  max_reviews_per_day?: number | null;
}

export interface Log {
  c: string;
  k: string;
  t: string;
  r: 1 | 2 | 3 | 4;
  s: "n" | "l" | "r" | "x";
  e: number;
  i: number;
  d: number;
}

export interface Settings {
  desired_retention: number;
  new_per_day: number;
  max_reviews_per_day: number;
  learning_steps: number[];
  relearning_steps: number[];
  maximum_interval: number;
  fuzz: boolean;
  rollover_hour: number;
  new_mix: "mixed" | "before" | "after";
  bury_siblings: boolean;
  leech_threshold: number;
  leech_action: "tag" | "suspend";
  weights: number[];
  show_intervals: boolean;
  reminder_enabled: boolean;
  reminder_time: string;
  streak_nudge: boolean;
  streak_nudge_time: string;
  exam_date: string | null;
  onboarded: boolean;
}

export interface Data {
  settings: Settings;
  decks: Deck[];
  cards: Card[];
  review_log: Log[];
  /** Oldest review-log entries dropped at the cap (archive instead). */
  log_trimmed?: number;
}

/** Review-log entries a file holds (models.py MAX_LOG). Past ~80% the Stats
 *  tab suggests archiving older history; the server drops the oldest only
 *  as a last resort and counts them in ``log_trimmed``. */
export const MAX_LOG = 100_000;
