import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { authApi } from "@/api/auth";
import { chatApi, type UpdateConversationPayload } from "@/api/chat";
import { useAuthStore } from "@/store/authStore";
import { useChatStore } from "@/store/chatStore";
import { toast } from "@/store/toastStore";

const CONVERSATIONS_KEY = ["conversations"] as const;

/**
 * Remove a conversation from *this user's own* sidebar without deleting
 * the underlying chat — the "remove from my history" fallback for a chat
 * you can see but don't own (e.g. one that reached you before per-chat
 * sharing was retired, which the delete endpoint refuses to remove).
 * Persists the hidden id to ``users.settings.hidden_conversations`` so it
 * stays gone across reloads, and drops it from the local store now.
 */
// Serialise hide writes. The PATCH is a read-modify-write of the whole
// hidden_conversations array, so two near-simultaneous hides could each
// read the same base array and the second would clobber the first. We
// chain them so each link re-reads the latest settings (after the prior
// link's setUser committed) before building its new array.
let _hideChain: Promise<void> = Promise.resolve();

export function hideConversationFromHistory(id: string): Promise<void> {
  // Drop from the sidebar immediately for snappy UX.
  useChatStore.getState().removeConversation(id);
  _hideChain = _hideChain
    .catch(() => {}) // a prior hide's failure must not block later ones
    .then(async () => {
      const settings = useAuthStore.getState().user?.settings;
      const current = Array.isArray(settings?.hidden_conversations)
        ? (settings!.hidden_conversations as string[])
        : [];
      if (current.includes(id)) return;
      const fresh = await authApi.updatePreferences({
        hidden_conversations: [...current, id],
      });
      useAuthStore.getState().setUser(fresh);
    });
  return _hideChain;
}

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
      qc.invalidateQueries({ queryKey: ARCHIVED_KEY });
    },
  });
}

const ARCHIVED_KEY = ["conversations", "archived"] as const;

/** Archived chats for the dedicated Archive page. Kept separate from the
 *  sidebar store (``CONVERSATIONS_KEY``) so archived rows never leak into
 *  the active list. */
export function useArchivedConversationsQuery() {
  return useQuery({
    queryKey: ARCHIVED_KEY,
    queryFn: () => chatApi.list(200, 0, true),
  });
}

/** Archive a chat — drops it from the sidebar store immediately, then
 *  refreshes the archive list. */
export function useArchiveConversation() {
  const qc = useQueryClient();
  const remove = useChatStore((s) => s.removeConversation);
  const upsert = useChatStore((s) => s.upsertConversation);
  return useMutation({
    mutationFn: (id: string) => chatApi.archive(id),
    onSuccess: (_data, id) => {
      remove(id);
      qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
      qc.invalidateQueries({ queryKey: ARCHIVED_KEY });
      // The undo toast lives here, not at the call site: removing the row
      // unmounts the sidebar component, and TanStack skips per-call mutate
      // callbacks for unmounted components — a call-site toast never fires.
      toast.success("Chat archived", {
        action: {
          label: "Undo",
          onClick: () => {
            void chatApi.unarchive(id).then((updated) => {
              upsert(updated);
              void qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
              void qc.invalidateQueries({ queryKey: ARCHIVED_KEY });
            });
          },
        },
      });
    },
  });
}

/** Restore an archived chat — adds it back to the sidebar store and
 *  refreshes both lists. */
export function useUnarchiveConversation() {
  const qc = useQueryClient();
  const upsert = useChatStore((s) => s.upsertConversation);
  return useMutation({
    mutationFn: (id: string) => chatApi.unarchive(id),
    onSuccess: (updated) => {
      upsert(updated);
      qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
      qc.invalidateQueries({ queryKey: ARCHIVED_KEY });
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
