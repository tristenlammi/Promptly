import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, Bell, Heart, MessageCircle, Reply, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { Link } from "react-router-dom";

import { porchApi, type ActivityItem, type TagRequest } from "@/api/porch";
import { EmptyState, ItemButton, List, Section } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { ACTIVITY_KEY, BOOTSTRAP_KEY, refreshPost, updateBootstrap } from "../cache";
import { Column, LoadError, PageHeader, PorchAvatar, fullTime, shortAgo } from "../components/ui";
import { InviteRow } from "./GroupsPage";

const ICONS: Record<ActivityItem["kind"], ComponentType<{ className?: string }>> = {
  comment: MessageCircle,
  reply: Reply,
  mention: AtSign,
  reaction: Heart,
  removed: ShieldAlert,
};

/** "Sam", "Sam and Mum", "Sam, Mum and 3 others". */
function actorsWords(it: ActivityItem): string {
  const names = it.actors.map((a) => a.name);
  if (it.others > 0) return `${names.join(", ")} and ${it.others} ${it.others === 1 ? "other" : "others"}`;
  return names.length === 2 ? `${names[0]} and ${names[1]}` : names[0] ?? "Someone";
}

function itemWords(it: ActivityItem): { lead: string; rest: string; quote: string | null } {
  const lead = actorsWords(it);
  const quote = it.text ? `“${it.text}”` : null;
  switch (it.kind) {
    case "comment":
      return { lead, rest: "commented on your post", quote };
    case "reply":
      return { lead, rest: "replied to your comment", quote };
    case "mention":
      return { lead, rest: it.comment_id ? "mentioned you in a comment" : "mentioned you in a post", quote };
    case "reaction":
      return { lead, rest: `reacted ${(it.emoji ?? []).join("")} to your ${it.target === "comment" ? "comment" : "post"}`, quote: null };
    case "removed":
      return { lead: "", rest: "", quote };
  }
}

/** A server admin took down your post or comment (or took it out of
 *  Everyone): what, and the reason they gave. Only you see this. */
function RemovedRow({ it }: { it: ActivityItem }) {
  const what = it.target === "comment" ? "comment" : "post";
  const where = it.removed?.scope === "everyone" ? " from Everyone" : "";
  const reason = it.removed?.reason?.trim();
  const inner = (
    <>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text-muted)]" aria-hidden>
        <ShieldAlert className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1 text-sm leading-snug text-[var(--text)]">
        <b className="font-semibold">
          Your {what} was removed{where}
        </b>
        {reason ? <span className="text-[var(--text-muted)]">: “{reason}”</span> : <span className="text-[var(--text-muted)]"> by the person who runs this Promptly.</span>}
        {it.text && <span className="mt-0.5 block truncate text-xs text-[var(--text-muted)]">{it.text}</span>}
        <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
          <time dateTime={it.at} title={fullTime(it.at)}>
            {shortAgo(it.at)}
          </time>
          {it.unseen && <span className="sr-only"> · new</span>}
        </span>
      </span>
    </>
  );
  const cls = cn(
    "flex min-h-[64px] items-center gap-3 px-3 py-2.5",
    it.unseen && "bg-[color-mix(in_srgb,var(--item-accent)_7%,transparent)]",
  );
  if (!it.post) {
    return (
      <div data-activity="removed" className={cls}>
        {inner}
      </div>
    );
  }
  return (
    <Link
      to={`/porch/p/${it.post.id}`}
      data-activity="removed"
      className={cn(cls, "transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]")}
    >
      {inner}
    </Link>
  );
}

function bucket(iso: string, now = new Date()): "Today" | "This week" | "Earlier" {
  const d = new Date(iso);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (d >= start) return "Today";
  if (now.getTime() - d.getTime() < 7 * 86_400_000) return "This week";
  return "Earlier";
}

function Thumb({ src, text }: { src: string | null; text: string }) {
  if (src) return <img src={src} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />;
  return (
    <span aria-hidden className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--surface-2)] p-1 text-[9px] leading-tight text-[var(--text-muted)]">
      {text.slice(0, 40)}
    </span>
  );
}

function ItemRow({ it }: { it: ActivityItem }) {
  if (it.kind === "removed" || !it.post) return <RemovedRow it={it} />;
  return <TalkRow it={it} post={it.post} />;
}

function TalkRow({ it, post }: { it: ActivityItem; post: NonNullable<ActivityItem["post"]> }) {
  const Icon = ICONS[it.kind];
  const w = itemWords(it);
  const to = `/porch/p/${post.id}${it.comment_id ? `#comment-${it.comment_id}` : ""}`;
  return (
    <Link
      to={to}
      data-activity={it.kind}
      className={cn(
        "flex min-h-[64px] items-center gap-3 px-3 py-2.5 transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]",
        it.unseen && "bg-[color-mix(in_srgb,var(--item-accent)_7%,transparent)]",
      )}
    >
      <span className="relative shrink-0">
        <PorchAvatar user={it.actors[0]} size={40} />
        <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--item-accent)] text-white ring-2 ring-[var(--surface)]" aria-hidden>
          <Icon className="h-3 w-3" />
        </span>
      </span>
      <span className="min-w-0 flex-1 text-sm leading-snug text-[var(--text)]">
        <b className="font-semibold">{w.lead}</b> {w.rest}
        {w.quote && <span className="text-[var(--text-muted)]">: {w.quote}</span>}
        <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
          <time dateTime={it.at} title={fullTime(it.at)}>
            {shortAgo(it.at)}
          </time>
          {it.unseen && <span className="sr-only"> · new</span>}
        </span>
      </span>
      <Thumb src={post.thumb} text={post.body} />
    </Link>
  );
}

function TagRequestRow({ t, onDone }: { t: TagRequest; onDone: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const answer = async (yes: boolean) => {
    setBusy(true);
    try {
      await porchApi.answerTag(t.id, yes);
      toast.success(yes ? "Your tag shows on the photo now." : "You won't be tagged in that photo.");
      void refreshPost(qc, t.post.id);
      onDone();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't answer. Try again."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-tag-request={t.id} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
      <Link to={`/porch/p/${t.post.id}`} className="flex min-w-0 flex-1 items-center gap-3">
        <Thumb src={t.thumb ?? t.post.thumb} text={t.post.body} />
        <span className="min-w-0 text-sm text-[var(--text)]">
          <b className="font-semibold">{t.by?.name ?? "Someone"}</b> tagged you in a photo
          <span className="block text-xs text-[var(--text-muted)]">It shows once you say yes.{t.created_at ? ` · ${shortAgo(t.created_at)}` : ""}</span>
        </span>
      </Link>
      <div className="flex shrink-0 gap-2">
        <ItemButton size="sm" variant="primary" disabled={busy} onClick={() => void answer(true)}>
          Show it
        </ItemButton>
        <ItemButton size="sm" variant="secondary" disabled={busy} onClick={() => void answer(false)}>
          Not me
        </ItemButton>
      </div>
    </div>
  );
}

/** ``/porch/activity``: what's about you. Opening it marks it seen. */
export function ActivityPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ACTIVITY_KEY, queryFn: porchApi.activity, staleTime: 0 });
  const marked = useRef(false);
  const firstAt = useRef(0);
  const data = q.data;

  // Seen as soon as it's on screen: the badge clears (invites and tag
  // requests keep counting until they're answered). What was new stays
  // highlighted while you're here.
  useEffect(() => {
    if (!data || marked.current) return;
    marked.current = true;
    firstAt.current = q.dataUpdatedAt;
    void porchApi
      .activitySeen()
      .then(() => updateBootstrap(qc, (b) => ({ ...b, activity_unseen: data.invites.length + data.tag_requests.length })))
      .catch(() => {
        marked.current = false;
      });
  }, [data, qc, q.dataUpdatedAt]);
  // Live: something new arrived while you're looking. Seen too.
  useEffect(() => {
    if (q.dataUpdatedAt && marked.current && q.dataUpdatedAt !== firstAt.current) {
      void porchApi.activitySeen().then(() => void qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY })).catch(() => undefined);
    }
  }, [q.dataUpdatedAt, qc]);

  const refetch = () => void q.refetch();
  let body;
  if (q.isPending) body = <p className="px-4 py-10 text-center text-sm text-[var(--text-muted)]">Loading…</p>;
  else if (q.isError) body = <LoadError what="Couldn't load your activity." onRetry={refetch} />;
  else if (data && !data.items.length && !data.invites.length && !data.tag_requests.length) {
    body = <EmptyState className="mx-4 mt-4 md:mx-0" icon={Bell} title="Nothing new" text="Comments, reactions and invites show up here." />;
  } else if (data) {
    const groups: { title: string; items: ActivityItem[] }[] = [];
    for (const it of data.items) {
      const t = bucket(it.at);
      const g = groups.find((x) => x.title === t);
      if (g) g.items.push(it);
      else groups.push({ title: t, items: [it] });
    }
    body = (
      <div className="flex flex-col gap-6 px-4 pt-2 md:px-0">
        {data.invites.length > 0 && (
          <Section title="Invites" hint="Nobody is added to a group without saying yes.">
            <List>
              {data.invites.map((g) => (
                <InviteRow key={g.id} g={g} />
              ))}
            </List>
          </Section>
        )}
        {data.tag_requests.length > 0 && (
          <Section title="Needs your OK" hint="Tags show on a photo only after you say yes.">
            <List>
              {data.tag_requests.map((t) => (
                <TagRequestRow key={t.id} t={t} onDone={refetch} />
              ))}
            </List>
          </Section>
        )}
        {groups.map((g) => (
          <Section key={g.title} title={g.title}>
            <List>
              {g.items.map((it) => (
                <ItemRow key={it.id} it={it} />
              ))}
            </List>
          </Section>
        ))}
        {!data.items.length && <p className="px-1 text-sm text-[var(--text-muted)]">Nothing else new. Comments and reactions show up here.</p>}
      </div>
    );
  }

  return (
    <Column>
      <PageHeader title="Activity" />
      {body}
    </Column>
  );
}
