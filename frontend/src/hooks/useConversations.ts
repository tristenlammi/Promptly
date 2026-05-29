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
