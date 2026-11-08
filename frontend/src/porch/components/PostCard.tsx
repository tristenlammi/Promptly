import { useQueryClient } from "@tanstack/react-query";
import {
  Baby,
  Briefcase,
  Download,
  ExternalLink,
  GraduationCap,
  Gem,
  Home,
  ImageOff,
  Link2,
  MapPin,
  MoreHorizontal,
  Pencil,
  Sparkles,
  Trash2,
  UserX,
} from "lucide-react";
import { Fragment, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { porchApi, type LifeEventType, type PorchPost } from "@/api/porch";
import { confirm } from "@/components/shared/ConfirmDialog";
import { ItemButton, Sheet, TextArea } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { useBlock } from "../actions";
import { putPost } from "../cache";
import { MediaCarousel } from "./MediaCarousel";
import { ActionSheet, PorchAvatar, PersonLink, dayWords, fullTime, groupsLine, shortAgo, type MenuAction } from "./ui";

export const LIFE_EVENTS: Record<LifeEventType, { label: string; icon: ComponentType<{ className?: string }> }> = {
  new_baby: { label: "New baby", icon: Baby },
  new_job: { label: "New job", icon: Briefcase },
  moved_house: { label: "Moved house", icon: Home },
  engaged: { label: "Engaged", icon: Gem },
  graduated: { label: "Graduated", icon: GraduationCap },
  other: { label: "Life event", icon: Sparkles },
};

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

/** Plain text with web links made clickable (nothing else is interpreted). */
export function RichText({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer nofollow" className="text-[var(--accent-text)] underline-offset-2 hover:underline">
            {part}
          </a>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/** A caption cut to three lines, with "more". */
function Caption({ text, big, full }: { text: string; big?: boolean; full?: boolean }) {
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
        <RichText text={text} />
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
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const qc = useQueryClient();
  const block = useBlock();
  const author = post.author;
  const isText = post.kind === "text" || post.kind === "poll";
  const big = isText && !post.link && post.body.length > 0 && post.body.length < 120;
  const who = author?.name ?? "Someone";

  const actions: MenuAction[] = [];
  if (post.can_edit) actions.push({ label: "Edit words", icon: Pencil, onClick: () => setEditing(true) });
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
  if (!post.mine && author) actions.push({ label: `Block ${who}`, icon: UserX, danger: true, onClick: () => void block(author) });
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

  const time = (
    <Link to={`/porch/p/${post.id}`} className="hover:underline" title={fullTime(post.created_at)}>
      <time dateTime={post.created_at}>{shortAgo(post.created_at)}</time>
    </Link>
  );

  return (
    <article
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
        <MediaCarousel media={post.media} label={`${who}'s ${post.media.length > 1 ? `${post.media.length} photos` : post.media[0].kind === "video" ? "video" : "photo"}`} className="md:rounded-xl" />
      )}
      {post.photo_removed && (
        <div className="mx-4 flex items-center gap-2 rounded-xl bg-[var(--surface-2)] px-3 py-6 text-sm text-[var(--text-muted)] md:mx-0">
          <ImageOff className="h-4 w-4" aria-hidden /> Photo removed
        </div>
      )}

      {post.body && <Caption text={post.body} big={big} full={full} />}
      {post.link && <LinkCard link={post.link} />}
      {post.place && (
        <Link
          to={`/maps?q=${encodeURIComponent(post.place.name)}`}
          className="mx-4 inline-flex w-fit items-center gap-1 text-sm text-[var(--text-muted)] hover:text-[var(--text)] md:mx-0"
        >
          <MapPin className="h-4 w-4" aria-hidden /> {post.place.name}
        </Link>
      )}

      <ActionSheet open={menu} onClose={() => setMenu(false)} title={post.mine ? "Your post" : `${who}'s post`} actions={actions} />
      {editing && <EditWordsSheet post={post} onClose={() => setEditing(false)} />}
      {saving && <SaveSheet post={post} onClose={() => setSaving(false)} />}
    </article>
  );
}

function EditWordsSheet({ post, onClose }: { post: PorchPost; onClose: () => void }) {
  const qc = useQueryClient();
  const [body, setBody] = useState(post.body);
  const [busy, setBusy] = useState(false);
  const empty = !body.trim() && post.kind === "text" && !post.link;
  const save = async () => {
    setBusy(true);
    try {
      putPost(qc, post.id, await porchApi.updatePost(post.id, { body }));
      toast.success("Post updated.");
      onClose();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't save your changes. Try again."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title="Edit words"
      footer={
        <div className="flex justify-end gap-2">
          <ItemButton variant="ghost" onClick={onClose}>
            Cancel
          </ItemButton>
          <ItemButton variant="primary" onClick={() => void save()} disabled={busy || empty || body === post.body}>
            Save
          </ItemButton>
        </div>
      }
    >
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-[var(--text-muted)]">What you wrote</span>
        <TextArea data-autofocus value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} rows={6} />
      </label>
      <p className="mt-2 text-xs text-[var(--text-muted)]">It will say "edited". Who can see it stays the same.</p>
    </Sheet>
  );
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
