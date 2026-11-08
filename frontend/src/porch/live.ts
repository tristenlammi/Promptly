/**
 * Porch's live feed: one fetch-based SSE stream per open Porch app
 * (``GET /api/porch/events``), copied from Rooms' (``rooms/live.ts``):
 * ``fetch`` not ``EventSource`` because auth is a bearer token in memory; we
 * reconnect ourselves with a capped backoff, and every reconnect after the
 * first catches up on what was missed.
 *
 * Events carry ids only. A new post is fetched through the checked
 * ``GET /posts/{id}``; if it's in a group you've ticked, it joins the
 * "↑ N new posts" pill rather than jumping into the list under your thumb.
 */
import { useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useEffect } from "react";

import { API_BASE_URL, authHeader, refreshAccessToken } from "@/api/client";
import { PORCH_EVENTS_PATH, porchApi, type Bootstrap, type PorchEvent, type PostPage } from "@/api/porch";

import { BOOTSTRAP_KEY, feedKey, groupsChanged, listPosts, putPost } from "./cache";
import { usePorchStore } from "./store";

const BASE_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;
// The server pings every 20 s; silence for longer is a dead connection a
// proxy is still holding open. Drop it and reconnect (which also catches up).
const STALL_MS = 50000;

export function usePorchEvents(enabled: boolean) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let connectedBefore = false;
    let lastByte = Date.now();
    const watchdog = setInterval(() => {
      if (controller && Date.now() - lastByte > STALL_MS) {
        lastByte = Date.now();
        controller.abort();
      }
    }, 10000);

    const resync = () => {
      void qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
      void checkFeedHead(qc);
    };

    const open = () =>
      fetch(`${API_BASE_URL}${PORCH_EVENTS_PATH}`, {
        method: "GET",
        headers: { ...authHeader(), Accept: "text/event-stream" },
        signal: controller?.signal,
      });

    const connect = async () => {
      if (cancelled) return;
      controller = new AbortController();
      lastByte = Date.now();
      try {
        let resp = await open();
        if (resp.status === 401 && (await refreshAccessToken())) resp = await open();
        if (!resp.ok || !resp.body) throw new Error(`Porch stream failed (${resp.status})`);
        attempt = 0;
        if (connectedBefore) resync();
        connectedBefore = true;
        const reader = resp.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          lastByte = Date.now();
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
              void applyPorchEvent(qc, JSON.parse(data) as PorchEvent);
            } catch {
              // A malformed frame shouldn't kill the stream.
            }
          }
        }
      } catch {
        // Expected: navigation, proxy timeout, sleep.
      }
      if (cancelled) return;
      attempt += 1;
      retryTimer = setTimeout(() => void connect(), Math.min(BASE_RETRY_MS * 2 ** (attempt - 1), MAX_RETRY_MS));
    };

    void connect();

    // Back to the window: catch up even if the stream looked alive.
    let lastFocus = 0;
    const onFocus = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastFocus < 5000) return;
      lastFocus = now;
      resync();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    return () => {
      cancelled = true;
      clearInterval(watchdog);
      if (retryTimer) clearTimeout(retryTimer);
      controller?.abort();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [qc, enabled]);
}

function gone(err: unknown): boolean {
  return isAxiosError(err) && (err.response?.status === 404 || err.response?.status === 403);
}

/** Is this post one the open feed would show (a ticked group, the filter)? */
function belongsInFeed(qc: QueryClient, post: { groups: { id: string }[]; kind: string }): boolean {
  const b = qc.getQueryData<Bootstrap>(BOOTSTRAP_KEY);
  if (!b) return false;
  const ticked = new Set(b.groups.filter((g) => g.in_feed).map((g) => g.id));
  if (!post.groups.some((g) => ticked.has(g.id))) return false;
  return !usePorchStore.getState().photosOnly || post.kind === "photo" || post.kind === "video";
}

function inFeed(qc: QueryClient, id: string): boolean {
  const photos = usePorchStore.getState().photosOnly;
  return listPosts(qc.getQueryData<InfiniteData<PostPage, string | null>>(feedKey(photos))).some((p) => p.id === id);
}

export async function applyPorchEvent(qc: QueryClient, ev: PorchEvent): Promise<void> {
  switch (ev.type) {
    case "post": {
      // Other lists (a group's page, a profile) refresh next time they're opened.
      void qc.invalidateQueries({ queryKey: ["porch", "list", "group"], refetchType: "none" });
      void qc.invalidateQueries({ queryKey: ["porch", "list", "user"], refetchType: "none" });
      let post;
      try {
        post = await porchApi.post(ev.post_id);
      } catch {
        return;
      }
      if (inFeed(qc, post.id)) return;
      if (post.mine) {
        // Posted from another device (or this one): straight in.
        void qc.invalidateQueries({ queryKey: feedKey(usePorchStore.getState().photosOnly) });
        return;
      }
      if (belongsInFeed(qc, post)) usePorchStore.getState().addFresh(post.id);
      return;
    }
    case "post_change": {
      try {
        putPost(qc, ev.post_id, await porchApi.post(ev.post_id));
      } catch (err) {
        if (gone(err)) putPost(qc, ev.post_id, null);
      }
      return;
    }
    case "group":
    case "invite":
      groupsChanged(qc, ev.group_id);
      return;
  }
}

/** After a reconnect: anything newer than the top of the feed is "new". */
async function checkFeedHead(qc: QueryClient): Promise<void> {
  const photos = usePorchStore.getState().photosOnly;
  const cur = listPosts(qc.getQueryData<InfiniteData<PostPage, string | null>>(feedKey(photos)));
  if (!cur.length) {
    void qc.invalidateQueries({ queryKey: feedKey(photos) });
    return;
  }
  try {
    const head = await porchApi.feed(null, photos);
    const top = cur[0].created_at;
    const known = new Set(cur.map((p) => p.id));
    for (const p of head.posts) {
      if (p.created_at > top && !known.has(p.id) && !p.mine) usePorchStore.getState().addFresh(p.id);
    }
  } catch {
    /* next time */
  }
}
