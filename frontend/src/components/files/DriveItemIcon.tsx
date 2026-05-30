import {
  Archive,
  File as FileIcon,
  FileCode,
  FileText,
  Film,
  Folder as FolderIcon,
  Image as ImageIcon,
  Inbox,
  Music,
  Sparkles,
  Table as TableIcon,
} from "lucide-react";

import type { FileItem, FolderItem, SystemFolderKind } from "@/api/files";
import { classifyMime } from "./helpers";
import { cn } from "@/utils/cn";

/**
 * Canonical, type-coloured icon for a Drive item so file kinds are
 * scannable at a glance (the way a real drive colour-codes by type).
 * Keyed off the shared `classifyMime` so it stays in lockstep with the
 * preview renderer. Folders get their system-aware glyph.
 */
export function DriveItemIcon({
  file,
  folder,
  className,
}: {
  file?: FileItem;
  folder?: FolderItem;
  className?: string;
}) {
  const sz = cn("shrink-0", className ?? "h-5 w-5");

  if (folder) {
    return <FolderGlyph kind={folder.system_kind} className={sz} />;
  }
  if (!file) return <FileIcon className={cn(sz, "text-[var(--text-muted)]")} />;

  const lower = (file.filename || "").toLowerCase();
  const mime = (file.mime_type || "").toLowerCase();

  if (mime.startsWith("video/"))
    return <Film className={cn(sz, "text-fuchsia-500")} />;
  if (mime.startsWith("audio/"))
    return <Music className={cn(sz, "text-pink-500")} />;
  if (/\.(zip|tar|gz|tgz|rar|7z)$/.test(lower))
    return <Archive className={cn(sz, "text-amber-600")} />;

  const kind = classifyMime(file.mime_type, file.filename, file.source_kind);
  switch (kind) {
    case "image":
      return <ImageIcon className={cn(sz, "text-violet-500")} />;
    case "pdf":
      return <FileText className={cn(sz, "text-rose-500")} />;
    case "document":
      return <FileText className={cn(sz, "text-sky-500")} />;
    case "code":
      return <FileCode className={cn(sz, "text-amber-500")} />;
    case "code_artifact":
      // csv/json/html/svg/markdown live here — split sheets from the rest.
      if (/\.csv$/.test(lower))
        return <TableIcon className={cn(sz, "text-emerald-500")} />;
      return <FileCode className={cn(sz, "text-emerald-500")} />;
    case "markdown":
    case "text":
      return <FileText className={cn(sz, "text-sky-500")} />;
    default:
      return <FileIcon className={cn(sz, "text-[var(--text-muted)]")} />;
  }
}

function FolderGlyph({
  kind,
  className,
}: {
  kind: SystemFolderKind | null;
  className?: string;
}) {
  const c = cn(className, "text-[var(--accent)]");
  switch (kind) {
    case "chat_uploads":
      return <Inbox className={c} />;
    case "generated_root":
      return <Sparkles className={c} />;
    case "generated_files":
      return <FileText className={c} />;
    case "generated_media":
      return <ImageIcon className={c} />;
    default:
      return <FolderIcon className={c} />;
  }
}
