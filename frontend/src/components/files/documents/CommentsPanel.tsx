import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { Check, ChevronDown, ChevronRight, Loader2, MessageSquare, MoreHorizontal, RotateCcw, X } from "lucide-react";

import {
  documentCommentsApi,
  isTextAnchor,
  type CommentAnchor,
  type CommentAuthor,
  type DocComment,
} from "@/api/documentComments";
import { formatRelativeTime } from "@/components/files/helpers";
import { confirm } from "@/components/shared/ConfirmDialog";
import { UserAvatar } from "@/components/shared/UserAvatar";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { resolveAnchor } from "./CommentsExtension";
import { useEditorDoc } from "./useEditorFormatState";
import type { CommentThread } from "./useDocComments";

/**
 * The comments side panel (WP-4.5, R-227). Open threads in the order
 * their text appears in the document, then any whose text was deleted,
 * then resolved ones (collapsed). Clicking a thread selects its text.
 * Every failure says so in a toast (note comments used to fail silently).
 */
export interface CommentDraft {
  anchor: CommentAnchor;
  quote: string;
}

const MENTION_AT_CARET = /(?:^|\s)@([A-Za-z0-9_.-]{0,63})$/;

function Body({ text }: { text: string }) {
  const parts = text.split(/((?:^|(?<=\s))@[A-Za-z0-9][A-Za-z0-9_.-]{0,63})/g);
  return (
    <p className="whitespace-pre-wrap break-words text-sm text-[var(--text)]">
      {parts.map((p, i) =>
        p.startsWith("@") ? (
          <span key={i} className="rounded bg-[var(--accent)]/10 px-0.5 font-medium text-[var(--accent-text)]">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </p>
  );
}

/** A textarea with @-mention suggestions from the people who can open the
 *  document. Ctrl/⌘+Enter sends. */
function Composer({
  documentId,
  placeholder,
  initial = "",
  submitLabel,
  autoFocus,
  onSubmit,
  onCancel,
}: {
  documentId: string;
  placeholder: string;
  initial?: string;
  submitLabel: string;
  autoFocus?: boolean;
  onSubmit: (body: string) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [pick, setPick] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const { data: people } = useQuery({
    queryKey: ["doc-comment-people", documentId],
    queryFn: () => documentCommentsApi.people(documentId),
    staleTime: 60_000,
    enabled: query !== null,
  });
  const matches = useMemo(
    () =>
      query === null
        ? []
        : (people ?? []).filter((p) => p.username.toLowerCase().startsWith(query.toLowerCase())).slice(0, 6),
    [people, query]
  );
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const onChange = (value: string) => {
    setBody(value);
    const caret = ref.current?.selectionStart ?? value.length;
    const m = MENTION_AT_CARET.exec(value.slice(0, caret));
    setQuery(m ? m[1] : null);
    setPick(0);
  };
  const insert = (p: CommentAuthor) => {
    const el = ref.current;
    const caret = el?.selectionStart ?? body.length;
    const before = body.slice(0, caret).replace(/@([A-Za-z0-9_.-]{0,63})$/, `@${p.username} `);
    const next = before + body.slice(caret);
    setBody(next);
    setQuery(null);
    window.setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(before.length, before.length);
    }, 0);
  };
  const send = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    const ok = await onSubmit(text);
    setBusy(false);
    if (ok) setBody("");
  };

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={body}
        rows={2}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (matches.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setPick((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              insert(matches[pick]);
              return;
            }
          }
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            if (query !== null) setQuery(null);
            else onCancel?.();
          }
        }}
        className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
      />
      {matches.length > 0 && (
        <div role="listbox" aria-label="People" className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)] shadow-lg">
          {matches.map((p, i) => (
            <button
              key={p.user_id}
              type="button"
              role="option"
              aria-selected={i === pick}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(p)}
              className={cn("flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm", i === pick ? "bg-[var(--hover)]" : "")}
            >
              <UserAvatar name={p.username} userId={p.user_id} avatarUrl={p.avatar_url} color={p.avatar_color} size={18} />
              {p.username}
            </button>
          ))}
        </div>
      )}
      <div className="mt-1.5 flex justify-end gap-1.5">
        {onCancel && (
          <button type="button" onClick={onCancel} className="h-7 rounded-md px-2.5 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]">
            Cancel
          </button>
        )}
        <button
          type="button"
          disabled={!body.trim() || busy}
          onClick={() => void send()}
          className="inline-flex h-7 items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin" />}
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

function CommentRow({
  documentId,
  comment,
  onChanged,
}: {
  documentId: string;
  comment: DocComment;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const name = comment.author?.username ?? "Former member";
  return (
    <div className="group/comment">
      <div className="flex items-center gap-2">
        <UserAvatar
          name={name}
          userId={comment.author?.user_id}
          avatarUrl={comment.author?.avatar_url}
          color={comment.author?.avatar_color}
          size={22}
        />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-xs font-medium text-[var(--text)]">{name}</div>
          <div className="text-[11px] text-[var(--text-muted)]">
            {formatRelativeTime(comment.created_at)}
            {comment.edited_at ? " · edited" : ""}
          </div>
        </div>
        {(comment.can_edit || comment.can_delete) && !editing && (
          <div className="relative">
            <button
              type="button"
              aria-label="Comment actions"
              onClick={(e) => {
                e.stopPropagation();
                setMenu((v) => !v);
              }}
              className="rounded p-1 text-[var(--text-muted)] opacity-0 transition hover:bg-[var(--hover)] focus:opacity-100 group-hover/comment:opacity-100"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
            {menu && (
              <div
                role="menu"
                onClick={(e) => e.stopPropagation()}
                className="absolute right-0 top-full z-10 mt-1 w-28 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)] py-1 shadow-lg"
              >
                {comment.can_edit && (
                  <button type="button" role="menuitem" onClick={() => { setMenu(false); setEditing(true); }} className="block w-full px-3 py-1.5 text-left text-xs hover:bg-[var(--hover)]">
                    Edit
                  </button>
                )}
                {comment.can_delete && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={async () => {
                      setMenu(false);
                      const ok = await confirm({
                        title: comment.parent_id ? "Delete reply" : "Delete comment",
                        message: comment.parent_id ? "Delete this reply?" : "Delete this comment and its replies?",
                        confirmLabel: "Delete",
                        danger: true,
                      });
                      if (!ok) return;
                      try {
                        await documentCommentsApi.remove(documentId, comment.id);
                        await onChanged();
                      } catch (e) {
                        toast.error(apiErrorMessage(e, "Couldn't delete the comment."));
                      }
                    }}
                    className="block w-full px-3 py-1.5 text-left text-xs text-[var(--danger)] hover:bg-[var(--hover)]"
                  >
                    Delete
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="mt-1 pl-[30px]">
        {editing ? (
          <Composer
            documentId={documentId}
            placeholder="Edit comment"
            initial={comment.body}
            submitLabel="Save"
            autoFocus
            onCancel={() => setEditing(false)}
            onSubmit={async (body) => {
              try {
                await documentCommentsApi.edit(documentId, comment.id, body);
                setEditing(false);
                await onChanged();
                return true;
              } catch (e) {
                toast.error(apiErrorMessage(e, "Couldn't save the comment."));
                return false;
              }
            }}
          />
        ) : (
          <Body text={comment.body} />
        )}
      </div>
    </div>
  );
}

function ThreadCard({
  documentId,
  thread,
  active,
  canComment,
  orphan,
  onSelect,
  onChanged,
  label,
  orphanNote,
}: {
  documentId: string;
  thread: CommentThread;
  active: boolean;
  canComment: boolean;
  orphan: boolean;
  onSelect: () => void;
  onChanged: () => Promise<void>;
  /** Where it points, shown as a chip ("B5", "2 shapes"). */
  label?: string | null;
  orphanNote?: string;
}) {
  const [replying, setReplying] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);
  const resolved = Boolean(thread.root.resolved_at);
  const setResolved = async (value: boolean) => {
    try {
      await documentCommentsApi.resolve(documentId, thread.root.id, value);
      await onChanged();
    } catch (e) {
      toast.error(apiErrorMessage(e, value ? "Couldn't resolve the comment." : "Couldn't reopen the comment."));
    }
  };
  return (
    <div
      ref={ref}
      data-thread-id={thread.root.id}
      role="article"
      aria-label={`Comment by ${thread.root.author?.username ?? "former member"}`}
      onClick={onSelect}
      className={cn(
        "cursor-pointer rounded-lg border bg-[var(--bg)] p-3 transition",
        active ? "border-[var(--accent)] shadow-md" : "border-[var(--border)] hover:border-[var(--text-muted)]/40",
        resolved && "opacity-75"
      )}
    >
      {(label || thread.root.quote) && (
        <div className="mb-2 flex items-start gap-1.5">
          <span aria-hidden className="mt-0.5 h-4 w-0.5 shrink-0 rounded bg-amber-400" />
          {label && (
            <span className="shrink-0 rounded bg-[var(--hover)] px-1.5 font-mono text-[11px] text-[var(--text)]">{label}</span>
          )}
          {thread.root.quote && (
            <p className={cn("line-clamp-2 text-xs italic text-[var(--text-muted)]", orphan && "line-through")}>
              {thread.root.quote}
            </p>
          )}
        </div>
      )}
      {orphan && !resolved && (
        <p className="mb-2 text-[11px] text-[var(--text-muted)]">{orphanNote ?? "The text this was about has been deleted."}</p>
      )}
      <div className="space-y-3">
        <CommentRow documentId={documentId} comment={thread.root} onChanged={onChanged} />
        {thread.replies.map((r) => (
          <CommentRow key={r.id} documentId={documentId} comment={r} onChanged={onChanged} />
        ))}
      </div>
      {resolved && (
        <p className="mt-2 text-[11px] text-[var(--text-muted)]">
          Resolved{thread.root.resolved_by ? ` by ${thread.root.resolved_by}` : ""} {formatRelativeTime(thread.root.resolved_at)}
        </p>
      )}
      {canComment && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          {replying ? (
            <div className="w-full">
              <Composer
                documentId={documentId}
                placeholder="Reply…"
                submitLabel="Reply"
                autoFocus
                onCancel={() => setReplying(false)}
                onSubmit={async (body) => {
                  try {
                    await documentCommentsApi.create(documentId, { body, parent_id: thread.root.id });
                    setReplying(false);
                    await onChanged();
                    return true;
                  } catch (e) {
                    toast.error(apiErrorMessage(e, "Couldn't post the reply."));
                    return false;
                  }
                }}
              />
            </div>
          ) : (
            <>
              {!resolved && (
                <button type="button" onClick={() => setReplying(true)} className="h-7 rounded-md border border-[var(--border)] px-2.5 text-xs text-[var(--text)] hover:bg-[var(--hover)]">
                  Reply
                </button>
              )}
              <button
                type="button"
                onClick={() => void setResolved(!resolved)}
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
              >
                {resolved ? <RotateCcw className="h-3 w-3" /> : <Check className="h-3 w-3" />}
                {resolved ? "Reopen" : "Resolve"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function CommentsPanel({
  documentId,
  editor,
  threads,
  canComment,
  loading,
  draft,
  activeId,
  onActivate,
  onDraftDone,
  onChanged,
  onClose,
  placeOf,
  onSelectThread,
  labelOf,
  emptyHint,
  orphanNote,
  header,
}: {
  documentId: string;
  /** The document editor — threads follow its text. Sheets and whiteboards
   *  pass ``placeOf`` / ``onSelectThread`` instead (WP-6.1). */
  editor: Editor | null;
  threads: CommentThread[];
  canComment: boolean;
  loading: boolean;
  draft: CommentDraft | null;
  activeId: string | null;
  onActivate: (id: string | null) => void;
  onDraftDone: () => void;
  onChanged: () => Promise<void>;
  onClose: () => void;
  /** Sort key for a thread's anchor; ``null`` = what it pointed at is gone. */
  placeOf?: (t: CommentThread) => number | null;
  /** Go to what a thread points at. */
  onSelectThread?: (t: CommentThread) => void;
  labelOf?: (t: CommentThread) => string | null;
  emptyHint?: string;
  orphanNote?: string;
  /** Extra controls under the title (e.g. "Comment on B5"). */
  header?: React.ReactNode;
}) {
  const [showResolved, setShowResolved] = useState(false);
  // Threads follow the text order — re-sort when the document changes.
  useEditorDoc(editor);
  const state = editor?.state;
  const { open, orphans, resolved } = useMemo(() => {
    const placed: { t: CommentThread; at: number }[] = [];
    const lost: CommentThread[] = [];
    const done: CommentThread[] = [];
    for (const t of threads) {
      if (t.root.resolved_at) {
        done.push(t);
        continue;
      }
      let at: number | null = null;
      if (placeOf) at = t.root.anchor ? placeOf(t) : Number.MAX_SAFE_INTEGER;
      else if (state && isTextAnchor(t.root.anchor)) at = resolveAnchor(state, t.root.anchor)?.from ?? null;
      else if (!t.root.anchor) at = Number.MAX_SAFE_INTEGER;
      if (at !== null) placed.push({ t, at });
      else lost.push(t);
    }
    placed.sort((a, b) => a.at - b.at);
    return { open: placed.map((p) => p.t), orphans: lost, resolved: done };
  }, [threads, state, placeOf]);

  const select = (t: CommentThread) => {
    onActivate(t.root.id);
    if (onSelectThread) {
      onSelectThread(t);
      return;
    }
    if (!editor || !isTextAnchor(t.root.anchor)) return;
    const at = resolveAnchor(editor.state, t.root.anchor);
    if (at) editor.chain().setTextSelection(at).scrollIntoView().run();
  };

  return (
    <aside
      aria-label="Comments"
      data-esc-layer={draft ? "" : undefined}
      className="absolute inset-y-0 right-0 z-20 flex w-full flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-xl sm:w-80 print:hidden"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <MessageSquare className="h-4 w-4 text-[var(--text-muted)]" />
        <h2 className="text-sm font-semibold text-[var(--text)]">Comments</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close comments"
          className="ml-auto rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {header}
      <div className="promptly-scroll min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
        {draft && (
          <div className="rounded-lg border border-[var(--accent)] bg-[var(--bg)] p-3 shadow-md">
            {draft.quote && (
              <div className="mb-2 flex items-start gap-1.5">
                <span aria-hidden className="mt-0.5 h-4 w-0.5 shrink-0 rounded bg-amber-400" />
                <p className="line-clamp-2 text-xs italic text-[var(--text-muted)]">{draft.quote}</p>
              </div>
            )}
            <Composer
              documentId={documentId}
              placeholder="Add a comment… (@ to mention)"
              submitLabel="Comment"
              autoFocus
              onCancel={onDraftDone}
              onSubmit={async (body) => {
                try {
                  const c = await documentCommentsApi.create(documentId, { body, quote: draft.quote, anchor: draft.anchor });
                  onDraftDone();
                  await onChanged();
                  onActivate(c.id);
                  return true;
                } catch (e) {
                  toast.error(apiErrorMessage(e, "Couldn't post the comment."));
                  return false;
                }
              }}
            />
          </div>
        )}
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : !draft && open.length + orphans.length + resolved.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-[var(--text-muted)]">
            {canComment ? emptyHint ?? "No comments yet. Select some text and choose Comment." : "No comments yet."}
          </p>
        ) : null}
        {[...open, ...orphans].map((t) => (
          <ThreadCard
            key={t.root.id}
            documentId={documentId}
            thread={t}
            active={activeId === t.root.id}
            canComment={canComment}
            orphan={orphans.includes(t)}
            onSelect={() => select(t)}
            onChanged={onChanged}
            label={labelOf?.(t)}
            orphanNote={orphanNote}
          />
        ))}
        {resolved.length > 0 && (
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setShowResolved((v) => !v)}
              className="flex items-center gap-1 px-1 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              {showResolved ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              Resolved ({resolved.length})
            </button>
            {showResolved && (
              <div className="mt-2 space-y-2.5">
                {resolved.map((t) => (
                  <ThreadCard
                    key={t.root.id}
                    documentId={documentId}
                    thread={t}
                    active={activeId === t.root.id}
                    canComment={canComment}
                    orphan={false}
                    onSelect={() => onActivate(t.root.id)}
                    onChanged={onChanged}
                    label={labelOf?.(t)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
