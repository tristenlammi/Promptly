/* The shape of a Game Night file (backend: app/items/kinds/boardgames/models.py). */

export type WinCondition = "high" | "low" | "winlose" | "coop" | "teams" | "ranked";
export type PadKind = "categories" | "rounds" | "total";

export interface Settings {
  me_player_id: string | null;
  default_location: string;
  elo_k: number;
  confetti: boolean;
  keep_screen_on: boolean;
  onboarded: boolean;
  min_plays_for_best: number;
}

export interface Player {
  id: string;
  name: string;
  color: string;
  favorite: boolean;
  archived: boolean;
  me: boolean;
  bgg_user: string;
  notes: string;
  created: string;
}

export interface ScoreCategory {
  id: string;
  name: string;
  hint: string;
  section: string;
  multiplier: number;
  subtract: boolean;
  step: number;
  options: number[];
  min: number | null;
  max: number | null;
  /** Counts only once this other category (id) scored — Yahtzee bonus. */
  requires?: string | null;
}

export interface BonusRule {
  id: string;
  name: string;
  categories: string[];
  threshold: number;
  points: number;
}

export interface Scoring {
  win: WinCondition;
  pad: PadKind;
  categories: ScoreCategory[];
  bonuses: BonusRule[];
  rounds: number | null;
  target_score: number | null;
  tiebreaker: string;
  notes: string;
  factions: string[];
}

export interface Expansion {
  id: string;
  name: string;
  categories: ScoreCategory[];
  factions: string[];
}

export interface Game {
  id: string;
  name: string;
  year: number | null;
  min_players: number;
  max_players: number;
  play_minutes: number | null;
  weight: number | null;
  categories: string[];
  bgg_id: number | null;
  template_id: string | null;
  scoring: Scoring;
  expansions: Expansion[];
  favorite: boolean;
  owned: boolean;
  notes: string;
  created: string;
}

export interface Entry {
  scores: Record<string, number>;
  rounds: (number | null)[];
  total: number | null;
  tiebreak: number | null;
  score: number | null;
  place: number | null;
  winner: boolean;
}

export interface Team extends Entry {
  id: string;
  name: string;
  color: string;
}

export interface Seat extends Entry {
  player_id: string;
  team_id: string | null;
  faction: string;
  first_play: boolean;
  note: string;
}

export interface Play {
  id: string;
  game_id: string;
  status: "active" | "finished";
  date: string;
  started_at: string | null;
  ended_at: string | null;
  duration_min: number | null;
  location: string;
  notes: string;
  seats: Seat[];
  teams: Team[];
  expansions: string[];
  coop_won: boolean | null;
  manual: boolean;
  round: number;
  focus: number;
  timer_started_at: string | null;
  timer_elapsed_s: number;
  tiebreak_note: string;
  created_at: string;
}

export interface Data {
  settings: Settings;
  players: Player[];
  games: Game[];
  plays: Play[];
}

export const WIN_LABELS: Record<WinCondition, string> = {
  high: "Highest score wins",
  low: "Lowest score wins",
  winlose: "Win / lose",
  coop: "Co-operative",
  teams: "Teams",
  ranked: "Finishing order",
};

export const PAD_LABELS: Record<PadKind, string> = {
  categories: "Score categories",
  rounds: "Round by round",
  total: "One total each",
};

export const PALETTE = ["#C2557A", "#3B7DD8", "#4E9F5B", "#D9902F", "#7B6CD9", "#2C9CC8", "#E2725B", "#8A6F5A", "#2F8F83", "#B5835A", "#D9506A", "#5B6DD9"];
export const TEAM_COLORS = ["#D9506A", "#3B7DD8", "#4E9F5B", "#D9902F", "#7B6CD9", "#2C9CC8"];

export function emptyEntry(): Entry {
  return { scores: {}, rounds: [], total: null, tiebreak: null, score: null, place: null, winner: false };
}

export function newSeat(player_id: string, team_id: string | null = null): Seat {
  return { ...emptyEntry(), player_id, team_id, faction: "", first_play: false, note: "" };
}

export function newCategory(id: string, name: string): ScoreCategory {
  return { id, name, hint: "", section: "", multiplier: 1, subtract: false, step: 1, options: [], min: null, max: null, requires: null };
}

export function newGame(id: string, name: string, today: string): Game {
  return {
    id,
    name,
    year: null,
    min_players: 2,
    max_players: 6,
    play_minutes: null,
    weight: null,
    categories: [],
    bgg_id: null,
    template_id: null,
    scoring: { win: "high", pad: "total", categories: [], bonuses: [], rounds: null, target_score: null, tiebreaker: "", notes: "", factions: [] },
    expansions: [],
    favorite: false,
    owned: true,
    notes: "",
    created: today,
  };
}
