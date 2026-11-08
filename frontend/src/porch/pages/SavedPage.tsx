import { useInfiniteQuery } from "@tanstack/react-query";
import { Bookmark } from "lucide-react";
import { useMemo } from "react";

import { porchApi } from "@/api/porch";
import { EmptyState, ItemButton } from "@/items/ui";

import { listPosts, savedKey } from "../cache";
import { PostCard, PostList } from "../components/PostCard";
import { Column, LoadError, PageHeader, PostSkeleton } from "../components/ui";
import { useSentinel } from "../scroll";

/** ``/porch/saved``: your saved posts, a private list (the last saved first). */
export function SavedPage() {
  const q = useInfiniteQuery({
    queryKey: savedKey,
    queryFn: ({ pageParam }) => porchApi.saved(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    staleTime: 15_000,
  });
  const posts = useMemo(() => listPosts(q.data), [q.data]);
  const sentinel = useSentinel(() => {
    if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  });

  let body;
  if (q.isPending) body = <PostSkeleton />;
  else if (q.isError) body = <LoadError what="Couldn't load your saved posts." onRetry={() => void q.refetch()} />;
  else if (!posts.length) {
    body = (
      <EmptyState
        className="mx-4 mt-4 md:mx-0"
        icon={Bookmark}
        title="Nothing saved yet"
        text="Tap the bookmark under a post to keep it here. Only you can see what you've saved."
      />
    );
  } else {
    body = (
      <>
        <p className="px-4 pb-2 text-xs text-[var(--text-muted)] md:px-0">Only you can see this list. A post that's deleted or no longer shared with you drops out.</p>
        <PostList>
          {posts.map((p) => (
            <PostCard key={p.id} post={p} />
          ))}
        </PostList>
        <div ref={sentinel} className="flex justify-center py-6">
          {q.hasNextPage && (
            <ItemButton variant="ghost" size="sm" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
              Show more
            </ItemButton>
          )}
        </div>
      </>
    );
  }
  return (
    <Column>
      <PageHeader title="Saved" back />
      {body}
    </Column>
  );
}
