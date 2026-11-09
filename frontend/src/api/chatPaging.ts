import type { ConversationSummary } from "./types";

// Plain helpers, no API client: the Passwords page's copy of the sidebar
// (passwords/ui/PromptlyNav.tsx) pages the chat list the same way.

/** Rows per page of the conversation list. */
export const CONVERSATION_PAGE_SIZE = 50;

/** Where the next page of the conversation list starts: built from the
 *  previous page's last row (the server pages by these keys, so chats that
 *  move while you scroll don't get skipped or repeated). */
export function conversationCursor(c: Pick<ConversationSummary, "pinned" | "updated_at" | "id" | "archived_at">, archived = false): string {
  return archived
    ? `${c.archived_at}|${c.id}`
    : `${c.pinned ? 1 : 0}|${c.updated_at}|${c.id}`;
}
