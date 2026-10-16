import { useCallback, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import type { HocuspocusProvider } from "@hocuspocus/provider";

import { documentCommentsApi, type DocComment } from "@/api/documentComments";

/**
 * A document's comment threads (WP-4.5, R-227): fetched from the backend,
 * pushed into the editor as highlights, and refetched whenever someone in
 * the collab room says they changed (a stateless "comments-changed" ping)
 * or the tab regains focus. ``changed()`` refetches and tells the room.
 */
export interface CommentThread {
  root: DocComment;
  replies: DocComment[];
}

export function useDocComments(
  documentId: string | undefined,
  editor: Editor | null,
  provider: HocuspocusProvider | null
) {
  const qc = useQueryClient();
  const key = useMemo(() => ["doc-comments", documentId], [documentId]);
  const query = useQuery({
    queryKey: key,
    queryFn: () => documentCommentsApi.list(documentId!),
    // Sheets and whiteboards opened outside Files (a workspace pane) have no
    // file id here — no comments there (WP-6.1).
    enabled: !!documentId,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });

  const threads = useMemo<CommentThread[]>(() => {
    const all = query.data?.comments ?? [];
    const byRoot = new Map<string, CommentThread>();
    for (const c of all) if (!c.parent_id) byRoot.set(c.id, { root: c, replies: [] });
    for (const c of all) if (c.parent_id) byRoot.get(c.parent_id)?.replies.push(c);
    return [...byRoot.values()];
  }, [query.data]);

  // Highlights follow the thread list.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.commands.setCommentMarks(
      threads
        .filter((t) => t.root.anchor)
        .map((t) => ({ id: t.root.id, anchor: t.root.anchor!, resolved: Boolean(t.root.resolved_at) }))
    );
  }, [editor, threads]);

  // Someone else changed the comments → refetch.
  useEffect(() => {
    if (!provider) return;
    const onStateless = ({ payload }: { payload: string }) => {
      try {
        if (JSON.parse(payload)?.type === "comments-changed") void qc.invalidateQueries({ queryKey: key });
      } catch {
        /* not ours */
      }
    };
    provider.on("stateless", onStateless);
    return () => {
      provider.off("stateless", onStateless);
    };
  }, [provider, qc, key]);

  const changed = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: key });
    try {
      provider?.sendStateless(JSON.stringify({ type: "comments-changed" }));
    } catch {
      /* the others will see it on their next refetch */
    }
  }, [qc, key, provider]);

  return {
    threads,
    canComment: query.data?.can_comment ?? false,
    loading: query.isLoading,
    error: query.error,
    openCount: threads.filter((t) => !t.root.resolved_at).length,
    changed,
  };
}
