/* Contacts — the file's shape (mirrors backend/app/items/kinds/contacts/models.py). */

export interface Labeled {
  label: string;
  value: string;
}

export interface Address {
  label: string;
  street: string;
  city: string;
  region: string;
  postcode: string;
  country: string;
}

export interface ImportantDate {
  id: string;
  label: string;
  /** ``YYYY-MM-DD`` or ``--MM-DD`` (no year). */
  date: string;
  kind: "anniversary" | "other";
  remind: boolean;
}

export const REL_TYPES = [
  "partner",
  "spouse",
  "child",
  "parent",
  "sibling",
  "friend",
  "colleague",
  "manager",
  "report",
  "relative",
  "other",
] as const;
export type RelType = (typeof REL_TYPES)[number];

export const RECIPROCAL: Record<RelType, RelType> = {
  partner: "partner",
  spouse: "spouse",
  child: "parent",
  parent: "child",
  sibling: "sibling",
  friend: "friend",
  colleague: "colleague",
  manager: "report",
  report: "manager",
  relative: "relative",
  other: "other",
};

export interface Relationship {
  id: string;
  type: RelType;
  contact_id: string | null;
  name: string;
  label: string;
}

export const INTERACTION_TYPES = ["call", "message", "meeting", "email", "other"] as const;
export type InteractionType = (typeof INTERACTION_TYPES)[number];

export interface Interaction {
  id: string;
  date: string;
  type: InteractionType;
  notes: string;
}

export interface Note {
  id: string;
  text: string;
  done: boolean;
  added: string | null;
}

export interface Contact {
  id: string;
  prefix: string;
  first: string;
  middle: string;
  last: string;
  suffix: string;
  nickname: string;
  pronouns: string;
  phonetic_first: string;
  /** Their account on this Promptly, chosen by you. */
  promptly_user_id: string;
  promptly_username: string;
  phonetic_last: string;
  company: string;
  title: string;
  department: string;
  phones: Labeled[];
  emails: Labeled[];
  addresses: Address[];
  websites: Labeled[];
  /** A small JPEG/PNG/WebP data URL (≤ ~60 KB; the app downscales to 256 px). */
  photo: string | null;
  /** The vCard UID it came with — re-imports match on it. */
  uid: string;
  /** "<import id>:<row>" for people an import added (retries skip them). */
  import_ref: string;
  birthday: string | null;
  dates: ImportantDate[];
  met_how: string;
  met_where: string;
  met_date: string | null;
  relationships: Relationship[];
  tags: string[];
  groups: string[];
  notes: string;
  favorite: boolean;
  color: string | null;
  created_at: string;
  updated_at: string;
  interactions: Interaction[];
  cadence_days: number | null;
  snoozed_until: string | null;
  gifts: Note[];
  remember: Note[];
  topics: Note[];
}

export interface Group {
  id: string;
  name: string;
  color: string | null;
  description: string;
}

export interface Settings {
  reminder_time: string;
  birthday_reminders: boolean;
  birthday_days_before: number;
  date_reminders: boolean;
  reconnect_digest: boolean;
  digest_weekday: number;
  name_order: "first_last" | "last_first";
  sort_by: "first" | "last";
  default_cadence_days: number | null;
  /** Two-letter country national phone numbers are read in; "" = from location / time zone. */
  phone_country: string;
  not_duplicates: string[];
}

export interface ContactsData {
  contacts: Contact[];
  groups: Group[];
  settings: Settings;
}

/** A contact as an importer produces it (no id / CRM state yet). */
export type ContactDraft = Partial<Omit<Contact, "id">> & { groupNames?: string[] };
