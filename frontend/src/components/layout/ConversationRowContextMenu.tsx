import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  Download,
  FileCode,
  FileText,
  Loader2,
  Share2,
} from "lucide-react";

import { chatApi } from "@/api/chat";
import { cn } from "@/utils/cn";

type ExportFormat = "markdown" | "json" | "pdf";

interface Position {
  x: number;
  y: number;
}

interface Props {
  conversationId: string;
  position: Position;
  /** Owner-only — when ``false`` the Share row is hidden so non-owner
   *  collaborators don't see an action that would just 403 anyway. */
  canShare: boolean;
  onShare: () => void;
  onClose: () => void;
}

const MENU_MIN_WIDTH = 240;

/** Floating context menu launched from a sidebar conversation row.
 *
 *  Replaces the dedicated Share + Export buttons that used to live in
 *  the chat top-nav. Those actions weren't frequent enough to earn
 *  permanent header real estate, so we hid them behind a right-click
 *  (or long-press on touch) gesture borrowed from native file
 *  managers.
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
  position,
  canShare,
  onShare,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<Position>(position);
  const [busyFmt, setBusyFmt] = useState<ExportFormat | null>(null);
  const [lastDownloaded, setLastDownloaded] = useState<ExportFormat | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

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
        {canShare && (
          <>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onShare();
                onClose();
              }}
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
                <Share2 className="h-3 w-3" />
              </span>
              <span className="font-medium">Share…</span>
            </button>
            <div className="my-1 border-t border-[var(--border)]" />
          </>
        )}

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

        {error && (
          <div
            role="alert"
            className={cn(
              "mx-2 mb-2 mt-1 rounded border px-2 py-1.5 text-[11px]",
              "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
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
