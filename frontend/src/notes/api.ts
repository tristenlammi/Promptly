/** The Notes API (``/api/notes``, ``backend/app/notes/router.py``). */
import { apiClient } from "@/api/client";

import type { DocNode, Note, NoteItem, NoteKind, NoteLabel, NoteUser, NoteView } from "./types";

export interface Page {
  notes: Note[];
  next_cursor: string | null;
  users: Record<string, NoteUser>;
}

export interface NewNote {
  client_id: string;
  kind: NoteKind;
  title?: string;
  body_doc?: DocNode | null;
  items?: { id: string; text: string; checked?: boolean; indent?: boolean }[];
  color?: string;
  tag_ids?: string[];
  pinned?: boolean;
  archived?: boolean;
  source?: string;
}

export interface NotePatch {
  base_revision: number;
  title?: string;
  body_doc?: DocNode | null;
  color?: string;
  kind?: NoteKind;
  list_opts?: Record<string, boolean>;
}

export type BulkAction = "pin" | "unpin" | "archive" | "unarchive" | "color" | "label" | "unlabel" | "trash";

export const notesApi = {
  async list(view: NoteView, opts: { q?: string; cursor?: string | null; limit?: number } = {}): Promise<Page> {
    const { data } = await apiClient.get<Page>("/notes", {
      params: { view, q: opts.q || undefined, cursor: opts.cursor || undefined, limit: opts.limit ?? 200 },
    });
    return data;
  },
  async get(id: string): Promise<Note> {
    const { data } = await apiClient.get<{ note: Note }>(`/notes/${id}`);
    return data.note;
  },
  async create(body: NewNote): Promise<Note> {
    const { data } = await apiClient.post<{ note: Note }>("/notes", body);
    return data.note;
  },
  async patch(id: string, body: NotePatch): Promise<Note> {
    const { data } = await apiClient.patch<{ note: Note }>(`/notes/${id}`, body);
    return data.note;
  },
  async addItem(id: string, body: { id: string; text: string; after_id?: string | null; parent_id?: string | null; checked?: boolean }): Promise<NoteItem> {
    const { data } = await apiClient.post<{ item: NoteItem }>(`/notes/${id}/items`, body);
    return data.item;
  },
  async patchItem(id: string, itemId: string, body: { text?: string; checked?: boolean; parent_id?: string | null; position?: number }): Promise<void> {
    await apiClient.patch(`/notes/${id}/items/${itemId}`, body);
  },
  async deleteItem(id: string, itemId: string): Promise<void> {
    await apiClient.delete(`/notes/${id}/items/${itemId}`);
  },
  async itemsBulk(id: string, action: "untick_all" | "delete_ticked" | "sort"): Promise<void> {
    await apiClient.post(`/notes/${id}/items/bulk`, { action });
  },
  async me(id: string, body: { pinned?: boolean; archived?: boolean; position?: number; seen?: boolean }): Promise<void> {
    await apiClient.put(`/notes/${id}/me`, body);
  },
  async labels(id: string, tagIds: string[]): Promise<NoteLabel[]> {
    const { data } = await apiClient.put<{ labels: NoteLabel[] }>(`/notes/${id}/labels`, { tag_ids: tagIds });
    return data.labels;
  },
  async bulk(ids: string[], action: BulkAction, extra: { color?: string; tag_id?: string } = {}): Promise<void> {
    await apiClient.post("/notes/bulk", { ids, action, ...extra });
  },
  /** Your note → Trash; someone else's → you leave it. */
  async remove(id: string): Promise<void> {
    await apiClient.delete(`/notes/${id}`);
  },
  async restore(id: string): Promise<void> {
    await apiClient.post(`/notes/${id}/restore`);
  },
  async forever(id: string): Promise<void> {
    await apiClient.delete(`/notes/${id}/forever`);
  },
  async emptyTrash(): Promise<void> {
    await apiClient.delete("/notes/trash");
  },
};
