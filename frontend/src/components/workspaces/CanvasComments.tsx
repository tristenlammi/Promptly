import { useCallback, useEffect, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { History, MessageSquare, MessageSquarePlus } from "lucide-react";

import type { ElementAnchor } from "@/api/documentComments";
import { CommentsPanel, type CommentDraft } from "@/components/files/documents/CommentsPanel";
import { VersionHistoryPanel } from "@/components/files/VersionHistoryPanel";
import { useDocComments, type CommentThread } from "@/components/files/documents/useDocComments";
import { cn } from "@/utils/cn";

/**
 * Comments on a whiteboard (WP-6.1): a thread points at shapes. "Comment on
 * the selection" starts one; clicking a thread selects its shapes and zooms
 * to them. A thread whose shapes were all deleted shows as such.
 */
type Provider = Parameters<typeof useDocComments>[2];

function elementAnchor(t: CommentThread): ElementAnchor | null {
  const a = t.root.anchor;
  return a && "kind" in a && a.kind === "element" ? a : null;
}

export function CanvasComments({
  fileId,
  api,
  provider,
  openThreadId,
}: {
  fileId: string;
  api: ExcalidrawImperativeAPI | null;
  provider: Provider;
  openThreadId?: string | null;
}) {
  const comments = useDocComments(fileId, null, provider);
  const [open, setOpen] = useState(!!openThreadId);
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const [activeId, setActiveId] = useState<string | null>(openThreadId ?? null);
  const [selected, setSelected] = useState<string[]>([]);
  // The board's version history (WP-6.2) lives beside its comments.
  const [historyOpen, setHistoryOpen] = useState(false);

  // What's selected on the board (for "Comment on the selection").
  useEffect(() => {
    if (!api || !open) return;
    const read = () => setSelected(Object.keys(api.getAppState().selectedElementIds ?? {}));
    read();
    const t = window.setInterval(read, 600);
    return () => window.clearInterval(t);
  }, [api, open]);

  const live = useCallback(() => {
    const out = new Map<string, number>();
    (api?.getSceneElements() ?? []).forEach((el, i) => out.set(el.id, i));
    return out;
  }, [api]);

  const placeOf = useCallback(
    (t: CommentThread) => {
      const a = elementAnchor(t);
      if (!a) return Number.MAX_SAFE_INTEGER;
      const idx = live();
      const at = a.ids.map((id) => idx.get(id)).filter((x): x is number => x !== undefined);
      return at.length ? Math.min(...at) : null;
    },
    [live]
  );

  const goTo = useCallback(
    (t: CommentThread) => {
      const a = elementAnchor(t);
      if (!api || !a) return;
      const els = api.getSceneElements().filter((el) => a.ids.includes(el.id));
      if (!els.length) return;
      api.updateScene({ appState: { selectedElementIds: Object.fromEntries(els.map((el) => [el.id, true])) } as never });
      api.scrollToContent(els, { fitToContent: true, animate: true });
    },
    [api]
  );

  useEffect(() => {
    if (!openThreadId || !api) return;
    const t = comments.threads.find((x) => x.root.id === openThreadId);
    if (t) {
      setActiveId(t.root.id);
      goTo(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openThreadId, api, comments.threads.length]);

  const startDraft = () => {
    if (!api) return;
    if (!selected.length) {
      // On the whiteboard as a whole — what a commenter can do, since a
      // read-only board can't select shapes (WP-6.6). The server keeps no
      // anchor for an empty one.
      setDraft({ anchor: { kind: "element", ids: [] }, quote: "" });
      return;
    }
    const els = api.getSceneElements().filter((el) => selected.includes(el.id));
    const words = els
      .map((el) => ("text" in el && typeof el.text === "string" ? el.text : ""))
      .filter(Boolean)
      .join(" · ");
    setDraft({
      anchor: { kind: "element", ids: selected.slice(0, 20) },
      // The shapes' own words, if any — the chip already says how many.
      quote: words.slice(0, 200),
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Comments on this board"
        className={cn(
          "absolute right-3 top-16 z-20 inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-medium text-[var(--text)] shadow-md hover:bg-[var(--hover)]",
          open && "hidden"
        )}
      >
        <MessageSquare className="h-3.5 w-3.5" />
        {comments.openCount ? `Comments (${comments.openCount})` : "Comments"}
      </button>
      <button
        type="button"
        onClick={() => setHistoryOpen((o) => !o)}
        aria-expanded={historyOpen}
        title="Version history"
        className={cn(
          "absolute right-3 top-[6.25rem] z-20 inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-medium text-[var(--text)] shadow-md hover:bg-[var(--hover)]",
          (open || historyOpen) && "hidden"
        )}
      >
        <History className="h-3.5 w-3.5" />
        History
      </button>
      {historyOpen && <VersionHistoryPanel fileId={fileId} onClose={() => setHistoryOpen(false)} />}
      {open && (
        <CommentsPanel
          documentId={fileId}
          editor={null}
          threads={comments.threads}
          canComment={comments.canComment}
          loading={comments.loading}
          draft={draft}
          activeId={activeId}
          onActivate={setActiveId}
          onDraftDone={() => setDraft(null)}
          onChanged={comments.changed}
          onClose={() => setOpen(false)}
          placeOf={placeOf}
          onSelectThread={goTo}
          labelOf={(t) => {
            const a = elementAnchor(t);
            return a ? `${a.ids.length} shape${a.ids.length === 1 ? "" : "s"}` : null;
          }}
          emptyHint="No comments yet. Select shapes to comment on them, or comment on the whiteboard as a whole."
          orphanNote="The shapes this was about have been deleted."
          header={
            comments.canComment && !draft ? (
              <div className="border-b border-[var(--border)] px-3 py-2">
                <button
                  type="button"
                  onClick={startDraft}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-50"
                >
                  <MessageSquarePlus className="h-3.5 w-3.5" />
                  {selected.length ? "Comment on the selection" : "Comment on the whiteboard"}
                </button>
              </div>
            ) : null
          }
        />
      )}
    </>
  );
}
