import { apiClient } from "@/api/client";

/**
 * Recent — what you opened lately across Promptly (``backend/app/today/recents.py``):
 * docs, sheets, whiteboards, files, app files, chats, rooms and workspace
 * items, newest first. Each ``url`` is the in-app route straight back to it.
 */

export type RecentKind = "document" | "sheet" | "whiteboard" | "file" | "item" | "chat" | "room" | "workspace_item";

export interface RecentEntry {
  kind: RecentKind;
  id: string;
  title: string;
  /** Where it lives ("Sheet", the workspace's name, the space…). */
  detail: string;
  url: string;
  /** A finer type for the icon: an app kind, a workspace item kind, "image"… */
  icon: string;
  opened_at: string;
}

export const recentsApi = {
  list: (limit = 12) => apiClient.get<{ items: RecentEntry[] }>("/today/recents", { params: { limit } }).then((r) => r.data.items),
  clear: () => apiClient.delete("/today/recents").then(() => undefined),
  forget: (kind: RecentKind, id: string) => apiClient.delete(`/today/recents/${kind}/${id}`).then(() => undefined),
  opened: (kind: RecentKind, id: string) => apiClient.post("/today/recents", { kind, id }).then(() => undefined),
};

// One post per thing per minute, however often a page re-renders or
// re-mounts (the server debounces too).
const sent = new Map<string, number>();
const GAP_MS = 60_000;

/** "I opened this" — fire-and-forget, debounced. */
export function recordOpen(kind: RecentKind, id: string | null | undefined): void {
  if (!id) return;
  const key = `${kind}:${id}`;
  const now = Date.now();
  if (now - (sent.get(key) ?? 0) < GAP_MS) return;
  sent.set(key, now);
  void recentsApi.opened(kind, id).catch(() => undefined);
}
