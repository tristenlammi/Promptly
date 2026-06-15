import {
  createContext,
  useContext,
  type MouseEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import {
  HTMLContainer,
  Rectangle2d,
  resizeBox,
  ShapeUtil,
  T,
  useEditor,
  useValue,
  type Geometry2d,
  type RecordProps,
  type TLBaseShape,
  type TLResizeInfo,
} from "tldraw";
import {
  FileText,
  MessageSquare,
  PenLine,
  File as FileIcon,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { ChatPage } from "@/pages/ChatPage";
import { documentsApi } from "@/api/documents";
import type { WorkspaceItemNode, WorkspaceItemKind } from "@/api/workspaces";

/**
 * "Live cards" — the Phase 5 wow feature.
 *
 * A custom tldraw shape (``item-card``) that embeds a *live* workspace item
 * onto the board: a note preview, a file/canvas reference, or — the headline
 * — an actually-interactive chat that streams in-shape. Drop a running AI
 * conversation onto a planning board next to your notes; that's the thing
 * Obsidian Canvas structurally can't do.
 *
 * The shape stores only a *reference* (``itemId`` / ``kind`` / ``refId`` /
 * ``title``); the body fetches its own content via React Query, so the Yjs
 * record stays tiny and every peer renders identically. The shape util is
 * registered in BOTH the Yjs ``TLStore`` and the ``<Tldraw>`` component (see
 * ``customShapeUtils``) so custom records deserialize on remote peers.
 */

export interface ItemCardProps {
  w: number;
  h: number;
  /** ``workspace_items`` row id — what ``onOpenItem`` navigates to. */
  itemId: string;
  /** note | chat | canvas | file — drives which body renders. */
  kind: string;
  /** Underlying resource id: Drive doc id (note), conversation id
   *  (chat), canvas id (canvas), file id (file). */
  refId: string;
  title: string;
}

export type ItemCardShape = TLBaseShape<"item-card", ItemCardProps>;

// tldraw v5 makes the ``TLShape`` union extensible by augmenting
// ``TLGlobalShapePropsMap``. Registering ``item-card`` here is what lets our
// custom shape satisfy ``ShapeUtil<S extends TLShape>`` / ``createShape`` /
// ``resizeBox`` without casts. Props must match the validators below.
declare module "@tldraw/tlschema" {
  interface TLGlobalShapePropsMap {
    "item-card": ItemCardProps;
  }
}

// --------------------------------------------------------------------------
// Context — lets card bodies (rendered deep inside the tldraw subtree) reach
// the workspace id + the "open this item in the main pane" callback. The
// provider wraps <Tldraw> in WorkspaceCanvasPane, so this is in scope.
// --------------------------------------------------------------------------

export interface CanvasCardContextValue {
  workspaceId: string;
  onOpenItem?: (node: WorkspaceItemNode) => void;
}

const CanvasCardContext = createContext<CanvasCardContextValue | null>(null);

export const CanvasCardProvider = CanvasCardContext.Provider;

function useCanvasCardContext(): CanvasCardContextValue | null {
  return useContext(CanvasCardContext);
}

// --------------------------------------------------------------------------
// Shape util
// --------------------------------------------------------------------------

const CARD_W = 340;
const CARD_H = 420;

// Custom shapes can't satisfy ``BaseBoxShapeUtil``'s ``TLBaseBoxShape`` bound
// (it's a closed union over the built-in shapes), so we extend ``ShapeUtil``
// directly and supply box geometry + resize ourselves.
export class ItemCardShapeUtil extends ShapeUtil<ItemCardShape> {
  static override type = "item-card" as const;

  static override props: RecordProps<ItemCardShape> = {
    w: T.number,
    h: T.number,
    itemId: T.string,
    kind: T.string,
    refId: T.string,
    title: T.string,
  };

  override getDefaultProps(): ItemCardShape["props"] {
    return {
      w: CARD_W,
      h: CARD_H,
      itemId: "",
      kind: "note",
      refId: "",
      title: "Untitled",
    };
  }

  // Cards are reference widgets, not free-text shapes — no tldraw text
  // editor, but they do resize like a box.
  override canEdit() {
    return false;
  }
  override canResize() {
    return true;
  }

  override getGeometry(shape: ItemCardShape): Geometry2d {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    });
  }

  override onResize(shape: ItemCardShape, info: TLResizeInfo<ItemCardShape>) {
    // Registered in TLGlobalShapePropsMap (w/h present) → ``item-card`` is a
    // valid box shape, so ``resizeBox`` types cleanly and preserves our extra
    // reference props.
    return resizeBox(shape, info);
  }

  override component(shape: ItemCardShape) {
    return (
      // ``pointerEvents: all`` lets the card's own UI receive clicks; the
      // body then stops propagation so interacting with content doesn't
      // pan/select the canvas. The header is left "transparent" to pointer
      // semantics so it stays a drag handle.
      <HTMLContainer
        style={{
          width: shape.props.w,
          height: shape.props.h,
          pointerEvents: "all",
        }}
      >
        <ItemCardBody shape={shape} />
      </HTMLContainer>
    );
  }

  override getIndicatorPath(shape: ItemCardShape) {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }
}

// --------------------------------------------------------------------------
// Card body
// --------------------------------------------------------------------------

const KIND_ICON: Record<string, typeof FileText> = {
  note: FileText,
  chat: MessageSquare,
  canvas: PenLine,
  file: FileIcon,
};

/** Swallow pointer/wheel events so interacting inside the card never starts
 *  a canvas drag, marquee-select, or zoom. Applied to the scrollable body. */
const swallow = {
  onPointerDown: (e: PointerEvent) => e.stopPropagation(),
  onPointerMove: (e: PointerEvent) => e.stopPropagation(),
  onPointerUp: (e: PointerEvent) => e.stopPropagation(),
  onWheel: (e: WheelEvent) => e.stopPropagation(),
};

function ItemCardBody({ shape }: { shape: ItemCardShape }) {
  const ctx = useCanvasCardContext();
  const editor = useEditor();
  const { kind, refId, title, itemId } = shape.props;

  // A chat card goes *live* (renders the real, streaming ChatPage) only when
  // it is the single selected shape. ChatPage drives a singleton chat store,
  // so allowing two live chats at once would let messages bleed across cards.
  // Gating on "only selected" guarantees at most one live conversation.
  const isLiveChat = useValue(
    "card-is-live",
    () => {
      const ids = editor.getSelectedShapeIds();
      return ids.length === 1 && ids[0] === shape.id;
    },
    [editor, shape.id]
  );

  const Icon = KIND_ICON[kind] ?? FileIcon;

  const open = (e: MouseEvent) => {
    e.stopPropagation();
    ctx?.onOpenItem?.({
      id: itemId,
      kind: kind as WorkspaceItemKind,
      ref_id: refId || null,
      title,
      icon: null,
      position: 0,
      indexing_status: null,
      children: [],
    });
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-[12px] border border-[var(--border)] bg-[var(--surface)] shadow-xl">
      {/* Header — drag handle (no event swallowing) + open button */}
      <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-2,var(--surface))] px-3 py-2">
        <Icon className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--text)]">
          {title || "Untitled"}
        </span>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
          {kind}
        </span>
        {ctx?.onOpenItem && itemId && (
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={open}
            title="Open in workspace"
            className="shrink-0 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-hidden" {...swallow}>
        {kind === "chat" && refId ? (
          <ChatCardBody convId={refId} live={isLiveChat} />
        ) : kind === "note" && refId ? (
          <NoteCardBody docId={refId} />
        ) : (
          <RefCardBody kind={kind} />
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Chat card — the headline. Live (streaming) when selected, static otherwise.
// --------------------------------------------------------------------------

function ChatCardBody({ convId, live }: { convId: string; live: boolean }) {
  if (live) {
    return (
      <div className="h-full w-full overflow-hidden">
        {/* The embedded ChatPage hides its own TopNav and keys off the
         *  passed conversation id. Sized to the card; it scrolls inside. */}
        <ChatPage embedded embeddedConversationId={convId} />
      </div>
    );
  }
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">
      <MessageSquare className="h-6 w-6 text-[var(--text-muted)]" />
      <p className="text-xs font-medium text-[var(--text)]">Live chat</p>
      <p className="text-[11px] leading-snug text-[var(--text-muted)]">
        Click the card to open the conversation and chat right here on the
        board.
      </p>
    </div>
  );
}

// --------------------------------------------------------------------------
// Note card — markdown preview of the underlying Drive document.
// --------------------------------------------------------------------------

function NoteCardBody({ docId }: { docId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["canvas-card", "note-preview", docId],
    queryFn: async () => {
      const { blob } = await documentsApi.download(docId, "md");
      const text = await blob.text();
      return text;
    },
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-[var(--text-muted)]">
        Couldn't load this note's preview.
      </div>
    );
  }

  const text = (data ?? "").trim();
  if (!text) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-[var(--text-muted)]">
        This note is empty.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-3 py-2">
      <pre className="whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed text-[var(--text)]">
        {text.slice(0, 2000)}
      </pre>
    </div>
  );
}

// --------------------------------------------------------------------------
// Canvas / file reference card — a labelled chip with an open affordance.
// --------------------------------------------------------------------------

function RefCardBody({ kind }: { kind: string }) {
  const label =
    kind === "canvas"
      ? "Canvas board"
      : kind === "file"
        ? "File"
        : "Workspace item";
  const Icon = KIND_ICON[kind] ?? FileIcon;
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">
      <Icon className="h-6 w-6 text-[var(--text-muted)]" />
      <p className="text-xs font-medium text-[var(--text)]">{label}</p>
      <p className="text-[11px] leading-snug text-[var(--text-muted)]">
        Open it from the header to view the full {label.toLowerCase()}.
      </p>
    </div>
  );
}
