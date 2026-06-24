import { useCallback, useEffect, useState } from "react";
import { Loader2, MessageSquare, Send, Trash2 } from "lucide-react";

import {
  workspacesApi,
  type WorkspaceItemComment,
} from "@/api/workspaces";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";

interface Props {
  workspaceId: string;
  itemId: string;
  /** Owner/editor can post; viewers see a read-only thread. */
  canEdit: boolean;
}

/**
 * Collaboration comment thread for a workspace item (Phase 6). A flat,
 * chronological discussion that lives alongside the item without editing
 * it. Rendered as a collapsible panel beneath the item (next to backlinks).
 */
export function ItemCommentsPanel({ workspaceId, itemId, canEdit }: Props) {
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const isOwnerOrAdmin = useAuthStore((s) => s.user?.role === "admin");
  const [comments, setComments] = useState<WorkspaceItemComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setComments(await workspacesApi.listComments(workspaceId, itemId));
    } catch {
      // Non-fatal — leave the thread empty rather than blocking the item.
    } finally {
      setLoading(false);
    }
  }, [workspaceId, itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    try {
      const created = await workspacesApi.createComment(
        workspaceId,
        itemId,
        body
      );
      setComments((prev) => [...prev, created]);
      setDraft("");
    } catch {
      // swallow — the user can retry
    } finally {
      setPosting(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await workspacesApi.deleteComment(workspaceId, itemId, id);
      setComments((prev) => prev.filter((c) => c.id !== id));
    } catch {
      // swallow
    }
  };

  return (
    <details className="border-t border-[var(--border)]">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] hover:text-[var(--text)]">
        <MessageSquare className="h-3.5 w-3.5" />
        Comments
        {comments.length > 0 && (
          <span className="font-normal normal-case">({comments.length})</span>
        )}
      </summary>

      <div className="px-4 pb-3">
        {loading ? (
          <div className="flex items-center gap-2 py-2 text-xs text-[var(--text-muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : comments.length === 0 ? (
          <p className="py-2 text-xs text-[var(--text-muted)]">
            No comments yet.
          </p>
        ) : (
          <ul className="space-y-2.5 py-1">
            {comments.map((c) => {
              const canDelete =
                canEdit &&
                (c.author_user_id === currentUserId || isOwnerOrAdmin);
              return (
                <li key={c.id} className="group flex gap-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                      <span className="font-medium text-[var(--text)]">
                        {c.author_name}
                      </span>
                      <span>{new Date(c.created_at).toLocaleString()}</span>
                    </div>
                    <div className="whitespace-pre-wrap break-words text-[var(--text)]">
                      {c.body}
                    </div>
                  </div>
                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => void remove(c.id)}
                      className="h-fit shrink-0 rounded p-1 text-[var(--text-muted)] opacity-0 transition hover:bg-red-500/10 hover:text-red-500 group-hover:opacity-100"
                      title="Delete comment"
                      aria-label="Delete comment"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {canEdit && (
          <div className="mt-2 flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, 4000))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
              rows={2}
              placeholder="Add a comment… (⌘/Ctrl+Enter to post)"
              className={cn(
                "min-h-0 flex-1 resize-y rounded-md border bg-[var(--bg)] px-2.5 py-1.5 text-sm",
                "border-[var(--border)] text-[var(--text)] outline-none focus:border-[var(--accent)]"
              )}
            />
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!draft.trim() || posting}
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium",
                "bg-[var(--accent)] text-white hover:opacity-90",
                "disabled:cursor-not-allowed disabled:opacity-50"
              )}
            >
              {posting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              Post
            </button>
          </div>
        )}
      </div>
    </details>
  );
}
