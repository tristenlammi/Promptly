import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { chatApi, type UpdateConversationPayload } from "@/api/chat";
import { useChatStore } from "@/store/chatStore";

const CONVERSATIONS_KEY = ["conversations"] as const;

export function useConversationsQuery() {
  const setConversations = useChatStore((s) => s.setConversations);
  return useQuery({
    queryKey: CONVERSATIONS_KEY,
    queryFn: async () => {
      const list = await chatApi.list();
      setConversations(list);
      return list;
    },
  });
}

export function useConversationQuery(id: string | null) {
  return useQuery({
    queryKey: ["conversation", id],
    queryFn: () => chatApi.get(id as string),
    enabled: Boolean(id),
  });
}

export function useUpdateConversation() {
  const qc = useQueryClient();
  const upsert = useChatStore((s) => s.upsertConversation);
  return useMutation({
    mutationFn: async ({ id, payload }: { id: string; payload: UpdateConversationPayload }) =>
      chatApi.update(id, payload),
    onSuccess: (updated) => {
      upsert(updated);
      qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
      qc.invalidateQueries({ queryKey: ["conversation", updated.id] });
    },
  });
}

export function useDeleteConversation() {
  const qc = useQueryClient();
  const remove = useChatStore((s) => s.removeConversation);
  return useMutation({
    mutationFn: (id: string) => chatApi.remove(id),
    onSuccess: (_data, id) => {
      remove(id);
      qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    },
  });
}

/** Full-text search over the user's conversation history. Disabled
 *  until the trimmed query is non-empty so we don't slam the API
 *  on every keystroke before the debounced value catches up.
 *  ``staleTime`` is generous because results only change when the
 *  user posts new messages; the sidebar already invalidates on send. */
export function useConversationSearchQuery(q: string) {
  const trimmed = q.trim();
  return useQuery({
    queryKey: ["conversation-search", trimmed],
    queryFn: () => chatApi.search(trimmed, 20),
    enabled: trimmed.length > 0,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });
}

// ---- Phase 4c — branching ----
export function useBranchConversation() {
  const qc = useQueryClient();
  const upsert = useChatStore((s) => s.upsertConversation);
  return useMutation({
    mutationFn: ({
      conversationId,
      messageId,
    }: {
      conversationId: string;
      messageId: string;
    }) => chatApi.branch(conversationId, messageId),
    onSuccess: (branch) => {
      upsert(branch);
      qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    },
  });
}

// ---- Phase 4b — shared conversations ----
const SHARES_KEY = (conversationId: string) =>
  ["conversation-shares", conversationId] as const;
const INVITES_KEY = ["share-invites"] as const;

export function useConversationShares(conversationId: string | null) {
  return useQuery({
    queryKey: SHARES_KEY(conversationId ?? ""),
    queryFn: () => chatApi.listShares(conversationId as string),
    enabled: Boolean(conversationId),
  });
}

export function useShareInvites() {
  // Polled every 60s so a fresh invite shows up without the user
  // having to refresh; cheap because the endpoint is a single
  // indexed lookup keyed on the caller's user id.
  return useQuery({
    queryKey: INVITES_KEY,
    queryFn: () => chatApi.listInvites(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

export function useCreateShare(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { username?: string; email?: string }) =>
      chatApi.createShare(conversationId, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SHARES_KEY(conversationId) });
    },
  });
}

export function useDeleteShare(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shareId: string) =>
      chatApi.deleteShare(conversationId, shareId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SHARES_KEY(conversationId) });
      // Also nuke conversation detail in case a participant just left.
      qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
    },
  });
}

export function useAcceptInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shareId: string) => chatApi.acceptInvite(shareId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: INVITES_KEY });
      qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    },
  });
}

export function useDeclineInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shareId: string) => chatApi.declineInvite(shareId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: INVITES_KEY });
    },
  });
}
