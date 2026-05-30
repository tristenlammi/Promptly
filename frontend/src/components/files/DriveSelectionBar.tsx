import {
  Download,
  FolderInput,
  RotateCcw,
  Star,
  StarOff,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/shared/Button";
import { cn } from "@/utils/cn";

/**
 * Contextual action bar shown when one or more Drive items are selected
 * (Google-Drive style). Renders only the actions whose handler is
 * supplied, so each surface (browse / starred / trash) shows the right
 * set. Sticks to the top of the scroll area so it stays reachable.
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
  onRestore,
  onDeleteForever,
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
}) {
  if (count === 0) return null;
  return (
    <div className="sticky top-0 z-10 mb-2 flex items-center gap-2 rounded-card border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 shadow-sm">
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear selection"
        className={cn(
          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
          "text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
        )}
      >
        <X className="h-4 w-4" />
      </button>
      <span className="mr-1 text-sm font-medium">{count} selected</span>

      <div className="ml-auto flex items-center gap-1">
        {onDownload && (
          <BarButton
            icon={<Download className="h-3.5 w-3.5" />}
            label="Download"
            busy={busy}
            onClick={onDownload}
          />
        )}
        {onStar && (
          <BarButton
            icon={<Star className="h-3.5 w-3.5" />}
            label="Star"
            busy={busy}
            onClick={onStar}
          />
        )}
        {onUnstar && (
          <BarButton
            icon={<StarOff className="h-3.5 w-3.5" />}
            label="Unstar"
            busy={busy}
            onClick={onUnstar}
          />
        )}
        {onMove && (
          <BarButton
            icon={<FolderInput className="h-3.5 w-3.5" />}
            label="Move"
            busy={busy}
            onClick={onMove}
          />
        )}
        {onRestore && (
          <BarButton
            icon={<RotateCcw className="h-3.5 w-3.5" />}
            label="Restore"
            busy={busy}
            onClick={onRestore}
          />
        )}
        {onTrash && (
          <Button
            size="sm"
            variant="danger"
            loading={busy}
            leftIcon={<Trash2 className="h-3.5 w-3.5" />}
            onClick={onTrash}
          >
            <span className="hidden sm:inline">Move to trash</span>
            <span className="sm:hidden">Trash</span>
          </Button>
        )}
        {onDeleteForever && (
          <Button
            size="sm"
            variant="danger"
            loading={busy}
            leftIcon={<Trash2 className="h-3.5 w-3.5" />}
            onClick={onDeleteForever}
          >
            <span className="hidden sm:inline">Delete forever</span>
            <span className="sm:hidden">Delete</span>
          </Button>
        )}
      </div>
    </div>
  );
}

function BarButton({
  icon,
  label,
  busy,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  busy?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={label}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition",
        "text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]",
        "disabled:cursor-not-allowed disabled:opacity-50"
      )}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
