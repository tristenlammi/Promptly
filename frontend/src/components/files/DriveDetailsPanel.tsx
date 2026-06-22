import {
  Download,
  ExternalLink,
  FolderInput,
  Share2,
  Star,
  StarOff,
  Trash2,
  X,
} from "lucide-react";

import type { FileItem, FolderItem } from "@/api/files";
import { DriveItemIcon } from "./DriveItemIcon";
import { DriveThumb } from "./DriveThumb";
import { GranteesPill } from "./GranteesPill";
import { formatRelativeTime, humanSize, kindLabel } from "./helpers";
import { cn } from "@/utils/cn";

/**
 * Right-hand details pane shown when exactly one Drive item is selected —
 * the "inspect without opening" affordance every real drive has. Renders a
 * preview/thumbnail, metadata, sharing, and the item's actions so the user
 * never has to bounce through a full-screen modal just to check a file's
 * size or share state. Desktop-only (the caller hides it under ``lg``).
 */
export function DriveDetailsPanel({
  file,
  folder,
  writable,
  onClose,
  onOpen,
  onDownload,
  onShare,
  onMove,
  onStar,
  onUnstar,
  onTrash,
}: {
  file?: FileItem | null;
  folder?: FolderItem | null;
  writable: boolean;
  onClose: () => void;
  onOpen: () => void;
  onDownload?: () => void;
  onShare: () => void;
  onMove: () => void;
  onStar: () => void;
  onUnstar: () => void;
  onTrash: () => void;
}) {
  const isFolder = !!folder;
  const name = folder ? folder.name : (file?.filename ?? "");
  const starred = folder ? !!folder.starred_at : !!file?.starred_at;
  const updatedAt = folder ? folder.updated_at : (file?.updated_at ?? null);
  const sharing = folder ? folder.sharing : file?.sharing;
  // System folders can't be renamed / moved / trashed — gate the
  // mutating actions accordingly.
  const isSystem = !!folder?.system_kind;
  const canMutate = writable && !isSystem;
  const canShare = !isSystem;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Details
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {/* Preview / thumbnail */}
        <div className="mb-3 flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg)]">
          {file ? (
            <DriveThumb file={file} className="h-full w-full" />
          ) : (
            <DriveItemIcon folder={folder ?? undefined} className="h-14 w-14" />
          )}
        </div>

        <h3 className="break-words text-sm font-semibold [overflow-wrap:anywhere]">
          {name}
        </h3>
        {sharing && (
          <div className="mt-1.5">
            <GranteesPill sharing={sharing} variant="compact" />
          </div>
        )}

        {/* Metadata */}
        <dl className="mt-4 space-y-2 text-xs">
          <Meta label="Kind" value={isFolder ? "Folder" : kindLabel(file!)} />
          {!isFolder && (
            <Meta label="Size" value={humanSize(file!.size_bytes)} />
          )}
          <Meta
            label="Modified"
            value={updatedAt ? formatRelativeTime(updatedAt) : "—"}
          />
        </dl>

        {/* Actions */}
        <div className="mt-5 space-y-1">
          <PanelAction icon={<ExternalLink className="h-4 w-4" />} label={isFolder ? "Open" : "Preview"} onClick={onOpen} />
          {!isFolder && onDownload && (
            <PanelAction icon={<Download className="h-4 w-4" />} label="Download" onClick={onDownload} />
          )}
          {canShare && (
            <PanelAction icon={<Share2 className="h-4 w-4" />} label="Share" onClick={onShare} />
          )}
          {canMutate &&
            (starred ? (
              <PanelAction icon={<StarOff className="h-4 w-4" />} label="Remove star" onClick={onUnstar} />
            ) : (
              <PanelAction icon={<Star className="h-4 w-4" />} label="Add star" onClick={onStar} />
            ))}
          {canMutate && (
            <PanelAction icon={<FolderInput className="h-4 w-4" />} label="Move to…" onClick={onMove} />
          )}
          {canMutate && (
            <PanelAction
              icon={<Trash2 className="h-4 w-4" />}
              label="Move to trash"
              onClick={onTrash}
              destructive
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-[var(--text-muted)]">{label}</dt>
      <dd className="truncate text-right text-[var(--text)]" title={value}>
        {value}
      </dd>
    </div>
  );
}

function PanelAction({
  icon,
  label,
  onClick,
  destructive,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition",
        destructive
          ? "text-red-600 hover:bg-red-500/10 dark:text-red-400"
          : "text-[var(--text)] hover:bg-[var(--hover)]"
      )}
    >
      <span className={destructive ? "" : "text-[var(--text-muted)]"}>
        {icon}
      </span>
      {label}
    </button>
  );
}
