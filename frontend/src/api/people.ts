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
}

export interface ReviewEntry extends Subject {
  kind: SubjectKind;
  samples: { id: string; crop: string | null }[];
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
  async update(id: string, patch: { name?: string | null; hidden?: boolean; me?: boolean; cover_id?: string | null; memories?: boolean }): Promise<Subject> {
    const { data } = await apiClient.patch<Subject>(`/photos/people/${id}`, patch);
    return data;
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
