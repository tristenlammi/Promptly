import { useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useSearchParams } from "react-router-dom";

import { porchApi } from "@/api/porch";

import { postKey } from "../cache";
import { Composer } from "../components/composer/Composer";
import { Column, LoadError, PageHeader, PostSkeleton } from "../components/ui";
import { usePorch } from "../context";
import { Unavailable } from "./PostPage";

/** ``/porch/new``: a new post (``?group=``, ``?memory=`` and ``?shared=1`` say where it came from). */
export function NewPostPage() {
  const [params] = useSearchParams();
  return (
    <Composer
      start={{
        group: params.get("group"),
        memory: params.get("memory"),
        shared: params.get("shared") === "1",
      }}
    />
  );
}

/** ``/porch/p/:id/edit``: change your own post's words, photos, place. */
export function EditPostPage({ postId }: { postId: string }) {
  const { b } = usePorch();
  const q = useQuery({
    queryKey: postKey(postId),
    queryFn: () => porchApi.post(postId),
    retry: (n, err) => !(isAxiosError(err) && err.response?.status === 404) && n < 2,
  });
  if (q.data && q.data.author?.id === b.me.id) return <Composer key={postId} editing={q.data} />;
  return (
    <Column>
      <PageHeader title="Edit post" back />
      {q.isPending ? (
        <PostSkeleton />
      ) : q.isError && !(isAxiosError(q.error) && q.error.response?.status === 404) ? (
        <LoadError what="Couldn't load this post." onRetry={() => void q.refetch()} />
      ) : (
        <Unavailable title="This post can't be changed" text="Only the person who posted it can change it, and it may have been deleted." />
      )}
    </Column>
  );
}
