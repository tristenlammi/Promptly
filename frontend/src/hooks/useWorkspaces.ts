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
