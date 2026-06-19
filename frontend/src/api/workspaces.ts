/**
 * Workspaces API client.
 *
 * Mirrors the Study API shape intentionally — the workspaces UI re-uses
 * the list/detail/archive patterns wholesale so the two features feel
 * like siblings in the sidebar.
 */

import { apiClient } from "./client";
import type { ConversationSummary } from "@/api/types";

export interface WorkspaceFilePin {
  file_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  pinned_at: string;
  /** RAG indexing lifecycle. ``queued`` also covers non-RAG files
   *  (images / binaries) — they stay queued and retrieval ignores them. */
  indexing_status: "queued" | "embedding" | "ready" | "failed";
  indexing_error: string | null;
  /** "Use as workspace context" — feeds the shared RAG pool when true. */
  context_enabled: boolean;
}

export interface WorkspaceParticipant {
  user_id: string;
  username: string;
  email: string;
}

export interface WorkspaceSummary {
  id: string;
  title: string;
  description: string | null;
  default_model_id: string | null;
  default_provider_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  conversation_count: number;
  file_count: number;
  /** Whether the caller owns this workspace or has an accepted share
   *  on it. Used to badge cards in the list and to hide destructive
   *  actions (delete, archive, manage shares) from collaborators. */
  role: "owner" | "collaborator";
  /** Non-null only when ``role === "collaborator"`` — tells the
   *  caller who they got access from so the card can render
   *  "shared by Jane" in place of the owner timestamp. */
  shared_by: WorkspaceParticipant | null;
}

export interface WorkspaceDetail extends WorkspaceSummary {
  system_prompt: string | null;
  files: WorkspaceFilePin[];
  /** The workspace's owner — present on the detail endpoint so the
   *  header can render "Owned by X" consistently across owner /
   *  collaborator viewpoints. */
  owner: WorkspaceParticipant | null;
  /** Every user with an accepted workspace share, sorted by username. */
  collaborators: WorkspaceParticipant[];
  /** Per-turn context budget (Phase P2). ``per_turn_tokens`` is what
   *  every chat in the workspace actually pays: instructions + full pinned
   *  text in full-dump mode, or instructions + a top-k retrieval slice
   *  once ``retrieval_active`` is true. ``indexing_count`` is how many
   *  pinned files are still being embedded. */
  instruction_tokens: number;
  pinned_file_tokens: number;
  per_turn_tokens: number;
  retrieval_active: boolean;
  indexing_count: number;
  /** Caller's fine-grained permission. ``viewer`` is read-only;
   *  ``editor``/``owner`` can edit. */
  access_role: "owner" | "editor" | "viewer";
  /** Opt-in rolling workspace memory. */
  auto_memory_enabled: boolean;
  /** True when the workspace has an embedding provider configured.
   *  False → files stay in full-dump mode regardless of size;
   *  the Files tab shows an onboarding nudge when this is false. */
  embeddings_configured: boolean;
  /** Drive folder id of the workspace's ``Files`` subfolder (owned by the
   *  owner). The home uploader drops files here so the owner's Drive stays
   *  tidy; null if not seeded. Only usable when the caller owns the
   *  workspace — collaborators can't write to the owner's folder. */
  files_folder_id: string | null;
}

/** Kinds the navigator tree can hold. ``folder``/``note`` are real
 *  ``workspace_items`` rows; ``chat`` rows are synthesised at the root
 *  from the workspace's conversations; ``canvas``/``file`` are reserved
 *  for later phases but typed here so the tree renderer stays exhaustive. */
export type WorkspaceItemKind =
  | "folder"
  | "note"
  | "canvas"
  | "board"
  | "file"
  | "chat";

/** One node in ``GET /workspaces/{id}/tree``. Folders/notes nest via
 *  ``children``; chats are appended flat at the root. */
export interface WorkspaceItemNode {
  id: string;
  kind: WorkspaceItemKind;
  /** Underlying resource id: a Drive Document id for notes, a
   *  conversation id for chats, ``null`` for folders. */
  ref_id: string | null;
  title: string;
  icon: string | null;
  position: number;
  indexing_status: string | null;
  /** "Use as workspace context" — note/canvas items feed the shared RAG
   *  pool when true (default). Always present from the tree API; optional
   *  here so synthesised chat nodes don't need to set it. Treat undefined
   *  as enabled. */
  context_enabled?: boolean;
  /** Surfaced in the rail's Pinned quick-access section when true. */
  pinned?: boolean;
  children: WorkspaceItemNode[];
}

/** A board's coloured label, defined once per board and referenced by id
 *  from cards. ``color`` is a hex string. */
export interface BoardLabel {
  id: string;
  name: string;
  color: string;
}

/** Kind-specific JSON config on a workspace item. Boards use it for the
 *  label registry (and, later, custom columns). */
export interface BoardConfig {
  labels?: BoardLabel[];
  columns?: BoardColumn[];
}

/** Flat ``workspace_items`` row returned by the create / update / move
 *  endpoints (no ``children``). */
export interface WorkspaceItemResponse {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  kind: WorkspaceItemKind;
  ref_id: string | null;
  title: string;
  icon: string | null;
  position: number;
  indexing_status: string | null;
  context_enabled?: boolean;
  pinned?: boolean;
  config?: BoardConfig | null;
}

/** A source citation returned by "ask this workspace". ``item_id`` is the
 *  navigator item to jump to (null for a pinned file); ``ref_id`` is what
 *  it opens by (doc id for a note, canvas id for a canvas). */
export interface WorkspaceAskCitation {
  index: number;
  item_id: string | null;
  ref_id: string | null;
  kind: string;
  title: string;
}

export interface WorkspaceAskResponse {
  answer: string;
  citations: WorkspaceAskCitation[];
}

export interface WorkspaceTaskItem {
  text: string;
  checked: boolean;
  note_item_id: string;
  note_ref_id: string | null;
  note_title: string;
}

/** Workspace landing-pane summary (counts + tasks rollup + recent). */
export interface WorkspaceOverview {
  counts: { notes: number; canvases: number; chats: number; files: number };
  tasks: WorkspaceTaskItem[];
  open_task_count: number;
  recent: {
    id: string;
    kind: string;
    ref_id: string | null;
    title: string;
  }[];
}

/** A task's ``status`` is a board *column id* — the defaults (todo / doing
 *  / done) or any custom column the board defines. */
export type TaskStatus = string;
export type TaskPriority = "low" | "medium" | "high";

/** A board column. ``done`` marks the "completed" column; ``wip`` is an
 *  optional work-in-progress limit. */
export interface BoardColumn {
  id: string;
  name: string;
  done?: boolean;
  wip?: number | null;
}

export interface Subtask {
  id: string;
  text: string;
  done: boolean;
}

/** A workspace member that can be assigned to a card. */
export interface BoardMember {
  id: string;
  username: string;
}

/** A comment ("comment") or auto-logged change ("activity") on a card. */
export interface WorkspaceTaskComment {
  id: string;
  task_id: string;
  author_user_id: string | null;
  author_username: string | null;
  kind: "comment" | "activity";
  text: string;
  created_at: string;
}

/** A first-class workspace task (the dedicated project to-do list — not
 *  the checkbox rollup parsed out of notes). */
export interface WorkspaceTask {
  id: string;
  board_item_id: string | null;
  title: string;
  description: string | null;
  subtasks: Subtask[] | null;
  labels: string[] | null;
  assignee_user_id: string | null;
  done: boolean;
  status: TaskStatus;
  priority: TaskPriority;
  due_at: string | null;
  position: number;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceTaskCreatePayload {
  title: string;
  board_item_id?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  due_at?: string | null;
}

export interface WorkspaceTaskUpdatePayload {
  title?: string;
  done?: boolean;
  status?: TaskStatus;
  priority?: TaskPriority;
  due_at?: string | null;
  position?: number;
  description?: string | null;
  subtasks?: Subtask[] | null;
  labels?: string[] | null;
  assignee_user_id?: string | null;
}


export interface CreateWorkspaceItemPayload {
  kind: "folder" | "note" | "canvas" | "board";
  parent_id?: string | null;
  title?: string;
}

export interface UpdateWorkspaceItemPayload {
  title?: string;
  icon?: string;
}

export interface MoveWorkspaceItemPayload {
  parent_id?: string | null;
  position: number;
}

export type WorkspaceShareRole = "editor" | "viewer";

/** One share row on the owner-facing management list. */
export interface WorkspaceShareRow {
  id: string;
  workspace_id: string;
  invitee: WorkspaceParticipant;
  status: "pending" | "accepted" | "declined";
  role: WorkspaceShareRole;
  created_at: string;
  accepted_at: string | null;
}

/** A pending workspace-share invite as seen by the invitee. */
export interface WorkspaceInviteRow {
  id: string;
  workspace_id: string;
  workspace_title: string;
  inviter: WorkspaceParticipant;
  created_at: string;
}

export interface WorkspaceUsageModel {
  model_id: string | null;
  messages: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
}

export interface WorkspaceUsage {
  conversation_count: number;
  message_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  by_model: WorkspaceUsageModel[];
}

export interface CreateWorkspacePayload {
  title: string;
  description?: string | null;
  system_prompt?: string | null;
  default_model_id?: string | null;
  default_provider_id?: string | null;
}

export interface UpdateWorkspacePayload {
  title?: string;
  description?: string | null;
  system_prompt?: string | null;
  default_model_id?: string | null;
  default_provider_id?: string | null;
  auto_memory_enabled?: boolean;
}

export const workspacesApi = {
  async list(opts: { archived?: boolean } = {}): Promise<WorkspaceSummary[]> {
    const { data } = await apiClient.get<WorkspaceSummary[]>(
      "/workspaces",
      { params: { archived: opts.archived ?? false } }
    );
    return data;
  },

  async get(id: string): Promise<WorkspaceDetail> {
    const { data } = await apiClient.get<WorkspaceDetail>(
      `/workspaces/${id}`
    );
    return data;
  },

  async create(
    payload: CreateWorkspacePayload
  ): Promise<WorkspaceSummary> {
    const { data } = await apiClient.post<WorkspaceSummary>(
      "/workspaces",
      payload
    );
    return data;
  },

  async update(
    id: string,
    payload: UpdateWorkspacePayload
  ): Promise<WorkspaceSummary> {
    const { data } = await apiClient.patch<WorkspaceSummary>(
      `/workspaces/${id}`,
      payload
    );
    return data;
  },

  async remove(id: string): Promise<void> {
    await apiClient.delete(`/workspaces/${id}`);
  },

  async archive(id: string): Promise<WorkspaceSummary> {
    const { data } = await apiClient.post<WorkspaceSummary>(
      `/workspaces/${id}/archive`
    );
    return data;
  },

  async unarchive(id: string): Promise<WorkspaceSummary> {
    const { data } = await apiClient.post<WorkspaceSummary>(
      `/workspaces/${id}/unarchive`
    );
    return data;
  },

  async listConversations(id: string): Promise<ConversationSummary[]> {
    const { data } = await apiClient.get<ConversationSummary[]>(
      `/workspaces/${id}/conversations`
    );
    return data;
  },

  async usage(id: string): Promise<WorkspaceUsage> {
    const { data } = await apiClient.get<WorkspaceUsage>(
      `/workspaces/${id}/usage`
    );
    return data;
  },

  async reindex(id: string): Promise<void> {
    await apiClient.post(`/workspaces/${id}/reindex`);
  },

  /** Bulk-detach every conversation from this workspace (workspace_id → null).
   *  Conversations are preserved; they move back to the top-level list.
   *  Returns the count of affected conversations. */
  async removeAllConversations(id: string): Promise<{ removed: number }> {
    const { data } = await apiClient.delete<{ removed: number }>(
      `/workspaces/${id}/conversations`
    );
    return data;
  },

  // ------------------------------------------------------------------
  // Navigator tree (Phase 1c) — folders / notes / chats
  // ------------------------------------------------------------------
  async tree(id: string): Promise<WorkspaceItemNode[]> {
    const { data } = await apiClient.get<WorkspaceItemNode[]>(
      `/workspaces/${id}/tree`
    );
    return data;
  },

  async createItem(
    id: string,
    payload: CreateWorkspaceItemPayload
  ): Promise<WorkspaceItemResponse> {
    const { data } = await apiClient.post<WorkspaceItemResponse>(
      `/workspaces/${id}/items`,
      payload
    );
    return data;
  },

  async updateItem(
    id: string,
    itemId: string,
    payload: UpdateWorkspaceItemPayload
  ): Promise<WorkspaceItemResponse> {
    const { data } = await apiClient.patch<WorkspaceItemResponse>(
      `/workspaces/${id}/items/${itemId}`,
      payload
    );
    return data;
  },

  async moveItem(
    id: string,
    itemId: string,
    payload: MoveWorkspaceItemPayload
  ): Promise<WorkspaceItemResponse> {
    const { data } = await apiClient.post<WorkspaceItemResponse>(
      `/workspaces/${id}/items/${itemId}/move`,
      payload
    );
    return data;
  },

  async deleteItem(id: string, itemId: string): Promise<void> {
    await apiClient.delete(`/workspaces/${id}/items/${itemId}`);
  },

  /** Fetch one item (e.g. a board, to read its ``config`` label registry). */
  async getItem(id: string, itemId: string): Promise<WorkspaceItemResponse> {
    const { data } = await apiClient.get<WorkspaceItemResponse>(
      `/workspaces/${id}/items/${itemId}`
    );
    return data;
  },

  /** Replace a board item's config (label registry, etc.). */
  async setItemConfig(
    id: string,
    itemId: string,
    config: BoardConfig
  ): Promise<WorkspaceItemResponse> {
    const { data } = await apiClient.patch<WorkspaceItemResponse>(
      `/workspaces/${id}/items/${itemId}`,
      { config }
    );
    return data;
  },

  /** Toggle whether a note/canvas item feeds the workspace RAG context. */
  async setItemContext(
    id: string,
    itemId: string,
    enabled: boolean
  ): Promise<WorkspaceItemResponse> {
    const { data } = await apiClient.patch<WorkspaceItemResponse>(
      `/workspaces/${id}/items/${itemId}`,
      { context_enabled: enabled }
    );
    return data;
  },

  /** Opt a workspace chat into (or out of) the RAG context. Enabling
   *  flattens + embeds the transcript; disabling drops it. Returns the
   *  refreshed chat tree node. */
  async setChatContext(
    id: string,
    conversationId: string,
    enabled: boolean
  ): Promise<WorkspaceItemNode> {
    const { data } = await apiClient.patch<WorkspaceItemNode>(
      `/workspaces/${id}/chats/${conversationId}/context`,
      { enabled }
    );
    return data;
  },

  /** Pin / unpin a note, canvas, or folder to the rail's Pinned section. */
  async setItemPinned(
    id: string,
    itemId: string,
    pinned: boolean
  ): Promise<WorkspaceItemResponse> {
    const { data } = await apiClient.patch<WorkspaceItemResponse>(
      `/workspaces/${id}/items/${itemId}`,
      { pinned }
    );
    return data;
  },

  /** Toggle whether a pinned file feeds the workspace RAG context. */
  async setFileContext(
    id: string,
    fileId: string,
    enabled: boolean
  ): Promise<WorkspaceFilePin> {
    const { data } = await apiClient.patch<WorkspaceFilePin>(
      `/workspaces/${id}/files/${fileId}/context`,
      { enabled }
    );
    return data;
  },

  /** Notes that wiki-link to this item (the backend scans note HTML for
   *  the ``item=<itemId>`` substring). Returns the same node shape the
   *  tree uses so rows can be rendered + opened identically. */
  async backlinks(id: string, itemId: string): Promise<WorkspaceItemNode[]> {
    const { data } = await apiClient.get<WorkspaceItemNode[]>(
      `/workspaces/${id}/items/${itemId}/backlinks`
    );
    return data;
  },

  /** Soft-archive an item (folder → its subtree) into the workspace
   *  Archive section. */
  async archiveItem(id: string, itemId: string): Promise<WorkspaceItemResponse> {
    const { data } = await apiClient.post<WorkspaceItemResponse>(
      `/workspaces/${id}/items/${itemId}/archive`
    );
    return data;
  },

  async unarchiveItem(
    id: string,
    itemId: string
  ): Promise<WorkspaceItemResponse> {
    const { data } = await apiClient.post<WorkspaceItemResponse>(
      `/workspaces/${id}/items/${itemId}/unarchive`
    );
    return data;
  },

  /** Archived item roots + archived chats for the Archive section. */
  async archivedItems(id: string): Promise<WorkspaceItemNode[]> {
    const { data } = await apiClient.get<WorkspaceItemNode[]>(
      `/workspaces/${id}/archived-items`
    );
    return data;
  },

  /** Landing-pane summary: counts, tasks rollup, recent items. */
  async overview(id: string): Promise<WorkspaceOverview> {
    const { data } = await apiClient.get<WorkspaceOverview>(
      `/workspaces/${id}/overview`
    );
    return data;
  },

  /** Ask a grounded question across the whole workspace. Returns a cited
   *  answer; citations link back to the source note/canvas/file. */
  async ask(id: string, question: string): Promise<WorkspaceAskResponse> {
    const { data } = await apiClient.post<WorkspaceAskResponse>(
      `/workspaces/${id}/ask`,
      { question }
    );
    return data;
  },

  // ------------------------------------------------------------------
  // Task list — a first-class, project-level to-do list
  // ------------------------------------------------------------------
  async tasks(id: string, boardItemId?: string): Promise<WorkspaceTask[]> {
    const { data } = await apiClient.get<WorkspaceTask[]>(
      `/workspaces/${id}/tasks`,
      boardItemId ? { params: { board_item_id: boardItemId } } : undefined
    );
    return data;
  },

  async createTask(
    id: string,
    payload: WorkspaceTaskCreatePayload
  ): Promise<WorkspaceTask> {
    const { data } = await apiClient.post<WorkspaceTask>(
      `/workspaces/${id}/tasks`,
      payload
    );
    return data;
  },

  async updateTask(
    id: string,
    taskId: string,
    payload: WorkspaceTaskUpdatePayload
  ): Promise<WorkspaceTask> {
    const { data } = await apiClient.patch<WorkspaceTask>(
      `/workspaces/${id}/tasks/${taskId}`,
      payload
    );
    return data;
  },

  async deleteTask(id: string, taskId: string): Promise<void> {
    await apiClient.delete(`/workspaces/${id}/tasks/${taskId}`);
  },

  // ---- card comments + activity ------------------------------------
  async taskComments(
    id: string,
    taskId: string
  ): Promise<WorkspaceTaskComment[]> {
    const { data } = await apiClient.get<WorkspaceTaskComment[]>(
      `/workspaces/${id}/tasks/${taskId}/comments`
    );
    return data;
  },

  async addTaskComment(
    id: string,
    taskId: string,
    text: string
  ): Promise<WorkspaceTaskComment> {
    const { data } = await apiClient.post<WorkspaceTaskComment>(
      `/workspaces/${id}/tasks/${taskId}/comments`,
      { text }
    );
    return data;
  },

  async deleteTaskComment(
    id: string,
    taskId: string,
    commentId: string
  ): Promise<void> {
    await apiClient.delete(
      `/workspaces/${id}/tasks/${taskId}/comments/${commentId}`
    );
  },

  async pinFile(id: string, fileId: string): Promise<WorkspaceFilePin> {
    const { data } = await apiClient.post<WorkspaceFilePin>(
      `/workspaces/${id}/files`,
      { file_id: fileId }
    );
    return data;
  },

  async unpinFile(id: string, fileId: string): Promise<void> {
    await apiClient.delete(`/workspaces/${id}/files/${fileId}`);
  },

  async moveConversation(
    workspaceId: string,
    conversationId: string
  ): Promise<ConversationSummary> {
    const { data } = await apiClient.post<ConversationSummary>(
      `/workspaces/${workspaceId}/conversations/${conversationId}`
    );
    return data;
  },

  async removeConversationFromWorkspace(
    workspaceId: string,
    conversationId: string
  ): Promise<ConversationSummary> {
    const { data } = await apiClient.delete<ConversationSummary>(
      `/workspaces/${workspaceId}/conversations/${conversationId}`
    );
    return data;
  },

  // ------------------------------------------------------------------
  // Workspace sharing — owner perspective
  // ------------------------------------------------------------------
  async listShares(workspaceId: string): Promise<WorkspaceShareRow[]> {
    const { data } = await apiClient.get<WorkspaceShareRow[]>(
      `/workspaces/${workspaceId}/shares`
    );
    return data;
  },

  async createShare(
    workspaceId: string,
    payload: { username?: string; email?: string; role?: WorkspaceShareRole }
  ): Promise<WorkspaceShareRow> {
    const { data } = await apiClient.post<WorkspaceShareRow>(
      `/workspaces/${workspaceId}/shares`,
      payload
    );
    return data;
  },

  async deleteShare(workspaceId: string, shareId: string): Promise<void> {
    await apiClient.delete(
      `/workspaces/${workspaceId}/shares/${shareId}`
    );
  },

  // ------------------------------------------------------------------
  // Workspace sharing — invitee perspective
  // ------------------------------------------------------------------
  async listInvites(): Promise<WorkspaceInviteRow[]> {
    const { data } = await apiClient.get<WorkspaceInviteRow[]>(
      "/workspace-share-invites"
    );
    return data;
  },

  async acceptInvite(shareId: string): Promise<void> {
    await apiClient.post(`/workspace-share-invites/${shareId}/accept`);
  },

  async declineInvite(shareId: string): Promise<void> {
    await apiClient.post(`/workspace-share-invites/${shareId}/decline`);
  },
};
