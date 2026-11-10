import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { Archive, Bell, Bookmark, Cake, ContactRound, MessageCircle, MoreHorizontal, Pencil, Search, Settings, Sparkles, UserX } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import { porchApi, type Profile, type ProfileTab } from "@/api/porch";
import { roomsApi } from "@/api/rooms";
import { EmptyState, Field, ItemButton, List, ListRow, Segmented, Sheet, TextArea, TextInput, Toggle } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { useBlock } from "../actions";
import { BOOTSTRAP_KEY, listPosts, profileKey, userPostsKey, userStoriesKey } from "../cache";
import { LIFE_EVENTS, PostCard, PostList } from "../components/PostCard";
import { ActionSheet, Column, LoadError, PageHeader, PorchAvatar, PostSkeleton, dayWords, type MenuAction } from "../components/ui";
import { usePorch } from "../context";
import { usePorchStore } from "../store";
import { AlertButton } from "../notify";
import { useSentinel } from "../scroll";
import { HighlightsRow } from "../components/stories/HighlightsRow";
import { PhotoGrid } from "./GroupPage";
import { Unavailable } from "./PostPage";

/** "Sam, your brother" — only ever shown to you. */
function relationLine(p: Profile): string | null {
  const r = p.relation;
  if (!r) return null;
  if (r.label) return `${p.user.name}, your ${r.label.toLowerCase()}`;
  return r.name && r.name !== p.user.name ? `${r.name} in your People` : "In your People";
}

/** Their picture, ringed while they have a story up that you can see
 *  (terracotta when there's one you haven't seen): tap to watch. */
function AvatarRing({ userId, me, children }: { userId: string; me: boolean; children: ReactNode }) {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: userStoriesKey(userId, false), queryFn: () => porchApi.userStories(userId, false), staleTime: 30_000 });
  const stories = q.data?.stories ?? [];
  if (!stories.length) return <>{children}</>;
  const fresh = !me && stories.some((s) => !s.seen);
  return (
    <button
      type="button"
      onClick={() => navigate(`/porch/stories/${userId}`)}
      aria-label={me ? "Your story" : `${q.data?.user.name ?? "Their"} story${fresh ? " (new)" : ""}`}
      className={cn(
        "shrink-0 rounded-full p-[3px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] focus-visible:ring-offset-2",
        fresh ? "bg-[var(--item-accent)]" : "bg-[var(--border)]",
      )}
    >
      <span className="block rounded-full bg-[var(--bg)] p-[2px]">{children}</span>
    </button>
  );
}

/** ``/porch/u/:id``: someone's profile, as you're allowed to see it. */
export function ProfilePage({ userId }: { userId: string }) {
  const { b } = usePorch();
  const navigate = useNavigate();
  const block = useBlock();
  const [tab, setTab] = useState<Exclude<ProfileTab, "all">>("photos");
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [messaging, setMessaging] = useState(false);
  const q = useQuery({
    queryKey: profileKey(userId),
    queryFn: () => porchApi.profile(userId),
    retry: (n, err) => !(isAxiosError(err) && err.response?.status === 404) && n < 2,
  });
  const p = q.data;

  if (q.isPending) {
    return (
      <Column>
        <PageHeader title="Profile" back />
        <PostSkeleton />
      </Column>
    );
  }
  if (q.isError || !p) {
    return (
      <Column>
        <PageHeader title="Profile" back />
        {isAxiosError(q.error) && q.error.response?.status === 404 ? (
          <Unavailable title="This profile isn't available" text="They may not use Porch, or one of you has blocked the other." />
        ) : (
          <LoadError what="Couldn't load this profile." onRetry={() => void q.refetch()} />
        )}
      </Column>
    );
  }

  const me = p.is_me;
  const rel = relationLine(p);
  const message = async () => {
    setMessaging(true);
    try {
      const room = await roomsApi.openDm([p.user.id]);
      navigate(`/rooms/r/${room.id}`);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't open a conversation. Try again."));
    } finally {
      setMessaging(false);
    }
  };
  const actions: MenuAction[] = me
    ? []
    : [
        { label: "See in People", icon: ContactRound, hint: "Everything you share with them across Promptly", onClick: () => navigate(`/people/u/${p.user.id}`) },
        { label: `Block ${p.user.name}`, icon: UserX, danger: true, onClick: () => void block(p.user, { leave: true }) },
      ];

  return (
    <Column>
      <PageHeader
        title={me ? "Your profile" : p.user.name}
        back={me ? undefined : true}
        actions={
          !me ? (
            <button
              type="button"
              aria-label={`More for ${p.user.name}`}
              aria-haspopup="dialog"
              onClick={() => setMenu(true)}
              className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
            >
              <MoreHorizontal className="h-5 w-5" />
            </button>
          ) : (
            // Your own page: the places the bottom bar has no room for.
            <>
              {(
                [
                  ["Search Porch", Search, () => usePorchStore.getState().setSearchOpen(true)],
                  ["Saved posts", Bookmark, () => navigate("/porch/saved")],
                  ["Porch settings", Settings, () => navigate("/porch/settings")],
                ] as const
              ).map(([label, Icon, go]) => (
                <button
                  key={label}
                  type="button"
                  aria-label={label}
                  title={label}
                  onClick={go}
                  className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] md:hidden"
                >
                  <Icon className="h-5 w-5" aria-hidden />
                </button>
              ))}
            </>
          )
        }
      />
      <div className="flex flex-col gap-3 px-4 pt-2 md:px-0">
        <div className="flex items-center gap-4">
          <AvatarRing userId={p.user.id} me={me}>
            <PorchAvatar user={p.user} size={76} />
          </AvatarRing>
          <div className="min-w-0">
            <h2 className="truncate text-xl font-bold text-[var(--text)]">{p.user.name}</h2>
            <p className="truncate text-sm text-[var(--text-muted)]">@{p.user.username}</p>
            {p.birthday && (
              <p className="mt-0.5 flex items-center gap-1 text-sm text-[var(--text-muted)]">
                <Cake className="h-3.5 w-3.5" aria-hidden /> Birthday {dayWords(p.birthday, false)}
              </p>
            )}
          </div>
        </div>
        {p.bio && <p className="whitespace-pre-wrap text-sm text-[var(--text)]">{p.bio}</p>}
        {rel && (
          <Link to={`/people/u/${p.user.id}`} className="w-fit text-sm font-medium text-[var(--accent-text)] hover:underline">
            {rel}
          </Link>
        )}
        {!me && (
          <p className="text-sm text-[var(--text-muted)]">
            {p.shared_groups && p.shared_groups.length > 0 ? (
              <>
                Groups you're both in:{" "}
                {p.shared_groups.map((g, i) => (
                  <span key={g.id}>
                    {i > 0 && ", "}
                    <Link to={`/porch/g/${g.id}`} className="font-medium text-[var(--text)] hover:underline">
                      {g.emoji ? `${g.emoji} ` : ""}
                      {g.name}
                    </Link>
                  </span>
                ))}
              </>
            ) : (
              "You're both in Everyone."
            )}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {me ? (
            <>
              <ItemButton variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>
                Edit profile
              </ItemButton>
            </>
          ) : (
            <>
              <ItemButton variant="primary" icon={<MessageCircle className="h-4 w-4" />} disabled={messaging} onClick={() => void message()}>
                Message
              </ItemButton>
              <AlertButton userId={p.user.id} name={p.user.name} on={!!p.alert} />
            </>
          )}
        </div>
      </div>
      <HighlightsRow userId={p.user.id} me={me} />
      <div className="px-4 pt-5 md:px-0">
        <Segmented
          className="w-full"
          value={tab}
          onChange={setTab}
          options={[
            { value: "photos", label: "Photos" },
            { value: "posts", label: "Posts" },
            { value: "life_events", label: "Life events" },
          ]}
        />
      </div>
      <div className="pt-3">
        <ProfilePosts userId={p.user.id} tab={tab} me={me} />
      </div>
      {me && (
        <div className="flex flex-col gap-2 px-4 pt-6 md:px-0">
          <h2 className="px-1 text-sm font-semibold text-[var(--text)]">Settings</h2>
          <List>
            <ListRow leading={<Bookmark className="h-4 w-4 text-[var(--text-muted)]" />} title="Saved" subtitle="Posts you've saved. Only you can see them." onClick={() => navigate("/porch/saved")} />
            <ListRow leading={<Archive className="h-4 w-4 text-[var(--text-muted)]" />} title="Story archive" subtitle="Every story you've posted. Only you can see it." onClick={() => navigate("/porch/archive")} />
            <ListRow leading={<Bell className="h-4 w-4 text-[var(--text-muted)]" />} title="Notifications" subtitle="What Porch tells you about, and when" onClick={() => navigate("/porch/settings")} />
            <ListRow leading={<UserX className="h-4 w-4 text-[var(--text-muted)]" />} title="Blocked people" subtitle="Set in Account → Blocked people" onClick={() => navigate("/account/blocked")} />
          </List>
        </div>
      )}
      <ActionSheet open={menu} onClose={() => setMenu(false)} title={p.user.name} actions={actions} />
      {me && <EditProfileSheet open={editing} onClose={() => setEditing(false)} profile={p} welcomedName={b.me.name} />}
    </Column>
  );
}

function ProfilePosts({ userId, tab, me }: { userId: string; tab: Exclude<ProfileTab, "all">; me: boolean }) {
  const q = useInfiniteQuery({
    queryKey: userPostsKey(userId, tab),
    queryFn: ({ pageParam }) => porchApi.userPosts(userId, pageParam, tab),
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
  const empty = me ? "You haven't posted anything here yet." : "No posts you can see yet.";
  if (tab === "photos") {
    return (
      <>
        <PhotoGrid posts={posts} empty={empty} />
        <div ref={sentinel} className="h-4" />
      </>
    );
  }
  if (posts.length === 0) {
    return <EmptyState className="mx-4 md:mx-0" icon={tab === "life_events" ? LIFE_EVENTS.other.icon : Sparkles} title={empty} />;
  }
  return (
    <>
      <PostList>
        {posts.map((post) => (
          <PostCard key={post.id} post={post} />
        ))}
      </PostList>
      <div ref={sentinel} className="flex justify-center py-6">
        {q.hasNextPage && (
          <ItemButton variant="ghost" size="sm" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            Show older posts
          </ItemButton>
        )}
      </div>
    </>
  );
}

function EditProfileSheet({ open, onClose, profile, welcomedName }: { open: boolean; onClose: () => void; profile: Profile; welcomedName: string }) {
  const qc = useQueryClient();
  const [bio, setBio] = useState(profile.bio);
  const [birthday, setBirthday] = useState(profile.birthday ?? "");
  const [show, setShow] = useState(!!profile.show_birthday);
  const [faces, setFaces] = useState(!!profile.face_suggestions);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setBio(profile.bio);
    setBirthday(profile.birthday ?? "");
    setShow(!!profile.show_birthday);
    setFaces(!!profile.face_suggestions);
  }, [open, profile]);
  const save = async () => {
    setBusy(true);
    try {
      await porchApi.updateProfile({ bio, birthday: birthday || null, show_birthday: show, face_suggestions: faces });
      void qc.invalidateQueries({ queryKey: profileKey(profile.user.id) });
      void qc.invalidateQueries({ queryKey: BOOTSTRAP_KEY });
      toast.success("Profile saved.");
      onClose();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't save your profile. Try again."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Edit profile"
      footer={
        <div className="flex justify-end gap-2">
          <ItemButton variant="ghost" onClick={onClose}>
            Cancel
          </ItemButton>
          <ItemButton variant="primary" disabled={busy} onClick={() => void save()}>
            Save
          </ItemButton>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-[var(--text-muted)]">
          Your picture and name ({welcomedName}) come from your Promptly account; change them in{" "}
          <Link to="/account/profile" className="font-medium text-[var(--accent-text)] hover:underline">
            Account → Profile
          </Link>
          .
        </p>
        <Field label="Bio" hint={`${bio.length}/300`}>
          <TextArea value={bio} maxLength={300} onChange={(e) => setBio(e.target.value)} placeholder="A line about you" rows={3} />
        </Field>
        <Field label="Birthday">
          <TextInput type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} />
        </Field>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-[var(--text)]">Show my birthday</p>
            <p className="text-xs text-[var(--text-muted)]">Day and month only, on your profile.</p>
          </div>
          <Toggle checked={show} onChange={setShow} label="Show my birthday" />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-[var(--text)]">Suggest tags from my faces</p>
            <p className="text-xs text-[var(--text-muted)]">
              When someone posts a photo you're in, Porch can suggest tagging you, from the faces their own Photos knows. Only between people who both turn this on. You still say yes to every tag.
            </p>
          </div>
          <Toggle checked={faces} onChange={setFaces} label="Suggest tags from my faces" />
        </div>
      </div>
    </Sheet>
  );
}
