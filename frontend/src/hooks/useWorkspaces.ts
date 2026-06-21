/**
 * TanStack Query hooks for the Workspaces API.
 *
 * Key conventions (mirror ``useStudy``):
 * - ``["workspaces"]`` is the root key.
 * - Active vs archived use ``["workspaces", "list", archived]``.
 * - Detail uses ``["workspaces", "detail", id]``.
 * - Conversations-inside-a-workspace is ``["workspaces", "conversations", id]``.
 * Invalidation is deliberately broad (whole list) on mutations — the
 * underlying endpoint is cheap and we only have ~dozens of workspaces.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  workspacesApi,
  type WorkspaceSummary,
  type WorkspaceDetail,
  type CreateWorkspacePayload,
  type WorkspaceInviteRow,
  type WorkspaceShareRow,
  type UpdateWorkspacePayload,
  type WorkspaceItemNode,
  type CreateWorkspaceItemPayload,
  type UpdateWorkspaceItemPayload,
  type MoveWorkspaceItemPayload,
  type WorkspaceTaskCreatePayload,
  type WorkspaceTaskUpdatePayload,
  type BoardConfig,
  type WorkspaceMemory,
} from "@/api/workspaces";

const KEYS = {
  root: ["workspaces"] as const,
  list: (archived: boolean) =>
    ["workspaces", "list", archived] as const,
  detail: (id: string) => ["workspaces", "detail", id] as const,
  conversations: (id: string) =>
    ["workspaces", "conversations", id] as const,
  usage: (id: string) => ["workspaces", "usage", id] as const,
  shares: (id: string) => ["workspaces", "shares", id] as const,
  tree: (id: string) => ["workspaces", "tree", id] as const,
  archive: (id: string) => ["workspaces", "archive", id] as const,
  overview: (id: string) => ["workspaces", "overview", id] as const,
  tasks: (id: string) => ["workspaces", "tasks", id] as const,
  backlinks: (workspaceId: string, itemId: string) =>
    ["workspaces", "backlinks", workspaceId, itemId] as const,
  invites: ["workspace-invites"] as const,
};

export function useWorkspaces(opts: { archived?: boolean } = {}) {
  const archived = opts.archived ?? false;
  return useQuery<WorkspaceSummary[]>({
    queryKey: KEYS.list(archived),
    queryFn: () => workspacesApi.list({ archived }),
  });
}

export function useWorkspace(id: string | undefined) {
  return useQuery<WorkspaceDetail>({
    queryKey: id ? KEYS.detail(id) : ["workspaces", "detail", "_"],
    queryFn: () => workspacesApi.get(id as string),
    enabled: Boolean(id),
    // Poll while files are mid-index so the Files tab flips from
    // "indexing…" to "searchable" without a manual refresh. Stops as
    // soon as nothing is in flight (the common steady state).
    refetchInterval: (query) =>
      (query.state.data?.indexing_count ?? 0) > 0 ? 2500 : false,
  });
}

export function useWorkspaceConversations(id: string | undefined) {
  return useQuery({
    queryKey: id ? KEYS.conversations(id) : ["workspaces", "conversations", "_"],
    queryFn: () => workspacesApi.listConversations(id as string),
    enabled: Boolean(id),
  });
}

export function useWorkspaceUsage(id: string | undefined) {
  return useQuery({
    queryKey: id ? KEYS.usage(id) : ["workspaces", "usage", "_"],
    queryFn: () => workspacesApi.usage(id as string),
    enabled: Boolean(id),
  });
}

// ---------------------------------------------------------------------
// Navigator tree (Phase 1c)
//
// The tree query holds folders + notes (nested) and chats (flat at root).
// Every mutation invalidates the same tree key — the endpoint is cheap
// and a workspace holds at most a few dozen items, so optimistic merging
// isn't worth the complexity here.
// ---------------------------------------------------------------------

export function useWorkspaceTree(id: string | undefined) {
  return useQuery<WorkspaceItemNode[]>({
    queryKey: id ? KEYS.tree(id) : ["workspaces", "tree", "_"],
    queryFn: () => workspacesApi.tree(id as string),
    enabled: Boolean(id),
    // Poll only while something is *actively embedding* so the spinner
    // clears without a manual refresh. We intentionally do NOT poll on
    // ``queued`` — an empty note/canvas (or a workspace with no embedding
    // provider) parks there forever, which would otherwise refetch every
    // few seconds indefinitely.
    refetchInterval: (query) => {
      const anyIndexing = (query.state.data ?? []).some(function check(
        node: WorkspaceItemNode
      ): boolean {
        if (node.indexing_status === "embedding") return true;
        return node.children.some(check);
      });
      return anyIndexing ? 2500 : false;
    },
  });
}

export function useCreateWorkspaceItem(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateWorkspaceItemPayload) =>
      workspacesApi.createItem(workspaceId, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.tree(workspaceId) });
    },
  });
}

export function useUpdateWorkspaceItem(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      itemId: string;
      payload: UpdateWorkspaceItemPayload;
    }) => workspacesApi.updateItem(workspaceId, args.itemId, args.payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.tree(workspaceId) });
    },
  });
}

export function useMoveWorkspaceItem(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      itemId: string;
      payload: MoveWorkspaceItemPayload;
    }) => workspacesApi.moveItem(workspaceId, args.itemId, args.payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.tree(workspaceId) });
    },
  });
}

export function useDeleteWorkspaceItem(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) =>
      workspacesApi.deleteItem(workspaceId, itemId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.tree(workspaceId) });
      qc.invalidateQueries({ queryKey: KEYS.archive(workspaceId) });
    },
  });
}

export function useWorkspaceArchive(id: string | undefined) {
  return useQuery<WorkspaceItemNode[]>({
    queryKey: id ? KEYS.archive(id) : ["workspaces", "archive", "_"],
    queryFn: () => workspacesApi.archivedItems(id as string),
    enabled: Boolean(id),
  });
}

/** Notes that wiki-link to ``itemId`` (the "Linked from" / backlinks
 *  panel in the note pane). Gated on both ids being present so the pane
 *  can call it unconditionally. */
export function useItemBacklinks(
  workspaceId: string | undefined,
  itemId: string | undefined
) {
  return useQuery<WorkspaceItemNode[]>({
    queryKey:
      workspaceId && itemId
        ? KEYS.backlinks(workspaceId, itemId)
        : ["workspaces", "backlinks", "_"],
    queryFn: () =>
      workspacesApi.backlinks(workspaceId as string, itemId as string),
    enabled: Boolean(workspaceId && itemId),
  });
}

export function useWorkspaceOverview(id: string | undefined) {
  return useQuery({
    queryKey: id ? KEYS.overview(id) : ["workspaces", "overview", "_"],
    queryFn: () => workspacesApi.overview(id as string),
    enabled: Boolean(id),
  });
}

/** The workspace structural map (the catalog injected into chat context),
 *  surfaced so the user can see what the AI sees. */
export function useWorkspaceMap(id: string | undefined) {
  return useQuery({
    queryKey: id ? ["workspaces", "map", id] : ["workspaces", "map", "_"],
    queryFn: () => workspacesApi.map(id as string),
    enabled: Boolean(id),
  });
}

export function useWorkspaceMemory(id: string | undefined) {
  return useQuery<WorkspaceMemory>({
    queryKey: id
      ? ["workspaces", "memory", id]
      : ["workspaces", "memory", "_"],
    queryFn: () => workspacesApi.getMemory(id as string),
    enabled: Boolean(id),
  });
}

export function useSaveWorkspaceMemory(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (markdown: string) => workspacesApi.saveMemory(id, markdown),
    onSuccess: (data) => {
      qc.setQueryData(["workspaces", "memory", id], data);
      // The memory file is pinned, so its edit shifts per-turn context +
      // the map; refresh detail so the budget bar/map reflect it.
      qc.invalidateQueries({ queryKey: KEYS.detail(id) });
      qc.invalidateQueries({ queryKey: ["workspaces", "map", id] });
    },
  });
}

export function useRegenerateWorkspaceMemory(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => workspacesApi.regenerateMemory(id),
    onSuccess: (data) => {
      qc.setQueryData(["workspaces", "memory", id], data);
      qc.invalidateQueries({ queryKey: KEYS.detail(id) });
      qc.invalidateQueries({ queryKey: ["workspaces", "map", id] });
    },
  });
}

export function useAppendWorkspaceMemory(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => workspacesApi.appendMemory(id, text),
    onSuccess: (data) => {
      qc.setQueryData(["workspaces", "memory", id], data);
      qc.invalidateQueries({ queryKey: KEYS.detail(id) });
      qc.invalidateQueries({ queryKey: ["workspaces", "map", id] });
    },
  });
}


// ---------------------------------------------------------------------
// Task list — first-class, project-level to-dos
// ---------------------------------------------------------------------
export function useTaskComments(
  workspaceId: string,
  taskId: string | undefined
) {
  return useQuery({
    queryKey: ["workspaces", "task-comments", workspaceId, taskId],
    queryFn: () => workspacesApi.taskComments(workspaceId, taskId as string),
    enabled: Boolean(taskId),
  });
}

export function useAddTaskComment(workspaceId: string, taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) =>
      workspacesApi.addTaskComment(workspaceId, taskId, text),
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: ["workspaces", "task-comments", workspaceId, taskId],
      }),
  });
}

export function useDeleteTaskComment(workspaceId: string, taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) =>
      workspacesApi.deleteTaskComment(workspaceId, taskId, commentId),
    onSuccess: () =>
      qc.invalidateQueries({
        queryKey: ["workspaces", "task-comments", workspaceId, taskId],
      }),
  });
}

export function useAddTaskAttachment(workspaceId: string, taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) =>
      workspacesApi.addTaskAttachment(workspaceId, taskId, fileId),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.tasks(workspaceId) }),
  });
}

export function useSetTaskAttachmentCover(
  workspaceId: string,
  taskId: string
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { fileId: string; cover: boolean }) =>
      workspacesApi.setTaskAttachmentCover(
        workspaceId,
        taskId,
        vars.fileId,
        vars.cover
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.tasks(workspaceId) }),
  });
}

export function useDeleteTaskAttachment(workspaceId: string, taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) =>
      workspacesApi.deleteTaskAttachment(workspaceId, taskId, fileId),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.tasks(workspaceId) }),
  });
}

export function useWorkspaceItem(
  workspaceId: string,
  itemId: string | undefined
) {
  return useQuery({
    queryKey: ["workspaces", "item", workspaceId, itemId],
    queryFn: () => workspacesApi.getItem(workspaceId, itemId as string),
    enabled: Boolean(itemId),
  });
}

export function useSetBoardConfig(workspaceId: string, itemId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: BoardConfig) =>
      workspacesApi.setItemConfig(workspaceId, itemId, config),
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["workspaces", "item", workspaceId, itemId],
      });
    },
  });
}

export function useWorkspaceTasks(
  id: string | undefined,
  boardItemId?: string
) {
  return useQuery({
    queryKey: id
      ? [...KEYS.tasks(id), boardItemId ?? "all"]
      : ["workspaces", "tasks", "_"],
    queryFn: () => workspacesApi.tasks(id as string, boardItemId),
    enabled: Boolean(id),
  });
}

export function useCreateWorkspaceTask(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: WorkspaceTaskCreatePayload) =>
      workspacesApi.createTask(workspaceId, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.tasks(workspaceId) });
      qc.invalidateQueries({ queryKey: KEYS.overview(workspaceId) });
    },
  });
}

export function useUpdateWorkspaceTask(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      taskId: string;
      payload: WorkspaceTaskUpdatePayload;
    }) => workspacesApi.updateTask(workspaceId, vars.taskId, vars.payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.tasks(workspaceId) });
      qc.invalidateQueries({ queryKey: KEYS.overview(workspaceId) });
    },
  });
}

export function useDeleteWorkspaceTask(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) =>
      workspacesApi.deleteTask(workspaceId, taskId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.tasks(workspaceId) });
      qc.invalidateQueries({ queryKey: KEYS.overview(workspaceId) });
    },
  });
}

export function useSetItemContext(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { itemId: string; enabled: boolean }) =>
      workspacesApi.setItemContext(workspaceId, vars.itemId, vars.enabled),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.tree(workspaceId) });
      qc.invalidateQueries({ queryKey: KEYS.detail(workspaceId) });
    },
  });
}

export function useSetItemPinned(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { itemId: string; pinned: boolean }) =>
      workspacesApi.setItemPinned(workspaceId, vars.itemId, vars.pinned),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.tree(workspaceId) });
    },
  });
}

export function useSetFileContext(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { fileId: string; enabled: boolean }) =>
      workspacesApi.setFileContext(workspaceId, vars.fileId, vars.enabled),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.detail(workspaceId) });
    },
  });
}

export function useArchiveWorkspaceItem(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) =>
      workspacesApi.archiveItem(workspaceId, itemId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.tree(workspaceId) });
      qc.invalidateQueries({ queryKey: KEYS.archive(workspaceId) });
    },
  });
}

export function useUnarchiveWorkspaceItem(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) =>
      workspacesApi.unarchiveItem(workspaceId, itemId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.tree(workspaceId) });
      qc.invalidateQueries({ queryKey: KEYS.archive(workspaceId) });
    },
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateWorkspacePayload) =>
      workspacesApi.create(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.root });
    },
  });
}

export function useUpdateWorkspace(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateWorkspacePayload) =>
      workspacesApi.update(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.root });
    },
  });
}

export function useDeleteWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => workspacesApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.root });
      // Deleting a workspace detaches its conversations at the
      // DB layer (FK set-null), so the top-level sidebar must refresh
      // too.
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

export function useArchiveWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => workspacesApi.archive(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.root });
    },
  });
}

export function useUnarchiveWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => workspacesApi.unarchive(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.root });
    },
  });
}

export function usePinWorkspaceFile(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) =>
      workspacesApi.pinFile(workspaceId, fileId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.detail(workspaceId) });
      qc.invalidateQueries({ queryKey: KEYS.list(false) });
    },
  });
}

export function useUnpinWorkspaceFile(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) =>
      workspacesApi.unpinFile(workspaceId, fileId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.detail(workspaceId) });
      qc.invalidateQueries({ queryKey: KEYS.list(false) });
    },
  });
}

export function useMoveConversationToWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { workspaceId: string; conversationId: string }) =>
      workspacesApi.moveConversation(args.workspaceId, args.conversationId),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: KEYS.root });
      qc.invalidateQueries({ queryKey: KEYS.conversations(vars.workspaceId) });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

export function useRemoveConversationFromWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { workspaceId: string; conversationId: string }) =>
      workspacesApi.removeConversationFromWorkspace(
        args.workspaceId,
        args.conversationId
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: KEYS.root });
      qc.invalidateQueries({ queryKey: KEYS.conversations(vars.workspaceId) });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

// ---------------------------------------------------------------------
// Workspace sharing — owner side
// ---------------------------------------------------------------------

/** List existing share rows (pending + accepted + declined) on the
 *  workspace. Passing ``null`` / ``undefined`` disables the query so
 *  the share modal can gate the fetch on open. */
export function useWorkspaceShares(workspaceId: string | null | undefined) {
  return useQuery<WorkspaceShareRow[]>({
    queryKey: workspaceId
      ? KEYS.shares(workspaceId)
      : ["workspaces", "shares", "_"],
    queryFn: () => workspacesApi.listShares(workspaceId as string),
    enabled: Boolean(workspaceId),
  });
}

export function useCreateWorkspaceShare(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      username?: string;
      email?: string;
      role?: "editor" | "viewer";
    }) => workspacesApi.createShare(workspaceId, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.shares(workspaceId) });
      qc.invalidateQueries({ queryKey: KEYS.detail(workspaceId) });
    },
  });
}

export function useDeleteWorkspaceShare(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shareId: string) =>
      workspacesApi.deleteShare(workspaceId, shareId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.shares(workspaceId) });
      qc.invalidateQueries({ queryKey: KEYS.detail(workspaceId) });
      // Revoking a share may change the invitee's accessible
      // conversations — make sure their sidebar repaints.
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

// ---------------------------------------------------------------------
// Workspace sharing — invitee side
// ---------------------------------------------------------------------

/** Pending workspace invites for the current user. Polled on the same
 *  cadence as conversation invites (every 60 s) so a freshly-
 *  invited teammate sees the badge without a manual refresh. */
export function useWorkspaceInvites() {
  return useQuery<WorkspaceInviteRow[]>({
    queryKey: KEYS.invites,
    queryFn: () => workspacesApi.listInvites(),
    refetchInterval: 60_000,
  });
}

export function useAcceptWorkspaceInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shareId: string) => workspacesApi.acceptInvite(shareId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.invites });
      qc.invalidateQueries({ queryKey: KEYS.root });
      // Accepting widens the caller's accessible-chat set — refresh
      // the main conversation list too.
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

export function useDeclineWorkspaceInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shareId: string) => workspacesApi.declineInvite(shareId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.invites });
    },
  });
}

export function useReindexWorkspace(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => workspacesApi.reindex(workspaceId),
    onSuccess: () => {
      // Refresh the detail so the Files tab starts polling for indexing progress.
      qc.invalidateQueries({ queryKey: KEYS.detail(workspaceId) });
    },
  });
}

/** Bulk-detach every conversation from the workspace (set workspace_id → null).
 *  Conversations are preserved and return to the top-level chat list.
 *  Owner-only; used from the archived-workspace banner as a "dissolve" action. */
export function useBulkRemoveConversationsFromWorkspace(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => workspacesApi.removeAllConversations(workspaceId),
    onSuccess: () => {
      // Conversations list inside the workspace is now empty.
      qc.invalidateQueries({ queryKey: KEYS.conversations(workspaceId) });
      // The top-level sidebar must refresh so the moved-out chats reappear.
      qc.invalidateQueries({ queryKey: ["conversations"] });
      // Workspace card counts need to update too.
      qc.invalidateQueries({ queryKey: KEYS.detail(workspaceId) });
    },
  });
}
