import { useQuery } from "@tanstack/react-query";
import { ChevronRight, House } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { porchApi } from "@/api/porch";

/**
 * On an event made from a Porch post ("Make this an event", or planned in a
 * group): "Posted in Family" (your own groups only), else "From a Porch
 * post", and a way back to it — only for people who can see the post.
 * Anyone else (a 404, or Porch off for them) sees nothing at all.
 */
export function PorchSourceBadge({ postId, onNavigate }: { postId: string; onNavigate?: () => void }) {
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["porch", "card", postId],
    queryFn: () => porchApi.card(postId),
    staleTime: 60_000,
    retry: false,
  });
  if (!data) return null;
  return (
    <button
      type="button"
      onClick={() => {
        onNavigate?.();
        navigate(data.href);
      }}
      className="flex w-full items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left text-sm hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
    >
      {data.thumb ? (
        <img src={data.thumb} alt="" className="h-8 w-8 shrink-0 rounded-lg object-cover" />
      ) : (
        <House className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate text-[var(--text-muted)]">
        {/* Porch WP-P3.2: "Posted in Family" (only ever your own groups). */}
        {data.where ? `Posted in ${data.where}` : "From a Porch post"} · <span className="text-[var(--text)]">{data.title}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
    </button>
  );
}
