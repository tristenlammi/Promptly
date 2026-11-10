import { TilesSkeleton } from "../components/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, Bookmark, Eye, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { porchApi, type PorchStory } from "@/api/porch";
import { confirm } from "@/components/shared/ConfirmDialog";
import { EmptyState, ItemButton } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { HIGHLIGHTS_KEY, STORIES_KEY } from "../cache";
import { AddToHighlightSheet, StoryTile, useArchive } from "../components/stories/HighlightSheets";
import { StoryPlayer } from "../components/stories/StoryPlayer";
import { ActionSheet, Column, LoadError, PageHeader, groupsLine, type MenuAction } from "../components/ui";
import { useSentinel } from "../scroll";

function when(s: PorchStory): string {
  return new Date(s.created_at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "long", year: "numeric" });
}

/**
 * ``/porch/archive``: every story you've posted, month by month, kept
 * privately for you after its day is up. Tap one to watch it again, add it
 * to a highlight, or delete it.
 */
export function ArchivePage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { q, stories, months } = useArchive();
  const [menu, setMenu] = useState<PorchStory | null>(null);
  const [adding, setAdding] = useState<PorchStory | null>(null);
  const [playing, setPlaying] = useState<number | null>(null);
  const sentinel = useSentinel(() => {
    if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  });

  const remove = async (s: PorchStory) => {
    const ok = await confirm({
      title: "Delete this story?",
      message: "It goes from your archive and any highlight (and from everyone's stories, if it's still up). The photo stays in your Photos library.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await porchApi.deleteStory(s.id);
      void qc.invalidateQueries({ queryKey: STORIES_KEY });
      void qc.invalidateQueries({ queryKey: HIGHLIGHTS_KEY });
      toast.success("Story deleted.");
      setPlaying(null);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't delete it. Try again."));
    }
  };

  const actions = (s: PorchStory): MenuAction[] => [
    { label: "Watch it", icon: Eye, onClick: () => setPlaying(stories.findIndex((x) => x.id === s.id)) },
    { label: "Add to highlight", icon: Bookmark, hint: "Keep it on your profile", onClick: () => setAdding(s) },
    { label: "Delete story", icon: Trash2, danger: true, onClick: () => void remove(s) },
  ];

  let body;
  if (q.isPending) body = <TilesSkeleton tiles={9} className="px-0.5" />;
  else if (q.isError) body = <LoadError what="Couldn't load your stories." onRetry={() => void q.refetch()} />;
  else if (!stories.length) {
    body = (
      <EmptyState
        className="mx-4 md:mx-0"
        icon={Archive}
        title="No stories yet"
        text="Every story you post is kept here for you, even after its day is up. Only you can see your archive."
        action={
          <ItemButton variant="primary" onClick={() => navigate("/porch/story/new")}>
            New story
          </ItemButton>
        }
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-4 px-3 md:px-0">
        <p className="text-sm text-[var(--text-muted)]">Only you can see your archive. Add stories to a highlight to keep them on your profile.</p>
        {months.map((m) => (
          <section key={m.label} aria-label={m.label}>
            <h2 className="pb-2 text-sm font-semibold text-[var(--text)]">{m.label}</h2>
            <ul className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
              {m.stories.map((s) => (
                <li key={s.id}>
                  <StoryTile
                    story={s}
                    onClick={() => setMenu(s)}
                    label={`${s.kind === "text" ? s.text : s.kind === "video" ? "A video" : "A photo"}, ${when(s)}${s.expired ? "" : ", still up"}`}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
        <div ref={sentinel} className="h-4" />
      </div>
    );
  }

  return (
    <Column wide>
      <PageHeader title="Story archive" back />
      {body}
      {menu && <ActionSheet open onClose={() => setMenu(null)} title={when(menu)} actions={actions(menu)} />}
      <AddToHighlightSheet story={adding} open={!!adding} onClose={() => setAdding(null)} />
      {playing !== null && playing >= 0 && stories.length > 0 && (
        <StoryPlayer
          stories={stories}
          index={Math.min(playing, stories.length - 1)}
          onIndex={setPlaying}
          onClose={() => setPlaying(null)}
          onDone={() => setPlaying(null)}
          hold={!!adding || !!menu}
          label="Your story archive"
          subtitle={(s) => [when(s), s.groups.length ? `in ${groupsLine(s.groups)}` : null].filter(Boolean).join(" · ")}
          menu={(s) => () => setMenu(s)}
        />
      )}
    </Column>
  );
}
