/**
 * Porch's react-query keys and the small helpers that keep cached posts and
 * groups in step after a change (yours, or one the live feed told us about).
 *
 * Every list of posts (the feed, a group's posts, a profile's tabs) lives
 * under ``LISTS`` as an infinite query of ``PostPage``s, so one helper can
 * replace or drop a post wherever it shows.
 */
import type { InfiniteData, QueryClient } from "@tanstack/react-query";

import type { Bootstrap, PorchPost, PostPage } from "@/api/porch";

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
export const discoverKey = (q: string) => ["porch", "discover", q] as const;
export const profileKey = (id: string) => ["porch", "profile", id] as const;

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
  if (groupId) {
    void qc.invalidateQueries({ queryKey: groupKey(groupId) });
    void qc.invalidateQueries({ queryKey: membersKey(groupId) });
    void qc.invalidateQueries({ queryKey: pendingKey(groupId) });
  }
}
