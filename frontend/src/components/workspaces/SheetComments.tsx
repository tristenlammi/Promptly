import { useCallback, useEffect, useState, type MutableRefObject } from "react";
import type { WorkbookInstance } from "@fortune-sheet/react";
import { MessageSquarePlus } from "lucide-react";

import type { CellAnchor } from "@/api/documentComments";
import { CommentsPanel, type CommentDraft } from "@/components/files/documents/CommentsPanel";
import type { CommentThread } from "@/components/files/documents/useDocComments";

import { colName, readGrid, safely } from "./SheetAiPanel";

/**
 * Comments on a sheet (WP-6.1): a thread points at a cell — the panel lists
 * open threads in sheet order (tab, then row, then column), "Comment on B5"
 * starts one on the selected cell, and clicking a thread goes to its cell.
 */
interface TabInfo {
  id: string;
  name: string;
  order: number;
}

function tabsOf(wb: WorkbookInstance | null): TabInfo[] {
  return safely(() => wb?.getAllSheets?.() ?? [], []).map((s, i) => ({
    id: String(s.id ?? ""),
    name: s.name,
    order: typeof s.order === "number" ? s.order : i,
  }));
}

/** The tab a cell anchor is on — by id, else by name (an imported workbook's
 *  tabs get fresh ids until it's first saved). */
function tabFor(tabs: TabInfo[], a: CellAnchor): TabInfo | undefined {
  return tabs.find((t) => t.id === a.sheet) ?? (a.tab ? tabs.find((t) => t.name === a.tab) : undefined);
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

export function SheetComments({
  fileId,
  workbookRef,
  comments,
  onClose,
  openThreadId,
}: {
  fileId: string;
  workbookRef: MutableRefObject<WorkbookInstance | null>;
  comments: {
    threads: CommentThread[];
    canComment: boolean;
    loading: boolean;
    changed: () => Promise<void>;
  };
  onClose: () => void;
  /** Open on this thread (a notification's link). */
  openThreadId?: string | null;
}) {
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const [activeId, setActiveId] = useState<string | null>(openThreadId ?? null);
  // Re-read tabs and the selection now and then: the panel shows the
  // selected cell on its "Comment on …" button.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 700);
    return () => window.clearInterval(t);
  }, []);
  const tabs = tabsOf(workbookRef.current);
  void tick;

  const cellAnchor = (t: CommentThread): CellAnchor | null => {
    const a = t.root.anchor;
    return a && "kind" in a && a.kind === "cell" ? a : null;
  };

  const placeOf = useCallback(
    (t: CommentThread) => {
      const a = cellAnchor(t);
      if (!a) return Number.MAX_SAFE_INTEGER;
      const tab = tabFor(tabsOf(workbookRef.current), a);
      return tab ? tab.order * 1e10 + a.r * 1e5 + a.c : null;
    },
    [workbookRef]
  );

  const labelOf = (t: CommentThread) => {
    const a = cellAnchor(t);
    if (!a) return null;
    const tab = tabFor(tabs, a);
    const active = safely(() => workbookRef.current?.getSheet?.(), undefined);
    const prefix = tab && active && String(active.id) !== tab.id ? `${tab.name}!` : "";
    return `${prefix}${colName(a.c)}${a.r + 1}`;
  };

  const goTo = useCallback(
    async (t: CommentThread) => {
      const a = cellAnchor(t);
      if (!a) return;
      const tab = tabFor(tabsOf(workbookRef.current), a);
      if (!tab) return;
      const wb = () => workbookRef.current;
      if (String(safely(() => wb()?.getSheet?.()?.id, undefined)) !== tab.id) {
        wb()?.activateSheet({ id: tab.id });
        await nextFrame();
      }
      try {
        wb()?.setSelection([{ row: [a.r, a.r], column: [a.c, a.c] }], { id: tab.id });
        wb()?.scroll({ targetRow: a.r, targetColumn: a.c });
      } catch {
        /* a cell past the end */
      }
    },
    [workbookRef]
  );

  // A notification's link: go to its cell once the threads and the workbook
  // have both arrived.
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    if (!openThreadId || landed) return;
    const t = comments.threads.find((x) => x.root.id === openThreadId);
    const a = t ? cellAnchor(t) : null;
    if (!t || !a || !tabFor(tabs, a)) return;
    setLanded(true);
    setActiveId(t.root.id);
    void goTo(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openThreadId, comments.threads.length, tick]);

  const sel = safely(() => workbookRef.current?.getSelection?.()?.[0], undefined);
  const active = safely(() => workbookRef.current?.getSheet?.(), undefined);
  const here = sel ? { r: sel.row[0], c: sel.column[0] } : null;
  const startDraft = () => {
    if (!here || !active?.id) return;
    const { cells } = readGrid(workbookRef.current);
    setDraft({
      anchor: { kind: "cell", sheet: String(active.id), tab: active.name, r: here.r, c: here.c },
      quote: cells.get(`${here.r}:${here.c}`)?.text ?? "",
    });
  };

  return (
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
      onClose={onClose}
      placeOf={placeOf}
      onSelectThread={(t) => void goTo(t)}
      labelOf={labelOf}
      emptyHint="No comments yet. Select a cell, then “Comment on …” above."
      orphanNote="The tab this was on has been deleted."
      header={
        comments.canComment && !draft ? (
          <div className="border-b border-[var(--border)] px-3 py-2">
            <button
              type="button"
              onClick={startDraft}
              disabled={!here}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-50"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
              {here ? `Comment on ${colName(here.c)}${here.r + 1}` : "Select a cell to comment on"}
            </button>
          </div>
        ) : null
      }
    />
  );
}
