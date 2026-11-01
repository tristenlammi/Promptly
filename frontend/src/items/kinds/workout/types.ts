/* The shape of a .workout file (backend: app/items/kinds/workout/models.py).
 * Loads are kg; settings.units is how they're shown. */

export type Unit = "kg" | "lb";
export type Goal = "strength" | "hypertrophy" | "fat_loss" | "general" | "endurance" | "powerlifting";
export type Experience = "beginner" | "intermediate" | "advanced";
export type LogType = "weight_reps" | "bodyweight_reps" | "assisted" | "duration" | "distance";
export type SetType = "warmup" | "working" | "drop" | "failure";
export type Equip =
  | "full_gym" | "barbell" | "rack" | "bench" | "dumbbell" | "kettlebell" | "cable" | "machine" | "smith" | "ez_bar"
  | "trap_bar" | "pullup_bar" | "dip_station" | "band" | "rings" | "cardio" | "sled" | "bodyweight";

export interface Plate {
  kg: number;
  pairs: number;
}

/** A best the person stated for a lift not logged yet ("bench 90 × 5"):
 *  loads calibrate from it until the lift has logged sessions. */
export interface Baseline {
  exercise_id: string;
  kg: number;
  reps: number;
  date?: string | null;
}

export interface Settings {
  units: Unit;
  bodyweight_kg: number | null;
  sex: "" | "male" | "female";
  birth_year: number | null;
  experience: Experience;
  goal: Goal;
  days_per_week: number;
  session_minutes: number;
  training_days: number[];
  /** What each training day is for: weekday ("0" = Monday) → "Upper", "Legs", … */
  day_focus?: Record<string, string>;
  equipment: Equip[];
  dumbbells_kg: number[];
  dumbbell_step_kg: number;
  dumbbell_max_kg: number | null;
  kettlebells_kg: number[];
  machine_step_kg: number;
  bar_kg: number;
  ez_bar_kg: number;
  trap_bar_kg: number;
  plates: Plate[];
  injuries: string;
  /** Stated bests (calibration only — the log wins once a lift is logged). */
  baselines?: Baseline[];
  avoid_exercises: string[];
  rest_compound_s: number;
  rest_isolation_s: number;
  /** Legacy (RIR/RPE display) — dropped by the server on save; never read. */
  effort?: "rir" | "rpe";
  e1rm_formula: "epley" | "brzycki";
  week_start: "mon" | "sun";
  reminders: boolean;
  reminder_time: string;
  remind_before_min: number;
  /** Count down rest after each ticked set (off → no timer, no alerts). */
  rest_timer?: boolean;
  /** How much the logger's − / + change the weight (stored in kg). */
  weight_step_kg?: number;
  vibrate: boolean;
  sound: boolean;
  warmups: boolean;
  onboarded: boolean;
}

export interface CustomExercise {
  id: string;
  name: string;
  primary: string[];
  secondary: string[];
  equipment: Equip;
  pattern: string;
  log: LogType;
  compound: boolean;
  notes: string;
  archived: boolean;
}

export interface Prescription {
  id: string;
  exercise_id: string;
  sets: number;
  reps_min: number;
  reps_max: number;
  seconds?: number | null;
  meters?: number | null;
  /** Legacy: read, ignored, never written (no RIR targets). */
  target_rir?: number | null;
  load_kg?: number | null;
  load_pct?: number | null;
  rest_s?: number | null;
  superset?: string | null;
  warmup?: boolean | null;
  drop_sets?: number;
  notes?: string;
}

/* Sessions, logged exercises and workouts are stored without the fields
 * that hold their default (models.py ``Compact``) — those are optional
 * here and read with a fallback. */
export interface PlannedSession {
  id: string;
  date: string;
  time?: string | null;
  name: string;
  notes?: string;
  exercises: Prescription[];
  program_id?: string | null;
  week?: number | null;
  deload?: boolean;
  status: "planned" | "done" | "skipped";
  workout_id?: string | null;
}

export interface Routine {
  id: string;
  name: string;
  notes: string;
  exercises: Prescription[];
}

export interface ProgramWeek {
  n: number;
  label: string;
  deload: boolean;
  notes: string;
}

export interface Program {
  id: string;
  name: string;
  goal: Goal | "";
  start_date: string;
  weeks: ProgramWeek[];
  notes: string;
  status: "active" | "done" | "archived";
}

/** Sets are stored without empty fields — read with defaults. */
export interface SetLog {
  id: string;
  type?: SetType;
  kg?: number | null;
  /** Live workout only: the load the logger suggests — shown in the empty
   *  weight box; ticking the set without typing one adopts it. */
  suggest_kg?: number | null;
  reps?: number | null;
  seconds?: number | null;
  meters?: number | null;
  /** Legacy: read, ignored, never written. */
  rir?: number | null;
  done?: boolean;
  at?: string | null;
}

export interface WorkoutExercise {
  id: string;
  exercise_id: string;
  sets: SetLog[];
  notes?: string;
  superset?: string | null;
  rest_s?: number | null;
  rx?: Prescription | null;
}

export interface Workout {
  id: string;
  name: string;
  date: string;
  started_at?: string | null;
  ended_at?: string | null;
  duration_s?: number | null;
  exercises: WorkoutExercise[];
  notes?: string;
  session_id?: string | null;
  program_id?: string | null;
  bodyweight_kg?: number | null;
  /** Legacy session RPE: read, ignored, never written. */
  effort?: number | null;
  /** A deload session — progression keys off the last non-deload one. */
  deload?: boolean;
  rest_until?: string | null;
  rest_total_s?: number | null;
}

export interface WorkoutData {
  settings: Settings;
  exercises: CustomExercise[];
  routines: Routine[];
  programs: Program[];
  planned: PlannedSession[];
  workouts: Workout[];
  active: Workout | null;
}

/** A library exercise (built-in from the catalog endpoint, or custom). */
export interface Exercise {
  id: string;
  name: string;
  equipment: string;
  needs: string[][];
  pattern: string;
  log: LogType;
  primary: string[];
  secondary: string[];
  compound: boolean;
  start: number | null;
  aliases: string[];
  custom: boolean;
  archived?: boolean;
  notes?: string;
}

export interface MuscleInfo {
  label: string;
  mv: number;
  mev: number;
  mav: [number, number];
  mrv: number;
  group: string;
}

export interface Catalog {
  exercises: Exercise[];
  muscles: Record<string, MuscleInfo>;
  equipment: Record<string, string>;
  patterns: Record<string, string>;
}
