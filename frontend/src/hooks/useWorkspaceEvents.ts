/**
 * Live structure updates for an open workspace (R-187).
 *
 * The backend publishes a ``{"type": "structure"}`` event whenever anyone
 * creates, deletes, renames, moves, trashes or re-shares something in the
 * workspace (``GET /workspaces/{id}/events``). On one we refetch the tree,
 * overview, detail and archive — a teammate's new note or move used to stay
 * invisible until you navigated away and back.
 *
 * ``fetch`` rather than ``EventSource`` for the bearer header, with our own
 * capped reconnect — the same pattern as ``useDiscussionEvents``.
 */
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { API_BASE_URL, authHeader } from "@/api/client";
import { useAuthStore } from "@/store/authStore";

const BASE_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;
// Several changes in a burst (a bulk move, a template applying) → one refetch.
const DEBOUNCE_MS = 600;

export function useWorkspaceEvents(workspaceId: string | undefined) {
  const qc = useQueryClient();
  const me = useAuthStore((s) => s.user?.id ?? null);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const refresh = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        for (const key of ["tree", "overview", "detail", "archive", "conversations"]) {
          void qc.invalidateQueries({ queryKey: ["workspaces", key, workspaceId] });
        }
      }, DEBOUNCE_MS);
    };

    let boardDebounce: ReturnType<typeof setTimeout> | null = null;
    const refreshBoards = () => {
      if (boardDebounce) clearTimeout(boardDebounce);
      boardDebounce = setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ["workspaces", "tasks", workspaceId] });
        void qc.invalidateQueries({ queryKey: ["workspaces", "overview", workspaceId] });
      }, 300);
    };

    const connect = async () => {
      if (cancelled) return;
      controller = new AbortController();
      try {
        const resp = await fetch(`${API_BASE_URL}/workspaces/${workspaceId}/events`, {
          method: "GET",
          headers: { ...authHeader(), Accept: "text/event-stream" },
          signal: controller.signal,
        });
        // Gone or no access: stop — the page shows its own error state.
        if (resp.status === 404 || resp.status === 403) return;
        if (!resp.ok || !resp.body) throw new Error(`stream ${resp.status}`);
        attempt = 0;
        const reader = resp.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            try {
              const ev = JSON.parse(data) as {
                type?: string;
                actor_id?: string | null;
              };
              // Our own changes already refreshed what they touched.
              if (ev.actor_id === me) continue;
              if (ev.type === "structure") refresh();
              // A teammate moved or edited a card: re-sync the boards
              // (R-170 — they stayed stale until you navigated away).
              else if (ev.type === "board") refreshBoards();
            } catch {
              // A malformed frame isn't worth killing the stream over.
            }
          }
        }
      } catch {
        // A drop is expected (navigation, proxy timeout, sleep).
      }
      if (cancelled) return;
      attempt += 1;
      const delay = Math.min(BASE_RETRY_MS * 2 ** (attempt - 1), MAX_RETRY_MS);
      retryTimer = setTimeout(() => void connect(), delay);
    };

    void connect();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (debounce) clearTimeout(debounce);
      if (boardDebounce) clearTimeout(boardDebounce);
      controller?.abort();
    };
  }, [workspaceId, me, qc]);
}
