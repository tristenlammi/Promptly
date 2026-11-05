/* The file's shape — mirrors backend/app/items/kinds/health/models.py. */

export type Sex = "female" | "male" | "intersex" | "unspecified";
export type BloodType = "" | "A+" | "A-" | "B+" | "B-" | "AB+" | "AB-" | "O+" | "O-" | "unknown";

export interface CareProvider {
  id: string;
  name: string;
  role: string;
  clinic: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
}

export interface Profile {
  height_cm: number | null;
  birth_date: string | null;
  sex: Sex;
  blood_type: BloodType;
  conditions: string[];
  allergies: string[];
  emergency_contact: string;
  emergency_notes: string;
  care_team: CareProvider[];
}

export interface Settings {
  weight_unit: "kg" | "lb";
  length_unit: "cm" | "in";
  glucose_unit: "mmol" | "mgdl";
  temp_unit: "c" | "f";
  water_unit: "ml" | "oz";
  cycle_tracking: boolean;
  med_reminders: boolean;
  refill_reminders: boolean;
  refill_days: number;
  appointment_reminders: boolean;
  weigh_in_time: string | null;
  discreet_reminders: boolean;
  smoothing: number;
  today_tiles: string[];
  onboarded: boolean;
}

export interface CustomMetric {
  id: string;
  name: string;
  unit: string;
  aggregate: "sum" | "avg" | "last" | "max" | "min";
  decimals: number;
  higher_is_better: boolean | null;
}

export interface Goal {
  metric: string;
  target: number | null;
  low: number | null;
  high: number | null;
  direction: "down" | "up" | "range" | "daily";
  target_date: string | null;
  start_value: number | null;
  start_day: string | null;
}

export type GlucoseContext = "fasting" | "pre_meal" | "post_meal" | "bedtime" | "random";

export interface Reading {
  id: string;
  metric: string;
  at: string;
  value: number | null;
  sys: number | null;
  dia: number | null;
  pulse: number | null;
  arm: "left" | "right" | null;
  position: "sitting" | "standing" | "lying" | null;
  context: GlucoseContext | null;
  bed: string | null;
  quality: number | null;
  note: string;
}

export interface Symptom {
  id: string;
  at: string;
  name: string;
  severity: number;
  tags: string[];
  note: string;
}

export type Flow = "spotting" | "light" | "medium" | "heavy";
export interface PeriodDay {
  day: string;
  flow: Flow;
}

export interface SlotDose {
  dose: string;
  per_dose: number | null;
}

export interface Schedule {
  type: "daily" | "days" | "interval" | "as_needed";
  times: string[];
  weekdays: number[];
  every_days: number;
  /** First due day of an "interval" schedule. */
  anchor?: string | null;
  /** A different amount at some times, keyed by HH:MM. */
  slot_doses?: Record<string, SlotDose>;
}

/** An earlier plan: it applied on days up to and including ``until``. */
export interface PlanStep {
  until: string;
  schedule: Schedule;
  dose: string;
  per_dose: number;
  stopped: boolean;
}

export type MedForm =
  | "tablet"
  | "capsule"
  | "liquid"
  | "injection"
  | "inhaler"
  | "drops"
  | "patch"
  | "cream"
  | "powder"
  | "spray"
  | "other";

export interface Medication {
  id: string;
  name: string;
  kind: "medication" | "supplement";
  dose: string;
  form: MedForm;
  per_dose: number;
  schedule: Schedule;
  with_food: "any" | "with" | "before" | "after" | "empty";
  start: string | null;
  end: string | null;
  remaining: number | null;
  purpose: string;
  prescriber: string;
  instructions: string;
  active: boolean;
  stopped_at?: string | null;
  color: string;
  max_per_day?: number | null;
  min_hours_between?: number | null;
  schedule_history?: PlanStep[];
}

export interface Dose {
  id: string;
  med_id: string;
  day: string;
  slot: string | null;
  status: "taken" | "late" | "skipped";
  at: string | null;
  note: string;
}

export interface Appointment {
  id: string;
  at: string;
  title: string;
  who: string;
  provider_id: string | null;
  location: string;
  questions: string[];
  notes: string;
  done: boolean;
}

export interface LabResult {
  id: string;
  day: string;
  test: string;
  value: number | null;
  value_text: string;
  unit: string;
  ref_low: number | null;
  ref_high: number | null;
  flag: "" | "normal" | "low" | "high" | "critical" | "abnormal";
  panel: string;
  note: string;
  /** When it was collected, HH:MM, if known. */
  time?: string;
  /** The report it came from. */
  source?: string;
}

export interface Vaccination {
  id: string;
  day: string;
  name: string;
  dose_label: string;
  next_due: string | null;
  provider: string;
  lot: string;
  note: string;
}

export interface HealthData {
  profile: Profile;
  settings: Settings;
  custom_metrics: CustomMetric[];
  goals: Goal[];
  readings: Reading[];
  symptoms: Symptom[];
  periods: PeriodDay[];
  medications: Medication[];
  doses: Dose[];
  appointments: Appointment[];
  labs: LabResult[];
  vaccinations: Vaccination[];
}

/** Hard ceilings, mirroring models.py. Nothing is trimmed at a cap — the UI
 *  warns and points to "Archive older data" instead. */
export const CAPS = { readings: 40_000, doses: 40_000, symptoms: 10_000, periods: 3_000 } as const;
