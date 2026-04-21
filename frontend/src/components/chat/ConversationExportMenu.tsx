import { useEffect, useRef, useState } from "react";
import {
  Check,
  Download,
  FileCode,
  FileText,
  Loader2,
} from "lucide-react";

import { chatApi } from "@/api/chat";
import { cn } from "@/utils/cn";

interface ConversationExportMenuProps {
  conversationId: string;
  compact?: boolean;
}

type ExportFormat = "markdown" | "json" | "pdf";

interface FormatRow {
  fmt: ExportFormat;
  label: string;
  hint: string;
  icon: typeof FileText;
}

/** Order matters: Markdown first because it's the default (round-trip
 *  friendly and renders nicely in every other tool), JSON second (for
 *  power users / re-importing), PDF last because it's the heaviest
 *  renderer and least frequently wanted. */
const FORMATS: FormatRow[] = [
  {
    fmt: "markdown",
    label: "Markdown",
    hint: "Human-readable transcript",
    icon: FileText,
  },
  {
    fmt: "json",
    label: "JSON",
    hint: "Full fidelity — re-importable",
    icon: FileCode,
  },
  {
    fmt: "pdf",
    label: "PDF",
    hint: "Polished doc for sharing offline",
    icon: FileText,
  },
];

/**
 * Export-this-chat button + popover. Renders as an icon-only button in
 * the TopNav actions row, matching the Share / ModelSelector footprint.
 *
 * Why a standalone component rather than inline in ChatPage:
 *
 *  * ChatPage is already dense — another dropdown would push it past
 *    readability on mobile width.
 *  * The download side-effect (blob → object URL → <a download>) is
 *    fiddly enough to deserve its own test surface.
 *  * The same component will be reusable from the conversation list
 *    row menu (Phase 2) without copy-pasting.
 */
export function ConversationExportMenu({
  conversationId,
  compact = false,
}: ConversationExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [busyFmt, setBusyFmt] = useState<ExportFormat | null>(null);
  const [lastDownloaded, setLastDownloaded] = useState<ExportFormat | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (wrapRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

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
      // Revoke after a short delay so Safari actually commits the
      // download before the URL is yanked out from under it.
      window.setTimeout(() => window.URL.revokeObjectURL(url), 1500);
      setLastDownloaded(fmt);
      window.setTimeout(() => setLastDownloaded(null), 2500);
      setOpen(false);
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : "Export failed. Try another format.";
      setError(msg);
    } finally {
      setBusyFmt(null);
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={busyFmt !== null}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] font-medium",
          "text-[var(--text-muted)] transition",
          "hover:border-[var(--accent)]/50 hover:text-[var(--text)]",
          open && "border-[var(--accent)]/60 text-[var(--text)]",
          compact ? "h-9 w-9 justify-center" : "px-2.5 py-1.5 text-xs",
          "disabled:cursor-not-allowed disabled:opacity-60"
        )}
        title="Export this conversation"
        aria-label="Export this conversation"
        aria-expanded={open}
      >
        {busyFmt ? (
          <Loader2 className={cn("animate-spin", compact ? "h-4 w-4" : "h-3.5 w-3.5")} />
        ) : (
          <Download className={compact ? "h-4 w-4" : "h-3.5 w-3.5"} />
        )}
        {!compact && <span>Export</span>}
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            "absolute right-0 top-full z-30 mt-1 min-w-[260px] overflow-hidden rounded-md border shadow-lg",
            "border-[var(--border)] bg-[var(--surface)] py-1"
          )}
        >
          <div
            className={cn(
              "px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide",
              "text-[var(--text-muted)]"
            )}
          >
            Download as…
          </div>
          <ul>
            {FORMATS.map((row) => {
              const Icon = row.icon;
              const isBusy = busyFmt === row.fmt;
              const justDone = lastDownloaded === row.fmt;
              return (
                <li key={row.fmt}>
                  <button
                    type="button"
                    disabled={busyFmt !== null}
                    onClick={() => void doExport(row.fmt)}
                    className={cn(
                      "flex w-full items-start gap-2 px-3 py-2 text-left text-xs transition",
                      "text-[var(--text)]",
                      "hover:bg-[var(--accent)]/[0.08]",
                      "disabled:cursor-not-allowed disabled:opacity-60"
                    )}
                    role="menuitem"
                  >
                    <span
                      className={cn(
                        "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded",
                        "bg-[var(--accent)]/10 text-[var(--accent)]"
                      )}
                    >
                      {isBusy ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : justDone ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <Icon className="h-3 w-3" />
                      )}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium">{row.label}</span>
                      <span className="text-[11px] text-[var(--text-muted)]">
                        {row.hint}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {error && (
            <div
              className={cn(
                "mx-2 mb-2 mt-1 rounded border px-2 py-1.5 text-[11px]",
                "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
              )}
              role="alert"
            >
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
