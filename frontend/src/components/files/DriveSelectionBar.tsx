import {
  Download,
  FolderInput,
  MoreHorizontal,
  RotateCcw,
  Star,
  StarOff,
  Trash2,
  X,
  MessageSquareText,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";
import { usePopoverDismiss } from "@/hooks/usePopoverDismiss";
import { cn } from "@/utils/cn";

type BarAction = {
  key: string;
  /** Full label (desktop, and the "More" list). */
  label: string;
  /** One word for under the icon on a phone. */
  short: string;
  icon: ReactNode;
  onClick: () => void;
  danger?: boolean;
};

/**
 * Contextual action bar shown when one or more Drive items are selected.
 * It floats over the bottom of the page (above the phone's tab bar) and
 * slides in, so the list underneath does not jump. Renders only the
 * actions whose handler is supplied, so each surface (browse / starred /
 * trash) shows the right set. On a phone the three most useful actions
 * are shown with their names and the rest sit under "More".
 */
export function DriveSelectionBar({
  count,
  busy,
  onClear,
  onMove,
  onStar,
  onUnstar,
  onDownload,
  onTrash,
  onSelectAll,
  onRestore,
  onDeleteForever,
  onAsk,
}: {
  count: number;
  busy?: boolean;
  onClear: () => void;
  onMove?: () => void;
  onStar?: () => void;
  onUnstar?: () => void;
  onDownload?: () => void;
  onTrash?: () => void;
  onRestore?: () => void;
  onDeleteForever?: () => void;
  /** "Ask about these" — a chat with the selected files (WP-3.5). */
  onAsk?: () => void;
  /** Offered until everything in the folder is selected. */
  onSelectAll?: () => void;
}) {
  const isPhone = useIsMobile();
  const visible = count > 0;
  // Slide in: mount off-place, then settle on the next frame. (The global
  // reduced-motion rule turns the transition off for people who ask.)
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!visible) {
      setSettled(false);
      return;
    }
    const id = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(id);
  }, [visible]);

  // The uploads panel shares the bottom of the screen: while this bar is
  // up it sits above it (``--selection-bar-lift``, read by the panel).
  useEffect(() => {
    if (!visible) return;
    const root = document.documentElement;
    root.style.setProperty("--selection-bar-lift", isPhone ? "8.5rem" : "4.75rem");
    return () => {
      root.style.removeProperty("--selection-bar-lift");
    };
  }, [visible, isPhone]);

  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  usePopoverDismiss(moreOpen, moreRef, () => setMoreOpen(false));
  useEffect(() => {
    if (!visible) setMoreOpen(false);
  }, [visible]);

  if (!visible) return null;

  const icon = "h-4 w-4";
  // Most useful first: a phone shows the first three by name.
  const actions: BarAction[] = [];
  if (onRestore) actions.push({ key: "restore", label: "Restore", short: "Restore", icon: <RotateCcw className={icon} />, onClick: onRestore });
  if (onMove) actions.push({ key: "move", label: "Move", short: "Move", icon: <FolderInput className={icon} />, onClick: onMove });
  if (onDownload) actions.push({ key: "download", label: "Download", short: "Download", icon: <Download className={icon} />, onClick: onDownload });
  if (onTrash) actions.push({ key: "trash", label: "Move to trash", short: "Trash", icon: <Trash2 className={icon} />, onClick: onTrash, danger: true });
  if (onDeleteForever) actions.push({ key: "delete", label: "Delete forever", short: "Delete", icon: <Trash2 className={icon} />, onClick: onDeleteForever, danger: true });
  if (onStar) actions.push({ key: "star", label: "Star", short: "Star", icon: <Star className={icon} />, onClick: onStar });
  if (onUnstar) actions.push({ key: "unstar", label: "Unstar", short: "Unstar", icon: <StarOff className={icon} />, onClick: onUnstar });
  if (onAsk)
    actions.push({
      key: "ask",
      label: count === 1 ? "Ask about this" : "Ask about these",
      short: "Ask",
      icon: <MessageSquareText className={icon} />,
      onClick: onAsk,
    });

  const shown = isPhone ? actions.slice(0, 3) : actions;
  const extra = isPhone ? actions.slice(3) : [];
  const hasMore = extra.length > 0 || (isPhone && !!onSelectAll);

  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-x-0 z-40 flex justify-center px-2",
        // Clear of the phone's bottom tabs; a little off the edge elsewhere.
        isPhone ? "bottom-[calc(env(safe-area-inset-bottom,0px)+4.5rem)]" : "bottom-6"
      )}
    >
      <div
        role="toolbar"
        aria-label="Selected items"
        className={cn(
          "pointer-events-auto flex max-w-full items-center gap-1 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-xl",
          "transition duration-200 ease-out",
          settled ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0",
          isPhone && "w-full"
        )}
      >
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear selection"
          className={cn(
            "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
            "text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
          )}
        >
          <X className="h-4 w-4" />
        </button>
        <span className="mr-1 whitespace-nowrap text-sm font-medium" aria-live="polite">
          {count} selected
        </span>
        {onSelectAll && !isPhone && (
          <button
            type="button"
            disabled={busy}
            onClick={onSelectAll}
            className="rounded-lg px-2 py-2 text-xs font-medium text-[var(--accent-text)] transition hover:bg-[var(--hover)] disabled:opacity-50"
          >
            Select all
          </button>
        )}

        <div className={cn("flex items-center gap-0.5", isPhone ? "ml-auto" : "ml-2 border-l border-[var(--border)] pl-2")}>
          {shown.map((a) => (
            <button
              key={a.key}
              type="button"
              disabled={busy}
              onClick={a.onClick}
              title={a.label}
              className={cn(
                "inline-flex items-center justify-center rounded-xl font-medium transition",
                "disabled:cursor-not-allowed disabled:opacity-50",
                isPhone
                  ? "h-12 min-w-[3.5rem] flex-col gap-0.5 px-1.5 text-xs"
                  : "h-10 gap-1.5 whitespace-nowrap px-3 text-sm",
                a.danger
                  ? "text-[var(--danger)] hover:bg-[var(--danger-bg)]"
                  : "text-[var(--text)] hover:bg-[var(--hover)]"
              )}
            >
              {a.icon}
              <span>{isPhone ? a.short : a.label}</span>
            </button>
          ))}
          {hasMore && (
            <div ref={moreRef} className="relative">
              <button
                type="button"
                disabled={busy}
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((o) => !o)}
                className="inline-flex h-12 min-w-[3.5rem] flex-col items-center justify-center gap-0.5 rounded-xl px-1.5 text-xs font-medium text-[var(--text)] transition hover:bg-[var(--hover)] disabled:opacity-50"
              >
                <MoreHorizontal className={icon} />
                <span>More</span>
              </button>
              {moreOpen && (
                <div
                  role="menu"
                  aria-label="More actions"
                  className="absolute bottom-full right-0 mb-2 w-52 rounded-card border border-[var(--border)] bg-[var(--surface)] py-1 text-sm shadow-xl"
                >
                  {onSelectAll && (
                    <MoreItem
                      label="Select all"
                      onClick={() => {
                        setMoreOpen(false);
                        onSelectAll();
                      }}
                    />
                  )}
                  {extra.map((a) => (
                    <MoreItem
                      key={a.key}
                      icon={a.icon}
                      label={a.label}
                      danger={a.danger}
                      onClick={() => {
                        setMoreOpen(false);
                        a.onClick();
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MoreItem({
  icon,
  label,
  danger,
  onClick,
}: {
  icon?: ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex min-h-10 w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-[var(--hover)]",
        danger && "text-[var(--danger)]"
      )}
    >
      <span className="inline-flex w-4 justify-center text-[var(--text-muted)]">{icon}</span>
      {label}
    </button>
  );
}
