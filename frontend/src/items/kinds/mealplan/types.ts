/* The Meal Planner file (mirrors backend/app/items/kinds/mealplan/models.py). */

export type Slot = "breakfast" | "lunch" | "dinner" | "snack";
export const SLOTS: Slot[] = ["breakfast", "lunch", "dinner", "snack"];
export const SLOT_LABEL: Record<Slot, string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack" };

export interface Preferences {
  household_size: number;
  diets: string[];
  allergies: string[];
  dislikes: string[];
  cuisines: string[];
  weeknight_minutes: number | null;
  weekend_minutes: number | null;
  budget: "low" | "medium" | "high";
  skill: "beginner" | "intermediate" | "advanced";
  equipment: string[];
  week_start: number;
  slots: Slot[];
  units: "metric" | "imperial";
  calories_per_day: number | null;
  protein_g_per_day: number | null;
  prep_reminders: boolean;
  prep_reminder_time: string;
  shopping_reminder: boolean;
  shopping_day: number;
  shopping_time: string;
  aisle_order: string[];
  keep_awake: boolean;
  onboarded: boolean;
}

export interface Ingredient {
  id: string;
  qty: number | null;
  qty_max: number | null;
  unit: string;
  item: string;
  note: string;
  optional: boolean;
  group: string;
  aisle: string;
}

export interface Nutrition {
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  sugar_g: number | null;
  saturated_fat_g: number | null;
  sodium_mg: number | null;
}

export interface Recipe {
  id: string;
  title: string;
  servings: number;
  ingredients: Ingredient[];
  steps: string[];
  prep_min: number | null;
  cook_min: number | null;
  total_min: number | null;
  tags: string[];
  cuisine: string;
  source_url: string;
  image_url: string;
  notes: string;
  prep_ahead: string;
  rating: number;
  favorite: boolean;
  times_cooked: number;
  last_cooked: string | null;
  nutrition: Nutrition | null;
  added: string | null;
}

export interface PlanEntry {
  id: string;
  date: string;
  slot: Slot;
  recipe_id: string | null;
  title: string;
  servings: number | null;
  leftovers_of: string | null;
  note: string;
  cooked: boolean;
}

export interface Amount {
  qty: number | null;
  unit: string;
}

export interface GroceryItem {
  id: string;
  name: string;
  key: string;
  amounts: Amount[];
  aisle: string;
  checked: boolean;
  source: "plan" | "manual";
  recipes: string[];
  note: string;
  /** The person renamed it / changed its amount — "Update from plan" keeps theirs. */
  renamed?: boolean;
  qty_edited?: boolean;
}

export interface PantryItem {
  id: string;
  name: string;
  qty: number | null;
  unit: string;
  staple: boolean;
}

export interface MealPlanData {
  preferences: Preferences;
  recipes: Recipe[];
  plan: PlanEntry[];
  grocery: {
    items: GroceryItem[];
    start: string | null;
    end: string | null;
    generated_at: string | null;
    covered: string[];
    /** Keys of plan items deleted from this range's list (kept off on update). */
    removed?: string[];
  };
  pantry: PantryItem[];
  aisle_overrides: { key: string; aisle: string }[];
}

/** A recipe draft from the importer (no id yet). */
export type RecipeDraft = Omit<Recipe, "id" | "rating" | "favorite" | "times_cooked" | "last_cooked" | "added" | "prep_ahead" | "ingredients"> & {
  ingredients: Omit<Ingredient, "id">[];
  prep_ahead?: string;
};

export const AISLES: Record<string, string> = {
  produce: "Produce",
  bakery: "Bakery",
  meat: "Meat & poultry",
  seafood: "Fish & seafood",
  dairy: "Dairy & eggs",
  deli: "Deli",
  frozen: "Frozen",
  pantry: "Pantry & grains",
  canned: "Canned & jarred",
  baking: "Baking",
  spices: "Spices & seasonings",
  condiments: "Sauces & condiments",
  international: "International",
  snacks: "Snacks",
  drinks: "Drinks",
  household: "Household",
  other: "Other",
};

export const DIETS = ["vegetarian", "vegan", "pescatarian", "keto", "low carb", "gluten-free", "dairy-free", "halal", "kosher", "nut-free"];
export const ALLERGIES = ["peanut", "tree nut", "dairy", "egg", "gluten", "soy", "fish", "shellfish", "sesame", "mustard", "celery"];
export const EQUIPMENT = ["oven", "stovetop", "microwave", "air fryer", "slow cooker", "pressure cooker", "grill", "blender", "food processor", "stand mixer", "rice cooker", "sous vide"];
export const CUISINES = ["Italian", "Mexican", "Indian", "Chinese", "Japanese", "Thai", "Korean", "Vietnamese", "Mediterranean", "Greek", "Middle Eastern", "French", "American", "Spanish"];
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
