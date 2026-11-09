import { useQueryClient } from "@tanstack/react-query";
import {
  Baby,
  BellRing,
  Briefcase,
  CalendarPlus,
  Download,
  ExternalLink,
  GraduationCap,
  Gem,
  Home,
  ImageOff,
  Link2,
  MapPin,
  MessageSquareShare,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  ShieldMinus,
  Sparkles,
  Trash2,
  TriangleAlert,
  UserX,
} from "lucide-react";
import { useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import { HEART, porchApi, type LifeEventType, type PorchPost, type PorchUser } from "@/api/porch";
import { SendToSheet } from "@/components/share/SendToSheet";
import { confirm } from "@/components/shared/ConfirmDialog";
import { Sheet } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { useBlock } from "../actions";
import { profileKey, putPost } from "../cache";
import { usePorch } from "../context";
import { usePostTalk } from "../talkActions";
import { CommentsSheet, InlineComments } from "./Comments";
import { MakeEventSheet } from "./MakeEventSheet";
import { MediaCarousel } from "./MediaCarousel";
import { PollCard } from "./PollCard";
import { PostActions } from "./PostActions";
import { RemoveFromEveryoneSheet, ReportSheet } from "./ReportSheet";
import { RichText } from "./RichText";
import { ActionSheet, PorchAvatar, PersonLink, dayWords, fullTime, groupsLine, shortAgo, type MenuAction } from "./ui";

export { RichText };

export const LIFE_EVENTS: Record<LifeEventType, { label: string; icon: ComponentType<{ className?: string }> }> = {
  new_baby: { label: "New baby", icon: Baby },
  new_job: { label: "New job", icon: Briefcase },
  moved_house: { label: "Moved house", icon: Home },
  engaged: { label: "Engaged", icon: Gem },
  graduated: { label: "Graduated", icon: GraduationCap },
  other: { label: "Life event", icon: Sparkles },
};

/** A caption cut to three lines, with "more". */
function Caption({ text, big, full, mentions }: { text: string; big?: boolean; full?: boolean; mentions: PorchUser[] }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(!!full);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [text, open]);
  return (
    <div className="px-4 md:px-0">
      <p
        ref={ref}
        className={cn(
          "whitespace-pre-wrap break-words text-[var(--text)]",
          big ? "text-xl leading-snug" : "text-[15px] leading-relaxed",
          !open && "line-clamp-3",
        )}
      >
        <RichText text={text} mentions={mentions} />
      </p>
      {long && !open && (
        <button type="button" onClick={() => setOpen(true)} className="mt-0.5 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text)]">
          more
        </button>
      )}
    </div>
  );
}

function LinkCard({ link }: { link: NonNullable<PorchPost["link"]> }) {
  let host = "";
  try {
    host = new URL(link.url).hostname.replace(/^www\./, "");
  } catch {
    /* shown as given */
  }
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="mx-4 flex flex-col gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-3 transition hover:border-[var(--item-accent)] md:mx-0"
    >
      <span className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
        <ExternalLink className="h-3 w-3" aria-hidden /> {link.site_name || host}
      </span>
      <span className="line-clamp-2 text-sm font-semibold text-[var(--text)]">{link.title || link.url}</span>
      {link.description && <span className="line-clamp-2 text-xs text-[var(--text-muted)]">{link.description}</span>}
    </a>
  );
}

function LifeEventCard({ post }: { post: PorchPost }) {
  const ev = post.life_event;
  if (!ev) return null;
  const meta = LIFE_EVENTS[ev.type] ?? LIFE_EVENTS.other;
  const Icon = meta.icon;
  return (
    <div className="mx-4 flex flex-col items-center gap-2 rounded-2xl bg-[color-mix(in_srgb,var(--item-accent)_10%,var(--surface))] px-4 py-6 text-center md:mx-0">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--item-accent)] text-white">
        <Icon className="h-7 w-7" />
      </span>
      <p className="text-lg font-semibold text-[var(--text)]">{ev.title || meta.label}</p>
      <p className="text-sm text-[var(--text-muted)]">
        {meta.label} · {dayWords(ev.date)}
      </p>
    </div>
  );
}

/**
 * One post: who posted it and in which of *your* groups, its photos, words,
 * link, place or life event, and "…" for what you can do with it.
 * ``full`` is the post's own page (nothing cut short).
 */
export function PostCard({ post, full = false, media = true, className }: { post: PorchPost; full?: boolean; media?: boolean; className?: string }) {
  const [menu, setMenu] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [planning, setPlanning] = useState(false);
  // Comments: a sheet on a phone, under the post on a computer, always on
  // the post's own page.
  const [talk, setTalk] = useState<null | { focus: boolean }>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [reporting, setReporting] = useState(false);
  const [unEveryone, setUnEveryone] = useState(false);
  const block = useBlock();
  const { isPhone, b } = usePorch();
  const { react } = usePostTalk();
  const ref = useRef<HTMLElement>(null);
  const openComments = (focus: boolean) => {
    if (full) {
      const box = ref.current?.querySelector<HTMLTextAreaElement>("[data-comments] textarea");
      box?.scrollIntoView({ block: "center", behavior: "smooth" });
      if (focus) box?.focus({ preventScroll: true });
      return;
    }
    setTalk((t) => (t && !isPhone ? null : { focus }));
  };
  const heart = () => {
    if (!post.reactions.mine) void react(post, HEART);
  };
  const author = post.author;
  const isText = post.kind === "text" || post.kind === "poll";
  const big = isText && !post.link && post.body.length > 0 && post.body.length < 120;
  const who = author?.name ?? "Someone";

  const actions: MenuAction[] = [];
  if (post.can_edit) {
    actions.push({
      label: "Edit post",
      icon: Pencil,
      hint: post.kind === "text" || post.kind === "poll" ? "Its words and place" : "Its words, photos and place",
      onClick: () => navigate(`/porch/p/${post.id}/edit`),
    });
  }
  if (!post.mine && author) {
    actions.push({
      label: "Reply privately",
      icon: MessagesSquare,
      hint: `A message to ${who} in Rooms, with this post`,
      onClick: async () => {
        try {
          const got = await porchApi.replyPrivately(post.id);
          navigate(got.url);
        } catch (err) {
          toast.error(apiErrorMessage(err, "Couldn't open a conversation. Try again."));
        }
      },
    });
  }
  actions.push({
    label: "Share to a Room",
    icon: MessageSquareShare,
    hint: "Only people who can see this post can open it",
    onClick: () => setSharing(true),
  });
  actions.push({
    label: "Make this an event",
    icon: CalendarPlus,
    hint: "In your calendar, inviting people who can see this post",
    onClick: () => setPlanning(true),
  });
  actions.push({
    label: "Copy link",
    icon: Link2,
    hint: "Only people who can see this post can open it",
    onClick: () => {
      const url = `${window.location.origin}/porch/p/${post.id}`;
      void navigator.clipboard?.writeText(url).then(
        () => toast.success("Link copied."),
        () => toast.error("Couldn't copy the link."),
      );
    },
  });
  if (post.media.some((m) => m.full)) {
    actions.push({ label: post.media.length > 1 ? "Save photos" : post.media[0]?.kind === "video" ? "Save video" : "Save photo", icon: Download, onClick: () => setSaving(true) });
  }
  if (!post.mine && author) {
    actions.push({
      label: `Turn on posts from ${who}`,
      icon: BellRing,
      hint: `A notification when ${who} posts. Turn it off on their profile.`,
      onClick: async () => {
        try {
          await porchApi.setAlert(author.id, true);
          void qc.invalidateQueries({ queryKey: profileKey(author.id) });
          toast.success(`You'll get a notification when ${who} posts.`);
        } catch (err) {
          toast.error(apiErrorMessage(err, "Couldn't turn that on. Try again."));
        }
      },
    });
  }
  // Server admins run Everyone: they can take someone's post out of it.
  const inEveryone = post.groups.some((g) => g.kind === "everyone");
  if (!post.mine && b?.me?.is_admin && inEveryone) {
    actions.push({ label: `Remove from ${b.everyone.name}`, icon: ShieldMinus, hint: "Asks for a reason, which they'll see", danger: true, onClick: () => setUnEveryone(true) });
  }
  if (!post.mine && author) actions.push({ label: `Block ${who}`, icon: UserX, danger: true, onClick: () => void block(author) });
  if (!post.mine) actions.push({ label: "Report", icon: TriangleAlert, hint: "Tell the person who runs this Promptly", danger: true, onClick: () => setReporting(true) });
  if (post.can_delete) {
    actions.push({
      label: "Delete post",
      icon: Trash2,
      danger: true,
      onClick: async () => {
        const ok = await confirm({
          title: "Delete this post?",
          message: post.mine
            ? "This deletes the post for everyone. The photos stay in your Photos library."
            : `This deletes ${who}'s post for everyone. Their photos stay in their Photos library.`,
          confirmLabel: "Delete",
          danger: true,
        });
        if (!ok) return;
        try {
          await porchApi.deletePost(post.id);
          putPost(qc, post.id, null);
          toast.success("Post deleted.");
        } catch (err) {
          toast.error(apiErrorMessage(err, "Couldn't delete the post. Try again."));
        }
      },
    });
  }

  const hasMedia = media && post.media.length > 0;
  const actions_ = <PostActions post={post} onComments={openComments} preview={!full && !(talk && !isPhone)} />;

  const time = (
    <Link to={`/porch/p/${post.id}`} className="hover:underline" title={fullTime(post.created_at)}>
      <time dateTime={post.created_at}>{shortAgo(post.created_at)}</time>
    </Link>
  );

  return (
    <article
      ref={ref}
      aria-label={`Post by ${who}`}
      data-post={post.id}
      className={cn("flex flex-col gap-3 py-3 md:rounded-2xl md:border md:border-[var(--border)] md:bg-[var(--surface)] md:px-4 md:shadow-[var(--shadow-sm)]", className)}
    >
      <header className="flex items-center gap-3 px-4 md:px-0">
        <Link to={author ? `/porch/u/${author.id}` : "#"} tabIndex={-1} aria-hidden>
          <PorchAvatar user={author} size={40} />
        </Link>
        <div className="min-w-0 flex-1 text-sm leading-tight">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <PersonLink user={author} className="truncate" />
            <span className="shrink-0 text-xs text-[var(--text-muted)]">
              {time}
              {post.edited_at && <span title={fullTime(post.edited_at)}> · edited</span>}
            </span>
          </div>
          {post.groups.length > 0 && <div className="truncate text-xs text-[var(--text-muted)]">in {groupsLine(post.groups)}</div>}
        </div>
        <button
          type="button"
          aria-label="More for this post"
          aria-haspopup="dialog"
          onClick={() => setMenu(true)}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
        >
          <MoreHorizontal className="h-5 w-5" />
        </button>
      </header>

      {post.kind === "life_event" && <LifeEventCard post={post} />}

      {media && post.media.length > 0 && (
        <MediaCarousel
          media={post.media}
          label={`${who}'s ${post.media.length > 1 ? `${post.media.length} photos` : post.media[0].kind === "video" ? "video" : "photo"}`}
          className="md:rounded-xl"
          onDoubleTap={heart}
        />
      )}
      {post.photo_removed && (
        <div className="mx-4 flex items-center gap-2 rounded-xl bg-[var(--surface-2)] px-3 py-6 text-sm text-[var(--text-muted)] md:mx-0">
          <ImageOff className="h-4 w-4" aria-hidden /> Photo removed
        </div>
      )}

      {/* Photos: the actions right under them, then the words (as Instagram). */}
      {hasMedia && actions_}
      {post.body && <Caption text={post.body} big={big && !post.poll} full={full} mentions={post.mentions} />}
      {post.poll && <PollCard post={post} />}
      {post.link && <LinkCard link={post.link} />}
      {post.place && (
        <Link
          to={`/maps?q=${encodeURIComponent(post.place.name)}`}
          className="mx-4 inline-flex w-fit items-center gap-1 text-sm text-[var(--text-muted)] hover:text-[var(--text)] md:mx-0"
        >
          <MapPin className="h-4 w-4" aria-hidden /> {post.place.name}
        </Link>
      )}
      {!hasMedia && actions_}

      {full && <InlineComments post={post} className="px-4 md:px-0" />}
      {!full && talk && !isPhone && <InlineComments post={post} focusBox={talk.focus} className="mx-4 rounded-xl bg-[var(--surface-1)] p-3 md:mx-0" />}
      {!full && isPhone && <CommentsSheet post={post} open={!!talk} onClose={() => setTalk(null)} />}

      <ActionSheet open={menu} onClose={() => setMenu(false)} title={post.mine ? "Your post" : `${who}'s post`} actions={actions} />
      {!post.mine && <ReportSheet open={reporting} onClose={() => setReporting(false)} target="post" id={post.id} who={who} />}
      {!post.mine && b?.me?.is_admin && inEveryone && (
        <RemoveFromEveryoneSheet
          open={unEveryone}
          onClose={() => setUnEveryone(false)}
          postId={post.id}
          who={who}
          everyone={b.everyone.name}
          onDone={() => void qc.invalidateQueries({ queryKey: ["porch"] })}
        />
      )}
      {saving && <SaveSheet post={post} onClose={() => setSaving(false)} />}
      <SendToSheet
        open={sharing}
        onClose={() => setSharing(false)}
        target={{ kind: "porch_post", id: post.id, title: shareTitle(post, who) }}
        canGrant={false}
      />
      <MakeEventSheet post={post} open={planning} onClose={() => setPlanning(false)} />
    </article>
  );
}

/** How the post is named in "Send to…" ("Sharing “BBQ Saturday”"). */
function shareTitle(post: PorchPost, who: string): string {
  const line = post.body.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
  if (line) return line.length > 60 ? `${line.slice(0, 59)}…` : line;
  if (post.life_event?.title) return post.life_event.title;
  if (post.kind === "photo" || post.kind === "video") return `${who}'s ${post.media.length > 1 ? `${post.media.length} photos` : post.kind}`;
  return `${who}'s post`;
}

function SaveSheet({ post, onClose }: { post: PorchPost; onClose: () => void }) {
  const items = post.media.filter((m) => m.full);
  return (
    <Sheet open onClose={onClose} title={items.length > 1 ? "Save photos" : "Save"} size="md">
      <p className="mb-3 text-sm text-[var(--text-muted)]">Saved at full size, as posted (with its place, if it has one).</p>
      <ul className="grid grid-cols-3 gap-2">
        {items.map((m, i) => (
          <li key={m.id} className="flex flex-col gap-1">
            <a
              href={m.full ?? undefined}
              download
              className="group relative block aspect-square overflow-hidden rounded-xl bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
              aria-label={`Save ${m.kind === "video" ? "video" : "photo"} ${i + 1}`}
            >
              {(m.thumb || m.poster) && <img src={(m.thumb || m.poster) ?? undefined} alt="" className="h-full w-full object-cover" />}
              <span className="absolute bottom-1 right-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white">
                <Download className="h-3.5 w-3.5" />
              </span>
            </a>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

export function PostList({ children }: { children: ReactNode }) {
  return <div className="flex flex-col divide-y divide-[var(--border)] md:gap-4 md:divide-y-0">{children}</div>;
}
