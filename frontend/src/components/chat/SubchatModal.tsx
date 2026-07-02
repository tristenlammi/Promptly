import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  CornerDownLeft,
  GripHorizontal,
  MessagesSquare,
  RotateCcw,
  Save,
  Send,
  Square,
  X,
} from "lucide-react";

import type { ConversationSummary } from "@/api/types";
import { useSubchatStream } from "@/hooks/useSubchatStream";
import { cn } from "@/utils/cn";

interface SubchatModalProps {
  subchat: ConversationSummary;
  /** Title of the parent chat — shown so the user knows what context the
   *  subchat inherited. */
  parentTitle: string | null;
  /** Display name of the model the subchat will use (inherited from the
   *  parent). Purely informational. */
  modelName?: string | null;
  /** Discard the subchat (parent deletes the ephemeral conversation). */
  onClose: () => void;
  /** Promote the subchat to a permanent chat (parent PATCHes
   *  temporary_mode=null and navigates / toasts). */
  onKeep: () => void;
  /** Discard the current tangent and start a fresh subchat from the latest
   *  message. Parent owns the confirm prompt. */
  onReset: () => void;
  /** Drop an assistant answer into the main composer. */
  onInsert: (text: string) => void;
}

const DEFAULT_W = 384;
const MIN_W = 300;
const MIN_H = 240;

type Corner = "nw" | "ne" | "sw" | "se";

/**
 * Floating, draggable + resizable Subchat window. A throwaway side-
 * conversation that inherits the parent thread's full context (server-
 * side) without writing back into it. Streams via {@link useSubchatStream}
 * on isolated local state so it never disturbs the main chat.
 */
export function SubchatModal({
  subchat,
  parentTitle,
  modelName,
  onClose,
  onKeep,
  onReset,
  onInsert,
}: SubchatModalProps) {
  const { messages, streaming, streamingContent, error, send, cancel } =
    useSubchatStream(subchat.id);
  const [draft, setDraft] = useState("");

  // ---- Geometry (position + size) ----
  // Docked to the right, vertically centred-ish, with a safe fallback
  // when window isn't available (SSR / tests).
  const [pos, setPos] = useState(() => {
    if (typeof window === "undefined") return { x: 80, y: 80 };
    return {
      x: Math.max(16, window.innerWidth - DEFAULT_W - 32),
      y: Math.max(16, Math.round(window.innerHeight * 0.12)),
    };
  });
  const [size, setSize] = useState(() => {
    if (typeof window === "undefined") return { w: DEFAULT_W, h: 600 };
    return { w: DEFAULT_W, h: Math.min(720, Math.round(window.innerHeight * 0.82)) };
  });

  // ---- Drag (move) ----
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const onDragStart = useCallback(
    (e: React.PointerEvent) => {
      // Ignore drags that start on a button or a resize handle.
      const t = e.target as HTMLElement;
      if (t.closest("button") || t.dataset.resize) return;
      dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pos.x, pos.y]
  );
  const onDragMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const maxX = window.innerWidth - size.w - 8;
      const maxY = window.innerHeight - 80;
      setPos({
        x: Math.min(Math.max(8, e.clientX - d.dx), Math.max(8, maxX)),
        y: Math.min(Math.max(8, e.clientY - d.dy), Math.max(8, maxY)),
      });
    },
    [size.w]
  );
  const onDragEnd = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  }, []);

  // ---- Resize (corners) ----
  const resizeRef = useRef<{
    corner: Corner;
    sx: number;
    sy: number;
    sw: number;
    sh: number;
    px: number;
    py: number;
  } | null>(null);

  const onResizeStart = useCallback(
    (corner: Corner) => (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      resizeRef.current = {
        corner,
        sx: e.clientX,
        sy: e.clientY,
        sw: size.w,
        sh: size.h,
        px: pos.x,
        py: pos.y,
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [size.w, size.h, pos.x, pos.y]
  );

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    const dx = e.clientX - r.sx;
    const dy = e.clientY - r.sy;
    const east = r.corner === "ne" || r.corner === "se";
    const west = r.corner === "nw" || r.corner === "sw";
    const south = r.corner === "sw" || r.corner === "se";
    const north = r.corner === "nw" || r.corner === "ne";

    let w = r.sw;
    let h = r.sh;
    let x = r.px;
    let y = r.py;

    if (east) w = r.sw + dx;
    if (west) {
      w = r.sw - dx;
      x = r.px + dx;
    }
    if (south) h = r.sh + dy;
    if (north) {
      h = r.sh - dy;
      y = r.py + dy;
    }

    // Enforce minimums (when dragging a top/left edge, keep the opposite
    // edge pinned by adjusting the position back).
    if (w < MIN_W) {
      if (west) x -= MIN_W - w;
      w = MIN_W;
    }
    if (h < MIN_H) {
      if (north) y -= MIN_H - h;
      h = MIN_H;
    }
    // Keep inside the viewport.
    if (x < 8) {
      if (west) w += x - 8;
      x = 8;
    }
    if (y < 8) {
      if (north) h += y - 8;
      y = 8;
    }
    w = Math.min(w, window.innerWidth - x - 8);
    h = Math.min(h, window.innerHeight - y - 8);

    setSize({ w, h });
    setPos({ x, y });
  }, []);

  const onResizeEnd = useCallback((e: React.PointerEvent) => {
    resizeRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }, []);

  // Auto-scroll the transcript to the bottom as content grows.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamingContent]);

  // Esc closes (discards). Listen at document level so it fires even when
  // focus is inside the textarea.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = useCallback(() => {
    const body = draft.trim();
    if (!body || streaming) return;
    setDraft("");
    void send(body);
  }, [draft, streaming, send]);

  const hasTurns = messages.length > 0 || streaming;

  // Shared classes for a resize handle. ``data-resize`` lets the header's
  // drag detector ignore pointer-downs that land on a handle.
  const handle = (corner: Corner, cls: string, cursor: string) => (
    <div
      data-resize="1"
      onPointerDown={onResizeStart(corner)}
      onPointerMove={onResizeMove}
      onPointerUp={onResizeEnd}
      className={cn("absolute z-10 h-4 w-4", cls)}
      style={{ cursor, touchAction: "none" }}
    />
  );

  return (
    <div
      role="dialog"
      aria-label="Subchat"
      className="fixed z-[60] flex flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
      style={{
        left: pos.x,
        top: pos.y,
        width: size.w,
        height: size.h,
        maxHeight: "calc(100vh - 16px)",
        maxWidth: "calc(100vw - 16px)",
      }}
    >
      {/* Header / drag handle */}
      <div
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        style={{ touchAction: "none" }}
        className="flex shrink-0 cursor-grab items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 active:cursor-grabbing"
      >
        <MessagesSquare className="h-4 w-4 shrink-0 text-[var(--accent)]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text)]">
            Subchat
            <GripHorizontal className="h-3 w-3 text-[var(--text-muted)]" />
          </div>
          <div className="truncate text-[10px] text-[var(--text-muted)]">
            Context from {parentTitle ? `“${parentTitle}”` : "this chat"}
            {modelName ? ` · ${modelName}` : ""}
          </div>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] transition hover:bg-[var(--bg)] hover:text-[var(--text)]"
          aria-label="Reset subchat (starts a fresh tangent)"
          title="Reset — discard this tangent and start fresh"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onKeep}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-[var(--border)] px-2 text-[11px] font-medium text-[var(--text-muted)] transition hover:border-[var(--accent)]/60 hover:text-[var(--accent)]"
          title="Keep this subchat as a permanent chat"
        >
          <Save className="h-3 w-3" />
          Keep
        </button>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] transition hover:bg-[var(--bg)] hover:text-[var(--text)]"
          aria-label="Close subchat (discards it)"
          title="Close — discards this subchat"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Transcript. ``min-h-0`` lets it scroll inside the flex column;
          ``min-w-0`` + break rules below stop long tokens from forcing
          horizontal overflow instead of wrapping. */}
      <div
        ref={bodyRef}
        className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 text-sm"
      >
        {!hasTurns && (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-4 py-8 text-center text-xs text-[var(--text-muted)]">
            <MessagesSquare className="mb-1 h-5 w-5 opacity-50" />
            Ask a tangent without touching the main thread. This subchat sees
            everything above, but nothing here is added to your chat.
          </div>
        )}

        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex min-w-0 justify-end">
              <div className="max-w-[85%] overflow-hidden whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-[var(--accent)] px-3 py-1.5 text-white [overflow-wrap:anywhere]">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={m.id} className="group flex min-w-0 flex-col gap-1">
              <div className="prose prose-sm min-w-0 max-w-none break-words dark:prose-invert prose-p:my-1.5 prose-pre:my-2 prose-pre:overflow-x-auto [overflow-wrap:anywhere]">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {m.content}
                </ReactMarkdown>
              </div>
              <button
                type="button"
                onClick={() => onInsert(m.content)}
                className="self-start text-[10px] text-[var(--text-muted)] opacity-0 transition hover:text-[var(--accent)] group-hover:opacity-100"
                title="Insert this answer into the main composer"
              >
                <span className="inline-flex items-center gap-1">
                  <CornerDownLeft className="h-3 w-3" />
                  Insert into chat
                </span>
              </button>
            </div>
          )
        )}

        {/* In-flight assistant reply */}
        {streaming && (
          <div className="prose prose-sm min-w-0 max-w-none break-words dark:prose-invert prose-p:my-1.5 prose-pre:my-2 prose-pre:overflow-x-auto [overflow-wrap:anywhere]">
            {streamingContent ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {streamingContent}
              </ReactMarkdown>
            ) : (
              <span className="inline-flex gap-1 text-[var(--text-muted)]">
                <span className="animate-pulse">Thinking…</span>
              </span>
            )}
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="break-words rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-600 dark:text-red-400"
          >
            {error}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-[var(--border)] p-2">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="Ask the subchat…"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            className="max-h-32 min-h-[38px] min-w-0 flex-1 resize-none rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]/60"
          />
          {streaming ? (
            <button
              type="button"
              onClick={cancel}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--text)] text-[var(--bg)] transition hover:opacity-90"
              aria-label="Stop generating"
              title="Stop generating"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={draft.trim().length === 0}
              className={cn(
                "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition",
                "bg-[var(--accent)] text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              )}
              aria-label="Send"
              title="Send (Enter)"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Resize handles — one per corner. The SE handle carries a subtle
          visible grip; the rest are invisible but grabbable. */}
      {handle("nw", "left-0 top-0", "nwse-resize")}
      {handle("ne", "right-0 top-0", "nesw-resize")}
      {handle("sw", "bottom-0 left-0", "nesw-resize")}
      <div
        data-resize="1"
        onPointerDown={onResizeStart("se")}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        className="absolute bottom-0 right-0 z-10 flex h-4 w-4 items-end justify-end p-0.5"
        style={{ cursor: "nwse-resize", touchAction: "none" }}
        aria-label="Resize"
      >
        <span className="h-2 w-2 rounded-br border-b-2 border-r-2 border-[var(--text-muted)]/50" />
      </div>
    </div>
  );
}
