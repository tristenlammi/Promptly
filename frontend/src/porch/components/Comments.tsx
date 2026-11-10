import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Heart, MessageCircle, MoreHorizontal, Pencil, Send, Trash2, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { HEART, porchApi, REACTIONS, type PorchComment, type PorchPost, type PorchUser } from "@/api/porch";
import { confirm } from "@/components/shared/ConfirmDialog";
import { ItemButton, Sheet, TextArea } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { commentsKey, refreshPost } from "../cache";
import { usePorch } from "../context";
import { removeWithUndo } from "../undo";
import { MentionBox, mentionedIn } from "./composer/MentionBox";
import { ReactionPicker, ReactionsLine, useLongPress, WhoReactedSheet } from "./Reactions";
import { ReportSheet } from "./ReportSheet";
import { RichText } from "./RichText";
import { ActionSheet, PersonLink, PorchAvatar, RowsSkeleton, fullTime, shortAgo, type MenuAction } from "./ui";

type Thread = { comments: PorchComment[]; count: number };

/** A comment shown the moment you send it, before the server has it. */
const SENDING = "sending-";
const isSending = (c: PorchComment) => c.id.startsWith(SENDING);
let sendingSeq = 0;

/** Everyone who can see the post (not you): the @mention list. */
function useAudience(postId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["porch", "people", "audience", `post:${postId}`],
    queryFn: () => porchApi.people("", { post: postId }),
    enabled,
    staleTime: 60_000,
  });
}

/** Put a changed comment (or a new one) into the cached thread. */
function placeComment(t: Thread | undefined, c: PorchComment, mode: "add" | "replace" | "remove"): Thread | undefined {
  if (!t) return t;
  if (mode === "add") {
    if (c.parent_id) {
      return {
        count: t.count + 1,
        comments: t.comments.map((x) => (x.id === c.parent_id ? { ...x, replies: [...(x.replies ?? []), c] } : x)),
      };
    }
    return { count: t.count + 1, comments: [...t.comments, { ...c, replies: [] }] };
  }
  const swap = (x: PorchComment): PorchComment | null => (x.id === c.id ? (mode === "remove" ? null : { ...c, replies: x.replies }) : x);
  return {
    count: mode === "remove" ? Math.max(0, t.count - 1) : t.count,
    comments: t.comments
      .map((x): PorchComment | null => {
        const top = swap(x);
        if (!top) return (x.replies ?? []).length ? { ...x, deleted: true, body: "", author: null, can_edit: false, can_delete: false } : null;
        return { ...top, replies: (top.replies ?? []).map(swap).filter((r): r is PorchComment => !!r) };
      })
      .filter((x): x is PorchComment => !!x),
  };
}

/**
 * A post's comments (build §3.5): oldest first, one level of replies
 * (collapsed after two), Reply, a small ♡ (hold for the other five), and
 * Edit / Delete for your own (and Delete on your post, D5). The box has the
 * quick emoji and @mentions of people who can see the post.
 *
 * ``children`` lays out the list and the box: in a sheet on a phone (the
 * box in its footer), inline on a computer and on the post's page.
 */
export function CommentThread({
  post,
  children,
  focusBox = false,
}: {
  post: PorchPost;
  children: (list: ReactNode, box: ReactNode) => ReactNode;
  focusBox?: boolean;
}) {
  const qc = useQueryClient();
  const { b } = usePorch();
  const q = useQuery({ queryKey: commentsKey(post.id), queryFn: () => porchApi.comments(post.id), staleTime: 15_000 });
  const audience = useAudience(post.id, true);
  const [replyTo, setReplyTo] = useState<PorchComment | null>(null);
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<PorchUser[]>([]);
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (focusBox) window.setTimeout(() => box.current?.focus({ preventScroll: true }), 120);
  }, [focusBox]);

  const reply = useCallback((c: PorchComment) => {
    setReplyTo(c);
    const tag = c.author ? `@${c.author.username} ` : "";
    setText((t) => (t.trim() ? t : tag));
    if (c.author) setMentions((m) => (m.some((x) => x.id === c.author!.id) ? m : [...m, c.author!]));
    window.setTimeout(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 30);
  }, []);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    const who = [...mentions];
    for (const u of audience.data ?? []) if (!who.some((m) => m.id === u.id) && mentionedIn(body, u)) who.push(u);
    const named = who.filter((u) => mentionedIn(body, u));
    const parent = replyTo;
    // It's in the list at once; the box is clear for the next one.
    const mine: PorchComment = {
      id: `${SENDING}${++sendingSeq}`,
      post_id: post.id,
      parent_id: parent?.id ?? null,
      author: b?.me ?? null,
      body,
      mentions: named,
      deleted: false,
      created_at: new Date().toISOString(),
      edited_at: null,
      mine: true,
      can_edit: false,
      can_delete: false,
      reactions: { emojis: [], mine: null },
    };
    const shown = !!qc.getQueryData<Thread>(commentsKey(post.id));
    const kept = { text, mentions };
    if (shown) {
      qc.setQueryData<Thread>(commentsKey(post.id), (t) => placeComment(t, mine, "add"));
      setText("");
      setMentions([]);
      setReplyTo(null);
      window.setTimeout(() => document.getElementById(`comment-${mine.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 60);
    }
    try {
      const c = await porchApi.addComment(post.id, body, { parentId: parent?.id ?? null, mentions: named.map((u) => u.id) });
      qc.setQueryData<Thread>(commentsKey(post.id), (t) => {
        if (!t) return t;
        // Swap the placeholder for the real one (or add it, if the list was reloaded meanwhile).
        const has = t.comments.some((x) => x.id === mine.id || (x.replies ?? []).some((r) => r.id === mine.id));
        if (!has) return t.comments.some((x) => x.id === c.id || (x.replies ?? []).some((r) => r.id === c.id)) ? t : placeComment(t, c, "add");
        const swap = (x: PorchComment): PorchComment => (x.id === mine.id ? { ...c, replies: x.replies } : x);
        return { ...t, comments: t.comments.map((x) => ({ ...swap(x), replies: (x.replies ?? []).map(swap) })) };
      });
      if (!shown) {
        setText("");
        setMentions([]);
        setReplyTo(null);
      }
      void refreshPost(qc, post.id);
    } catch (err) {
      // Not sent: out of the list, and back in the box to try again.
      qc.setQueryData<Thread>(commentsKey(post.id), (t) => {
        if (!t) return t;
        const gone = (x: PorchComment) => x.id !== mine.id;
        const had = t.comments.some((x) => !gone(x) || (x.replies ?? []).some((r) => !gone(r)));
        return had ? { count: Math.max(0, t.count - 1), comments: t.comments.filter(gone).map((x) => ({ ...x, replies: (x.replies ?? []).filter(gone) })) } : t;
      });
      if (shown) {
        setText((t) => (t.trim() ? t : kept.text));
        setMentions((m) => (m.length ? m : kept.mentions));
        setReplyTo((r) => r ?? parent);
      }
      toast.error(apiErrorMessage(err, "Couldn't post your comment. It's back in the box to try again."));
    } finally {
      setSending(false);
    }
  };

  const data = q.data;
  // Opened from Activity (``#comment-<id>``): straight to that comment.
  const jumped = useRef(false);
  useEffect(() => {
    if (!data || jumped.current) return;
    const id = window.location.hash.slice(1);
    if (!id.startsWith("comment-")) return;
    jumped.current = true;
    window.setTimeout(() => {
      const el = document.getElementById(id);
      if (!el) return;
      el.scrollIntoView({ block: "center" });
      el.classList.add("porch-flash");
    }, 80);
  }, [data]);
  let list: ReactNode;
  if (q.isPending) {
    list = <RowsSkeleton rows={3} />;
  } else if (q.isError) {
    list = (
      <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-[var(--text-muted)]">
        Couldn't load the comments.
        <ItemButton size="sm" variant="secondary" onClick={() => void q.refetch()}>
          Try again
        </ItemButton>
      </div>
    );
  } else if (!data || data.comments.length === 0) {
    list = (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <MessageCircle className="h-6 w-6 text-[var(--text-muted)]" aria-hidden />
        <p className="text-sm text-[var(--text-muted)]">No comments yet. Say something nice.</p>
      </div>
    );
  } else {
    list = (
      <ul aria-label="Comments" className="flex flex-col gap-3 py-1">
        {data.comments.map((c) => (
          <li key={c.id}>
            <CommentRow c={c} post={post} onReply={reply} />
            {(c.replies?.length ?? 0) > 0 && <Replies replies={c.replies ?? []} post={post} onReply={reply} />}
          </li>
        ))}
      </ul>
    );
  }

  const groupsNote = post.groups.length > 1 ? `Everyone who can see this post sees your comment (${post.groups.map((g) => g.name).join(", ")}).` : null;
  const boxEl = (
    <div className="flex w-full flex-col gap-1.5">
      {replyTo && (
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <span className="flex-1 truncate">Replying to {replyTo.author?.name ?? "a comment"}</span>
          <button
            type="button"
            aria-label="Don't reply"
            onClick={() => {
              setReplyTo(null);
              const tag = replyTo.author ? `@${replyTo.author.username} ` : "";
              setText((t) => (t === tag ? "" : t));
            }}
            className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-[var(--hover)]"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      )}
      <div className="flex gap-1" role="group" aria-label="Quick emoji">
        {REACTIONS.map((e) => (
          <button
            key={e}
            type="button"
            aria-label={`Add ${e}`}
            onClick={() => {
              setText((t) => `${t}${e}`);
              box.current?.focus();
            }}
            className="flex h-10 w-10 items-center justify-center rounded-full text-lg hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
          >
            {e}
          </button>
        ))}
      </div>
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <MentionBox
            compact
            boxRef={box}
            value={text}
            onChange={setText}
            mentions={mentions}
            onMentions={setMentions}
            audience={audience.data ?? []}
            audienceReady={audience.isSuccess}
            label={replyTo ? `Reply to ${replyTo.author?.name ?? "the comment"}` : "Add a comment"}
            placeholder={replyTo ? "Write a reply…" : "Add a comment…"}
            maxLength={2000}
            onSubmit={() => void send()}
          />
        </div>
        <ItemButton variant="primary" aria-label={replyTo ? "Post reply" : "Post comment"} disabled={!text.trim() || sending} onClick={() => void send()} className="h-11 w-11 shrink-0 !px-0">
          <Send className="h-4 w-4" aria-hidden />
        </ItemButton>
      </div>
      {groupsNote && <p className="text-xs text-[var(--text-muted)]">{groupsNote}</p>}
    </div>
  );
  return <>{children(list, boxEl)}</>;
}

/** Replies under a comment: the first two, then "View 3 more replies". */
function Replies({ replies, post, onReply }: { replies: PorchComment[]; post: PorchPost; onReply: (c: PorchComment) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? replies : replies.slice(0, 2);
  const more = replies.length - shown.length;
  return (
    <ul aria-label="Replies" className="ml-11 mt-2 flex flex-col gap-2.5">
      {shown.map((r) => (
        <li key={r.id}>
          <CommentRow c={r} post={post} onReply={onReply} small />
        </li>
      ))}
      {more > 0 && (
        <li>
          <button type="button" onClick={() => setAll(true)} className="flex items-center gap-2 text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text)]">
            <span className="h-px w-6 bg-[var(--border)]" aria-hidden />
            View {more} more {more === 1 ? "reply" : "replies"}
          </button>
        </li>
      )}
    </ul>
  );
}

function CommentRow({ c, post, onReply, small = false }: { c: PorchComment; post: PorchPost; onReply: (c: PorchComment) => void; small?: boolean }) {
  const qc = useQueryClient();
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.body);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  const [who, setWho] = useState(false);
  const [reporting, setReporting] = useState(false);
  const heart = useLongPress((at) => setPicker(at));
  const [pop, setPop] = useState(false);
  // Long-press: your own comment's Edit / Delete, or Report someone else's.
  const hold = useLongPress(() => setMenu(true), 550);

  const set = (next: PorchComment, mode: "replace" | "remove" = "replace") => qc.setQueryData<Thread>(commentsKey(post.id), (t) => placeComment(t, next, mode));

  const react = async (emoji: string | null) => {
    const before = c.reactions;
    set({ ...c, reactions: { ...c.reactions, mine: emoji, emojis: emoji && !c.reactions.emojis.includes(emoji) ? [...c.reactions.emojis, emoji] : c.reactions.emojis } });
    try {
      const r = await porchApi.reactComment(c.id, emoji);
      set({ ...c, reactions: r });
    } catch (err) {
      set({ ...c, reactions: before });
      toast.error(apiErrorMessage(err, "Couldn't react. Try again."));
    }
  };

  const save = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    try {
      const next = await porchApi.editComment(c.id, body, c.mentions.filter((m) => mentionedIn(body, m)).map((m) => m.id));
      set(next);
      setEditing(false);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't save the comment. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    // Your own goes at once, with Undo. Someone else's (on your post): asked first.
    if (!c.mine) {
      const ok = await confirm({
        title: "Delete this comment?",
        message: `This deletes ${c.author?.name ?? "their"}'s comment on your post for everyone.`,
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
    }
    const before = qc.getQueryData<Thread>(commentsKey(post.id));
    removeWithUndo({
      message: "Comment deleted.",
      hide: () => set(c, "remove"),
      restore: () => {
        if (before) qc.setQueryData<Thread>(commentsKey(post.id), before);
        void qc.invalidateQueries({ queryKey: commentsKey(post.id) });
      },
      commit: async () => {
        await porchApi.deleteComment(c.id);
        set(c, "remove");
        void refreshPost(qc, post.id);
      },
      failed: "Couldn't delete the comment, so it's back. Try again.",
    });
  };

  if (c.deleted) {
    return (
      <div id={`comment-${c.id}`} className="flex items-center gap-3 text-sm italic text-[var(--text-muted)]">
        <span className="h-8 w-8 shrink-0 rounded-full bg-[var(--surface-2)]" aria-hidden />
        This comment was deleted.
      </div>
    );
  }

  const actions: MenuAction[] = [];
  if (c.can_edit) actions.push({ label: "Edit", icon: Pencil, onClick: () => { setDraft(c.body); setEditing(true); } });
  if (c.can_delete) actions.push({ label: "Delete", icon: Trash2, danger: true, hint: c.mine ? undefined : "It's on your post, so you can delete it", onClick: () => void remove() });
  const name = c.author?.name ?? "Someone";
  if (!c.mine) actions.push({ label: "Report", icon: TriangleAlert, danger: true, hint: "Tell the admins of a group it's in", onClick: () => setReporting(true) });
  const r = c.reactions;

  // Just sent, still on its way: the words, and nothing to press yet.
  if (isSending(c)) {
    return (
      <div id={`comment-${c.id}`} className="flex gap-3 opacity-70">
        <PorchAvatar user={c.author} size={small ? 24 : 32} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap break-words text-sm leading-snug text-[var(--text)]">
            <b className="mr-1.5 font-semibold">{name}</b>
            <RichText text={c.body} mentions={c.mentions} />
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">Sending…</p>
        </div>
      </div>
    );
  }

  return (
    <div id={`comment-${c.id}`} data-comment={c.id} className="flex gap-3">
      <PorchAvatar user={c.author} size={small ? 24 : 32} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex flex-col gap-2">
            <TextArea
              aria-label="Edit your comment"
              value={draft}
              maxLength={2000}
              rows={2}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setEditing(false);
                } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void save();
              }}
              className="!min-h-[64px]"
            />
            <div className="flex gap-2">
              <ItemButton size="sm" variant="primary" disabled={busy || !draft.trim()} onClick={() => void save()}>
                Save
              </ItemButton>
              <ItemButton size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </ItemButton>
            </div>
          </div>
        ) : (
          <div {...hold.handlers} className="select-text">
            <p className="whitespace-pre-wrap break-words text-sm leading-snug text-[var(--text)]">
              <PersonLink user={c.author} className="mr-1.5 text-sm" />
              <RichText text={c.body} mentions={c.mentions} />
            </p>
          </div>
        )}
        {!editing && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-[var(--text-muted)]">
            {c.created_at && (
              <time dateTime={c.created_at} title={fullTime(c.created_at)}>
                {shortAgo(c.created_at)}
              </time>
            )}
            {c.edited_at && <span title={fullTime(c.edited_at)}>edited</span>}
            <button type="button" onClick={() => onReply(c)} className="-mx-1.5 min-h-[40px] px-1.5 font-semibold hover:text-[var(--text)]" aria-label={`Reply to ${name}`}>
              Reply
            </button>
            <ReactionsLine r={r} onWho={c.mine ? () => setWho(true) : undefined} className="text-xs text-[var(--text-muted)]" />
            {actions.length > 0 && (
              <button
                type="button"
                aria-label={`More for ${c.mine ? "your" : `${name}'s`} comment`}
                aria-haspopup="dialog"
                onClick={() => setMenu(true)}
                className="flex h-10 w-10 items-center justify-center rounded-lg hover:bg-[var(--hover)] hover:text-[var(--text)]"
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>
        )}
      </div>
      {!editing && (
        <button
          type="button"
          {...heart.handlers}
          onClick={() => {
            if (heart.consumed()) return;
            setPop(!r.mine);
            void react(r.mine ? null : HEART);
          }}
          aria-pressed={!!r.mine}
          aria-label={r.mine ? `Take back your ${r.mine} on ${name}'s comment` : `React to ${name}'s comment with a heart`}
          title="Tap for ❤️, hold for more"
          className="flex h-10 w-10 shrink-0 items-center justify-center self-start rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
        >
          {r.mine && r.mine !== HEART ? (
            <span className="text-base" aria-hidden>
              {r.mine}
            </span>
          ) : (
            <Heart className={cn("h-4 w-4", r.mine && pop && "porch-pop", r.mine && "fill-[var(--danger)] text-[var(--danger)]")} aria-hidden />
          )}
        </button>
      )}
      <ReactionPicker open={!!picker} at={picker} current={r.mine} onPick={(e) => void react(e)} onClose={() => setPicker(null)} label={`React to ${name}'s comment`} />
      <ActionSheet open={menu} onClose={() => setMenu(false)} title={c.mine ? "Your comment" : `${name}'s comment`} actions={actions} />
      {!c.mine && <ReportSheet open={reporting} onClose={() => setReporting(false)} target="comment" id={c.id} who={name} authorId={c.author?.id} groups={post.groups} />}
      {c.mine && <WhoReactedSheet target="comment" id={c.id} open={who} onClose={() => setWho(false)} />}
    </div>
  );
}

/** The comments in a bottom sheet (phone), the box pinned under them. */
export function CommentsSheet({ post, open, onClose }: { post: PorchPost; open: boolean; onClose: () => void }) {
  const title = useMemo(() => (post.comment_count ? `Comments (${post.comment_count})` : "Comments"), [post.comment_count]);
  if (!open) return null;
  return (
    <CommentThread post={post}>
      {(list, box) => (
        <Sheet open={open} onClose={onClose} title={title} size="lg" footer={box}>
          <div className="min-h-[55dvh]">{list}</div>
        </Sheet>
      )}
    </CommentThread>
  );
}

/** The comments under a post, inline (desktop, and the post's own page). */
export function InlineComments({ post, focusBox, className }: { post: PorchPost; focusBox?: boolean; className?: string }) {
  return (
    <CommentThread post={post} focusBox={focusBox}>
      {(list, box) => (
        <section aria-label="Comments" data-comments className={cn("flex flex-col gap-3", className)}>
          {list}
          <div className="border-t border-[var(--border)] pt-3">{box}</div>
        </section>
      )}
    </CommentThread>
  );
}
