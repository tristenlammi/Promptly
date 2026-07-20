import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  MessagesSquare,
  Plus,
  Send,
  Trash2,
  X,
} from "lucide-react";

import {
  discussionsApi,
  type DiscussionMessage,
  type DiscussionThread,
} from "@/api/discussions";
import type { WorkspaceItemNode } from "@/api/workspaces";
import { useWorkspaceTree } from "@/hooks/useWorkspaces";
import { formatRelativeTime } from "@/components/files/helpers";
import { Callout, ErrorState } from "@/components/shared/Callout";
import { confirm } from "@/components/shared/ConfirmDialog";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";
import { ItemPaneHeader } from "./ItemPaneHeader";

/** Poll cadence while a discussion is open. There's no realtime transport
 *  for discussions yet, so the open thread and the thread list refresh on a
 *  timer — slow enough to be cheap, fast enough that a back-and-forth
 *  between two members feels live. */
const POLL_MS = 6000;

const threadsKey = (workspaceId: string, itemId: string) =>
  ["workspaces", "discussion-threads", workspaceId, itemId] as const;
const messagesKey = (workspaceId: string, threadId: string) =>
  ["workspaces", "discussion-messages", workspaceId, threadId] as const;

/**
 * A discussion item's pane: a thread list on the left, the selected
 * thread's messages on the right, and a composer pinned to the bottom.
 *
 * **RAG is opt-in here.** Unlike notes (always embedded, filtered at query
 * time), discussion items are created with ``context_enabled = false`` and
 * nothing is vectorised until a member flips the ⚡ in the header. The pane
 * says so explicitly rather than leaving members to guess whether the AI is
 * reading their conversation.
 */
export function WorkspaceDiscussionPane({
  workspaceId,
  node,
  canEdit,
}: {
  workspaceId: string;
  node: WorkspaceItemNode;
  /** Editor+ can post and start threads; viewers get a read-only pane. */
  canEdit: boolean;
}) {
  const itemId = node.id;
  const qc = useQueryClient();
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");

  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  const threads = useQuery({
    queryKey: threadsKey(workspaceId, itemId),
    queryFn: () => discussionsApi.listThreads(workspaceId, itemId),
    refetchInterval: POLL_MS,
  });

  // Default to the most recently active thread so opening the pane lands on
  // the live conversation rather than an empty right-hand column.
  useEffect(() => {
    const list = threads.data;
    if (!list || list.length === 0) return;
    if (selectedThreadId && list.some((t) => t.id === selectedThreadId)) return;
    setSelectedThreadId(list[0].id);
  }, [threads.data, selectedThreadId]);

  const selectedThread = useMemo(
    () => (threads.data ?? []).find((t) => t.id === selectedThreadId) ?? null,
    [threads.data, selectedThreadId]
  );

  const createThread = useMutation({
    mutationFn: (payload: { title: string; body?: string }) =>
      discussionsApi.createThread(workspaceId, itemId, payload),
    onSuccess: (created) => {
      setSelectedThreadId(created.id);
      setComposing(false);
      void qc.invalidateQueries({ queryKey: threadsKey(workspaceId, itemId) });
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const deleteThread = useMutation({
    mutationFn: (threadId: string) =>
      discussionsApi.deleteThread(workspaceId, threadId),
    onSuccess: (_v, threadId) => {
      if (threadId === selectedThreadId) setSelectedThreadId(null);
      void qc.invalidateQueries({ queryKey: threadsKey(workspaceId, itemId) });
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const onDeleteThread = async (t: DiscussionThread) => {
    const ok = await confirm({
      title: "Delete thread?",
      message: `“${t.title}” and its ${t.message_count} message${
        t.message_count === 1 ? "" : "s"
      } will be removed for everyone. This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) deleteThread.mutate(t.id);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ItemPaneHeader
        workspaceId={workspaceId}
        itemId={itemId}
        kind="discussion"
        fallbackTitle={node.title || "Discussion"}
        canEdit={canEdit}
      />

      <ContextHint workspaceId={workspaceId} itemId={itemId} />

      <div className="flex min-h-0 flex-1">
        {/* Thread rail */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg)]">
          <div className="flex items-center justify-between gap-2 px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Threads
            </span>
            {canEdit && (
              <button
                type="button"
                onClick={() => setComposing((o) => !o)}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs font-medium text-[var(--text)] transition hover:bg-[var(--hover)]"
                title="Start a new thread"
              >
                <Plus className="h-3.5 w-3.5" />
                New
              </button>
            )}
          </div>

          {composing && canEdit && (
            <NewThreadForm
              pending={createThread.isPending}
              onCancel={() => setComposing(false)}
              onSubmit={(title, body) =>
                createThread.mutate({ title, body: body || undefined })
              }
            />
          )}

          <div className="promptly-scroll min-h-0 flex-1 overflow-y-auto">
            {threads.isLoading ? (
              <div className="flex items-center gap-2 px-3 py-3 text-xs text-[var(--text-muted)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
              </div>
            ) : threads.isError ? (
              <p className="px-3 py-3 text-xs text-[var(--danger)]">
                {apiErrorMessage(threads.error)}
              </p>
            ) : (threads.data ?? []).length === 0 ? (
              <p className="px-3 py-3 text-xs text-[var(--text-muted)]">
                {canEdit
                  ? "No threads yet — hit New to start one."
                  : "No threads yet."}
              </p>
            ) : (
              <ul>
                {(threads.data ?? []).map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedThreadId(t.id)}
                      className={cn(
                        "group flex w-full flex-col gap-0.5 px-3 py-2 text-left transition hover:bg-[var(--hover)]",
                        t.id === selectedThreadId && "bg-[var(--hover)]"
                      )}
                    >
                      <span className="flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--text)]">
                          {t.title}
                        </span>
                        {(t.created_by === currentUserId || isAdmin) && (
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label="Delete thread"
                            title="Delete thread"
                            onClick={(e) => {
                              e.stopPropagation();
                              void onDeleteThread(t);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                e.stopPropagation();
                                void onDeleteThread(t);
                              }
                            }}
                            className="shrink-0 rounded p-0.5 text-[var(--text-muted)] opacity-0 transition hover:bg-[var(--danger-bg)] hover:text-[var(--danger)] group-hover:opacity-100"
                          >
                            <Trash2 className="h-3 w-3" />
                          </span>
                        )}
                      </span>
                      <span className="truncate text-[10px] text-[var(--text-muted)]">
                        {t.created_by_name} · {t.message_count} msg
                        {t.message_count === 1 ? "" : "s"}
                        {" · "}
                        {formatRelativeTime(t.last_message_at ?? t.created_at)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* Messages */}
        <div className="flex min-w-0 flex-1 flex-col">
          {selectedThread ? (
            <ThreadView
              key={selectedThread.id}
              workspaceId={workspaceId}
              itemId={itemId}
              thread={selectedThread}
              canEdit={canEdit}
              currentUserId={currentUserId}
              isAdmin={isAdmin}
            />
          ) : threads.isLoading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-[var(--text-muted)]">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
              <MessagesSquare className="h-6 w-6 text-[var(--text-muted)]/60" />
              <p className="text-sm text-[var(--text-muted)]">
                {(threads.data ?? []).length === 0
                  ? canEdit
                    ? "No threads yet. Start one to get the conversation going."
                    : "No threads yet."
                  : "Pick a thread to read it."}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The opt-in banner. Discussions are the one item kind that stays out of the
 * RAG pool by default, which is surprising enough (every other kind is in)
 * that it's worth stating in the pane rather than hiding behind the ⚡ tooltip.
 * Shown only while context is off — once it's on, the lit ⚡ says it.
 */
function ContextHint({
  workspaceId,
  itemId,
}: {
  workspaceId: string;
  itemId: string;
}) {
  const { data: tree } = useWorkspaceTree(workspaceId);
  const live = findNode(tree ?? [], itemId);
  // Discussions default OFF, so treat "unknown" as off (the opposite of the
  // note/board convention).
  const contextOn = live?.context_enabled === true;
  if (contextOn) return null;
  return (
    <div className="shrink-0 border-b border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--text-muted)]">
      This discussion is <span className="font-medium">not</span> part of the
      workspace's AI context. Turn on the ⚡ above to let chats in this
      workspace read the conversation.
    </div>
  );
}

function findNode(
  nodes: WorkspaceItemNode[],
  id: string
): WorkspaceItemNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const sub = findNode(n.children, id);
    if (sub) return sub;
  }
  return null;
}

/** Title (+ optional opening post) form in the thread rail. */
function NewThreadForm({
  pending,
  onSubmit,
  onCancel,
}: {
  pending: boolean;
  onSubmit: (title: string, body: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const submit = () => {
    const t = title.trim();
    if (!t || pending) return;
    onSubmit(t, body.trim());
  };
  return (
    <div className="flex flex-col gap-1.5 border-b border-[var(--border)] px-3 pb-2.5">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value.slice(0, 200))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") onCancel();
        }}
        placeholder="Thread title"
        aria-label="Thread title"
        className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value.slice(0, 8000))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") onCancel();
        }}
        rows={2}
        placeholder="First message (optional)"
        aria-label="First message"
        className="resize-y rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]"
      />
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={submit}
          disabled={!title.trim() || pending}
          className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending && <Loader2 className="h-3 w-3 animate-spin" />}
          Create
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <X className="h-3 w-3" />
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The selected thread: header, chronological messages, composer. */
function ThreadView({
  workspaceId,
  itemId,
  thread,
  canEdit,
  currentUserId,
  isAdmin,
}: {
  workspaceId: string;
  itemId: string;
  thread: DiscussionThread;
  canEdit: boolean;
  currentUserId: string | null;
  isAdmin: boolean;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const messages = useQuery({
    queryKey: messagesKey(workspaceId, thread.id),
    queryFn: () => discussionsApi.listMessages(workspaceId, thread.id),
    refetchInterval: POLL_MS,
  });

  const list = messages.data;

  // Follow the conversation as it grows (including polled-in messages).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [list?.length]);

  const post = useMutation({
    mutationFn: (body: string) =>
      discussionsApi.postMessage(workspaceId, thread.id, body),
    onSuccess: () => {
      setDraft("");
      void qc.invalidateQueries({
        queryKey: messagesKey(workspaceId, thread.id),
      });
      // The rail shows message counts / last activity — keep it honest.
      void qc.invalidateQueries({ queryKey: threadsKey(workspaceId, itemId) });
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (messageId: string) =>
      discussionsApi.deleteMessage(workspaceId, messageId),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: messagesKey(workspaceId, thread.id),
      });
      void qc.invalidateQueries({ queryKey: threadsKey(workspaceId, itemId) });
    },
    onError: (e) => toast.error(apiErrorMessage(e)),
  });

  const submit = () => {
    const body = draft.trim();
    if (!body || post.isPending) return;
    post.mutate(body);
  };

  return (
    <>
      <div className="shrink-0 border-b border-[var(--border)] px-4 py-2">
        <h3 className="truncate text-sm font-semibold text-[var(--text)]">
          {thread.title}
        </h3>
        <p className="text-[11px] text-[var(--text-muted)]">
          Started by {thread.created_by_name} ·{" "}
          {formatRelativeTime(thread.created_at)}
        </p>
      </div>

      <div
        ref={scrollRef}
        className="promptly-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
        {messages.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading messages…
          </div>
        ) : messages.isError ? (
          <ErrorState>{apiErrorMessage(messages.error)}</ErrorState>
        ) : (list ?? []).length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">
            {canEdit
              ? "No messages yet — say something."
              : "No messages in this thread yet."}
          </p>
        ) : (
          <ul className="space-y-3">
            {(list ?? []).map((m) => (
              <MessageRow
                key={m.id}
                message={m}
                canDelete={m.author_user_id === currentUserId || isAdmin}
                onDelete={() => remove.mutate(m.id)}
              />
            ))}
          </ul>
        )}
      </div>

      {canEdit ? (
        <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-4 py-2.5">
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, 8000))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={2}
              placeholder="Write a message… (Enter to send, Shift+Enter for a new line)"
              aria-label="Message"
              className="min-h-0 flex-1 resize-y rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim() || post.isPending}
              className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {post.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              Send
            </button>
          </div>
        </div>
      ) : (
        <div className="shrink-0 border-t border-[var(--border)] px-4 py-2.5">
          <Callout tone="info">
            You have read-only access to this workspace, so you can follow the
            discussion but not post.
          </Callout>
        </div>
      )}
    </>
  );
}

/** One message — author, relative timestamp, body with newlines preserved. */
function MessageRow({
  message: m,
  canDelete,
  onDelete,
}: {
  message: DiscussionMessage;
  canDelete: boolean;
  onDelete: () => void;
}) {
  return (
    <li className="group flex gap-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <span className="font-medium text-[var(--text)]">{m.author_name}</span>
          <span title={new Date(m.created_at).toLocaleString()}>
            {formatRelativeTime(m.created_at)}
          </span>
          {m.edited_at && <span>(edited)</span>}
        </div>
        <div className="whitespace-pre-wrap break-words text-[var(--text)]">
          {m.body}
        </div>
      </div>
      {canDelete && (
        <button
          type="button"
          onClick={onDelete}
          title="Delete message"
          aria-label="Delete message"
          className="h-fit shrink-0 rounded p-1 text-[var(--text-muted)] opacity-0 transition hover:bg-[var(--danger-bg)] hover:text-[var(--danger)] group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </li>
  );
}
