import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { Check, Crown, ImageIcon, LogOut, MoreHorizontal, PenSquare, Pencil, Shield, ShieldOff, Trash2, UserMinus, UserPlus, UserRound } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { porchApi, type Member, type PorchGroup } from "@/api/porch";
import { confirm } from "@/components/shared/ConfirmDialog";
import { EmptyState, ItemButton, List, Segmented } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { useGroupActions } from "../actions";
import { groupKey, groupPostsKey, groupsChanged, listPosts, membersKey, pendingKey } from "../cache";
import { EditGroupSheet, InviteSheet } from "../components/GroupSheets";
import { PostCard, PostList } from "../components/PostCard";
import { ActionSheet, Column, GroupTile, LoadError, PageHeader, PorchAvatar, PostSkeleton, VisibilityTag, peopleCount, shortAgo, type MenuAction } from "../components/ui";
import { usePorch } from "../context";
import { GroupBell } from "../notify";
import { useSentinel } from "../scroll";
import { Unavailable } from "./PostPage";

type Tab = "posts" | "photos" | "people" | "invites";
const ROLE_WORD = { owner: "Owner", admin: "Admin", member: "" } as const;

/** ``/porch/g/:id``: a group — its posts, photos, people and invites. */
export function GroupPage({ groupId }: { groupId: string }) {
  const { b } = usePorch();
  const q = useQuery({
    queryKey: groupKey(groupId),
    queryFn: () => porchApi.group(groupId),
    retry: (n, err) => !(isAxiosError(err) && err.response?.status === 404) && n < 2,
  });
  const g = q.data;

  if (q.isPending) {
    return (
      <Column>
        <PageHeader title="Group" back />
        <PostSkeleton />
      </Column>
    );
  }
  if (q.isError || !g) {
    return (
      <Column>
        <PageHeader title="Group" back />
        {isAxiosError(q.error) && q.error.response?.status === 404 ? (
          <Unavailable title="This group isn't available" text="It may have been deleted, or it's a private group you're not in." />
        ) : (
          <LoadError what="Couldn't load this group." onRetry={() => void q.refetch()} />
        )}
      </Column>
    );
  }
  // Your tick lives in bootstrap (the chips change it): show that one.
  const mine = b.groups.find((x) => x.id === g.id);
  const group: PorchGroup = mine ? { ...g, in_feed: mine.in_feed, notify: mine.notify ?? g.notify } : g;
  return group.view === "member" ? <MemberView g={group} /> : <OutlineView g={group} />;
}

function Band({ g }: { g: PorchGroup }) {
  return g.cover_url ? (
    <img src={g.cover_url} alt="" className="h-36 w-full object-cover md:h-44 md:rounded-2xl" />
  ) : (
    <div className="flex h-28 w-full items-center justify-center bg-[color-mix(in_srgb,var(--item-accent)_14%,var(--surface))] text-5xl md:rounded-2xl" aria-hidden>
      {g.emoji || g.name.slice(0, 1).toUpperCase()}
    </div>
  );
}

function Heading({ g, faces }: { g: PorchGroup; faces?: Member[] }) {
  return (
    <div className="flex flex-col gap-2 px-4 pt-3 md:px-0">
      <div className="flex items-center gap-3">
        {g.cover_url && <GroupTile group={g} size={48} />}
        <div className="min-w-0">
          <h2 className="truncate text-xl font-bold text-[var(--text)]">
            {g.name}
          </h2>
          <VisibilityTag visibility={g.visibility} everyone={g.kind === "everyone"} />
        </div>
      </div>
      {g.about && <p className="whitespace-pre-wrap text-sm text-[var(--text)]">{g.about}</p>}
      <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
        {faces && faces.length > 0 && (
          <span className="flex -space-x-2" aria-hidden>
            {faces.slice(0, 5).map((m) => (
              <PorchAvatar key={m.id} user={m} size={28} className="ring-2 ring-[var(--bg)]" />
            ))}
          </span>
        )}
        <span>{g.kind === "everyone" ? `Everyone on this Promptly is here · ${peopleCount(g.member_count)}` : peopleCount(g.member_count)}</span>
      </div>
    </div>
  );
}

/** A public group you're not in (or one you're invited to): the outline only. */
function OutlineView({ g }: { g: PorchGroup }) {
  const { join, accept, decline } = useGroupActions();
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const run = async (fn: () => Promise<boolean>, after?: () => void) => {
    setBusy(true);
    const ok = await fn();
    setBusy(false);
    if (ok) after?.();
  };
  return (
    <Column>
      <PageHeader title={g.name} back />
      <Band g={g} />
      <Heading g={g} />
      <div className="flex flex-col gap-4 px-4 pt-4 md:px-0">
        {g.admins.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-[var(--text-muted)]">{g.admins.length === 1 ? "Admin" : "Admins"}</p>
            <ul className="flex flex-wrap gap-2">
              {g.admins.map((a) => (
                <li key={a.id}>
                  <Link to={`/porch/u/${a.id}`} className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] py-1 pl-1 pr-3 text-sm text-[var(--text)] hover:bg-[var(--hover)]">
                    <PorchAvatar user={a} size={24} />
                    {a.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        {g.view === "invited" ? (
          <div className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <p className="text-sm text-[var(--text)]">
              {g.invited_by ? <b className="font-semibold">{g.invited_by.name}</b> : "Someone"} invited you to join. Its posts show once you join.
            </p>
            <div className="flex gap-2">
              <ItemButton variant="primary" disabled={busy} onClick={() => void run(() => accept(g))}>
                Join group
              </ItemButton>
              <ItemButton variant="secondary" disabled={busy} onClick={() => void run(() => decline(g), () => navigate("/porch/groups"))}>
                Not now
              </ItemButton>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <ItemButton variant="primary" size="lg" disabled={busy} onClick={() => void run(() => join(g))}>
              Join group
            </ItemButton>
            <p className="text-sm text-[var(--text-muted)]">Posts show once you join. You're in straight away.</p>
          </div>
        )}
      </div>
    </Column>
  );
}

function MemberView({ g }: { g: PorchGroup }) {
  const { b } = usePorch();
  const navigate = useNavigate();
  const { setTicks, leave, remove } = useGroupActions();
  const [tab, setTab] = useState<Tab>("posts");
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [inviting, setInviting] = useState(false);
  const members = useQuery({ queryKey: membersKey(g.id), queryFn: () => porchApi.members(g.id), staleTime: 30_000 });
  const showInvites = g.kind === "custom" && g.is_admin;

  const actions: MenuAction[] = [];
  if (g.is_admin) actions.push({ label: "Edit group", icon: Pencil, onClick: () => setEditing(true) });
  if (g.kind === "custom" && !g.is_owner) actions.push({ label: "Leave group", icon: LogOut, danger: true, onClick: () => void leave(g, b.me.id) });
  if (g.is_owner) {
    actions.push({ label: "Leave group", icon: LogOut, hint: "Make someone else the owner before you leave", onClick: () => toast.info("Make someone else the owner before you leave: People → their name → Make owner.") });
    actions.push({ label: "Delete group", icon: Trash2, danger: true, onClick: () => void remove(g) });
  }

  const tabs: { value: Tab; label: string }[] = [
    { value: "posts", label: "Posts" },
    { value: "photos", label: "Photos" },
    { value: "people", label: "People" },
  ];
  if (showInvites) tabs.push({ value: "invites", label: "Invites" });

  return (
    <Column>
      <PageHeader
        title={g.name}
        back
        actions={
          actions.length > 0 ? (
            <button
              type="button"
              aria-label={`More for ${g.name}`}
              aria-haspopup="dialog"
              onClick={() => setMenu(true)}
              className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
            >
              <MoreHorizontal className="h-5 w-5" />
            </button>
          ) : undefined
        }
      />
      <Band g={g} />
      <Heading g={g} faces={members.data} />
      <div className="flex flex-wrap gap-2 px-4 pt-3 md:px-0">
        <button
          type="button"
          role="checkbox"
          aria-checked={!!g.in_feed}
          onClick={() => setTicks({ [g.id]: !g.in_feed })}
          className={cn(
            "inline-flex h-10 items-center gap-1.5 rounded-xl border px-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
            g.in_feed ? "border-[var(--item-accent)] bg-[var(--item-accent)] text-white" : "border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--hover)]",
          )}
        >
          {g.in_feed && <Check className="h-4 w-4" aria-hidden />}
          In feed
        </button>
        <GroupBell group={g} className="border border-[var(--border)] bg-[var(--surface)]" />
        {g.can_invite && (
          <ItemButton variant="secondary" icon={<UserPlus className="h-4 w-4" />} onClick={() => setInviting(true)}>
            Invite
          </ItemButton>
        )}
        <ItemButton variant="secondary" icon={<PenSquare className="h-4 w-4" />} onClick={() => navigate(`/porch/new?group=${g.id}`)}>
          Post to {g.name}
        </ItemButton>
      </div>
      <div className="px-4 pt-4 md:px-0">
        <Segmented className="w-full" value={tab} onChange={setTab} options={tabs} />
      </div>
      <div className="pt-3">
        {tab === "posts" && <GroupPosts g={g} />}
        {tab === "photos" && <GroupPhotos g={g} />}
        {tab === "people" && <People g={g} members={members.data} loading={members.isPending} error={members.isError} retry={() => void members.refetch()} />}
        {tab === "invites" && showInvites && <PendingList g={g} onInvite={() => setInviting(true)} />}
      </div>

      <ActionSheet open={menu} onClose={() => setMenu(false)} title={g.name} actions={actions} />
      <EditGroupSheet group={g} open={editing} onClose={() => setEditing(false)} />
      <InviteSheet group={g} open={inviting} onClose={() => setInviting(false)} exclude={(members.data ?? []).map((m) => m.id)} />
    </Column>
  );
}

function GroupPosts({ g }: { g: PorchGroup }) {
  const navigate = useNavigate();
  const q = useInfiniteQuery({
    queryKey: groupPostsKey(g.id, false),
    queryFn: ({ pageParam }) => porchApi.groupPosts(g.id, pageParam, false),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    staleTime: 30_000,
  });
  const posts = useMemo(() => listPosts(q.data), [q.data]);
  const sentinel = useSentinel(() => {
    if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  });
  if (q.isPending) return <PostSkeleton />;
  if (q.isError) return <LoadError what="Couldn't load the posts." onRetry={() => void q.refetch()} />;
  if (posts.length === 0) {
    return (
      <EmptyState
        className="mx-4 md:mx-0"
        icon={PenSquare}
        title={`No posts in ${g.name} yet`}
        action={
          <ItemButton variant="primary" icon={<PenSquare className="h-4 w-4" />} onClick={() => navigate(`/porch/new?group=${g.id}`)}>
            Post to {g.name}
          </ItemButton>
        }
      />
    );
  }
  return (
    <>
      <PostList>
        {posts.map((p) => (
          <PostCard key={p.id} post={p} />
        ))}
      </PostList>
      <div ref={sentinel} className="flex justify-center py-6">
        {q.hasNextPage ? (
          <ItemButton variant="ghost" size="sm" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            Show older posts
          </ItemButton>
        ) : null}
      </div>
    </>
  );
}

/** Every photo post in the group as a grid (newest first). */
export function PhotoGrid({ posts, empty }: { posts: ReturnType<typeof listPosts>; empty: string }) {
  if (posts.length === 0) return <EmptyState className="mx-4 md:mx-0" icon={ImageIcon} title={empty} />;
  return (
    <ul className="grid grid-cols-3 gap-0.5 md:gap-1.5">
      {posts.map((p) => {
        const m = p.media[0];
        const src = m ? (m.thumb ?? m.poster) : null;
        return (
          <li key={p.id}>
            <Link
              to={`/porch/p/${p.id}`}
              aria-label={`${p.author?.name ?? "Someone"}'s post, ${shortAgo(p.created_at)}${p.media.length > 1 ? `, ${p.media.length} photos` : ""}`}
              className="relative block aspect-square overflow-hidden bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)] md:rounded-lg"
            >
              {src && <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" />}
              {p.media.length > 1 && (
                <span className="absolute right-1 top-1 rounded bg-black/60 px-1 text-[10px] font-semibold text-white" aria-hidden>
                  {p.media.length}
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function GroupPhotos({ g }: { g: PorchGroup }) {
  const q = useInfiniteQuery({
    queryKey: groupPostsKey(g.id, true),
    queryFn: ({ pageParam }) => porchApi.groupPosts(g.id, pageParam, true),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    staleTime: 30_000,
  });
  const posts = useMemo(() => listPosts(q.data), [q.data]);
  const sentinel = useSentinel(() => {
    if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  });
  if (q.isPending) return <p className="px-4 py-6 text-sm text-[var(--text-muted)]">Loading photos…</p>;
  if (q.isError) return <LoadError what="Couldn't load the photos." onRetry={() => void q.refetch()} />;
  return (
    <>
      <PhotoGrid posts={posts} empty={`No photos in ${g.name} yet`} />
      <div ref={sentinel} className="h-4" />
    </>
  );
}

function People({ g, members, loading, error, retry }: { g: PorchGroup; members?: Member[]; loading: boolean; error: boolean; retry: () => void }) {
  const { b } = usePorch();
  const [who, setWho] = useState<Member | null>(null);
  if (loading) return <p className="px-4 py-6 text-sm text-[var(--text-muted)]">Loading…</p>;
  if (error || !members) return <LoadError what="Couldn't load who's in the group." onRetry={retry} />;
  return (
    <div className="px-4 md:px-0">
      <List>
        {members.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => setWho(m)}
            className="flex min-h-[56px] w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]"
          >
            <PorchAvatar user={m} size={36} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-[var(--text)]">
                {m.name}
                {m.id === b.me.id ? " (you)" : ""}
              </span>
              <span className="block truncate text-xs text-[var(--text-muted)]">@{m.username}</span>
            </span>
            {ROLE_WORD[m.role] && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs font-medium text-[var(--text)]">
                {m.role === "owner" ? <Crown className="h-3 w-3" aria-hidden /> : <Shield className="h-3 w-3" aria-hidden />}
                {ROLE_WORD[m.role]}
              </span>
            )}
          </button>
        ))}
      </List>
      {who && <PersonSheet g={g} m={who} onClose={() => setWho(null)} />}
    </div>
  );
}

/** What you can do about one person in the group (your role decides). */
function PersonSheet({ g, m, onClose }: { g: PorchGroup; m: Member; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { b } = usePorch();
  const me = m.id === b.me.id;
  const run = async (fn: () => Promise<unknown>, done: string, fallback: string) => {
    try {
      await fn();
      groupsChanged(qc, g.id);
      void qc.invalidateQueries({ queryKey: membersKey(g.id) });
      toast.success(done);
    } catch (err) {
      toast.error(apiErrorMessage(err, fallback));
    }
  };
  const actions: MenuAction[] = [{ label: me ? "Your profile" : `${m.name}'s profile`, icon: UserRound, onClick: () => navigate(`/porch/u/${m.id}`) }];
  if (g.kind === "custom" && !me) {
    if (g.is_owner && m.role === "member") {
      actions.push({ label: "Make admin", icon: Shield, hint: "Admins edit the group, invite and remove people", onClick: () => void run(() => porchApi.setRole(g.id, m.id, "admin"), `${m.name} is now an admin.`, "Couldn't change that.") });
    }
    if (g.is_owner && m.role === "admin") {
      actions.push({ label: "Remove as admin", icon: ShieldOff, onClick: () => void run(() => porchApi.setRole(g.id, m.id, "member"), `${m.name} is no longer an admin.`, "Couldn't change that.") });
    }
    if (g.is_owner) {
      actions.push({
        label: "Make owner",
        icon: Crown,
        hint: "You'll stay an admin",
        onClick: async () => {
          const ok = await confirm({
            title: `Make ${m.name} the owner?`,
            message: `${m.name} will own ${g.name}: they can delete it and choose its admins. You'll stay an admin.`,
            confirmLabel: "Make owner",
          });
          if (ok) await run(() => porchApi.transfer(g.id, m.id), `${m.name} owns ${g.name} now.`, "Couldn't hand the group on.");
        },
      });
    }
    const canRemove = (g.is_admin && m.role === "member") || (g.is_owner && m.role === "admin");
    if (canRemove) {
      actions.push({
        label: "Remove from group",
        icon: UserMinus,
        danger: true,
        onClick: async () => {
          const ok = await confirm({
            title: `Remove ${m.name} from ${g.name}?`,
            message:
              g.visibility === "public"
                ? `${m.name} will stop seeing its posts and can't join again by themselves, only if invited. Their posts stay.`
                : `${m.name} will stop seeing its posts. Their posts stay.`,
            confirmLabel: "Remove",
            danger: true,
          });
          if (ok) await run(() => porchApi.removeMember(g.id, m.id), `${m.name} was removed from ${g.name}.`, "Couldn't remove them.");
        },
      });
    }
  }
  return <ActionSheet open onClose={onClose} title={m.name} actions={actions} />;
}

function PendingList({ g, onInvite }: { g: PorchGroup; onInvite: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: pendingKey(g.id), queryFn: () => porchApi.pendingInvites(g.id), staleTime: 15_000 });
  if (q.isPending) return <p className="px-4 py-6 text-sm text-[var(--text-muted)]">Loading…</p>;
  if (q.isError) return <LoadError what="Couldn't load the invites." onRetry={() => void q.refetch()} />;
  if (q.data.length === 0) {
    return (
      <EmptyState
        className="mx-4 md:mx-0"
        icon={UserPlus}
        title="No invites waiting"
        text="People you invite show here until they answer."
        action={
          g.can_invite ? (
            <ItemButton variant="secondary" icon={<UserPlus className="h-4 w-4" />} onClick={onInvite}>
              Invite people
            </ItemButton>
          ) : undefined
        }
      />
    );
  }
  return (
    <div className="px-4 md:px-0">
      <List>
        {q.data.map((inv) => (
          <div key={inv.user.id} className="flex items-center gap-3 px-3 py-2">
            <PorchAvatar user={inv.user} size={36} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-[var(--text)]">{inv.user.name}</span>
              <span className="block truncate text-xs text-[var(--text-muted)]">
                Invited{inv.invited_by ? ` by ${inv.invited_by.name}` : ""} {inv.invited_at ? shortAgo(inv.invited_at) : ""}
              </span>
            </span>
            <ItemButton
              size="sm"
              variant="ghost"
              aria-label={`Cancel ${inv.user.name}'s invite`}
              onClick={async () => {
                try {
                  await porchApi.cancelInvite(g.id, inv.user.id);
                  void qc.invalidateQueries({ queryKey: pendingKey(g.id) });
                  toast.success(`${inv.user.name}'s invite was cancelled.`);
                } catch (err) {
                  toast.error(apiErrorMessage(err, "Couldn't cancel the invite."));
                }
              }}
            >
              Cancel
            </ItemButton>
          </div>
        ))}
      </List>
    </div>
  );
}
