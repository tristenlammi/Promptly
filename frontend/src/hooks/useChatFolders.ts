import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  chatFoldersApi,
  type ChatFolder,
  type ChatFolderInput,
} from "@/api/folders";

const FOLDERS_KEY = ["chat-folders"] as const;

/** Load the user's chat folders. Cheap list; drives the sidebar folder
 *  section and the "Move to folder" menu. */
export function useChatFoldersQuery() {
  return useQuery({
    queryKey: FOLDERS_KEY,
    queryFn: chatFoldersApi.list,
  });
}

export function useCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ChatFolderInput) => chatFoldersApi.create(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: FOLDERS_KEY });
    },
  });
}

export function useUpdateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Partial<ChatFolderInput>;
    }) => chatFoldersApi.update(id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: FOLDERS_KEY });
    },
  });
}

export function useDeleteFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => chatFoldersApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: FOLDERS_KEY });
      // Chats fall back to top-level (server SET NULL) — refresh the list so
      // they resurface in the date buckets immediately.
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

export type { ChatFolder };
