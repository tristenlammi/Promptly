import { apiClient } from "./client";

/** The family library (PH-5): people on this server pooling photos; each
 *  member chooses what of theirs goes in (nothing, until they do). */

export type FamilyShareMode = "none" | "all" | "since" | "people";

export interface Family {
  id: string;
  name: string;
  /** You own it (name it, add and remove people). */
  owner: boolean;
  members: { user_id: string; username: string; owner: boolean; you: boolean; sharing: FamilyShareMode; photos: number }[];
  /** What you share. */
  share: { mode: FamilyShareMode; since: string | null; people: { id: string; name: string }[] };
}

export const familyApi = {
  async get(): Promise<Family | null> {
    const { data } = await apiClient.get<{ family: Family | null }>("/photos/family");
    return data.family;
  },
  async create(name: string): Promise<Family> {
    const { data } = await apiClient.post<{ family: Family }>("/photos/family", { name });
    return data.family;
  },
  async rename(name: string): Promise<Family> {
    const { data } = await apiClient.patch<{ family: Family }>("/photos/family", { name });
    return data.family;
  },
  async addMember(userId: string): Promise<Family> {
    const { data } = await apiClient.post<{ family: Family }>("/photos/family/members", { user_id: userId });
    return data.family;
  },
  async removeMember(userId: string): Promise<Family | null> {
    const { data } = await apiClient.delete<{ family: Family | null }>(`/photos/family/members/${userId}`);
    return data.family;
  },
  async share(mode: FamilyShareMode, since?: string | null, people?: string[]): Promise<Family> {
    const { data } = await apiClient.put<{ family: Family }>("/photos/family/share", { mode, since: since || null, people: people ?? [] });
    return data.family;
  },
};
