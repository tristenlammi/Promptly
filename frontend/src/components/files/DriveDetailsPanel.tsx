import { useQuery } from "@tanstack/react-query";
import {
  Download,
  ExternalLink,
  FilePen,
  FileSpreadsheet,
  MessageSquareText,
  FolderInput,
  Share2,
  Star,
  StarOff,
  Trash2,
  X,
  History,
} from "lucide-react";

import type { FileItem, FolderItem } from "@/api/files";
import { filesShellApi } from "@/api/filesShell";
import { MediaDetails, isMediaFile } from "@/components/files/MediaDetails";
import { DriveItemIcon } from "./DriveItemIcon";
import { DriveThumb } from "./DriveThumb";
import { GranteesPill } from "./GranteesPill";
import {
  displayFileName,
  formatRelativeTime,
  humanSize,
  kindLabel,
} from "./helpers";
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
  onAsk,
  onOpenAsDocument,
  onOpenAsSheet,
  onHistory,
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
  /** "Ask about this" — a chat with this file, or a folder's files. */
  onAsk?: () => void;
  /** A .docx: make an editable Promptly document from it. */
  onOpenAsDocument?: () => void;
  /** An .xlsx / .ods / .csv: make an editable Promptly sheet from it. */
  onOpenAsSheet?: () => void;
  /** Its earlier versions (WP-8.1). */
  onHistory?: () => void;
}) {
  // Owner, location and dates (WP-3.5) — one small read per selection.
  const { data: details } = useQuery({
    queryKey: ["file-details", file?.id],
    queryFn: () => filesShellApi.details(file!.id),
    enabled: !!file,
    staleTime: 30_000,
  });
  const isFolder = !!folder;
  const name = folder ? folder.name : file ? displayFileName(file) : "";
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
            value={
              (details?.modified_at ?? updatedAt)
                ? `${absoluteDate(details?.modified_at ?? updatedAt!)} (${formatRelativeTime(details?.modified_at ?? updatedAt!)})`
                : "—"
            }
          />
          {(details?.created_at ?? folder?.created_at) && (
            <Meta label="Created" value={absoluteDate(details?.created_at ?? folder!.created_at)} />
          )}
          {details && (
            <>
              <Meta label="Owner" value={details.is_owner ? "You" : (details.owner_name ?? "—")} />
              <Meta label="Location" value={details.location} />
              {details.versions > 0 && (
                <Meta label="Versions kept" value={String(details.versions)} />
              )}
            </>
          )}
        </dl>
        {file && isMediaFile(file.mime_type) && <MediaDetails fileId={file.id} />}

        {/* Actions */}
        <div className="mt-5 space-y-1">
          <PanelAction icon={<ExternalLink className="h-4 w-4" />} label="Open" onClick={onOpen} />
          {onOpenAsDocument && (
            <PanelAction icon={<FilePen className="h-4 w-4" />} label="Open in Promptly Docs" onClick={onOpenAsDocument} />
          )}
          {onOpenAsSheet && (
            <PanelAction icon={<FileSpreadsheet className="h-4 w-4" />} label="Open in Promptly Sheets" onClick={onOpenAsSheet} />
          )}
          {onHistory && (
            <PanelAction icon={<History className="h-4 w-4" />} label="Version history" onClick={onHistory} />
          )}
          {onAsk && (
            <PanelAction icon={<MessageSquareText className="h-4 w-4" />} label="Ask about this" onClick={onAsk} />
          )}
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

/** "12 Oct 2026, 14:05" — the pane shows real dates (Part C §2.2). */
function absoluteDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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
