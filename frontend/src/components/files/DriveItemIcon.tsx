import {
  Archive,
  File as FileIcon,
  FileCode,
  FileText,
  Film,
  Folder as FolderIcon,
  Image as ImageIcon,
  Inbox,
  type LucideIcon,
  Music,
  Sparkles,
  Table as TableIcon,
} from "lucide-react";

import type { SystemFolderKind } from "@/api/files";
import { classifyMime } from "./helpers";
import { cn } from "@/utils/cn";

/**
 * Canonical, type-coloured icon for a Drive item so file kinds are
 * scannable at a glance (the way a real drive colour-codes by type).
 * Keyed off the shared `classifyMime` so it stays in lockstep with the
 * preview renderer. Folders get their system-aware glyph.
 *
 * `tile` renders the glyph inside a translucent tinted square — the same
 * pastel-tile treatment the workspace navigator uses — so the account
 * Drive and workspace Drive lists match the item submenu. Plain (no tile)
 * is the bare coloured glyph, used at the larger grid / details sizes.
 *
 * Prop shapes are structural (not the full `FileItem` / `FolderItem`) so
 * the workspace Drive's lighter `WorkspaceDriveFile` / `WorkspaceDriveFolder`
 * rows can share the exact same icon.
 */
type IconFile = {
  filename: string;
  mime_type: string;
  source_kind?: string | null;
};
// ``name`` is only here to give the structural type a non-optional-overlap
// property (both FolderItem and WorkspaceDriveFolder carry it) so TS doesn't
// flag the otherwise all-optional shape as a weak type; the icon only reads
// ``system_kind``.
type IconFolder = { name: string; system_kind?: SystemFolderKind | null };

interface Tint {
  Icon: LucideIcon;
  /** Glyph colour class. */
  text: string;
  /** Matching translucent tile-background class (tile mode only). */
  tile: string;
}

const NEUTRAL: Tint = {
  Icon: FileIcon,
  text: "text-[var(--text-muted)]",
  tile: "bg-[var(--text-muted)]/10",
};

/** Public accessor for a file's kind colours — lets grid cards tint their
 *  thumbnail backing / kind badge to match this icon. */
export function fileKindTint(file: IconFile): { text: string; tile: string } {
  const { text, tile } = fileTint(file);
  return { text, tile };
}

function fileTint(file: IconFile): Tint {
  const lower = (file.filename || "").toLowerCase();
  const mime = (file.mime_type || "").toLowerCase();

  if (mime.startsWith("video/"))
    return { Icon: Film, text: "text-fuchsia-500", tile: "bg-fuchsia-500/15" };
  if (mime.startsWith("audio/"))
    return { Icon: Music, text: "text-pink-500", tile: "bg-pink-500/15" };
  if (/\.(zip|tar|gz|tgz|rar|7z)$/.test(lower))
    return { Icon: Archive, text: "text-amber-600", tile: "bg-amber-600/15" };

  const kind = classifyMime(file.mime_type, file.filename, file.source_kind);
  switch (kind) {
    case "image":
      return { Icon: ImageIcon, text: "text-violet-500", tile: "bg-violet-500/15" };
    case "pdf":
      return { Icon: FileText, text: "text-rose-500", tile: "bg-rose-500/15" };
    case "document":
      return { Icon: FileText, text: "text-sky-500", tile: "bg-sky-500/15" };
    case "code":
      return { Icon: FileCode, text: "text-amber-500", tile: "bg-amber-500/15" };
    case "code_artifact":
      // csv/json/html/svg/markdown live here — split sheets from the rest.
      if (/\.csv$/.test(lower))
        return { Icon: TableIcon, text: "text-emerald-500", tile: "bg-emerald-500/15" };
      return { Icon: FileCode, text: "text-emerald-500", tile: "bg-emerald-500/15" };
    case "markdown":
    case "text":
      return { Icon: FileText, text: "text-sky-500", tile: "bg-sky-500/15" };
    default:
      return NEUTRAL;
  }
}

function folderTint(kind: SystemFolderKind | null | undefined): Tint {
  const Icon: LucideIcon =
    kind === "chat_uploads"
      ? Inbox
      : kind === "generated_root"
        ? Sparkles
        : kind === "generated_files"
          ? FileText
          : kind === "generated_media"
            ? ImageIcon
            : FolderIcon;
  // Folders anchor the structure — the accent tile, echoing the navigator.
  return { Icon, text: "text-[var(--accent)]", tile: "bg-[var(--accent-soft)]" };
}

export function DriveItemIcon({
  file,
  folder,
  className,
  tile = false,
}: {
  file?: IconFile;
  folder?: IconFolder;
  className?: string;
  /** Render inside a pastel tinted square (matches the navigator tree). */
  tile?: boolean;
}) {
  const t = folder ? folderTint(folder.system_kind) : file ? fileTint(file) : NEUTRAL;

  if (tile) {
    return (
      <span
        className={cn(
          "grid shrink-0 place-items-center rounded-md",
          className ?? "h-5 w-5",
          t.tile
        )}
      >
        <t.Icon className={cn("h-3 w-3", t.text)} />
      </span>
    );
  }

  return <t.Icon className={cn("shrink-0", className ?? "h-5 w-5", t.text)} />;
}
