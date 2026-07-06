import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Check,
  Download,
  FileCode,
  FileText,
  LayoutGrid,
  FolderMinus,
  Loader2,
  Pin,
} from "lucide-react";

import { chatApi } from "@/api/chat";
import { useWorkspaces } from "@/hooks/useWorkspaces";
import { useUpdateConversation } from "@/hooks/useConversations";
import { cn } from "@/utils/cn";

type ExportFormat = "markdown" | "json" | "pdf";

interface Position {
  x: number;
  y: number;
}

interface Props {
  conversationId: string;
  /** Workspace this chat currently belongs to (``null`` for a standalone
   *  chat). Drives the checkmark + "Remove from workspace" affordance. */
  currentWorkspaceId: string | null;
  /** Current pinned state — drives the Pin/Unpin label. */
  pinned: boolean;
  /** Toggle the pin. The row owns the mutation; the menu just fires it. */
  onTogglePin: () => void;
  /** Archive the chat. The row owns the mutation; the menu just fires it.
   *  Permanent deletion lives on the Archive page, not here. */
  onArchive: () => void;
  position: Position;
  onClose: () => void;
}

const MENU_MIN_WIDTH = 240;

/** Floating context menu launched from a sidebar conversation row.
 *
 *  Hosts the per-conversation Export actions that used to live in the
 *  chat top-nav. Those weren't frequent enough to earn permanent
 *  header real estate, so we hid them behind a right-click (or
 *  long-press on touch) gesture borrowed from native file managers.
 *
 *  Implementation note: a full-screen ``inset-0`` overlay sits behind
 *  the menu and swallows the next mousedown / contextmenu, which is
 *  the simplest way to dismiss on outside-click without racing the
 *  same event that opened us. The menu itself is rendered into a
 *  portal so it can escape the sidebar's ``overflow-y-auto`` clip
 *  rectangle and stay anchored to the cursor wherever the row sits in
 *  the scroll viewport. */
export function ConversationRowContextMenu({
  conversationId,
  currentWorkspaceId,
  pinned,
  onTogglePin,
  onArchive,
  position,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<Position>(position);
  const [busyFmt, setBusyFmt] = useState<ExportFormat | null>(null);
  const [lastDownloaded, setLastDownloaded] = useState<ExportFormat | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  // Phase 3.2 — "Move to workspace" is a second level inside this menu.
  const [view, setView] = useState<"main" | "move">("main");
  // Busy target id during a move; ``"__remove__"`` while detaching.
  const [movingTo, setMovingTo] = useState<string | null>(null);
  const workspaces = useWorkspaces({ archived: false });
  const updateConv = useUpdateConversation();
  const qc = useQueryClient();

  const doMove = async (targetId: string | null) => {
    if (movingTo !== null) return;
    setMovingTo(targetId ?? "__remove__");
    setError(null);
    try {
      await updateConv.mutateAsync({
        id: conversationId,
        payload: { workspace_id: targetId },
      });
      // Refresh workspace membership counts / workspace conversation lists.
      qc.invalidateQueries({ queryKey: ["workspaces"] });
      onClose();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Couldn't move this chat. Try again."
      );
    } finally {
      setMovingTo(null);
    }
  };

  // Clamp the menu inside the viewport once we know its rendered
  // size — naively using the click coords can push it under the
  // bottom edge or off the right side, especially on mobile where
  // long-presses tend to land near a screen border.
  useLayoutEffect(() => {
    const el = ref.current;
    const margin = 8;
    const w = el?.offsetWidth ?? MENU_MIN_WIDTH;
    const h = el?.offsetHeight ?? 220;
    const maxX = window.innerWidth - w - margin;
    const maxY = window.innerHeight - h - margin;
    setPos({
      x: Math.min(Math.max(margin, position.x), Math.max(margin, maxX)),
      y: Math.min(Math.max(margin, position.y), Math.max(margin, maxY)),
    });
  }, [position.x, position.y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [onClose]);

  const doExport = async (fmt: ExportFormat) => {
    if (busyFmt) return;
    setBusyFmt(fmt);
    setError(null);
    try {
      const { blob, filename } = await chatApi.exportConversation(
        conversationId,
        fmt
      );
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Slight delay before revoking — Safari otherwise cancels the
      // download mid-flight when the object URL goes away.
      window.setTimeout(() => window.URL.revokeObjectURL(url), 1500);
      setLastDownloaded(fmt);
      window.setTimeout(() => {
        setLastDownloaded(null);
        onClose();
      }, 900);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Export failed. Try another format."
      );
    } finally {
      setBusyFmt(null);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[60]"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={ref}
        role="menu"
        style={{ top: pos.y, left: pos.x, minWidth: MENU_MIN_WIDTH }}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
        className={cn(
          "absolute overflow-hidden rounded-card border shadow-xl",
          "border-[var(--border)] bg-[var(--surface)] py-1 text-sm"
        )}
      >
        {view === "main" ? (
          <>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onTogglePin();
                onClose();
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition",
                "text-[var(--text)] hover:bg-[var(--accent)]/[0.08]"
              )}
            >
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                <Pin
                  className={cn(
                    "h-3.5 w-3.5",
                    pinned
                      ? "fill-current text-[var(--accent)]"
                      : "text-[var(--text-muted)]"
                  )}
                />
              </span>
              <span className="flex-1 font-medium">
                {pinned ? "Unpin" : "Pin to top"}
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onClose();
                onArchive();
              }}
              className={cn(
                // Neutral like Pin/Move — archive is reversible; amber made
                // it read as a destructive cousin of Delete.
                "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition",
                "text-[var(--text)] hover:bg-[var(--accent)]/[0.08]"
              )}
            >
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                <Archive className="h-3.5 w-3.5" />
              </span>
              <span className="flex-1 font-medium">Archive</span>
            </button>

            <div className="my-1 border-t border-[var(--border)]" />

            <button
              type="button"
              role="menuitem"
              onClick={() => setView("move")}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition",
                "text-[var(--text)] hover:bg-[var(--accent)]/[0.08]"
              )}
            >
              <span
                className={cn(
                  "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded",
                  "bg-[var(--accent)]/10 text-[var(--accent)]"
                )}
              >
                <LayoutGrid className="h-3 w-3" />
              </span>
              <span className="flex-1 font-medium">Move to workspace…</span>
              <ChevronRight className="h-3.5 w-3.5 text-[var(--text-muted)]" />
            </button>

            <div className="my-1 border-t border-[var(--border)]" />

            <div
              className={cn(
                "px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide",
                "text-[var(--text-muted)]"
              )}
            >
              Download as…
            </div>
            <ExportRow
              label="Markdown"
              hint="Human-readable transcript"
              Icon={FileText}
              busy={busyFmt === "markdown"}
              done={lastDownloaded === "markdown"}
              disabled={busyFmt !== null}
              onSelect={() => void doExport("markdown")}
            />
            <ExportRow
              label="JSON"
              hint="Full fidelity — re-importable"
              Icon={FileCode}
              busy={busyFmt === "json"}
              done={lastDownloaded === "json"}
              disabled={busyFmt !== null}
              onSelect={() => void doExport("json")}
            />
            <ExportRow
              label="PDF"
              hint="Polished doc for sharing offline"
              Icon={Download}
              busy={busyFmt === "pdf"}
              done={lastDownloaded === "pdf"}
              disabled={busyFmt !== null}
              onSelect={() => void doExport("pdf")}
            />
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setView("main")}
              className={cn(
                "flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide transition",
                "text-[var(--text-muted)] hover:text-[var(--text)]"
              )}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Move to workspace
            </button>

            {currentWorkspaceId && (
              <button
                type="button"
                role="menuitem"
                disabled={movingTo !== null}
                onClick={() => void doMove(null)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition",
                  "text-[var(--text)] hover:bg-[var(--accent)]/[0.08]",
                  "disabled:cursor-not-allowed disabled:opacity-60"
                )}
              >
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                  {movingTo === "__remove__" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <FolderMinus className="h-3 w-3" />
                  )}
                </span>
                <span className="flex-1">Remove from workspace</span>
              </button>
            )}

            <div className="max-h-60 overflow-y-auto">
              {workspaces.isLoading && (
                <div className="px-3 py-2 text-xs text-[var(--text-muted)]">
                  Loading workspaces…
                </div>
              )}
              {workspaces.data && workspaces.data.length === 0 && (
                <div className="px-3 py-2 text-xs text-[var(--text-muted)]">
                  No workspaces yet.
                </div>
              )}
              {workspaces.data?.map((p) => {
                const isCurrent = p.id === currentWorkspaceId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="menuitem"
                    disabled={movingTo !== null || isCurrent}
                    onClick={() => void doMove(p.id)}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition",
                      "text-[var(--text)] hover:bg-[var(--accent)]/[0.08]",
                      "disabled:cursor-not-allowed",
                      isCurrent && "opacity-80"
                    )}
                  >
                    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                      {movingTo === p.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : isCurrent ? (
                        <Check className="h-3 w-3 text-[var(--accent)]" />
                      ) : (
                        <LayoutGrid className="h-3 w-3 text-[var(--text-muted)]" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {p.title || "Untitled workspace"}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {error && (
          <div
            role="alert"
            className={cn(
              "mx-2 mb-2 mt-1 rounded border px-2 py-1.5 text-[11px]",
              "border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger)]"
            )}
          >
            {error}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function ExportRow({
  label,
  hint,
  Icon,
  busy,
  done,
  disabled,
  onSelect,
}: {
  label: string;
  hint: string;
  Icon: typeof FileText;
  busy: boolean;
  done: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2 px-3 py-2 text-left text-xs transition",
        "text-[var(--text)] hover:bg-[var(--accent)]/[0.08]",
        "disabled:cursor-not-allowed disabled:opacity-60"
      )}
    >
      <span
        className={cn(
          "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded",
          "bg-[var(--accent)]/10 text-[var(--accent)]"
        )}
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : done ? (
          <Check className="h-3 w-3" />
        ) : (
          <Icon className="h-3 w-3" />
        )}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="font-medium">{label}</span>
        <span className="text-[11px] text-[var(--text-muted)]">{hint}</span>
      </span>
    </button>
  );
}
