import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { Eye, Loader2, Trash2, TriangleAlert, UserX, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { porchApi, type PorchStory, type StoriesRow } from "@/api/porch";
import { confirm } from "@/components/shared/ConfirmDialog";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { useBlock } from "../../actions";
import { STORIES_KEY, STORIES_ROW_KEY, userStoriesKey } from "../../cache";
import { ReportSheet } from "../ReportSheet";
import { ActionSheet, type MenuAction } from "../ui";
import { StoryPlayer } from "./StoryPlayer";
import { ViewersSheet } from "./ViewersSheet";

/** Close the viewer: back where you came from, else the feed. */
export function useLeave() {
  const navigate = useNavigate();
  return useCallback(() => {
    const st = window.history.state as { idx?: number } | null;
    if (st && typeof st.idx === "number" && st.idx > 0) navigate(-1);
    else navigate("/porch/", { replace: true });
  }, [navigate]);
}

/**
 * ``/porch/stories/:userId``: someone's live stories, full screen, starting
 * at the first one you haven't seen. From the stories row (``?from=row``)
 * it carries on to the next person in the row, and only shows the stories
 * in the groups you've ticked. Your own show "Seen by 8".
 */
export function StoryViewer({ userId }: { userId: string }) {
  const [params] = useSearchParams();
  const fromRow = params.get("from") === "row";
  const navigate = useNavigate();
  const leave = useLeave();
  const qc = useQueryClient();
  const block = useBlock();
  const q = useQuery({
    queryKey: userStoriesKey(userId, fromRow),
    queryFn: () => porchApi.userStories(userId, fromRow),
    staleTime: 15_000,
    retry: (n, err) => !(isAxiosError(err) && err.response?.status === 404) && n < 2,
  });
  const stories = q.data?.stories ?? [];
  const [index, setIndex] = useState<number | null>(null);
  const [menu, setMenu] = useState<PorchStory | null>(null);
  const [viewers, setViewers] = useState<string | null>(null);
  const [reporting, setReporting] = useState<PorchStory | null>(null);

  // Who comes next: the row as it was when you opened it (carried along
  // from person to person, so seeing someone doesn't reshuffle it).
  const location = useLocation();
  const order = useRef<string[] | null>((location.state as { order?: string[] } | null)?.order ?? null);
  if (order.current === null) {
    const row = qc.getQueryData<StoriesRow>(STORIES_ROW_KEY);
    order.current = row ? [...(row.me ? [row.me.user.id] : []), ...row.people.map((p) => p.user.id)] : [];
  }
  const at = order.current.indexOf(userId);
  const nextPerson = fromRow && at >= 0 ? order.current[at + 1] : undefined;
  const prevPerson = fromRow && at > 0 ? order.current[at - 1] : undefined;

  // Start at the first one you haven't seen.
  useEffect(() => {
    if (index !== null || !q.data) return;
    const i = q.data.stories.findIndex((s) => !s.seen);
    setIndex(i >= 0 ? i : 0);
  }, [q.data, index]);
  // One deleted while you watch: stay in range.
  useEffect(() => {
    if (index !== null && stories.length && index > stories.length - 1) setIndex(stories.length - 1);
  }, [index, stories.length]);

  const goPerson = (id: string | undefined) => {
    if (!id) return leave();
    navigate(`/porch/stories/${id}?from=row`, { replace: true, state: { order: order.current } });
  };

  const markSeen = useCallback(
    (s: PorchStory) => {
      if (s.mine || s.seen) return;
      void porchApi
        .viewStory(s.id)
        .then(() => {
          qc.setQueryData<{ user: unknown; stories: PorchStory[] }>(userStoriesKey(userId, fromRow), (d) =>
            d ? { ...d, stories: d.stories.map((x) => (x.id === s.id ? { ...x, seen: true } : x)) } : d,
          );
          void qc.invalidateQueries({ queryKey: STORIES_ROW_KEY });
        })
        .catch(() => {
          /* gone or no longer shared: the next refresh drops it */
        });
    },
    [qc, userId, fromRow],
  );

  const remove = async (s: PorchStory) => {
    const ok = await confirm({
      title: "Delete this story?",
      message: "It goes from everyone's stories, your archive and any highlight. The photo stays in your Photos library.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await porchApi.deleteStory(s.id);
      toast.success("Story deleted.");
      void qc.invalidateQueries({ queryKey: STORIES_KEY });
      if (stories.length <= 1) leave();
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't delete the story. Try again."));
    }
  };

  const actions = (s: PorchStory): MenuAction[] => {
    if (s.mine) {
      return [
        { label: "Who's seen it", icon: Eye, onClick: () => setViewers(s.id) },
        { label: "Delete story", icon: Trash2, danger: true, onClick: () => void remove(s) },
      ];
    }
    const who = s.author;
    const out: MenuAction[] = [{ label: "Report", icon: TriangleAlert, hint: "Tell the admins of a group it's in", danger: true, onClick: () => setReporting(s) }];
    if (who) out.push({ label: `Block ${who.name}`, icon: UserX, danger: true, onClick: () => void block(who, { leave: true }) });
    return out;
  };

  if (q.isPending || index === null) {
    return createPortal(
      <div className="fixed inset-0 z-[45] flex items-center justify-center bg-black text-white" role="dialog" aria-modal="true" aria-label="Loading stories" data-story-player>
        {q.isError ? <Gone onClose={leave} text="Couldn't load these stories." /> : <Loader2 className="h-8 w-8 animate-spin" aria-label="Loading" />}
      </div>,
      document.body,
    );
  }
  if (!stories.length) {
    return createPortal(
      <div className="fixed inset-0 z-[45] flex items-center justify-center bg-black text-white" role="dialog" aria-modal="true" aria-label="No stories" data-story-player>
        <Gone onClose={leave} text={q.isError ? "These stories aren't available." : "No stories to see here. Stories last a day."} next={nextPerson ? () => goPerson(nextPerson) : undefined} />
      </div>,
      document.body,
    );
  }

  const name = q.data?.user.name ?? "Someone";
  return (
    <>
      <StoryPlayer
        key={userId}
        stories={stories}
        index={Math.min(index, stories.length - 1)}
        onIndex={setIndex}
        onClose={leave}
        onDone={() => goPerson(nextPerson)}
        onBeforeFirst={prevPerson ? () => goPerson(prevPerson) : undefined}
        onShown={markSeen}
        hold={!!menu || !!viewers || !!reporting}
        label={stories[0]?.mine ? "Your story" : `${name}'s story`}
        menu={(s) => () => setMenu(s)}
        footer={(s) =>
          s.mine ? (
            <button
              type="button"
              onClick={() => setViewers(s.id)}
              className="flex h-11 items-center gap-2 rounded-full px-3 text-sm font-medium text-white hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <Eye className="h-5 w-5" aria-hidden />
              {s.view_count ? `Seen by ${s.view_count}` : "No views yet"}
            </button>
          ) : null
        }
      />
      {menu && <ActionSheet open onClose={() => setMenu(null)} title={menu.mine ? "Your story" : `${menu.author?.name ?? "Someone"}'s story`} actions={actions(menu)} />}
      {viewers && <ViewersSheet storyId={viewers} open onClose={() => setViewers(null)} />}
      {reporting && (
        <ReportSheet
          open
          onClose={() => setReporting(null)}
          target="story"
          id={reporting.id}
          who={reporting.author?.name ?? "them"}
          authorId={reporting.author?.id}
          groups={reporting.groups}
        />
      )}
    </>
  );
}

function Gone({ text, onClose, next }: { text: string; onClose: () => void; next?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 px-6 text-center">
      <p className="max-w-xs text-base">{text}</p>
      <div className="flex gap-2">
        {next && (
          <button type="button" onClick={next} className="h-11 rounded-full bg-white px-5 text-sm font-semibold text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
            Next person
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-11 items-center gap-1.5 rounded-full border border-white/40 px-5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <X className="h-4 w-4" aria-hidden /> Close
        </button>
      </div>
    </div>
  );
}
