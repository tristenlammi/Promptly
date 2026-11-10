import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { porchApi, type StoryRing } from "@/api/porch";
import { cn } from "@/utils/cn";

import { STORIES_ROW_KEY } from "../../cache";
import { usePorch } from "../../context";
import { PorchAvatar } from "../ui";

/** One person's circle: their picture, a terracotta ring while there's
 *  something new (grey once seen), and a group's emoji when every story of
 *  theirs you see is in that one group. */
function Ring({ r, label, name, onClick, add }: { r: StoryRing | null; label: string; name: string; onClick: () => void; add?: () => void }) {
  const { b } = usePorch();
  const user = r?.user ?? b.me;
  const fresh = !!r && r.unseen > 0;
  return (
    <li className="relative flex w-[72px] shrink-0 flex-col items-center gap-1">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        data-story-ring={user.id}
        className="group flex flex-col items-center gap-1 rounded-2xl p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
      >
        <span
          className={cn(
            "relative flex h-[66px] w-[66px] items-center justify-center rounded-full",
            r ? (fresh ? "bg-[var(--item-accent)] p-[3px]" : "bg-[var(--border)] p-[2px]") : "p-[3px]",
          )}
        >
          <span className="flex h-full w-full items-center justify-center rounded-full bg-[var(--bg)] p-[2px]">
            <PorchAvatar user={user} size={56} />
          </span>
          {r?.ring_group && (
            <span
              className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--surface)] text-[13px] shadow-[var(--shadow-sm)] ring-2 ring-[var(--bg)]"
              title={`In ${r.ring_group.name}`}
              aria-hidden
            >
              {r.ring_group.emoji || r.ring_group.name.slice(0, 1)}
            </span>
          )}
        </span>
        <span className={cn("w-full truncate text-center text-xs", fresh ? "font-semibold text-[var(--text)]" : "text-[var(--text-muted)]")}>{name}</span>
      </button>
      {add && (
        <button
          type="button"
          onClick={add}
          aria-label="New story"
          className="absolute left-[46px] top-[44px] flex h-6 w-6 items-center justify-center rounded-full bg-[var(--item-accent)] text-white ring-2 ring-[var(--bg)] focus-visible:outline-none focus-visible:ring-[var(--text)]"
        >
          <Plus className="h-4 w-4" aria-hidden />
        </button>
      )}
    </li>
  );
}

function ringLabel(r: StoryRing): string {
  const n = r.unseen ? `${r.unseen} new` : "seen";
  const where = r.ring_group ? `, in ${r.ring_group.name}` : "";
  return `${r.user.name}'s story (${r.count === 1 ? "1 story" : `${r.count} stories`}, ${n}${where})`;
}

/**
 * The stories row under the group chips: your own circle first ("Your
 * story", with ＋), then the people with live stories in the groups you've
 * ticked, new ones first. Hidden while nobody has a story and you haven't
 * posted one (＋ → New story is always in the ＋ menu).
 */
export function StoriesRow() {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: STORIES_ROW_KEY, queryFn: porchApi.storiesRow, staleTime: 30_000 });
  const data = q.data;
  if (!data || (!data.me && data.people.length === 0)) return null;
  const me = data.me;
  const create = () => navigate("/porch/story/new");
  return (
    <nav aria-label="Stories" className="border-b border-[var(--border)] md:rounded-2xl md:border md:bg-[var(--surface)]">
      <ul className="flex gap-1 overflow-x-auto px-2 py-2.5 [scrollbar-width:none] md:px-3">
        <Ring
          r={me}
          name="Your story"
          label={me ? `Your story (${me.count === 1 ? "1 story" : `${me.count} stories`})` : "Add to your story"}
          onClick={me ? () => navigate(`/porch/stories/${me.user.id}?from=row`) : create}
          add={create}
        />
        {data.people.map((r) => (
          <Ring key={r.user.id} r={r} name={r.user.name.split(" ")[0]} label={ringLabel(r)} onClick={() => navigate(`/porch/stories/${r.user.id}?from=row`)} />
        ))}
      </ul>
    </nav>
  );
}
