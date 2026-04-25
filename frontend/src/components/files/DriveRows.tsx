import { useState } from "react";
import {
  Download,
  Eye,
  File as FileIcon,
  FileText,
  Folder as FolderIcon,
  Image as ImageIcon,
  MoreVertical,
  Pencil,
  RotateCcw,
  Share2,
  Star,
  Trash2,
} from "lucide-react";

import type { FileItem, FolderItem } from "@/api/files";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { cn } from "@/utils/cn";

import {
  downloadAuthed,
  formatRelativeTime,
  humanSize,
} from "./helpers";

/** Actions surfaced as context-menu entries on a Drive list row. */
export interface RowActions {
  onPreview?: () => void;
  onDownload?: () => void;
  onShare?: () => void;
  onStar?: () => void;
  onUnstar?: () => void;
  onRename?: () => void;
  onMove?: () => void;
  onTrash?: () => void;
  onRestore?: () => void;
  onDeleteForever?: () => void;
}

interface DriveFileRowProps {
  file: FileItem;
  actions: RowActions;
  /** Extra text in the metadata line (breadcrumb / snippet etc). */
  extra?: React.ReactNode;
  /** Custom click handler — defaults to preview. */
  onClick?: () => void;
}

export function DriveFileRow({
  file,
  actions,
  extra,
  onClick,
}: DriveFileRowProps) {
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const click = onClick ?? actions.onPreview ?? (() => downloadAuthed(file));

  const items: ContextMenuItem[] = buildFileContextItems(file, actions);

  return (
    <li
      onContextMenu={(e) => {
        e.preventDefault();
        setCtx({ x: e.clientX, y: e.clientY });
      }}
      onDoubleClick={() => actions.onPreview?.()}
      className="group flex items-center gap-3 px-4 py-3 transition hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
    >
      <button
        onClick={click}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <FileTypeIcon mime={file.mime_type} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 truncate text-sm">
            <span className="truncate">{file.filename}</span>
            {file.starred_at && (
              <Star className="h-3 w-3 shrink-0 fill-yellow-400 text-yellow-400" />
            )}
          </div>
          <div className="truncate text-xs text-[var(--text-muted)]">
            {humanSize(file.size_bytes)} · {file.mime_type || "unknown"}
            {file.updated_at && ` · ${formatRelativeTime(file.updated_at)}`}
            {extra && " · "}
            {extra}
          </div>
        </div>
      </button>

      {/* Desktop quick-action icons — hover-only so they stay out of
          the visual noise on a dense row. Hidden on mobile because
          there's no hover state to reveal them. */}
      {actions.onPreview && (
        <RowIconButton
          label="Preview"
          onClick={() => actions.onPreview!()}
          className="hidden md:inline-flex"
        >
          <Eye className="h-4 w-4" />
        </RowIconButton>
      )}
      {actions.onDownload && (
        <RowIconButton
          label="Download"
          onClick={() => actions.onDownload!()}
          className="hidden md:inline-flex"
        >
          <Download className="h-4 w-4" />
        </RowIconButton>
      )}

      {/* Mobile row menu — always visible on phones so touch users
          have a reachable entrypoint to every action on the row.
          The desktop still gets the right-click context menu as
          before. */}
      {items.length > 0 && (
        <RowMenuButton
          open={menuOpen}
          onOpenChange={setMenuOpen}
          items={items}
        />
      )}

      <ContextMenu
        open={ctx !== null}
        x={ctx?.x ?? 0}
        y={ctx?.y ?? 0}
        items={items}
        onClose={() => setCtx(null)}
      />
    </li>
  );
}

interface DriveFolderRowProps {
  folder: FolderItem;
  actions: RowActions;
  onOpen: () => void;
}

export function DriveFolderRow({
  folder,
  actions,
  onOpen,
}: DriveFolderRowProps) {
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const items: ContextMenuItem[] = buildFolderContextItems(folder, actions, onOpen);

  return (
    <li
      onContextMenu={(e) => {
        e.preventDefault();
        setCtx({ x: e.clientX, y: e.clientY });
      }}
      className="group flex items-center gap-3 px-4 py-3 transition hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
    >
      <button
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <FolderIcon className="h-5 w-5 shrink-0 text-[var(--accent)]" />
        <div className="flex items-center gap-1.5 truncate text-sm font-medium">
          <span className="truncate">{folder.name}</span>
          {folder.starred_at && (
            <Star className="h-3 w-3 shrink-0 fill-yellow-400 text-yellow-400" />
          )}
        </div>
        {folder.updated_at && (
          <span className="ml-auto hidden text-xs text-[var(--text-muted)] md:block">
            {formatRelativeTime(folder.updated_at)}
          </span>
        )}
      </button>

      {/* Mobile-always / desktop-hover menu — see DriveFileRow. */}
      {items.length > 1 && (
        <RowMenuButton
          open={menuOpen}
          onOpenChange={setMenuOpen}
          items={items}
        />
      )}

      <ContextMenu
        open={ctx !== null}
        x={ctx?.x ?? 0}
        y={ctx?.y ?? 0}
        items={items}
        onClose={() => setCtx(null)}
      />
    </li>
  );
}

function RowIconButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={label}
      aria-label={label}
      className={cn(
        "rounded-md p-1.5 text-[var(--text-muted)] opacity-0 transition",
        "hover:bg-black/[0.04] hover:text-[var(--text)] group-hover:opacity-100",
        "dark:hover:bg-white/[0.06]",
        className
      )}
    >
      {children}
    </button>
  );
}

/** Dropdown "more actions" button. On mobile it's always visible so
 *  touch users never have to rely on right-click or long-press to
 *  reach a row's actions. On desktop it's hover-revealed so the
 *  right-side rail stays visually quiet. */
function RowMenuButton({
  open,
  onOpenChange,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ContextMenuItem[];
}) {
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpenChange(!open);
        }}
        aria-label="More actions"
        title="More"
        className={cn(
          "rounded-md p-1.5 text-[var(--text-muted)] transition",
          "hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]",
          // Mobile: always shown. Desktop: revealed on row hover so
          // the quiet state still looks like a plain table row.
          "opacity-100 md:opacity-0 md:group-hover:opacity-100"
        )}
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => onOpenChange(false)}
          />
          <div className="absolute right-0 top-9 z-20 w-48 overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-lg">
            {items.map((it, i) => (
              <button
                key={`${it.label}-${i}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenChange(false);
                  it.onClick();
                }}
                disabled={it.disabled}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition",
                  it.destructive
                    ? "text-red-600 hover:bg-red-500/10 dark:text-red-400"
                    : "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]",
                  it.disabled && "cursor-not-allowed opacity-50"
                )}
              >
                {it.icon}
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function FileTypeIcon({ mime }: { mime: string }) {
  if (mime.startsWith("image/")) {
    return <ImageIcon className="h-5 w-5 shrink-0 text-violet-500" />;
  }
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml"
  ) {
    return <FileText className="h-5 w-5 shrink-0 text-sky-500" />;
  }
  return <FileIcon className="h-5 w-5 shrink-0 text-[var(--text-muted)]" />;
}

function buildFileContextItems(
  file: FileItem,
  actions: RowActions
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (actions.onPreview) {
    items.push({
      icon: <Eye className="h-3.5 w-3.5" />,
      label: "Preview",
      onClick: actions.onPreview,
    });
  }
  if (actions.onDownload) {
    items.push({
      icon: <Download className="h-3.5 w-3.5" />,
      label: "Download",
      onClick: actions.onDownload,
    });
  }
  if (actions.onStar && !file.starred_at) {
    items.push({
      icon: <Star className="h-3.5 w-3.5" />,
      label: "Star",
      onClick: actions.onStar,
    });
  }
  if (actions.onUnstar && file.starred_at) {
    items.push({
      icon: <Star className="h-3.5 w-3.5" />,
      label: "Unstar",
      onClick: actions.onUnstar,
    });
  }
  if (actions.onShare) {
    items.push({
      icon: <Share2 className="h-3.5 w-3.5" />,
      label: "Share",
      onClick: actions.onShare,
    });
  }
  if (actions.onRename) {
    items.push({
      icon: <Pencil className="h-3.5 w-3.5" />,
      label: "Rename",
      onClick: actions.onRename,
    });
  }
  if (actions.onMove) {
    items.push({
      icon: <FolderIcon className="h-3.5 w-3.5" />,
      label: "Move to…",
      onClick: actions.onMove,
    });
  }
  if (actions.onTrash) {
    items.push({
      icon: <Trash2 className="h-3.5 w-3.5" />,
      label: "Trash",
      destructive: true,
      onClick: actions.onTrash,
    });
  }
  if (actions.onRestore) {
    items.push({
      icon: <RotateCcw className="h-3.5 w-3.5" />,
      label: "Restore",
      onClick: actions.onRestore,
    });
  }
  if (actions.onDeleteForever) {
    items.push({
      icon: <Trash2 className="h-3.5 w-3.5" />,
      label: "Delete forever",
      destructive: true,
      onClick: actions.onDeleteForever,
    });
  }
  return items;
}

function buildFolderContextItems(
  folder: FolderItem,
  actions: RowActions,
  onOpen: () => void
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      icon: <FolderIcon className="h-3.5 w-3.5" />,
      label: "Open",
      onClick: onOpen,
    },
  ];
  if (actions.onStar && !folder.starred_at) {
    items.push({
      icon: <Star className="h-3.5 w-3.5" />,
      label: "Star",
      onClick: actions.onStar,
    });
  }
  if (actions.onUnstar && folder.starred_at) {
    items.push({
      icon: <Star className="h-3.5 w-3.5" />,
      label: "Unstar",
      onClick: actions.onUnstar,
    });
  }
  if (actions.onShare) {
    items.push({
      icon: <Share2 className="h-3.5 w-3.5" />,
      label: "Share",
      onClick: actions.onShare,
    });
  }
  if (actions.onRename) {
    items.push({
      icon: <Pencil className="h-3.5 w-3.5" />,
      label: "Rename",
      onClick: actions.onRename,
    });
  }
  if (actions.onMove) {
    items.push({
      icon: <FolderIcon className="h-3.5 w-3.5" />,
      label: "Move to…",
      onClick: actions.onMove,
    });
  }
  if (actions.onTrash) {
    items.push({
      icon: <Trash2 className="h-3.5 w-3.5" />,
      label: "Trash",
      destructive: true,
      onClick: actions.onTrash,
    });
  }
  if (actions.onRestore) {
    items.push({
      icon: <RotateCcw className="h-3.5 w-3.5" />,
      label: "Restore",
      onClick: actions.onRestore,
    });
  }
  if (actions.onDeleteForever) {
    items.push({
      icon: <Trash2 className="h-3.5 w-3.5" />,
      label: "Delete forever",
      destructive: true,
      onClick: actions.onDeleteForever,
    });
  }
  return items;
}

/** Small shared "Nothing here yet" card used by Drive views. */
export function DriveEmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-dashed border-[var(--border)] bg-[var(--surface)] px-6 py-12 text-center">
      <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-[var(--bg)] text-[var(--text-muted)]">
        {icon}
      </div>
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-[var(--text-muted)]">{description}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
