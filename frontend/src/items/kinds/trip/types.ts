/* The ``.trip`` file's shape — every trip of a person (mirrors backend app/items/kinds/trip/models.py).
 * Booking times are local wall times ``YYYY-MM-DDTHH:MM`` + the IANA zone of
 * that end; money is minor units of its own currency. */

export type TripStatus = "planning" | "booked" | "travelling" | "done";
export type BookingType = "flight" | "stay" | "car" | "train" | "bus" | "ferry" | "tour" | "ticket" | "insurance" | "other";
export type BookingStatus = "confirmed" | "pending" | "cancelled";
export type PlanType = "activity" | "food" | "transport" | "stay" | "flight" | "note";
export type PlanStatus = "idea" | "planned" | "booked" | "done";
export type Priority = "must" | "want" | "maybe";
export type Category = "flights" | "stays" | "transport" | "food" | "activities" | "shopping" | "insurance" | "fees" | "other";
export type SplitMode = "equal" | "exact" | "shares";
export type DocType = "passport" | "visa" | "eta" | "insurance" | "vaccination" | "driving_permit" | "id_card" | "other";
export type DocStatus = "todo" | "applied" | "done";

export interface Traveller {
  id: string;
  name: string;
  /** Legacy: the file's creator. "Me" is per viewer — see ``Trip.me_by_user``. */
  is_me: boolean;
  /** The Promptly account this traveller is, when known. */
  user_id: string;
  age_group: "adult" | "child" | "infant";
  passport_country: string;
}

export interface Destination {
  id: string;
  name: string;
  country: string;
  lat: number | null;
  lng: number | null;
  tz: string;
  start: string | null;
  end: string | null;
  notes: string;
}

export interface CurrencyRate {
  code: string;
  per_home: number;
  updated: string | null;
}

export interface Attachment {
  file_id: string;
  name: string;
}

export interface Booking {
  id: string;
  type: BookingType;
  title: string;
  status: BookingStatus;
  start: string | null;
  start_tz: string;
  end: string | null;
  end_tz: string;
  provider: string;
  number: string;
  from_code: string;
  to_code: string;
  from_place: string;
  to_place: string;
  terminal_from: string;
  terminal_to: string;
  seat: string;
  cabin: string;
  address: string;
  lat: number | null;
  lng: number | null;
  confirmation: string;
  cost_minor: number | null;
  currency: string | null;
  paid: boolean;
  traveller_ids: string[];
  attachments: Attachment[];
  link: string;
  phone: string;
  notes: string;
}

export interface PlanItem {
  id: string;
  time: string | null;
  duration_min: number | null;
  type: PlanType;
  title: string;
  place: string;
  address: string;
  area: string;
  lat: number | null;
  lng: number | null;
  cost_minor: number | null;
  currency: string | null;
  link: string;
  status: PlanStatus;
  notes: string;
  booking_id: string | null;
  travel_after: string;
}

export interface TripDay {
  date: string;
  title: string;
  notes: string;
  tz: string;
  items: PlanItem[];
}

export interface Idea {
  id: string;
  title: string;
  type: PlanType;
  place: string;
  address: string;
  area: string;
  lat: number | null;
  lng: number | null;
  tags: string[];
  priority: Priority;
  duration_min: number | null;
  cost_minor: number | null;
  currency: string | null;
  hours: string;
  book_ahead: boolean;
  link: string;
  notes: string;
}

export interface PackingItem {
  id: string;
  name: string;
  category: string;
  traveller_id: string | null;
  qty: number;
  checked: boolean;
  essential: boolean;
  notes: string;
}

export interface Share {
  traveller_id: string;
  amount_minor: number | null;
  weight: number | null;
}

export interface Expense {
  id: string;
  date: string;
  title: string;
  amount_minor: number;
  currency: string;
  category: Category;
  paid_by: string | null;
  split: SplitMode;
  shares: Share[];
  per_home: number | null;
  booking_id: string | null;
  notes: string;
}

export interface Settlement {
  id: string;
  date: string;
  from_id: string;
  to_id: string;
  amount_minor: number;
  note: string;
}

export interface TravelDocument {
  id: string;
  type: DocType;
  traveller_id: string | null;
  title: string;
  country: string;
  reference: string;
  issued: string | null;
  expires: string | null;
  status: DocStatus;
  remind_on: string | null;
  attachments: Attachment[];
  link: string;
  notes: string;
}

export interface TripSettings {
  /** Per trip in the view (the trip's own); in the file, the default for new trips. */
  home_currency: string;
  passport_months: number;
  onboarded: boolean;
  clock: "auto" | "24h" | "12h";
  distance: "km" | "mi";
}

/** One trip as the tabs see it: the trip's own fields plus ``settings`` (the
 *  file's preferences with this trip's home currency) — see ``trips.ts``. */
export interface Trip {
  id: string;
  home_currency: string;
  title: string;
  emoji: string;
  color: string;
  start: string | null;
  end: string | null;
  status: TripStatus;
  notes: string;
  destinations: Destination[];
  travellers: Traveller[];
  currencies: CurrencyRate[];
  budget: { total_minor: number | null; lines: { category: Category; amount_minor: number }[] };
  bookings: Booking[];
  days: TripDay[];
  ideas: Idea[];
  packing: PackingItem[];
  expenses: Expense[];
  settlements: Settlement[];
  documents: TravelDocument[];
  /** "This is me": Promptly user id → traveller id (each viewer has their own). */
  me_by_user: Record<string, string>;
  settings: TripSettings;
}

/** A trip as stored in the file (no ``settings``). */
export type TripRecord = Omit<Trip, "settings">;

/** The whole ``.trip`` file: all of a person's trips + their preferences. */
export interface TripFile {
  trips: TripRecord[];
  settings: TripSettings;
}

export const CATEGORIES: Category[] = ["flights", "stays", "transport", "food", "activities", "shopping", "insurance", "fees", "other"];
export const CATEGORY_LABEL: Record<Category, string> = {
  flights: "Flights",
  stays: "Stays",
  transport: "Transport",
  food: "Food & drink",
  activities: "Activities",
  shopping: "Shopping",
  insurance: "Insurance",
  fees: "Visas & fees",
  other: "Other",
};
export const BOOKING_TYPES: BookingType[] = ["flight", "stay", "car", "train", "bus", "ferry", "tour", "ticket", "insurance", "other"];
export const BOOKING_LABEL: Record<BookingType, string> = {
  flight: "Flight",
  stay: "Stay",
  car: "Car hire",
  train: "Train",
  bus: "Bus",
  ferry: "Ferry",
  tour: "Tour",
  ticket: "Ticket",
  insurance: "Insurance",
  other: "Other",
};
export const PLAN_TYPES: PlanType[] = ["activity", "food", "transport", "stay", "flight", "note"];
export const PLAN_LABEL: Record<PlanType, string> = {
  activity: "Activity",
  food: "Food",
  transport: "Transport",
  stay: "Stay",
  flight: "Flight",
  note: "Note",
};
export const DOC_LABEL: Record<DocType, string> = {
  passport: "Passport",
  visa: "Visa",
  eta: "ETA / e-visa",
  insurance: "Travel insurance",
  vaccination: "Vaccination",
  driving_permit: "Driving permit",
  id_card: "ID card",
  other: "Other",
};
export const BOOKING_CATEGORY: Record<BookingType, Category> = {
  flight: "flights",
  stay: "stays",
  car: "transport",
  train: "transport",
  bus: "transport",
  ferry: "transport",
  tour: "activities",
  ticket: "activities",
  insurance: "insurance",
  other: "other",
};
