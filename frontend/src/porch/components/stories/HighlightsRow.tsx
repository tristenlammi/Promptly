import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MinusCircle, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { porchApi, type Highlight, type PorchStory } from "@/api/porch";
import { confirm } from "@/components/shared/ConfirmDialog";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { HIGHLIGHTS_KEY, userHighlightsKey } from "../../cache";
import { ActionSheet, groupsLine, type MenuAction } from "../ui";
import { HighlightCircle, HighlightEditor } from "./HighlightSheets";
import { StoryPlayer } from "./StoryPlayer";

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * A profile's highlights under its header: round covers with a name. Each
 * viewer gets only the highlights with a story they may see, each holding
 * only those. Your own profile adds "New". Watching one marks nothing seen.
 */
export function HighlightsRow({ userId, me }: { userId: string; me: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: me ? HIGHLIGHTS_KEY : userHighlightsKey(userId),
    queryFn: () => (me ? porchApi.myHighlights() : porchApi.userHighlights(userId)),
    staleTime: 30_000,
  });
  const [open, setOpen] = useState<{ h: Highlight; i: number } | null>(null);
  const [making, setMaking] = useState(false);
  const [editing, setEditing] = useState<Highlight | null>(null);
  const [menu, setMenu] = useState<PorchStory | null>(null);
  const list = q.data ?? [];
  if (!me && !list.length) return null;
  // Your own: always there (it's where New lives), unless it can't load.
  if (q.isError) return null;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: HIGHLIGHTS_KEY });
    void qc.invalidateQueries({ queryKey: ["porch", "highlights"] });
  };
  const removeHighlight = async (h: Highlight) => {
    const ok = await confirm({ title: `Delete “${h.name}”?`, message: "The highlight goes from your profile. Its stories stay in your archive.", confirmLabel: "Delete", danger: true });
    if (!ok) return;
    try {
      await porchApi.deleteHighlight(h.id);
      refresh();
      setOpen(null);
      toast.success("Highlight deleted.");
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't delete it. Try again."));
    }
  };
  const takeOut = async (h: Highlight, s: PorchStory) => {
    try {
      const got = await porchApi.removeFromHighlight(h.id, s.id);
      refresh();
      if (got.deleted || !got.highlight) {
        setOpen(null);
        toast.success(`That was the last story, so “${h.name}” is gone.`);
      } else {
        setOpen({ h: got.highlight, i: 0 });
        toast.success(`Taken out of “${h.name}”.`);
      }
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't take it out. Try again."));
    }
  };

  const actions = (h: Highlight, s: PorchStory): MenuAction[] => [
    { label: "Edit highlight", icon: Pencil, hint: "Its name, cover and stories", onClick: () => setEditing(h) },
    { label: "Take this story out", icon: MinusCircle, hint: "It stays in your archive", onClick: () => void takeOut(h, s) },
    { label: "Delete highlight", icon: Trash2, danger: true, onClick: () => void removeHighlight(h) },
  ];

  return (
    <nav aria-label="Highlights" className="pt-4">
      <ul className="flex gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:px-0">
        {me && (
          <li className="flex w-[72px] shrink-0 flex-col items-center gap-1">
            <button
              type="button"
              onClick={() => setMaking(true)}
              className="flex flex-col items-center gap-1 rounded-2xl p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
            >
              <span className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-dashed border-[var(--border)] text-[var(--text-muted)]">
                <Plus className="h-6 w-6" aria-hidden />
              </span>
              <span className="text-xs text-[var(--text)]">New</span>
              <span className="sr-only">highlight, from your story archive</span>
            </button>
          </li>
        )}
        {list.map((h) => (
          <li key={h.id} className="flex w-[72px] shrink-0 flex-col items-center">
            <button
              type="button"
              onClick={() => setOpen({ h, i: 0 })}
              aria-label={`Highlight: ${h.name} (${h.count === 1 ? "1 story" : `${h.count} stories`})`}
              className="flex w-full flex-col items-center gap-1 rounded-2xl p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
            >
              <HighlightCircle h={h} size={64} />
              <span className="w-full truncate text-center text-xs text-[var(--text)]">{h.name}</span>
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <StoryPlayer
          stories={open.h.stories}
          index={Math.min(open.i, open.h.stories.length - 1)}
          onIndex={(i) => setOpen({ ...open, i })}
          onClose={() => setOpen(null)}
          onDone={() => setOpen(null)}
          hold={!!menu || !!editing}
          label={`Highlight: ${open.h.name}`}
          subtitle={(s) => [open.h.name, day(s.created_at), s.groups.length ? `in ${groupsLine(s.groups)}` : null].filter(Boolean).join(" · ")}
          menu={me ? (s) => () => setMenu(s) : undefined}
        />
      )}
      {open && menu && <ActionSheet open onClose={() => setMenu(null)} title={open.h.name} actions={actions(open.h, menu)} />}
      {me && <HighlightEditor open={making} onClose={() => setMaking(false)} />}
      {me && (
        <HighlightEditor
          open={!!editing}
          editing={editing}
          onClose={() => {
            setEditing(null);
            setOpen(null);
          }}
        />
      )}
    </nav>
  );
}
