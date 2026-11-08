/** The Notes API (``/api/notes``, ``backend/app/notes/router.py``). */
import { apiClient } from "@/api/client";

import type { AiAction, AiProposal, DocNode, Note, NoteItem, NoteKind, NoteLabel, NoteUser, NoteView, ProposedTask, ReminderIn } from "./types";

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
  /** An AI proposal being applied: the note as it was is kept as a version. */
  checkpoint?: "ai";
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
  /** One of your own pictures or recordings into the note (a retry with the same id is safe). */
  async attach(id: string, body: { id: string; file_id: string; kind?: "image" | "audio"; duration_ms?: number | null; peaks?: number[] | null }): Promise<Note> {
    const { data } = await apiClient.post<{ note: Note }>(`/notes/${id}/attachments`, body);
    return data.note;
  },
  async detach(id: string, aid: string): Promise<Note> {
    const { data } = await apiClient.delete<{ note: Note }>(`/notes/${id}/attachments/${aid}`);
    return data.note;
  },
  async transcribe(id: string, aid: string): Promise<Note> {
    const { data } = await apiClient.post<{ note: Note }>(`/notes/${id}/attachments/${aid}/transcribe`);
    return data.note;
  },
  /** Your reminder: a task in your Tasks, linked to the note. */
  async setReminder(id: string, body: ReminderIn): Promise<Note> {
    const { data } = await apiClient.put<{ note: Note }>(`/notes/${id}/reminder`, body);
    return data.note;
  },
  async clearReminder(id: string): Promise<Note> {
    const { data } = await apiClient.delete<{ note: Note }>(`/notes/${id}/reminder`);
    return data.note;
  },
  async members(id: string): Promise<Members> {
    const { data } = await apiClient.get<Members>(`/notes/${id}/members`);
    return data;
  },
  /** Share with people on this server (the owner only). */
  async share(id: string, userIds: string[]): Promise<Members> {
    const { data } = await apiClient.post<Members>(`/notes/${id}/members`, { user_ids: userIds });
    return data;
  },
  /** The owner takes someone off; your own id = Leave. */
  async unshare(id: string, userId: string): Promise<Members | { left: true }> {
    const { data } = await apiClient.delete<Members | { left: true }>(`/notes/${id}/members/${userId}`);
    return data;
  },
  async transcription(): Promise<TranscriptionStatus> {
    const { data } = await apiClient.get<TranscriptionStatus>("/notes/admin/transcription");
    return data;
  },
  async setTranscription(on: boolean): Promise<TranscriptionStatus> {
    const { data } = await apiClient.put<TranscriptionStatus>("/notes/admin/transcription", { on });
    return data;
  },
  async versions(id: string): Promise<NoteVersionRow[]> {
    const { data } = await apiClient.get<{ versions: NoteVersionRow[] }>(`/notes/${id}/versions`);
    return data.versions;
  },
  async restoreVersion(id: string, versionId: string): Promise<Note> {
    const { data } = await apiClient.post<{ note: Note }>(`/notes/${id}/versions/${versionId}/restore`);
    return data.note;
  },
  /** A proposal from the model — nothing is saved. */
  async ai(id: string, action: AiAction, model: { provider_id: string; model_id: string }): Promise<AiProposal> {
    const { data } = await apiClient.post<{ proposal: AiProposal }>(`/notes/${id}/ai/${action}`, model, { timeout: 150_000 });
    return data.proposal;
  },
  /** Make a copy: a new note of your own. */
  async copy(id: string, clientId: string): Promise<{ note: Note; skipped_attachments: number }> {
    const { data } = await apiClient.post<{ note: Note; skipped_attachments: number }>(`/notes/${id}/copy`, { client_id: clientId });
    return data;
  },
  async toDocument(id: string): Promise<{ note: Note; document: { id: string; title: string; href: string } | null; file_id: string }> {
    const { data } = await apiClient.post(`/notes/${id}/to-document`, {});
    return data;
  },
  async undoDocument(id: string): Promise<Note> {
    const { data } = await apiClient.delete<{ note: Note }>(`/notes/${id}/to-document`);
    return data.note;
  },
  async taskLists(): Promise<{ available: boolean; lists: { id: string; name: string; color?: string | null }[] }> {
    const { data } = await apiClient.get("/notes/to-tasks/lists");
    return data;
  },
  async toTasks(id: string, list: string | null, tasks: ProposedTask[]): Promise<ToTasksResult> {
    const { data } = await apiClient.post<ToTasksResult>(`/notes/${id}/to-tasks`, { list, tasks });
    return data;
  },
  async undoTasks(id: string, fileId: string, taskIds: string[]): Promise<number> {
    const { data } = await apiClient.post<{ removed: number }>(`/notes/${id}/to-tasks/undo`, { file_id: fileId, task_ids: taskIds });
    return data.removed;
  },
};

/** An earlier version of a note (kept before edits, AI changes and restores). */
export interface NoteVersionRow {
  id: string;
  revision: number;
  reason: "edit" | "restore" | "ai";
  made_by: string | null;
  created_at: string;
  title: string;
  kind: string;
  preview: string;
}

export interface ToTasksResult {
  file_id: string;
  task_ids: string[];
  count: number;
  list: string;
  href: string;
}

/** Who a note is shared with. */
export interface Members {
  owner_id: string;
  members: { user_id: string; added_by: string | null; added_at: string }[];
  users: Record<string, NoteUser>;
}

/** The admin's switch for transcribing voice notes. */
export interface TranscriptionStatus {
  on: boolean;
  backend: "local" | "openai";
  choice: boolean | null;
  ready: boolean;
}
