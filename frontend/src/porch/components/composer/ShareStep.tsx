import { BarChart3, ChevronRight, ExternalLink, Globe2, ImagePlus, MapPin, PartyPopper, Pencil, Tag, Users, X } from "lucide-react";
import type { ReactNode } from "react";

import type { GroupLabel, LinkSnapshot, PorchGroup, PorchUser, PostPlace } from "@/api/porch";
import { cn } from "@/utils/cn";

import { LIFE_EVENTS } from "../PostCard";
import { dayWords, groupsLine, peopleCount } from "../ui";
import { audienceWords } from "./AudienceSheet";
import { MentionBox } from "./MentionBox";
import type { Audience, LifeDraft, Pick, PollDraft } from "./model";
import { PickImage } from "./PickImage";
import { CLOSES } from "./PollEditor";

function RowButton({ icon, label, value, onClick, onClear, clearLabel }: { icon: ReactNode; label: string; value?: ReactNode; onClick: () => void; onClear?: () => void; clearLabel?: string }) {
  return (
    <div className="flex items-center rounded-xl border border-[var(--border)] bg-[var(--surface)]">
      <button
        type="button"
        onClick={onClick}
        className="flex min-h-[52px] min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text-muted)]">{icon}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn("text-sm", value ? "text-xs text-[var(--text-muted)]" : "font-medium text-[var(--text)]")}>{label}</span>
          {value && <span className="truncate text-sm font-medium text-[var(--text)]">{value}</span>}
        </span>
        {!onClear && <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />}
      </button>
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label={clearLabel}
          className="mr-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      )}
    </div>
  );
}

/**
 * Step 3, Share: who sees it first (it decides who can be mentioned), the
 * caption with @mentions, a link's preview for a text post, a place, a life
 * event. Editing a post keeps its groups.
 */
export function ShareStep({
  picks,
  onEditPhotos,
  onAddPhotos,
  audience,
  groups,
  fixedGroups,
  everyoneCount,
  onAudience,
  body,
  onBody,
  mentions,
  onMentions,
  audiencePeople,
  audienceReady,
  link,
  onDropLink,
  place,
  onPlace,
  onClearPlace,
  life,
  onLife,
  onClearLife,
  canPhotos,
  canLife,
  poll,
  onPoll,
  onClearPoll,
  canPoll,
  pollLocked,
  onTags,
}: {
  picks: Pick[];
  onEditPhotos: () => void;
  onAddPhotos: () => void;
  audience: Audience;
  groups: PorchGroup[];
  /** Editing: the post's groups, which don't change. */
  fixedGroups: GroupLabel[] | null;
  everyoneCount: number;
  onAudience: () => void;
  body: string;
  onBody: (v: string) => void;
  mentions: PorchUser[];
  onMentions: (m: PorchUser[]) => void;
  audiencePeople: PorchUser[];
  audienceReady: boolean;
  link: LinkSnapshot | null;
  onDropLink: () => void;
  place: PostPlace | null;
  onPlace: () => void;
  onClearPlace: () => void;
  life: LifeDraft | null;
  onLife: () => void;
  onClearLife: () => void;
  canPhotos: boolean;
  /** A life event can be added (not to a post that's already something else). */
  canLife: boolean;
  poll: PollDraft | null;
  onPoll: () => void;
  onClearPoll: () => void;
  /** A poll can be added (a new text post). */
  canPoll: boolean;
  /** Editing a poll: its options stay as they were. */
  pollLocked: boolean;
  /** Back to Arrange to change the tags. */
  onTags: () => void;
}) {
  const everyone = groups.find((g) => g.kind === "everyone");
  const withEveryone = !fixedGroups && !!everyone && (audience === "all" || audience.includes(everyone.id));
  const meta = life ? LIFE_EVENTS[life.type] : null;
  const LifeIcon = meta?.icon ?? PartyPopper;
  const label = picks.length ? "Caption" : life ? "Say a bit more (optional)" : poll || pollLocked ? "Question" : "What's new?";
  // Everyone tagged, and whether they'd still see the post with these groups.
  const inAudience = new Set(audiencePeople.map((u) => u.id));
  const tagged = Array.from(new Map(picks.flatMap((p) => p.tags ?? []).map((t) => [t.user.id, t.user])).values());
  const unseen = audienceReady && !fixedGroups ? tagged.filter((u) => !inAudience.has(u.id)) : [];
  return (
    <div className="flex flex-col gap-4 px-3 md:px-0">
      {picks.length > 0 && (
        <div className="flex items-center gap-2">
          <ul aria-label="Photos in this post" className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto [scrollbar-width:none]">
            {picks.map((p, i) => (
              <li key={p.key} className="shrink-0">
                <PickImage pick={p} label={p.alt || `Photo ${i + 1}`} className="h-14 w-14 rounded-lg" />
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={onEditPhotos}
            className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-[var(--accent-text)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
          >
            <Pencil className="h-4 w-4" aria-hidden /> Edit photos
          </button>
        </div>
      )}

      {fixedGroups ? (
        <div className="flex items-start gap-3 rounded-xl bg-[var(--surface-2)] px-3 py-2.5 text-sm">
          <Users className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
          <span className="text-[var(--text)]">
            {fixedGroups.length ? `Shared to ${groupsLine(fixedGroups)}.` : "Shared to its groups."}{" "}
            <span className="text-[var(--text-muted)]">A post's groups stay as they were.</span>
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <RowButton icon={<Users className="h-4 w-4" aria-hidden />} label="Share to" value={audienceWords(audience, groups)} onClick={onAudience} />
          {withEveryone && (
            <p className="flex items-center gap-1.5 px-1 text-xs text-[var(--text-muted)]">
              <Globe2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Everyone on this Promptly ({peopleCount(everyoneCount)}) will see this.
            </p>
          )}
        </div>
      )}

      {life && meta && (
        <div className="flex items-center gap-3 rounded-2xl bg-[color-mix(in_srgb,var(--item-accent)_10%,var(--surface))] p-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--item-accent)] text-white">
            <LifeIcon className="h-5 w-5" aria-hidden />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-semibold text-[var(--text)]">{life.title || meta.label}</span>
            <span className="text-xs text-[var(--text-muted)]">
              {meta.label} · {dayWords(life.date)}
            </span>
          </span>
          <button
            type="button"
            onClick={onLife}
            className="inline-flex h-10 items-center rounded-xl px-3 text-sm font-medium text-[var(--accent-text)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
          >
            Change
          </button>
          <button
            type="button"
            onClick={onClearLife}
            aria-label="Remove the life event"
            className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      )}

      <MentionBox
        value={body}
        onChange={onBody}
        mentions={mentions}
        onMentions={onMentions}
        audience={audiencePeople}
        audienceReady={audienceReady}
        label={label}
        placeholder={
          picks.length
            ? "Say something about these… type @ to mention someone"
            : poll || pollLocked
              ? "What do you want to ask?"
              : "Share some news… type @ to mention someone"
        }
      />

      {poll && (
        <div className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />
            <span className="flex-1 text-sm font-semibold text-[var(--text)]">Poll</span>
            <button
              type="button"
              onClick={onPoll}
              className="inline-flex h-9 items-center rounded-xl px-3 text-sm font-medium text-[var(--accent-text)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
            >
              Change
            </button>
            <button
              type="button"
              onClick={onClearPoll}
              aria-label="Remove the poll"
              className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <ol aria-label="Poll options" className="flex flex-col gap-1.5">
            {poll.options.map((o, i) => (
              <li key={i} className="rounded-xl border border-[var(--border)] px-3 py-2 text-sm text-[var(--text)]">
                {o}
              </li>
            ))}
          </ol>
          <p className="text-xs text-[var(--text-muted)]">{CLOSES.find((c) => c.value === poll.closes)?.words}. One vote each, changeable until it closes.</p>
        </div>
      )}
      {pollLocked && <p className="text-xs text-[var(--text-muted)]">A poll's options stay as they were once it's posted. You can change the question.</p>}

      {tagged.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <RowButton icon={<Tag className="h-4 w-4" aria-hidden />} label="Tagged" value={tagged.map((u) => u.name).join(", ")} onClick={onTags} />
          {unseen.length > 0 && (
            <p className="px-1 text-xs text-[var(--text-muted)]">
              {unseen.map((u) => u.name).join(", ")} can't see this post and won't be asked.
            </p>
          )}
        </div>
      )}

      {link && !picks.length && (
        <div className="relative flex flex-col gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-3 pr-12">
          <span className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
            <ExternalLink className="h-3 w-3" aria-hidden /> {link.site_name || link.url}
          </span>
          <span className="line-clamp-2 text-sm font-semibold text-[var(--text)]">{link.title || link.url}</span>
          {link.description && <span className="line-clamp-2 text-xs text-[var(--text-muted)]">{link.description}</span>}
          <button
            type="button"
            onClick={onDropLink}
            aria-label="Don't show the link's preview"
            className="absolute right-1 top-1 flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <RowButton
          icon={<MapPin className="h-4 w-4" aria-hidden />}
          label={place ? "Place" : "Add a place"}
          value={place?.name}
          onClick={onPlace}
          onClear={place ? onClearPlace : undefined}
          clearLabel="Remove the place"
        />
        {!life && !poll && canLife && <RowButton icon={<PartyPopper className="h-4 w-4" aria-hidden />} label="Life event" onClick={onLife} />}
        {!poll && !life && canPoll && !picks.length && <RowButton icon={<BarChart3 className="h-4 w-4" aria-hidden />} label="Poll" onClick={onPoll} />}
        {canPhotos && !picks.length && !poll && <RowButton icon={<ImagePlus className="h-4 w-4" aria-hidden />} label="Add photos" onClick={onAddPhotos} />}
      </div>
    </div>
  );
}
