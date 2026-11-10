import { RowsSkeleton } from "../ui";
import { useQuery } from "@tanstack/react-query";
import { Eye } from "lucide-react";
import { Link } from "react-router-dom";

import { porchApi } from "@/api/porch";
import { Sheet } from "@/items/ui";

import { storyViewersKey } from "../../cache";
import { LoadError, PorchAvatar, shortAgo } from "../ui";

/** Who saw your story, latest first. Only ever yours to see. */
export function ViewersSheet({ storyId, open, onClose }: { storyId: string; open: boolean; onClose: () => void }) {
  const q = useQuery({ queryKey: storyViewersKey(storyId), queryFn: () => porchApi.storyViewers(storyId), enabled: open, staleTime: 5_000 });
  const n = q.data?.count ?? 0;
  return (
    <Sheet open={open} onClose={onClose} title={q.data ? (n === 1 ? "Seen by 1 person" : `Seen by ${n} people`) : "Seen by"} size="sm">
      {q.isPending ? (
        <RowsSkeleton rows={4} />
      ) : q.isError ? (
        <LoadError what="Couldn't load who saw it." onRetry={() => void q.refetch()} />
      ) : n === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-[var(--text-muted)]">
          <Eye className="h-6 w-6" aria-hidden />
          Nobody's seen it yet. Only you can see who has.
        </div>
      ) : (
        <>
          <ul className="-mx-2 flex flex-col">
            {q.data.viewers.map((v) => (
              <li key={v.user.id}>
                <Link
                  to={`/porch/u/${v.user.id}`}
                  onClick={onClose}
                  className="flex min-h-[52px] items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]"
                >
                  <PorchAvatar user={v.user} size={36} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text)]">{v.user.name}</span>
                  <span className="shrink-0 text-xs text-[var(--text-muted)]">{shortAgo(v.seen_at)}</span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-[var(--text-muted)]">Only you can see this list.</p>
        </>
      )}
    </Sheet>
  );
}
