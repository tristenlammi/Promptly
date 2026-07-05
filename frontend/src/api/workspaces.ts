/**
 * Workspaces API client.
 *
 * Mirrors the Study API shape intentionally — the workspaces UI re-uses
 * the list/detail/archive patterns wholesale so the two features feel
 * like siblings in the sidebar.
 */

import { apiClient } from "./client";
import type { ConversationSummary } from "@/api/types";
import type { CollabTokenResponse } from "@/api/documents";

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
  /** Signed profile-picture URL (null = initials chip). */
  avatar_url?: string | null;
  /** Chosen chip colour; null = deterministic palette hash. */
  avatar_color?: string | null;
}

export interface WorkspaceSummary {
  id: string;
  title: string;
  description: string | null;
  default_model_id: string | null;
  default_provider_id: string | null;
  memory_model_id?: string | null;
  memory_provider_id?: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  conversation_count: number;
  file_count: number;
  /** Live (non-archived) items by kind — "note" / "canvas" / "board" /
   *  "sheet" / "container" / "task" / "folder". Chats are counted by
   *  ``conversation_count`` (they aren't tree items). Optional so stale
   *  cached payloads from before the rollup still render. */
  item_counts?: Record<string, number>;
  /** Owner first, then accepted collaborators — for the card avatars. */
  member_names?: string[];
  /** Same people with avatar url/colour (7.5) — real pictures on cards. */
  members?: WorkspaceParticipant[];
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
  /** Opt-in rolling workspace memory (legacy mirror of ``memory_mode``). */
  auto_memory_enabled: boolean;
  /** Tri-state memory mode: "off" | "auto" | "manual". */
  memory_mode: WorkspaceMemoryMode;
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
  | "chat"
  | "sheet"
  | "container"
  | "task";

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
  /** "workspace" (everyone) | "private" (creator-only draft, 0134).
   *  Other members never receive private nodes — this lets the creator's
   *  own UI badge them. */
  visibility?: "workspace" | "private";
  created_by?: string | null;
  /** Flagged as a note template (9.3) — shows in "New from template". */
  is_template?: boolean;
  children: WorkspaceItemNode[];
}

/** A spreadsheet page's persisted state. ``data`` is the Fortune-sheet
 *  workbook JSON (an array of sheet objects), ``null`` until first save. */
export interface SpreadsheetData {
  id: string;
  workspace_id: string;
  title: string;
  data: unknown[] | null;
}

// ---------------------------------------------------------------------
// Workspace Drive (Phases 6-7)
// ---------------------------------------------------------------------

export interface WorkspaceDriveFolder {
  id: string;
  name: string;
  /** null = first-level (the drive root is implicit). */
  parent_id: string | null;
}

export interface WorkspaceDriveFile extends WorkspaceFilePin {
  /** null = drive root. */
  folder_id: string | null;
  /** false for legacy pins living in a member's personal Drive —
   *  they list at root and can't be re-foldered. */
  movable: boolean;
}

export interface WorkspaceDriveResponse {
  root_folder_id: string;
  folders: WorkspaceDriveFolder[];
  files: WorkspaceDriveFile[];
  used_bytes: number;
  quota_bytes: number | null;
}

/** The workspace's rolling memory doc, as maintained by the librarian and
 *  optionally hand-edited. ``exists`` is false until the first auto-run or
 *  manual save creates it. */
export type WorkspaceMemoryMode = "off" | "auto" | "manual";

export interface WorkspaceMemory {
  exists: boolean;
  markdown: string;
  updated_at: string | null;
  auto_memory_enabled: boolean;
  memory_mode: WorkspaceMemoryMode;
  /** Outcome of the last regeneration attempt (Phase 10): "ok" | "failed" |
   *  "skipped" | null (never attempted). Lets the overview card flag a broken
   *  auto-refresh instead of silently showing a stale timestamp. */
  last_status: "ok" | "failed" | "skipped" | null;
  last_error: string | null;
  last_attempt_at: string | null;
}

/** A board's coloured label, defined once per board and referenced by id
 *  from cards. ``color`` is a hex string. */
export interface BoardLabel {
  id: string;
  name: string;
  color: string;
}

/** A custom field definition on a board (0138). Definitions live in the
 *  board item's config (like labels); per-card values live in
 *  ``WorkspaceTask.fields`` keyed by ``id``. */
export interface BoardField {
  id: string;
  name: string;
  type: "text" | "number" | "select" | "date";
  /** Select fields only. */
  options?: { id: string; label: string; color?: string }[];
}

/** A saved combination of board filters + sort (0138). */
export interface BoardView {
  id: string;
  name: string;
  search?: string;
  priority?: TaskPriority | "all";
  due?: "all" | "overdue" | "soon" | "has" | "none";
  labels?: string[];
  assignee?: string;
  sort?: string;
}

/** Kind-specific JSON config on a workspace item. Boards use it for the
 *  label registry, custom columns, custom fields, and saved views. */
export interface BoardConfig {
  labels?: BoardLabel[];
  columns?: BoardColumn[];
  fields?: BoardField[];
  views?: BoardView[];
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
  /** Opening text of the best-matching chunk — the deep-citation anchor. */
  snippet?: string | null;
}

export interface WorkspaceAskResponse {
  answer: string;
  citations: WorkspaceAskCitation[];
}

/** One open card assigned to the caller (the "My work" page). */
export interface MyWorkCard {
  id: string;
  title: string;
  status: string;
  priority: string;
  due_at: string | null;
  created_at: string;
  workspace_id: string;
  workspace_title: string;
  board_item_id: string | null;
  board_title: string | null;
}

export interface MyWorkResponse {
  cards: MyWorkCard[];
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
  counts: {
    notes: number;
    canvases: number;
    boards: number;
    sheets: number;
    chats: number;
    files: number;
  };
  tasks: WorkspaceTaskItem[];
  open_task_count: number;
  recent: {
    id: string;
    kind: string;
    ref_id: string | null;
    title: string;
    updated_at?: string | null;
  }[];
  /** Knowledge health (4.8): what's quietly degrading the AI's answers. */
  health?: {
    stale: Array<{
      item_id: string;
      kind: string;
      title: string;
      updated_at: string | null;
    }>;
    heavy: Array<{
      item_id: string;
      kind: string;
      title: string;
      chars: number | null;
    }>;
  };
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

/** A card → navigator-item reference. ``item_id`` is the tree node id;
 *  ``ref_id`` is what it opens by (doc id for a note, conversation id for a
 *  chat). ``title`` is denormalised for display. */
export interface TaskLink {
  item_id: string;
  kind: string;
  ref_id: string | null;
  title: string;
  /** External URL links carry ``kind === "url"`` and the href here;
   *  navigator-item links leave it null. */
  url?: string | null;
}

/** A file attached to a card. ``file_id`` references a ``UserFile``; an image
 *  flagged ``is_cover`` renders on the card face. */
export interface TaskAttachment {
  file_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  is_cover: boolean;
}

/** A workspace member that can be assigned to a card. */
export interface BoardMember {
  id: string;
  username: string;
  avatar_url?: string | null;
  avatar_color?: string | null;
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
  links: TaskLink[] | null;
  attachments: TaskAttachment[] | null;
  assignee_user_id: string | null;
  done: boolean;
  status: TaskStatus;
  priority: TaskPriority;
  due_at: string | null;
  position: number;
  completed_at: string | null;
  /** Custom-field values keyed by the board's field-definition id (0138). */
  fields?: Record<string, string | number> | null;
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
  links?: TaskLink[] | null;
  assignee_user_id?: string | null;
  /** Whole-map replace of the card's custom-field values; null clears. */
  fields?: Record<string, string | number> | null;
}


export interface CreateWorkspaceItemPayload {
  kind: "folder" | "note" | "canvas" | "board" | "sheet" | "container" | "chat";
  parent_id?: string | null;
  title?: string;
}

export interface UpdateWorkspaceItemPayload {
  title?: string;
  /** Emoji glyph shown in place of the kind icon; null clears it. */
  icon?: string | null;
  /** "workspace" | "private" — creator-only drafts (0134). */
  visibility?: "workspace" | "private";
  /** Kind-specific config. Notes use ``{template: true}`` (9.3). */
  config?: Record<string, unknown> | null;
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
  /** Starter template key (4.6) — null/omitted = blank workspace. */
  template?: string | null;
}

export interface UpdateWorkspacePayload {
  title?: string;
  description?: string | null;
  system_prompt?: string | null;
  default_model_id?: string | null;
  default_provider_id?: string | null;
  auto_memory_enabled?: boolean;
  memory_mode?: WorkspaceMemoryMode;
  memory_model_id?: string | null;
  memory_provider_id?: string | null;
  /** Drive storage cap in bytes (owner-only); null clears it. */
  storage_quota_bytes?: number | null;
}

export interface WorkspaceItemComment {
  id: string;
  item_id: string;
  body: string;
  /** The selected note text this comment anchors to (text-quote anchor). */
  quote?: string | null;
  author_user_id: string | null;
  author_name: string;
  /** Non-null = resolved; resolved comments collapse in the panel. */
  resolved_at?: string | null;
  created_at: string;
}

/** One workspace search hit. ``snippet`` for 'text' hits is a Postgres
 *  ts_headline fragment containing only ``<mark>`` markup. */
export interface WorkspaceSearchHit {
  source: "title" | "text" | "semantic";
  item_id: string | null;
  ref_id: string | null;
  kind: string;
  title: string;
  snippet: string;
  score: number;
}

export interface WorkspaceSearchResponse {
  hits: WorkspaceSearchHit[];
  semantic_available: boolean;
}

/** One workspace activity-feed row ("what changed since I was here"). */
export interface WorkspaceActivityEvent {
  kind: "item_created" | "item_comment" | "card_activity" | "card_comment";
  actor: {
    username: string;
    avatar_url?: string | null;
    avatar_color?: string | null;
  } | null;
  item_id: string | null;
  item_kind: string | null;
  item_title: string;
  text: string;
  created_at: string;
}

/** One meeting-notes job (upload → chunked transcription → seeded note). */
export interface MeetingJob {
  id: string;
  workspace_id: string;
  title: string | null;
  status: "pending" | "transcribing" | "summarising" | "done" | "failed";
  /** Transcription chunk progress; total is 0 until chunking finishes. */
  progress_done: number;
  progress_total: number;
  duration_s: number | null;
  error: string | null;
  /** The seeded note's tree item, once status is "done". */
  note_item_id: string | null;
  created_at: string;
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

  /** Deep-copy a note / sheet / board as a sibling ("Research 2"). */
  async duplicateItem(
    id: string,
    itemId: string
  ): Promise<WorkspaceItemResponse> {
    const { data } = await apiClient.post<WorkspaceItemResponse>(
      `/workspaces/${id}/items/${itemId}/duplicate`
    );
    return data;
  },

  // ---- Workspace Drive (Phases 6-7) ----

  async getDrive(id: string): Promise<WorkspaceDriveResponse> {
    const { data } = await apiClient.get<WorkspaceDriveResponse>(
      `/workspaces/${id}/drive`
    );
    return data;
  },

  /** Upload straight into the drive (workspace-owned + auto-pinned). */
  async uploadDriveFile(
    id: string,
    file: File,
    folderId: string | null
  ): Promise<WorkspaceDriveFile> {
    const form = new FormData();
    form.append("file", file);
    if (folderId) form.append("folder_id", folderId);
    const { data } = await apiClient.post<WorkspaceDriveFile>(
      `/workspaces/${id}/drive/files`,
      form,
      { headers: { "Content-Type": "multipart/form-data" }, timeout: 120_000 }
    );
    return data;
  },

  async createDriveFolder(
    id: string,
    name: string,
    parentId: string | null
  ): Promise<WorkspaceDriveFolder> {
    const { data } = await apiClient.post<WorkspaceDriveFolder>(
      `/workspaces/${id}/drive/folders`,
      { name, parent_id: parentId }
    );
    return data;
  },

  async renameDriveFolder(
    id: string,
    folderId: string,
    name: string
  ): Promise<WorkspaceDriveFolder> {
    const { data } = await apiClient.patch<WorkspaceDriveFolder>(
      `/workspaces/${id}/drive/folders/${folderId}`,
      { name }
    );
    return data;
  },

  async deleteDriveFolder(id: string, folderId: string): Promise<void> {
    await apiClient.delete(`/workspaces/${id}/drive/folders/${folderId}`);
  },

  async moveDriveFile(
    id: string,
    fileId: string,
    folderId: string | null
  ): Promise<WorkspaceDriveFile> {
    const { data } = await apiClient.post<WorkspaceDriveFile>(
      `/workspaces/${id}/drive/files/${fileId}/move`,
      { folder_id: folderId }
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

  /** Reorder / file a synthesised chat node in the navigator (0140). */
  async placeChat(
    id: string,
    conversationId: string,
    payload: MoveWorkspaceItemPayload
  ): Promise<void> {
    await apiClient.post(
      `/workspaces/${id}/chats/${conversationId}/place`,
      payload
    );
  },

  /** Reorder / file a synthesised automation node in the navigator (0140). */
  async placeTask(
    id: string,
    taskId: string,
    payload: MoveWorkspaceItemPayload
  ): Promise<void> {
    await apiClient.post(`/workspaces/${id}/tasks/${taskId}/place`, payload);
  },

  /** The workspace's structural map (Markdown) — the same catalog injected
   *  into chat context. */
  async map(id: string): Promise<{ markdown: string }> {
    const { data } = await apiClient.get<{ markdown: string }>(
      `/workspaces/${id}/map`
    );
    return data;
  },

  /** The librarian-maintained workspace memory doc (viewable + editable). */
  async getMemory(id: string): Promise<WorkspaceMemory> {
    const { data } = await apiClient.get<WorkspaceMemory>(
      `/workspaces/${id}/memory`
    );
    return data;
  },

  /** Replace the workspace memory with a hand-edited version. */
  async saveMemory(id: string, markdown: string): Promise<WorkspaceMemory> {
    const { data } = await apiClient.put<WorkspaceMemory>(
      `/workspaces/${id}/memory`,
      { markdown }
    );
    return data;
  },

  /** Rebuild the memory from recent chats now (bypasses cooldown + opt-in). */
  async regenerateMemory(id: string): Promise<WorkspaceMemory> {
    const { data } = await apiClient.post<WorkspaceMemory>(
      `/workspaces/${id}/memory/regenerate`
    );
    return data;
  },

  /** Pin a snippet into the workspace memory ("save to memory"). */
  async appendMemory(id: string, text: string): Promise<WorkspaceMemory> {
    const { data } = await apiClient.post<WorkspaceMemory>(
      `/workspaces/${id}/memory/append`,
      { text }
    );
    return data;
  },

  // --- Spreadsheet pages (single-user persistence) ---------------------
  async getSpreadsheet(
    id: string,
    sheetId: string
  ): Promise<SpreadsheetData> {
    const { data } = await apiClient.get<SpreadsheetData>(
      `/workspaces/${id}/spreadsheets/${sheetId}`
    );
    return data;
  },

  async saveSpreadsheet(
    id: string,
    sheetId: string,
    payload: { data: unknown; content_text?: string; title?: string }
  ): Promise<SpreadsheetData> {
    const { data } = await apiClient.put<SpreadsheetData>(
      `/workspaces/${id}/spreadsheets/${sheetId}`,
      payload
    );
    return data;
  },

  /** Mint the short-lived collab JWT for a sheet's ``sheet:<id>`` Yjs room. */
  async getSheetCollabToken(
    id: string,
    sheetId: string
  ): Promise<CollabTokenResponse> {
    const { data } = await apiClient.get<CollabTokenResponse>(
      `/workspaces/${id}/spreadsheets/${sheetId}/collab-token`
    );
    return data;
  },

  /** Fetch one item (e.g. a board, to read its ``config`` label registry). */
  async getItem(id: string, itemId: string): Promise<WorkspaceItemResponse> {
    const { data } = await apiClient.get<WorkspaceItemResponse>(
      `/workspaces/${id}/items/${itemId}`
    );
    return data;
  },

  /** List comments on a workspace item (chronological). */
  async listComments(
    id: string,
    itemId: string
  ): Promise<WorkspaceItemComment[]> {
    const { data } = await apiClient.get<WorkspaceItemComment[]>(
      `/workspaces/${id}/items/${itemId}/comments`
    );
    return data;
  },

  /** Post a comment on a workspace item, optionally anchored to a
   *  selected-text quote. */
  async createComment(
    id: string,
    itemId: string,
    body: string,
    quote?: string | null
  ): Promise<WorkspaceItemComment> {
    const { data } = await apiClient.post<WorkspaceItemComment>(
      `/workspaces/${id}/items/${itemId}/comments`,
      { body, quote: quote || undefined }
    );
    return data;
  },

  /** Resolve / unresolve a comment thread entry. */
  async setCommentResolved(
    id: string,
    itemId: string,
    commentId: string,
    resolved: boolean
  ): Promise<WorkspaceItemComment> {
    const { data } = await apiClient.post<WorkspaceItemComment>(
      `/workspaces/${id}/items/${itemId}/comments/${commentId}/resolve`,
      { resolved }
    );
    return data;
  },

  /** Embedding-nearest neighbours of an item ("Related" strip). */
  async related(
    id: string,
    itemId: string
  ): Promise<{
    items: Array<{
      item_id: string;
      ref_id: string | null;
      kind: string;
      title: string;
      score: number;
    }>;
  }> {
    const { data } = await apiClient.get(
      `/workspaces/${id}/items/${itemId}/related`
    );
    return data;
  },

  /** Workspace search — titles + full text (<mark> snippets) + semantic. */
  async search(id: string, q: string): Promise<WorkspaceSearchResponse> {
    const { data } = await apiClient.get<WorkspaceSearchResponse>(
      `/workspaces/${id}/search`,
      { params: { q } }
    );
    return data;
  },

  /** Cross-workspace search (9.2): one query over every workspace the
   *  caller can see, grouped per workspace, best group first. */
  async searchAll(q: string): Promise<{
    groups: {
      workspace_id: string;
      workspace_title: string;
      hits: WorkspaceSearchHit[];
    }[];
  }> {
    const { data } = await apiClient.get("/workspace-search", {
      params: { q },
    });
    return data;
  },

  /** Merged newest-first activity feed for the overview pane. */
  async activity(id: string): Promise<{ events: WorkspaceActivityEvent[] }> {
    const { data } = await apiClient.get<{
      events: WorkspaceActivityEvent[];
    }>(`/workspaces/${id}/activity`);
    return data;
  },

  /** Create a note from a builtin skeleton or a template-flagged note. */
  async createNoteFromTemplate(
    id: string,
    payload: {
      template_key?: string;
      from_item_id?: string;
      title?: string;
      parent_id?: string | null;
    }
  ): Promise<WorkspaceItemResponse> {
    const { data } = await apiClient.post<WorkspaceItemResponse>(
      `/workspaces/${id}/items/note-from-template`,
      payload
    );
    return data;
  },

  /** Trashed subtree roots, newest first (30-day retention). */
  async trash(id: string): Promise<
    {
      id: string;
      kind: string;
      title: string;
      trashed_at: string;
      subtree_count: number;
    }[]
  > {
    const { data } = await apiClient.get(`/workspaces/${id}/trash`);
    return data;
  },

  /** Bring a trashed item (+ subtree) back into the tree. */
  async restoreTrashed(id: string, itemId: string): Promise<void> {
    await apiClient.post(`/workspaces/${id}/trash/${itemId}/restore`);
  },

  /** Permanently delete a trashed item — the point of no return. */
  async purgeTrashed(id: string, itemId: string): Promise<void> {
    await apiClient.delete(`/workspaces/${id}/trash/${itemId}`);
  },

  /** Download the full workspace bundle (zip). Owner only. */
  async exportZip(id: string): Promise<Blob> {
    const { data } = await apiClient.get(`/workspaces/${id}/export`, {
      responseType: "blob",
      timeout: 300_000,
    });
    return data as Blob;
  },

  /** Build a new workspace from a zip of Markdown files. */
  async importZip(
    file: File,
    title?: string
  ): Promise<{
    id: string;
    title: string;
    notes: number;
    folders: number;
    skipped: number;
  }> {
    const form = new FormData();
    form.append("file", file);
    if (title) form.append("title", title);
    const { data } = await apiClient.post("/workspaces/import", form, {
      headers: { "Content-Type": "multipart/form-data" },
      timeout: 300_000,
    });
    return data;
  },

  /** Upload a meeting recording — returns the job to poll. */
  async createMeetingJob(
    id: string,
    file: File,
    opts: { title?: string; language?: string } = {}
  ): Promise<MeetingJob> {
    const form = new FormData();
    form.append("file", file);
    if (opts.title) form.append("title", opts.title);
    if (opts.language) form.append("language", opts.language);
    const { data } = await apiClient.post<MeetingJob>(
      `/workspaces/${id}/meetings`,
      form,
      { headers: { "Content-Type": "multipart/form-data" }, timeout: 300_000 }
    );
    return data;
  },

  /** Recent meeting jobs, newest first (resume an in-flight one). */
  async listMeetingJobs(id: string): Promise<MeetingJob[]> {
    const { data } = await apiClient.get<MeetingJob[]>(
      `/workspaces/${id}/meetings`
    );
    return data;
  },

  async getMeetingJob(id: string, jobId: string): Promise<MeetingJob> {
    const { data } = await apiClient.get<MeetingJob>(
      `/workspaces/${id}/meetings/${jobId}`
    );
    return data;
  },

  /** Delete a comment (author or workspace owner). */
  async deleteComment(
    id: string,
    itemId: string,
    commentId: string
  ): Promise<void> {
    await apiClient.delete(
      `/workspaces/${id}/items/${itemId}/comments/${commentId}`
    );
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

  /** Every open card assigned to the caller, across all their
   *  workspaces — the "My work" page's data. */
  async myWork(): Promise<MyWorkResponse> {
    const { data } = await apiClient.get<MyWorkResponse>(
      "/workspaces/my-work"
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

  // ---- card attachments + cover ------------------------------------
  async addTaskAttachment(
    id: string,
    taskId: string,
    fileId: string
  ): Promise<WorkspaceTask> {
    const { data } = await apiClient.post<WorkspaceTask>(
      `/workspaces/${id}/tasks/${taskId}/attachments`,
      { file_id: fileId }
    );
    return data;
  },

  async setTaskAttachmentCover(
    id: string,
    taskId: string,
    fileId: string,
    cover: boolean
  ): Promise<WorkspaceTask> {
    const { data } = await apiClient.post<WorkspaceTask>(
      `/workspaces/${id}/tasks/${taskId}/attachments/${fileId}/cover`,
      { cover }
    );
    return data;
  },

  async deleteTaskAttachment(
    id: string,
    taskId: string,
    fileId: string
  ): Promise<WorkspaceTask> {
    const { data } = await apiClient.delete<WorkspaceTask>(
      `/workspaces/${id}/tasks/${taskId}/attachments/${fileId}`
    );
    return data;
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
