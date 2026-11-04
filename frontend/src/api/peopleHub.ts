import { apiClient } from "./client";
import type { PhotoItem } from "./photos";
import type { RoomUser } from "./rooms";

/**
 * One person, everywhere: a Contacts entry, a Photos person and a Promptly
 * account, put together for you (``/api/people``). The person page and the
 * shared people picker both read from here.
 */

/** How to reach one person's page — any of the three works. */
export type PersonRef =
  | { kind: "u"; userId: string }
  | { kind: "c"; fileId: string; contactId: string }
  | { kind: "p"; personId: string };

export interface PersonLabeled {
  label: string;
  value: string;
}

export interface PersonContactCard {
  file_id: string;
  contact_id: string;
  name: string | null;
  nickname: string;
  company: string;
  title: string;
  phones: PersonLabeled[];
  emails: PersonLabeled[];
  addresses: { label: string; street: string; city: string; region: string; postcode: string; country: string }[];
  websites: PersonLabeled[];
  /** ``YYYY-MM-DD`` or ``--MM-DD``. */
  birthday: string | null;
  dates: { label: string; date: string; kind: "anniversary" | "other" }[];
  /** A small data URL, when the contact has its own picture. */
  photo: string | null;
  can_edit: boolean;
}

export interface PersonEvent {
  id: string;
  event_id: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string | null;
  color: string | null;
  my_status: string | null;
}

export interface PersonFile {
  id: string;
  type: "file" | "folder";
  name: string;
  mime: string | null;
  source_kind: string | null;
  /** "mine": you shared it with them; "theirs": they shared it with you. */
  direction: "mine" | "theirs";
}

export interface PersonPage {
  name: string;
  is_me: boolean;
  /** What they are to you ("Wife") — from Photos. */
  label: string | null;
  /** How their account was found from the contact. */
  match: "linked" | "email" | "name" | "me" | null;
  user: RoomUser | null;
  /** A signed link to their face in your Photos. */
  face: string | null;
  contact: PersonContactCard | null;
  photo_person_id: string | null;
  photos: { person_id: string; count: number; items: PhotoItem[] } | null;
  events: PersonEvent[];
  dm_room_id: string | null;
  /** Rooms you're both in — names only. */
  rooms: { room_id: string; name: string; space: string | null; kind: string }[];
  files: PersonFile[];
}

/** One row of the people picker. ``user`` null: not on Promptly (can't be picked). */
export interface PickerPerson {
  key: string;
  user: RoomUser | null;
  name: string;
  label: string | null;
  face: string | null;
  /** With ``details`` (item apps' person fields): the first phone / email /
   *  address on your own contact card ("" when it has none). */
  contact: { file_id: string; contact_id: string; phone?: string; email?: string; address?: string; company?: string } | null;
  photo_person_id: string | null;
}

function refPath(ref: PersonRef): string {
  if (ref.kind === "u") return `u/${ref.userId}`;
  if (ref.kind === "c") return `c/${ref.fileId}/${encodeURIComponent(ref.contactId)}`;
  return `p/${ref.personId}`;
}

/** The person page's address inside Promptly. */
export function personPath(ref: PersonRef): string {
  return `/people/${refPath(ref)}`;
}

export const personUserPath = (userId: string) => personPath({ kind: "u", userId });

export const peopleHubApi = {
  async get(ref: PersonRef): Promise<PersonPage> {
    return (await apiClient.get<PersonPage>(`/people/${refPath(ref)}`)).data;
  },
  async search(q: string, opts: { details?: boolean } = {}): Promise<PickerPerson[]> {
    const { data } = await apiClient.get<{ people: PickerPerson[] }>("/people/search", { params: { q, details: opts.details || undefined } });
    return data.people;
  },
};
