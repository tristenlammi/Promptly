import { Bookmark, ChevronDown, Heart, MessageCircle } from "lucide-react";
import { useState } from "react";

import { HEART, type PorchPost } from "@/api/porch";
import { cn } from "@/utils/cn";

import { usePostTalk } from "../talkActions";
import { ReactionPicker, ReactionsLine, useLongPress, WhoReactedSheet } from "./Reactions";

const btn =
  "inline-flex h-10 min-w-[40px] items-center justify-center gap-1.5 rounded-xl px-2 text-sm font-medium text-[var(--text)] transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]";

/**
 * Under a post: React (tap for ❤️, hold for the other five — or the small
 * arrow beside it), Comment, and Save on the right. Then the reactions —
 * who reacted on your own post, only the emoji on anyone else's — and the
 * latest two comments with "View all 12 comments".
 */
export function PostActions({ post, onComments, preview = true }: { post: PorchPost; onComments: (focusBox: boolean) => void; preview?: boolean }) {
  const { react, save } = usePostTalk();
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  const [who, setWho] = useState(false);
  const press = useLongPress((at) => setPicker(at));
  // The little pop is for a tap just now, not for every post you liked before.
  const [pop, setPop] = useState(false);
  const r = post.reactions;
  const mine = r.mine;
  const author = post.author?.name ?? "Someone";

  return (
    <div className="flex flex-col gap-1 px-2 md:px-0">
      <div className="flex items-center gap-0.5">
        <div className="flex items-center">
          <button
            type="button"
            {...press.handlers}
            onClick={() => {
              if (press.consumed()) return;
              setPop(!mine);
              void react(post, mine ? null : HEART);
            }}
            aria-pressed={!!mine}
            aria-label={mine ? `Take back your ${mine}` : `React to ${post.mine ? "your" : `${author}'s`} post with a heart`}
            title="Tap for ❤️, hold for more"
            className={btn}
          >
            {mine && mine !== HEART ? (
              <span className="text-xl leading-none" aria-hidden>
                {mine}
              </span>
            ) : (
              <Heart className={cn("h-6 w-6", mine && pop && "porch-pop", mine && "fill-[var(--danger)] text-[var(--danger)]")} aria-hidden />
            )}
          </button>
          <button
            type="button"
            aria-label="More reactions"
            aria-haspopup="menu"
            onClick={(e) => {
              const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setPicker({ x: b.left + b.width / 2, y: b.top });
            }}
            className="-ml-1 inline-flex h-10 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
          >
            <ChevronDown className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <button type="button" onClick={() => onComments(true)} className={btn} aria-label={post.comment_count ? `Comment (${post.comment_count} so far)` : "Comment"}>
          <MessageCircle className="h-6 w-6" aria-hidden />
          {/* Phones: how many, beside the icon. Bigger screens: the word. */}
          {post.comment_count > 0 && (
            <span aria-hidden className="text-sm font-semibold tabular-nums md:hidden">
              {post.comment_count}
            </span>
          )}
          <span className="sr-only md:not-sr-only">Comment</span>
        </button>
        <button
          type="button"
          onClick={() => void save(post, !post.saved)}
          aria-pressed={post.saved}
          aria-label={post.saved ? "Saved (tap to take it out)" : "Save"}
          title={post.saved ? "In your saved posts" : "Save for later"}
          className={cn(btn, "ml-auto")}
        >
          <Bookmark className={cn("h-6 w-6", post.saved && "fill-[var(--text)]")} aria-hidden />
        </button>
      </div>

      {r.emojis.length > 0 && (
        <div className="px-2">
          <ReactionsLine r={r} onWho={post.mine ? () => setWho(true) : undefined} />
        </div>
      )}

      {preview && post.comment_count > 0 && (
        <div className="flex flex-col gap-0.5 px-2 text-sm">
          {post.comment_count > post.latest_comments.length && (
            <button type="button" onClick={() => onComments(false)} className="w-fit text-left text-[var(--text-muted)] hover:text-[var(--text)]">
              View all {post.comment_count} comments
            </button>
          )}
          {post.latest_comments.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onComments(false)}
              className="w-full truncate text-left text-[var(--text)]"
              aria-label={`${c.author?.name ?? "Someone"}: ${c.body}. Open the comments`}
            >
              <b className="mr-1.5 font-semibold">{c.author?.name ?? "Someone"}</b>
              <span className="text-[var(--text)]">{c.body.split("\n")[0]}</span>
            </button>
          ))}
        </div>
      )}

      <ReactionPicker open={!!picker} at={picker} current={mine} onPick={(e) => void react(post, e)} onClose={() => setPicker(null)} label={`React to ${author}'s post`} />
      {post.mine && <WhoReactedSheet target="post" id={post.id} open={who} onClose={() => setWho(false)} />}
    </div>
  );
}
