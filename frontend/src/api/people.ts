import { apiClient } from "./client";
import type { PhotoItem } from "./photos";

/** People and pets in your photos (PH-3). */

export type SubjectKind = "person" | "pet";

export interface Subject {
  /** null for a review entry that's a species ("a dog in 214 photos"). */
  id: string | null;
  name: string | null;
  hidden: boolean;
  species: string | null;
  photos: number;
  /** This person is you. */
  me: boolean;
  /** A signed link to a square crop of their face (or the animal). */
  cover: string | null;
  /** Who they are to you ("my wife") — yours only. */
  relationship?: string | null;
  /** Memories of them are made (false: "don't show me memories of them"). */
  memories?: boolean;
  /** The contact they are (people only; yours only), or null. */
  contact?: ContactRef | null;
}

/** One contact in a Contacts item file. */
export interface ContactRef {
  file_id: string;
  contact_id: string;
}

/** A contact who's someone in your Photos: their face for the contact's
 *  picture, and the person page for "See all photos". */
export interface ContactPhotosLink {
  person_id: string;
  name: string | null;
  /** A signed link to a square crop of their face. */
  face: string | null;
}

export interface ReviewEntry extends Subject {
  kind: SubjectKind;
  samples: { id: string; crop: string | null }[];
  /** "Is this Sarah?" — they look like someone you've named, but not surely
   *  enough to be filed. Yes names the ticked samples; No says "not them". */
  suggest?: { id: string; name: string | null; cover: string | null };
}

/** A stable key for a review card (a group, a question about loose faces, or a species). */
export function reviewKey(r: ReviewEntry): string {
  return r.id ?? (r.suggest ? `suggest-${r.suggest.id}` : `species-${r.species}`);
}

export interface Observation {
  id: string;
  kind: SubjectKind;
  species: string | null;
  box: { x: number; y: number; w: number; h: number };
  crop: string | null;
  person: { id: string; name: string | null; hidden: boolean } | null;
  confirmed: boolean;
}

export const peopleApi = {
  async list(kind: SubjectKind, hidden = false): Promise<Subject[]> {
    const { data } = await apiClient.get<{ people: Subject[] }>("/photos/people", { params: { kind, hidden } });
    return data.people;
  },
  async review(): Promise<ReviewEntry[]> {
    const { data } = await apiClient.get<{ people: ReviewEntry[] }>("/photos/people/review");
    return data.people;
  },
  async get(id: string, before?: string | null): Promise<{ person: Subject; kind: SubjectKind; items: PhotoItem[]; next_cursor: string | null }> {
    const { data } = await apiClient.get(`/photos/people/${id}`, { params: { before: before || undefined } });
    return data;
  },
  async update(
    id: string,
    patch: { name?: string | null; hidden?: boolean; me?: boolean; cover_id?: string | null; memories?: boolean; contact?: ContactRef | null },
  ): Promise<Subject> {
    const { data } = await apiClient.patch<Subject>(`/photos/people/${id}`, patch);
    return data;
  },
  /** Link a person to a contact (null unlinks). One person per contact:
   *  linking takes the contact from whoever had it. */
  async setContact(id: string, contact: ContactRef | null): Promise<Subject> {
    const { data } = await apiClient.patch<Subject>(`/photos/people/${id}`, { contact });
    return data;
  },
  /** The contacts in this Contacts file who are someone in your Photos, by contact id. */
  async contactLinks(fileId: string): Promise<Record<string, ContactPhotosLink>> {
    const { data } = await apiClient.get<{ links: Record<string, ContactPhotosLink> }>("/photos/people/contacts", { params: { file_id: fileId } });
    return data.links ?? {};
  },
  async merge(id: string, into: string): Promise<void> {
    await apiClient.post(`/photos/people/${id}/merge`, { into });
  },
  async inPhoto(fileId: string): Promise<Observation[]> {
    const { data } = await apiClient.get<{ observations: Observation[] }>(`/photos/files/${fileId}/people`);
    return data.observations;
  },
  /** "This is …": an existing one, or a name (a new one, or yours of that name). */
  async name(observationId: string, who: { person_id?: string; name?: string }): Promise<string> {
    const { data } = await apiClient.post<{ person_id: string }>(`/photos/faces/${observationId}/person`, who);
    return data.person_id;
  },
  /** "These are all …" — several photos' faces or animals at once. */
  async nameMany(observationIds: string[], who: { person_id?: string; name?: string }): Promise<string> {
    const { data } = await apiClient.post<{ person_id: string }>("/photos/faces/assign", { observation_ids: observationIds, ...who });
    return data.person_id;
  },
  async setRelationship(id: string, label: string | null): Promise<void> {
    await apiClient.put(`/photos/people/${id}/relationship`, { label });
  },
  async faces(id: string, offset = 0): Promise<{ faces: { id: string; file_id: string; crop: string | null; confirmed: boolean }[]; more: boolean }> {
    const { data } = await apiClient.get(`/photos/people/${id}/faces`, { params: { offset } });
    return data;
  },
  /** Some of theirs are someone else: to another (``into``), or a new one. */
  async split(id: string, observationIds: string[], to: { into?: string; name?: string }): Promise<string> {
    const { data } = await apiClient.post<{ into: string }>(`/photos/people/${id}/split`, { observation_ids: observationIds, ...to });
    return data.into;
  },
  async notThem(observationId: string, personId: string): Promise<void> {
    await apiClient.post(`/photos/faces/${observationId}/not`, { person_id: personId });
  },
};
