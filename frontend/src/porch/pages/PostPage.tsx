import { useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { FileQuestion } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { HEART, porchApi } from "@/api/porch";
import { EmptyState, ItemButton } from "@/items/ui";

import { postKey } from "../cache";
import { MediaCarousel } from "../components/MediaCarousel";
import { PostCard } from "../components/PostCard";
import { Column, LoadError, PageHeader, PostSkeleton } from "../components/ui";
import { usePorch } from "../context";
import { usePostTalk } from "../talkActions";

/** One page for "deleted", "not shared with you" and "never existed". */
export function Unavailable({ title, text }: { title: string; text: string }) {
  const navigate = useNavigate();
  return (
    <EmptyState
      className="mx-4 mt-6 md:mx-0"
      icon={FileQuestion}
      title={title}
      text={text}
      action={
        <ItemButton variant="secondary" onClick={() => navigate("/porch/")}>
          Back to your feed
        </ItemButton>
      }
    />
  );
}

/** ``/porch/p/:id``: one post. */
export function PostPage({ postId }: { postId: string }) {
  const { isPhone } = usePorch();
  const q = useQuery({ queryKey: postKey(postId), queryFn: () => porchApi.post(postId), retry: (n, err) => !(isAxiosError(err) && err.response?.status === 404) && n < 2 });
  const post = q.data;
  const twoUp = !isPhone && !!post && post.media.length > 0;
  const { react } = usePostTalk();

  let body;
  if (q.isPending) body = <PostSkeleton />;
  else if (q.isError) {
    body =
      isAxiosError(q.error) && q.error.response?.status === 404 ? (
        <Unavailable title="This post isn't available" text="It may have been deleted, or it isn't shared with you." />
      ) : (
        <LoadError what="Couldn't load this post." onRetry={() => void q.refetch()} />
      );
  } else if (twoUp && post) {
    body = (
      <div className="grid grid-cols-[minmax(0,1fr)_320px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)]">
        <div className="flex items-center bg-[var(--surface-2)]">
          <MediaCarousel
            media={post.media}
            label={`${post.author?.name ?? "Someone"}'s photos`}
            onDoubleTap={() => {
              if (!post.reactions.mine) void react(post, HEART);
            }}
          />
        </div>
        <PostCard post={post} full media={false} className="border-l border-[var(--border)] md:rounded-none md:border-0 md:border-l md:shadow-none" />
      </div>
    );
  } else if (post) {
    body = <PostCard post={post} full />;
  }

  return (
    <Column wide={twoUp}>
      <PageHeader title="Post" back />
      {body}
    </Column>
  );
}
