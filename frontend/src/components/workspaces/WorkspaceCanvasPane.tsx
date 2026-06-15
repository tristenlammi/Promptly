import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2,
  Plus,
  FileText,
  MessageSquare,
  PenLine,
} from "lucide-react";
import { Tldraw, createShapeId, type Editor } from "tldraw";
import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import "tldraw/tldraw.css";

import { canvasApi } from "@/api/canvas";
import { useWorkspaceTree } from "@/hooks/useWorkspaces";
import type { WorkspaceItemNode } from "@/api/workspaces";
import { useCanvasCollabProvider } from "./useCanvasCollabProvider";
import { useYjsCanvasStore } from "./useYjsCanvasStore";
import { customShapeUtils } from "./canvas/customShapes";
import { CanvasCardProvider, type ItemCardShape } from "./canvas/ItemCardShape";

// Bundle tldraw's icons / fonts / translations through Vite so they load
// from our own origin. Promptly's CSP is ``default-src 'self'`` with no
// tldraw CDN allowance, so the default (CDN-hosted) assets are blocked —
// which is why the toolbar/style-panel render as empty squares without
// this. Computed once at module load (it only wires up import URLs).
const tldrawAssetUrls = getAssetUrlsByImport();

/**
 * Live, multiplayer tldraw board for a workspace canvas item.
 *
 * Mirrors the document collab path: a Hocuspocus provider feeds a shared
 * ``Y.Doc``; ``useYjsCanvasStore`` binds a tldraw ``TLStore`` to it (shapes
 * + presence). The board's flattened text is pushed back to the backend on
 * a 1.5s debounce so workspace RAG stays grounded in the canvas.
 *
 * The container is ``h-full`` + ``relative`` because tldraw fills its
 * positioned parent — without an explicitly sized parent it collapses to
 * zero height.
 */
const TEXT_DEBOUNCE_MS = 1500;

export function WorkspaceCanvasPane({
  canvasId,
  readOnly = false,
  workspaceId,
  onOpenItem,
}: {
  canvasId: string;
  /** Viewer-role access → board opens read-only. */
  readOnly?: boolean;
  /** Owning workspace — enables the "Insert card" picker + lets live
   *  cards resolve their workspace context. */
  workspaceId?: string;
  /** Open a card's underlying item in the workspace main pane. */
  onOpenItem?: (node: WorkspaceItemNode) => void;
}) {
  const { ydoc, provider, user, error } = useCanvasCollabProvider(canvasId);
  const storeWithStatus = useYjsCanvasStore({ ydoc, provider, user });

  const editorRef = useRef<Editor | null>(null);
  const debounceRef = useRef<number | null>(null);
  // Keep the last text we pushed so we skip no-op POSTs on cosmetic edits
  // (moving a shape doesn't change its text).
  const lastTextRef = useRef<string>("");

  // Flatten every text-bearing shape on the current page into one blob.
  // tldraw text / note / geo shapes carry their label under ``props.text``.
  const extractText = useCallback((editor: Editor): string => {
    const shapes = editor.getCurrentPageShapes();
    const parts: string[] = [];
    for (const shape of shapes) {
      const props = shape.props as { text?: unknown };
      if (typeof props.text === "string" && props.text.trim()) {
        parts.push(props.text.trim());
      }
    }
    return parts.join("\n");
  }, []);

  const schedulePush = useCallback(
    (editor: Editor) => {
      if (readOnly) return;
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        const text = extractText(editor);
        if (text === lastTextRef.current) return;
        lastTextRef.current = text;
        void canvasApi.updateText(canvasId, text).catch(() => {
          // Best-effort; a failed RAG sync shouldn't disrupt drawing.
        });
      }, TEXT_DEBOUNCE_MS);
    },
    [canvasId, extractText, readOnly]
  );

  const handleMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor;
      editor.updateInstanceState({ isReadonly: readOnly });

      // Push text whenever the document changes (debounced). We listen on
      // ``document`` scope so presence/cursor churn doesn't trip the push.
      const unlisten = editor.store.listen(
        () => schedulePush(editor),
        { scope: "document" }
      );
      // Seed an initial push so a freshly-opened board with prior content
      // re-grounds RAG even if nothing is edited this session.
      schedulePush(editor);

      return () => {
        unlisten();
      };
    },
    [readOnly, schedulePush]
  );

  // Clear any pending debounce on unmount / canvas swap.
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      lastTextRef.current = "";
    };
  }, [canvasId]);

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="rounded-card border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      </div>
    );
  }

  // Gate on the store being bound, not the live socket: once tldraw is up
  // we keep it mounted across transient disconnects (Yjs buffers + resyncs
  // on reconnect), so a blip doesn't blow away the user's view/selection.
  const ready = storeWithStatus.status === "synced-remote";

  if (!ready) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10 text-sm text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Connecting canvas…
        </span>
      </div>
    );
  }

  // Drop a live card for a workspace item onto the board at the current
  // viewport centre, then select it (so a chat card immediately goes live).
  const insertCard = (node: WorkspaceItemNode) => {
    const editor = editorRef.current;
    if (!editor || !node.ref_id) return;
    const center = editor.getViewportPageBounds().center;
    const id = createShapeId();
    editor.createShape<ItemCardShape>({
      id,
      type: "item-card",
      x: center.x - 170,
      y: center.y - 210,
      props: {
        w: 340,
        h: 420,
        itemId: node.id,
        kind: node.kind,
        refId: node.ref_id,
        title: node.title,
      },
    });
    editor.select(id);
  };

  return (
    <CanvasCardProvider value={{ workspaceId: workspaceId ?? "", onOpenItem }}>
      <div className="relative h-full min-h-0 flex-1">
        <Tldraw
          store={storeWithStatus}
          shapeUtils={customShapeUtils}
          assetUrls={tldrawAssetUrls}
          onMount={handleMount}
        />
        {!readOnly && workspaceId && (
          <InsertCardMenu workspaceId={workspaceId} onInsert={insertCard} />
        )}
      </div>
    </CanvasCardProvider>
  );
}

// --------------------------------------------------------------------------
// Insert-card picker — a floating control listing the workspace's notes,
// chats, and canvases. Selecting one drops a live card on the board.
// --------------------------------------------------------------------------

const INSERTABLE_ICON: Record<string, typeof FileText> = {
  note: FileText,
  chat: MessageSquare,
  canvas: PenLine,
};

function flattenInsertable(nodes: WorkspaceItemNode[]): WorkspaceItemNode[] {
  const out: WorkspaceItemNode[] = [];
  const walk = (list: WorkspaceItemNode[]) => {
    for (const n of list) {
      if (
        n.ref_id &&
        (n.kind === "note" || n.kind === "chat" || n.kind === "canvas")
      ) {
        out.push(n);
      }
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

function InsertCardMenu({
  workspaceId,
  onInsert,
}: {
  workspaceId: string;
  onInsert: (node: WorkspaceItemNode) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: tree } = useWorkspaceTree(workspaceId);
  const items = tree ? flattenInsertable(tree) : [];

  return (
    <div className="absolute left-3 top-3 z-10">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-card border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs font-medium text-[var(--text)] shadow-sm hover:bg-[var(--hover)]"
        title="Drop a live note, chat, or canvas card on the board"
      >
        <Plus className="h-3.5 w-3.5" />
        Insert card
      </button>
      {open && (
        <div className="mt-1 max-h-80 w-64 overflow-y-auto rounded-card border border-[var(--border)] bg-[var(--surface)] p-1 shadow-xl">
          {items.length === 0 ? (
            <p className="px-2 py-3 text-center text-[11px] text-[var(--text-muted)]">
              No notes, chats, or canvases yet. Create some in the rail, then
              drop them here.
            </p>
          ) : (
            items.map((n) => {
              const Icon = INSERTABLE_ICON[n.kind] ?? FileText;
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => {
                    onInsert(n);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[var(--text)] hover:bg-[var(--hover)]"
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                  <span className="min-w-0 flex-1 truncate">
                    {n.title || "Untitled"}
                  </span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                    {n.kind}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
