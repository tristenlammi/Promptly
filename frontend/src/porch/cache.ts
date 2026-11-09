/**
 * Porch's react-query keys and the small helpers that keep cached posts and
 * groups in step after a change (yours, or one the live feed told us about).
 *
 * Every list of posts (the feed, a group's posts, a profile's tabs) lives
 * under ``LISTS`` as an infinite query of ``PostPage``s, so one helper can
 * replace or drop a post wherever it shows.
 */
import type { InfiniteData, QueryClient } from "@tanstack/react-query";

import { porchApi, type Bootstrap, type PorchPost, type PostPage } from "@/api/porch";

export const ROOT = ["porch"] as const;
export const BOOTSTRAP_KEY = ["porch", "bootstrap"] as const;
export const LISTS = ["porch", "list"] as const;
export const feedKey = (photos: boolean) => ["porch", "list", "feed", photos] as const;
export const groupPostsKey = (id: string, photos: boolean) => ["porch", "list", "group", id, photos] as const;
export const userPostsKey = (id: string, tab: string) => ["porch", "list", "user", id, tab] as const;
export const postKey = (id: string) => ["porch", "post", id] as const;
export const groupKey = (id: string) => ["porch", "group", id] as const;
export const membersKey = (id: string) => ["porch", "members", id] as const;
export const pendingKey = (id: string) => ["porch", "pending", id] as const;
/** A group's Reports tab (its admins), open and handled. */
export const reportsKey = (id: string, status: "open" | "handled" = "open") => ["porch", "reports", id, status] as const;
export const discoverKey = (q: string) => ["porch", "discover", q] as const;
export const profileKey = (id: string) => ["porch", "profile", id] as const;
export const savedKey = ["porch", "list", "saved"] as const;
export const commentsKey = (postId: string) => ["porch", "comments", postId] as const;
export const ACTIVITY_KEY = ["porch", "activity"] as const;
export const NOTIFY_KEY = ["porch", "notifications"] as const;
/** Stories (WP-P2.2): the row, one person's live ones, and your archive. */
export const STORIES_KEY = ["porch", "stories"] as const;
export const STORIES_ROW_KEY = ["porch", "stories", "row"] as const;
export const userStoriesKey = (id: string, feed: boolean) => ["porch", "stories", "u", id, feed] as const;
export const storyViewersKey = (id: string) => ["porch", "stories", "viewers", id] as const;
export const STORY_ARCHIVE_KEY = ["porch", "stories", "archive"] as const;
/** Highlights (WP-P2.4): yours, and someone's as you see them. */
export const HIGHLIGHTS_KEY = ["porch", "highlights", "me"] as const;
export const userHighlightsKey = (id: string) => ["porch", "highlights", "u", id] as const;
export const ALERTS_KEY = ["porch", "alerts"] as const;

/** Change one post wherever it's cached (lists and its own query). */
export function patchPost(qc: QueryClient, id: string, fn: (p: PorchPost) => PorchPost): void {
  qc.setQueriesData<Pages>({ queryKey: LISTS }, (data) => {
    if (!data) return data;
    let changed = false;
    const pages = data.pages.map((p) => {
      if (!p.posts.some((x) => x.id === id)) return p;
      changed = true;
      return { ...p, posts: p.posts.map((x) => (x.id === id ? fn(x) : x)) };
    });
    return changed ? { ...data, pages } : data;
  });
  const own = qc.getQueryData<PorchPost>(postKey(id));
  if (own) qc.setQueryData(postKey(id), fn(own));
}

/** The cached copy of a post (its own query, else from a list). */
export function cachedPost(qc: QueryClient, id: string): PorchPost | undefined {
  const own = qc.getQueryData<PorchPost>(postKey(id));
  if (own) return own;
  for (const [, data] of qc.getQueriesData<Pages>({ queryKey: LISTS })) {
    const hit = data?.pages.flatMap((p) => p.posts).find((p) => p.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/** A post's comments or reactions changed: refetch it where it's shown. */
export async function refreshPost(qc: QueryClient, id: string): Promise<void> {
  if (!cachedPost(qc, id)) return; // not on screen anywhere
  try {
    putPost(qc, id, await porchApi.post(id));
  } catch {
    /* gone or not shared any more: the next list refresh drops it */
  }
}

type Pages = InfiniteData<PostPage, string | null>;

/** Put a changed post into every list and its own query (``null`` drops it:
 *  deleted, or no longer shared with you). */
export function putPost(qc: QueryClient, id: string, post: PorchPost | null): void {
  qc.setQueriesData<Pages>({ queryKey: LISTS }, (data) => {
    if (!data) return data;
    let changed = false;
    const pages = data.pages.map((p) => {
      if (!p.posts.some((x) => x.id === id)) return p;
      changed = true;
      return { ...p, posts: post ? p.posts.map((x) => (x.id === id ? post : x)) : p.posts.filter((x) => x.id !== id) };
    });
    return changed ? { ...data, pages } : data;
  });
  if (post) qc.setQueryData(postKey(id), post);
  else qc.removeQueries({ queryKey: postKey(id), exact: true });
}

/** Every post id in a list's pages, newest first. */
export function listPosts(data: { pages: PostPage[] } | undefined): PorchPost[] {
  const seen = new Set<string>();
  const out: PorchPost[] = [];
  for (const p of data?.pages ?? []) {
    for (const post of p.posts) {
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      out.push(post);
    }
  }
  return out;
}

export function updateBootstrap(qc: QueryClient, fn: (b: Bootstrap) => Bootstrap): void {
  const cur = qc.getQueryData<Bootstrap>(BOOTSTRAP_KEY);
  if (cur) qc.setQueryData(BOOTSTRAP_KEY, fn(cur));
}

/** After joining, leaving or a group's settings changing: groups, pages and lists. */
export function groupsChanged(qc: QueryClient, groupId?: string): void {
  void qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
  void qc.invalidateQueries({ queryKey: ["porch", "discover"] });
  void qc.invalidateQueries({ queryKey: ACTIVITY_KEY });
  if (groupId) {
    void qc.invalidateQueries({ queryKey: groupKey(groupId) });
    void qc.invalidateQueries({ queryKey: membersKey(groupId) });
    void qc.invalidateQueries({ queryKey: pendingKey(groupId) });
  }
}
