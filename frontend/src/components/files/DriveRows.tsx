import { useState } from "react";
import {
  Check,
  Download,
  Eye,
  Folder as FolderIcon,
  MoreVertical,
  Pencil,
  RotateCcw,
  Share2,
  Star,
  Trash2,
} from "lucide-react";

import type { FileItem, FolderItem } from "@/api/files";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { DriveItemIcon } from "./DriveItemIcon";
import { GranteesPill } from "./GranteesPill";
import { cn } from "@/utils/cn";

import {
  downloadAuthed,
  formatRelativeTime,
  humanSize,
  kindLabel,
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

interface SelectionProps {
  /** When provided, the row shows a multi-select checkbox. */
  selected?: boolean;
  selectionActive?: boolean;
  onToggleSelect?: () => void;
}

interface DriveFileRowProps extends SelectionProps {
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
  selected,
  selectionActive,
  onToggleSelect,
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
      className={cn(
        "group flex items-center gap-3 px-3 py-2 transition",
        selected ? "bg-[var(--accent)]/10" : "hover:bg-[var(--hover)]"
      )}
    >
      {onToggleSelect && (
        <DriveRowCheckbox
          checked={!!selected}
          active={!!selectionActive}
          onToggle={onToggleSelect}
        />
      )}
      <button
        onClick={click}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <DriveItemIcon file={file} />
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5 truncate text-sm">
            <span className="truncate">{file.filename}</span>
            {file.starred_at && (
              <Star className="h-3 w-3 shrink-0 fill-yellow-400 text-yellow-400" />
            )}
          </span>
          {(file.sharing || extra) && (
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--text-muted)]">
              {file.sharing && (
                <GranteesPill sharing={file.sharing} variant="compact" />
              )}
              {extra}
            </span>
          )}
        </span>
      </button>

      {/* Tabular columns — desktop only, matching the browse view. */}
      <span className="hidden w-24 shrink-0 truncate text-xs text-[var(--text-muted)] lg:block">
        {kindLabel(file)}
      </span>
      <span className="hidden w-28 shrink-0 text-xs text-[var(--text-muted)] lg:block">
        {file.updated_at ? formatRelativeTime(file.updated_at) : ""}
      </span>
      <span className="hidden w-16 shrink-0 text-right text-xs tabular-nums text-[var(--text-muted)] sm:block">
        {humanSize(file.size_bytes)}
      </span>

      {/* Desktop quick-action icons — hover-only so they stay out of
          the visual noise on a dense row. Hidden on mobile because
          there's no hover state to reveal them. */}
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

interface DriveFolderRowProps extends SelectionProps {
  folder: FolderItem;
  actions: RowActions;
  onOpen: () => void;
}

export function DriveFolderRow({
  folder,
  actions,
  onOpen,
  selected,
  selectionActive,
  onToggleSelect,
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
      className={cn(
        "group flex items-center gap-3 px-3 py-2 transition",
        selected ? "bg-[var(--accent)]/10" : "hover:bg-[var(--hover)]"
      )}
    >
      {onToggleSelect && (
        <DriveRowCheckbox
          checked={!!selected}
          active={!!selectionActive}
          onToggle={onToggleSelect}
        />
      )}
      <button
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <DriveItemIcon folder={folder} />
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5 truncate text-sm font-medium">
            <span className="truncate">{folder.name}</span>
            {folder.starred_at && (
              <Star className="h-3 w-3 shrink-0 fill-yellow-400 text-yellow-400" />
            )}
          </span>
          {folder.sharing && (
            <span className="mt-0.5">
              <GranteesPill sharing={folder.sharing} variant="compact" />
            </span>
          )}
        </span>
      </button>

      {/* Kind / Modified columns line up with file rows; folders have
          no size so that column stays blank. */}
      <span className="hidden w-24 shrink-0 truncate text-xs text-[var(--text-muted)] lg:block">
        Folder
      </span>
      <span className="hidden w-28 shrink-0 text-xs text-[var(--text-muted)] lg:block">
        {folder.updated_at ? formatRelativeTime(folder.updated_at) : ""}
      </span>
      <span className="hidden w-16 shrink-0 sm:block" aria-hidden />

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

/** Multi-select checkbox for a Drive row. Hidden until hover / selection
 *  mode (so the quiet list still reads as a plain table) and always shown
 *  once checked. */
function DriveRowCheckbox({
  checked,
  active,
  onToggle,
}: {
  checked: boolean;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={checked ? "Deselect item" : "Select item"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border transition",
        checked
          ? "border-[var(--accent)] bg-[var(--accent)] text-white"
          : "border-[var(--border)] bg-[var(--surface)] text-transparent hover:border-[var(--accent)]/60",
        !checked && !active && "opacity-0 group-hover:opacity-100"
      )}
    >
      <Check className="h-3.5 w-3.5" />
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
                    : "hover:bg-[var(--hover)]",
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

/** Static column header (Name / Modified / Size) for the secondary Drive
 *  list views, matching the browse page's tabular look. These views have
 *  a fixed sort order, so the header is non-interactive. */
export function DriveColumnsHeader() {
  return (
    <div className="flex items-center gap-3 border-b border-[var(--border)] px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
      <span className="flex-1">Name</span>
      <span className="hidden w-24 shrink-0 lg:block">Kind</span>
      <span className="hidden w-28 shrink-0 lg:block">Modified</span>
      <span className="hidden w-16 shrink-0 text-right sm:block">Size</span>
      <span className="w-8 shrink-0" aria-hidden />
    </div>
  );
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
