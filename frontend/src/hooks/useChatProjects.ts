/**
 * TanStack Query hooks for the Chat Projects API.
 *
 * Key conventions (mirror ``useStudy``):
 * - ``["chat-projects"]`` is the root key.
 * - Active vs archived use ``["chat-projects", "list", archived]``.
 * - Detail uses ``["chat-projects", "detail", id]``.
 * - Conversations-inside-a-project is ``["chat-projects", "conversations", id]``.
 * Invalidation is deliberately broad (whole list) on mutations — the
 * underlying endpoint is cheap and we only have ~dozens of projects.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  chatProjectsApi,
  type ChatProjectSummary,
  type ChatProjectDetail,
  type CreateChatProjectPayload,
  type UpdateChatProjectPayload,
} from "@/api/chatProjects";

const KEYS = {
  root: ["chat-projects"] as const,
  list: (archived: boolean) =>
    ["chat-projects", "list", archived] as const,
  detail: (id: string) => ["chat-projects", "detail", id] as const,
  conversations: (id: string) =>
    ["chat-projects", "conversations", id] as const,
};

export function useChatProjects(opts: { archived?: boolean } = {}) {
  const archived = opts.archived ?? false;
  return useQuery<ChatProjectSummary[]>({
    queryKey: KEYS.list(archived),
    queryFn: () => chatProjectsApi.list({ archived }),
  });
}

export function useChatProject(id: string | undefined) {
  return useQuery<ChatProjectDetail>({
    queryKey: id ? KEYS.detail(id) : ["chat-projects", "detail", "_"],
    queryFn: () => chatProjectsApi.get(id as string),
    enabled: Boolean(id),
  });
}

export function useChatProjectConversations(id: string | undefined) {
  return useQuery({
    queryKey: id ? KEYS.conversations(id) : ["chat-projects", "conversations", "_"],
    queryFn: () => chatProjectsApi.listConversations(id as string),
    enabled: Boolean(id),
  });
}

export function useCreateChatProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CreateChatProjectPayload) =>
      chatProjectsApi.create(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.root });
    },
  });
}

export function useUpdateChatProject(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateChatProjectPayload) =>
      chatProjectsApi.update(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.root });
    },
  });
}

export function useDeleteChatProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => chatProjectsApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.root });
      // Deleting a project un-projectises its conversations at the
      // DB layer (FK set-null), so the top-level sidebar must refresh
      // too.
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

export function useArchiveChatProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => chatProjectsApi.archive(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.root });
    },
  });
}

export function useUnarchiveChatProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => chatProjectsApi.unarchive(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.root });
    },
  });
}

export function usePinChatProjectFile(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) =>
      chatProjectsApi.pinFile(projectId, fileId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.detail(projectId) });
      qc.invalidateQueries({ queryKey: KEYS.list(false) });
    },
  });
}

export function useUnpinChatProjectFile(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) =>
      chatProjectsApi.unpinFile(projectId, fileId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.detail(projectId) });
      qc.invalidateQueries({ queryKey: KEYS.list(false) });
    },
  });
}

export function useMoveConversationToProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { projectId: string; conversationId: string }) =>
      chatProjectsApi.moveConversation(args.projectId, args.conversationId),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: KEYS.root });
      qc.invalidateQueries({ queryKey: KEYS.conversations(vars.projectId) });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

export function useRemoveConversationFromProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { projectId: string; conversationId: string }) =>
      chatProjectsApi.removeConversationFromProject(
        args.projectId,
        args.conversationId
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: KEYS.root });
      qc.invalidateQueries({ queryKey: KEYS.conversations(vars.projectId) });
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
