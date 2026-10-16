import type { FileItem } from "@/api/files";
import { useComposerStore } from "@/store/composerStore";
import { toast } from "@/store/toastStore";

/** Most files one "Ask about these" attaches — more than this stops being
 *  a useful prompt and starts being a context-window problem. */
export const ASK_MAX_FILES = 10;

/**
 * "Ask about this" (Part C §6, P0 + P1): start a new chat with these files
 * attached — your own, shared with you, or in a workspace you're in (the
 * chat resolves them by access, WP-3.5). ``text`` pre-fills the question
 * ("Summarize this file.").
 */
export function askAboutFiles(
  files: Pick<FileItem, "id" | "filename" | "mime_type" | "size_bytes">[],
  navigate: (to: string) => void,
  text = ""
): void {
  if (files.length === 0) return;
  const picked = files.slice(0, ASK_MAX_FILES);
  if (files.length > ASK_MAX_FILES) {
    toast.info(`Attached the first ${ASK_MAX_FILES} files.`);
  }
  useComposerStore.getState().saveDraft("__new__", {
    text,
    attachments: picked.map((f) => ({
      id: f.id,
      filename: f.filename,
      mime_type: f.mime_type,
      size_bytes: f.size_bytes,
    })),
  });
  navigate("/chat");
}
