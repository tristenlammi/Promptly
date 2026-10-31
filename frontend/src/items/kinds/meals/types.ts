/* The shape of a ``.meals`` file (mirrors backend/app/items/kinds/meals/models.py).
 * Canonical units: kcal, grams, sodium/minerals in mg, water in ml, kg, cm.
 *
 * The stored JSON leaves empty / default fields out of diary entries and
 * nutrients (no brand, no note, not an estimate, zero sugar…) to keep years
 * of logging small. These types are the FULL shape: views read the file
 * through ``meals(item.data)`` (lib.ts), which fills the defaults back in.
 * Mutator drafts are the raw stored shape — only assign fields there. */

export interface Nutrients {
  kcal: number;
  protein: number;
  carbs: number;
  sugar: number;
  fibre: number;
  fat: number;
  sat_fat: number;
  sodium: number; // mg
  micros: Record<string, number>;
}

export interface Serving {
  id: string;
  label: string;
  grams: number;
}

export interface Food {
  id: string;
  name: string;
  brand: string;
  barcode: string | null;
  servings: Serving[];
  default_serving: string | null;
  per100: Nutrients;
  liquid: boolean;
  /** g per ml, for cup / spoon measures (oils, honey, milk…). */
  density?: number | null;
  source: "custom" | "off" | "ai" | "recipe" | "copy" | "builtin";
  notes?: string;
  created?: string | null;
  category?: string; // built-ins
}

export type Unit = "g" | "ml" | "oz" | "serving" | "kcal" | "cup" | "tbsp" | "tsp" | "floz";

export interface Portion {
  name: string;
  brand: string;
  food_ref: string | null;
  amount: number;
  unit: Unit;
  serving_id: string | null;
  serving_label: string;
  grams: number | null;
  n: Nutrients;
  estimate: boolean;
}

export type EntrySource = "food" | "quick" | "ai" | "meal" | "mealplan" | "copy" | "barcode" | "online";

export interface Entry extends Portion {
  id: string;
  slot: string;
  source: EntrySource;
  time: string | null;
  note: string;
}

export interface Day {
  entries: Entry[];
  water_ml: number;
  note: string;
  complete: boolean;
}

export interface SavedMeal {
  id: string;
  name: string;
  slot: string | null;
  items: Portion[];
  created: string | null;
}

export interface WeighIn {
  date: string;
  kg: number;
}

export interface MealSlot {
  /** Stable: renaming changes ``name`` only. */
  id: string;
  name: string;
  remind_at: string | null;
  /** A removed meal that still has history (shown only on days that use it). */
  hidden?: boolean;
}

export type Activity = "sedentary" | "light" | "moderate" | "active" | "very_active";
export type Goal = "lose" | "maintain" | "gain";
export type DietStyle = "balanced" | "high_protein" | "low_carb" | "keto" | "low_fat";

export interface Profile {
  onboarded: boolean;
  sex: "male" | "female" | null;
  birth_year: number | null;
  height_cm: number | null;
  weight_kg: number | null;
  activity: Activity;
  goal: Goal;
  rate_pct: number;
  goal_weight_kg: number | null;
  diet_style: DietStyle;
  protein_per_kg: number | null;
  diet_tags: string[];
  allergies: string;
  dislikes: string;
}

export interface DayTarget {
  kcal?: number | null;
  protein?: number | null;
  carbs?: number | null;
  fat?: number | null;
}

export interface Targets {
  mode: "auto" | "custom";
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fibre: number;
  sodium: number;
  sugar: number | null;
  water_ml: number;
  weekday: Partial<Record<Weekday, DayTarget>>;
  basis: Record<string, number | string | null>;
  updated: string | null;
}

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface Settings {
  energy_unit: "kcal" | "kJ";
  weight_unit: "kg" | "lb";
  water_unit: "ml" | "floz";
  meal_slots: MealSlot[];
  reminders: boolean;
  close_day_at: string | null;
  water_step_ml: number;
  show_micros: boolean;
}

export interface MealsData {
  profile: Profile;
  targets: Targets;
  settings: Settings;
  days: Record<string, Day>;
  foods: Food[];
  favourites: string[];
  meals: SavedMeal[];
  weighins: WeighIn[];
}

/** A food found online (Open Food Facts) — no id until it's saved. */
export type FoundFood = Omit<Food, "id">;

export interface TdeeEstimate {
  window_days: number;
  from: string;
  to: string;
  logged_days: number;
  partial_days_skipped: number;
  typical_day_kcal?: number | null;
  weight_method?: "trend" | "robust" | null;
  weigh_ins: number;
  avg_intake_kcal: number | null;
  weight_change_kg_per_week: number | null;
  formula_tdee: number | null;
  latest_weight_kg: number | null;
  adaptive_tdee: number | null;
  tdee: number | null;
  confidence: "none" | "low" | "medium" | "high";
  source: "formula" | "adaptive" | "blended" | null;
  needs: string[];
}

export interface TrendsResponse {
  weights: WeighIn[];
  trend: WeighIn[];
  health_item: string | null;
  tdee: TdeeEstimate;
}
