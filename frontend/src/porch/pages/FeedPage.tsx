import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, CheckCircle2, Image as ImageIcon, PenSquare, Plus, Users } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { porchApi } from "@/api/porch";
import { EmptyState, ItemButton } from "@/items/ui";
import { cn } from "@/utils/cn";

import { feedKey, listPosts } from "../cache";
import { GroupChips } from "../components/GroupChips";
import { PostCard, PostList } from "../components/PostCard";
import { Column, LoadError, PageHeader, PostSkeleton } from "../components/ui";
import { usePorch } from "../context";
import { usePorchStore } from "../store";
import { scrollPorchTo, usePorchScroller, useSentinel } from "../scroll";

/** ``/porch``: posts from the groups you've ticked, newest first. */
export function FeedPage() {
  const { b, isPhone } = usePorch();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const photos = usePorchStore((s) => s.photosOnly);
  const setPhotos = usePorchStore((s) => s.setPhotosOnly);
  const fresh = usePorchStore((s) => s.fresh);
  const clearFresh = usePorchStore((s) => s.clearFresh);
  const setNewGroup = usePorchStore((s) => s.setNewGroupOpen);

  const q = useInfiniteQuery({
    queryKey: feedKey(photos),
    queryFn: ({ pageParam }) => porchApi.feed(pageParam, photos),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    staleTime: 30_000,
  });
  const posts = useMemo(() => listPosts(q.data), [q.data]);

  // Ticking or unticking a group, or joining or leaving one, changes the
  // feed: refetch once things settle.
  const ticks = b.groups.map((g) => `${g.id}:${g.in_feed ? 1 : 0}`).join(",");
  const firstTicks = useRef(ticks);
  useEffect(() => {
    if (ticks === firstTicks.current) return;
    firstTicks.current = ticks;
    const t = window.setTimeout(() => {
      clearFresh();
      void qc.invalidateQueries({ queryKey: ["porch", "list", "feed"] });
    }, 500);
    return () => window.clearTimeout(t);
  }, [ticks, qc, clearFresh]);

  // "You're all caught up" sits where you'd last seen up to when the feed
  // opened (it doesn't move under you while you read).
  const [seenAt, setSeenAt] = useState<string | null | undefined>(undefined);
  const firstPage = q.data?.pages[0];
  useEffect(() => {
    if (seenAt === undefined && firstPage) setSeenAt(firstPage.feed_seen_at ?? null);
  }, [firstPage, seenAt]);
  const dividerBefore = useMemo(() => {
    if (!seenAt) return null;
    const i = posts.findIndex((p) => p.created_at <= seenAt);
    return i > 0 ? posts[i].id : null;
  }, [posts, seenAt]);

  // The top of the feed on screen for a moment: you've seen up to its newest post.
  const scroller = usePorchScroller();
  const sent = useRef<string | null>(null);
  const newest = posts[0]?.created_at ?? null;
  useEffect(() => {
    if (!newest || !scroller) return;
    let timer: number | undefined;
    const check = () => {
      window.clearTimeout(timer);
      if (scroller.scrollTop > 120 || document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => {
        const already = sent.current ?? firstPage?.feed_seen_at ?? null;
        if (already && already >= newest) return;
        sent.current = newest;
        void porchApi.feedSeen(newest).catch(() => {
          sent.current = null;
        });
      }, 1500);
    };
    check();
    scroller.addEventListener("scroll", check, { passive: true });
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearTimeout(timer);
      scroller.removeEventListener("scroll", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [newest, scroller, firstPage?.feed_seen_at]);

  const sentinel = useSentinel(() => {
    if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  });

  const showFresh = async () => {
    clearFresh();
    scrollPorchTo(0);
    await qc.resetQueries({ queryKey: feedKey(photos) });
  };

  const ticked = b.groups.filter((g) => g.in_feed);
  const alone = b.everyone.member_count <= 1 && b.groups.length <= 1;

  let body;
  if (q.isPending) {
    body = (
      <PostList>
        <PostSkeleton />
        <PostSkeleton />
      </PostList>
    );
  } else if (q.isError) {
    body = <LoadError what="Couldn't load your feed." onRetry={() => void q.refetch()} />;
  } else if (ticked.length === 0) {
    body = (
      <EmptyState
        className="mx-4 mt-4 md:mx-0"
        icon={CheckCircle2}
        title="Your feed is empty"
        text="You've unticked every group. Tick one above to see its posts."
      />
    );
  } else if (posts.length === 0) {
    body = alone ? (
      <EmptyState
        className="mx-4 mt-4 md:mx-0"
        icon={Users}
        title="It's quiet on the Porch"
        text="You're the first one here. When others join this Promptly they'll be in Everyone automatically."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <ItemButton variant="primary" icon={<PenSquare className="h-4 w-4" />} onClick={() => navigate("/porch/new")}>
              New post
            </ItemButton>
            <ItemButton variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setNewGroup(true)}>
              Make a group
            </ItemButton>
          </div>
        }
      />
    ) : (
      <EmptyState
        className="mx-4 mt-4 md:mx-0"
        icon={photos ? ImageIcon : PenSquare}
        title={photos ? "No photos here yet" : "No posts in these groups yet"}
        text={photos ? "No photo posts in the groups you've ticked. Turn off Photos only to see everything." : "Be the first."}
        action={
          photos ? (
            <ItemButton variant="secondary" onClick={() => setPhotos(false)}>
              Show everything
            </ItemButton>
          ) : (
            <ItemButton variant="primary" icon={<PenSquare className="h-4 w-4" />} onClick={() => navigate("/porch/new")}>
              New post
            </ItemButton>
          )
        }
      />
    );
  } else {
    body = (
      <>
        <PostList>
          {posts.map((p) => (
            <Fragment key={p.id}>
              {p.id === dividerBefore && (
                <div role="separator" aria-label="You're all caught up" className="flex items-center gap-3 px-4 py-4 text-sm text-[var(--text-muted)] md:px-0">
                  <span className="h-px flex-1 bg-[var(--border)]" />
                  <span className="flex items-center gap-1.5 font-medium">
                    <CheckCircle2 className="h-4 w-4 text-[var(--accent-text)]" aria-hidden /> You're all caught up
                  </span>
                  <span className="h-px flex-1 bg-[var(--border)]" />
                </div>
              )}
              <PostCard post={p} />
            </Fragment>
          ))}
        </PostList>
        <div ref={sentinel} className="flex justify-center py-6">
          {q.isFetchingNextPage ? (
            <PostSkeleton />
          ) : q.hasNextPage ? (
            <ItemButton variant="ghost" size="sm" onClick={() => void q.fetchNextPage()}>
              Show older posts
            </ItemButton>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">That's everything in these groups.</p>
          )}
        </div>
      </>
    );
  }

  return (
    <Column>
      <PageHeader
        title={isPhone ? "Porch" : "Feed"}
        actions={
          <button
            type="button"
            aria-pressed={photos}
            title="Photos only"
            onClick={() => setPhotos(!photos)}
            className={cn(
              "inline-flex h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
              photos ? "bg-[var(--item-accent)] text-white" : "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]",
            )}
          >
            <ImageIcon className="h-[18px] w-[18px]" aria-hidden />
            <span className={cn(isPhone && "sr-only")}>Photos only</span>
          </button>
        }
      />
      <div className={cn("sticky top-0 z-10 bg-[var(--bg)]", isPhone && "border-b border-[var(--border)]")}>
        <GroupChips groups={b.groups} />
      </div>
      {fresh.length > 0 && (
        <div className="pointer-events-none sticky top-14 z-20 flex justify-center">
          <button
            type="button"
            onClick={() => void showFresh()}
            className="pointer-events-auto mt-2 inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--item-accent)] px-4 text-sm font-semibold text-white shadow-[var(--shadow-md)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] focus-visible:ring-offset-2"
          >
            <ArrowUp className="h-4 w-4" aria-hidden />
            {fresh.length === 1 ? "1 new post" : `${fresh.length} new posts`}
          </button>
        </div>
      )}
      <div className="pt-2 md:pt-3">{body}</div>
    </Column>
  );
}
