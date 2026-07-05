import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  MessageSquare,
  Quote,
  RotateCcw,
  Send,
  SquareKanban,
  Trash2,
  X,
} from "lucide-react";

import {
  workspacesApi,
  type WorkspaceItemComment,
  type WorkspaceItemNode,
} from "@/api/workspaces";
import { useWorkspaceTree } from "@/hooks/useWorkspaces";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";
import { MentionTextarea } from "./MentionTextarea";

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
  // Pending text-quote anchor for the next comment (from "Quote selection").
  const [quote, setQuote] = useState<string | null>(null);

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
        body,
        quote
      );
      setComments((prev) => [...prev, created]);
      setDraft("");
      setQuote(null);
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

  const toggleResolved = async (c: WorkspaceItemComment) => {
    try {
      const updated = await workspacesApi.setCommentResolved(
        workspaceId,
        itemId,
        c.id,
        !c.resolved_at
      );
      setComments((prev) =>
        prev.map((x) => (x.id === updated.id ? updated : x))
      );
    } catch {
      // swallow
    }
  };

  // Grab the current editor selection as a text-quote anchor. mousedown
  // is prevented on the button so clicking it doesn't clear the
  // selection before we read it.
  const captureQuote = () => {
    const sel = window.getSelection()?.toString().trim() ?? "";
    if (sel) setQuote(sel.slice(0, 500));
  };

  // "Make card" files the comment onto the workspace's first board (the
  // common single-board case). Hidden when no board exists.
  const { data: tree } = useWorkspaceTree(workspaceId);
  const boardItemId = useMemo(() => {
    const find = (nodes: WorkspaceItemNode[]): string | null => {
      for (const n of nodes) {
        if (n.kind === "board") return n.id;
        const hit = find(n.children);
        if (hit) return hit;
      }
      return null;
    };
    return find(tree ?? []);
  }, [tree]);

  const makeCard = async (c: WorkspaceItemComment) => {
    if (!boardItemId) return;
    try {
      const title =
        c.body.length > 80 ? `${c.body.slice(0, 79)}…` : c.body;
      const card = await workspacesApi.createTask(workspaceId, {
        title,
        board_item_id: boardItemId,
      });
      const description = [
        c.quote ? `> ${c.quote}` : null,
        c.body,
        `— from a comment by ${c.author_name}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      await workspacesApi.updateTask(workspaceId, card.id, { description });
      toast.success("Card created on the board");
    } catch {
      toast.error("Couldn't create the card. Try again.");
    }
  };

  const open = comments.filter((c) => !c.resolved_at);
  const resolved = comments.filter((c) => Boolean(c.resolved_at));

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
            No comments yet. Select text in the note and hit “Quote
            selection” to anchor one.
          </p>
        ) : (
          <>
            <ul className="space-y-2.5 py-1">
              {open.map((c) => (
                <CommentRow
                  key={c.id}
                  comment={c}
                  canEdit={canEdit}
                  canDelete={
                    canEdit &&
                    (c.author_user_id === currentUserId || isOwnerOrAdmin)
                  }
                  onDelete={() => void remove(c.id)}
                  onToggleResolved={() => void toggleResolved(c)}
                  onMakeCard={
                    boardItemId
                      ? () => void makeCard(c)
                      : undefined
                  }
                />
              ))}
            </ul>
            {resolved.length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer list-none py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] hover:text-[var(--text)]">
                  Resolved ({resolved.length})
                </summary>
                <ul className="space-y-2.5 py-1 opacity-60">
                  {resolved.map((c) => (
                    <CommentRow
                      key={c.id}
                      comment={c}
                      canEdit={canEdit}
                      canDelete={
                        canEdit &&
                        (c.author_user_id === currentUserId || isOwnerOrAdmin)
                      }
                      onDelete={() => void remove(c.id)}
                      onToggleResolved={() => void toggleResolved(c)}
                    />
                  ))}
                </ul>
              </details>
            )}
          </>
        )}

        {canEdit && quote && (
          <div className="mt-2 flex items-start gap-2 rounded-md border-l-2 border-[var(--accent)] bg-[var(--accent)]/5 px-2.5 py-1.5">
            <Quote className="mt-0.5 h-3 w-3 shrink-0 text-[var(--accent)]" />
            <span className="min-w-0 flex-1 text-xs italic text-[var(--text-muted)] line-clamp-2">
              {quote}
            </span>
            <button
              type="button"
              onClick={() => setQuote(null)}
              className="shrink-0 rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text)]"
              aria-label="Remove quote"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {canEdit && (
          <div className="mt-2 flex items-end gap-2">
            <MentionTextarea
              workspaceId={workspaceId}
              value={draft}
              onValueChange={(next) => setDraft(next.slice(0, 4000))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
              rows={2}
              placeholder="Add a comment… (@ to mention, ⌘/Ctrl+Enter to post)"
              className={cn(
                "min-h-0 resize-y rounded-md border bg-[var(--bg)] px-2.5 py-1.5 text-sm",
                "border-[var(--border)] text-[var(--text)] outline-none focus:border-[var(--accent)]"
              )}
            />
            <button
              type="button"
              // preventDefault on mousedown keeps the note selection alive
              // long enough to read it.
              onMouseDown={(e) => e.preventDefault()}
              onClick={captureQuote}
              title="Anchor the next comment to the text selected in the note"
              className="inline-flex h-9 shrink-0 items-center gap-1 rounded-md border border-[var(--border)] px-2 text-xs text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
            >
              <Quote className="h-3.5 w-3.5" />
              Quote
            </button>
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

/** One comment row — quote block, body, resolve / make-card / delete. */
function CommentRow({
  comment: c,
  canEdit,
  canDelete,
  onDelete,
  onToggleResolved,
  onMakeCard,
}: {
  comment: WorkspaceItemComment;
  canEdit: boolean;
  canDelete: boolean;
  onDelete: () => void;
  onToggleResolved: () => void;
  onMakeCard?: () => void;
}) {
  const resolved = Boolean(c.resolved_at);
  return (
    <li className="group flex gap-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <span className="font-medium text-[var(--text)]">
            {c.author_name}
          </span>
          <span>{new Date(c.created_at).toLocaleString()}</span>
          {resolved && (
            <span className="inline-flex items-center gap-0.5 text-[var(--success)]">
              <CheckCircle2 className="h-3 w-3" /> resolved
            </span>
          )}
        </div>
        {c.quote && (
          <div className="mt-1 border-l-2 border-[var(--accent)]/60 pl-2 text-xs italic text-[var(--text-muted)] line-clamp-2">
            {c.quote}
          </div>
        )}
        <div className="whitespace-pre-wrap break-words text-[var(--text)]">
          {c.body}
        </div>
      </div>
      <div className="flex h-fit shrink-0 items-center opacity-0 transition group-hover:opacity-100">
        {canEdit && onMakeCard && !resolved && (
          <button
            type="button"
            onClick={onMakeCard}
            className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            title="Turn this comment into a board card"
            aria-label="Turn into a card"
          >
            <SquareKanban className="h-3.5 w-3.5" />
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={onToggleResolved}
            className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--success)]"
            title={resolved ? "Reopen" : "Resolve"}
            aria-label={resolved ? "Reopen comment" : "Resolve comment"}
          >
            {resolved ? (
              <RotateCcw className="h-3.5 w-3.5" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--danger-bg)] hover:text-[var(--danger)]"
            title="Delete comment"
            aria-label="Delete comment"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </li>
  );
}
