import { createContext, memo, useContext, useRef, useState, type ReactNode } from "react";
import { Check, Download, Eye, MoreVertical, Star } from "lucide-react";

import type { FileItem, FolderItem, SystemFolderKind } from "@/api/files";
import type { ContextMenuItem } from "./ContextMenu";
import { DriveItemIcon, fileKindTint } from "./DriveItemIcon";
import { DriveThumb } from "./DriveThumb";
import { GranteesPill } from "./GranteesPill";
import {
  displayFileName,
  formatRelativeTime,
  humanSize,
  kindLabel,
  splitFileExt,
  withFileExt,
} from "./helpers";
import { cn } from "@/utils/cn";

/**
 * One row for every Drive list (WP-7.6, Part C §5.9): My files and Shared
 * (list and grid), Recent, Starred, Trash and search all draw this.
 *
 * There used to be four: FilesPage's FileRow / FolderRow and DriveRows'
 * DriveFileRow / DriveFolderRow, already drifting apart. Each FilesPage
 * row also carried four mutation hooks, its own AI-search query, its own
 * context menu, rename modal and trash confirmation — thousands of each in
 * a camera-roll folder — and fresh closures on every render, so ticking
 * one checkbox re-rendered the whole list.
 *
 * Now a row is memoised and holds only what's its own (drag-over, the
 * inline rename field). Everything it can *do* comes from one
 * {@link DriveListController} per page, provided through context: one set
 * of mutations, one context menu, one rename dialog, one confirmation.
 * Rows only re-render when their item, selection or editing state changes.
 */

// ---------------------------------------------------------------- items

export type DriveEntry =
  | { kind: "folder"; key: string; folder: FolderItem }
  | { kind: "file"; key: string; file: FileItem };

// One entry object per item object: React Query keeps unchanged items the
// same object across refetches, so a memoised row only re-renders when its
// own item changed.
const folderEntries = new WeakMap<FolderItem, DriveEntry>();
const fileEntries = new WeakMap<FileItem, DriveEntry>();
export function folderEntry(folder: FolderItem): DriveEntry {
  let e = folderEntries.get(folder);
  if (!e) folderEntries.set(folder, (e = { kind: "folder", key: `folder:${folder.id}`, folder }));
  return e;
}
export function fileEntry(file: FileItem): DriveEntry {
  let e = fileEntries.get(file);
  if (!e) fileEntries.set(file, (e = { kind: "file", key: `file:${file.id}`, file }));
  return e;
}
export const entryId = (e: DriveEntry) => (e.kind === "file" ? e.file.id : e.folder.id);
export const entryName = (e: DriveEntry) => (e.kind === "file" ? displayFileName(e.file) : e.folder.name);

// ---------------------------------------------------------------- drag & drop

export const DRAG_FILE = "application/x-promptly-file";
export const DRAG_FOLDER = "application/x-promptly-folder";
export const DRAG_SOURCE_PARENT = "application/x-promptly-source-parent";

export interface DragPayload {
  kind: "file" | "folder";
  id: string;
  sourceParent: string | null;
}

export interface DropOutcome {
  ok: boolean;
  error?: string;
}

export function readDragPayload(dt: DataTransfer): DragPayload | null {
  const fileId = dt.getData(DRAG_FILE);
  if (fileId) return { kind: "file", id: fileId, sourceParent: dt.getData(DRAG_SOURCE_PARENT) || null };
  const folderId = dt.getData(DRAG_FOLDER);
  if (folderId) return { kind: "folder", id: folderId, sourceParent: dt.getData(DRAG_SOURCE_PARENT) || null };
  return null;
}

export function dragHasItem(dt: DataTransfer): boolean {
  const types = Array.from(dt.types || []);
  return types.includes(DRAG_FILE) || types.includes(DRAG_FOLDER);
}

// ---------------------------------------------------------------- the controller

export interface DriveListController {
  layout: "list" | "grid";
  /** Folder being shown (its row, if listed, says "current"). */
  currentFolderId?: string | null;
  /** Open: a folder navigates, a file previews (or opens its editor). */
  open: (entry: DriveEntry) => void;
  /** The Drive click model: a mouse click selects (⌘/Ctrl adds, Shift
   *  extends), double-click opens; a tap opens. Absent → click opens. */
  select?: (entry: DriveEntry, e: React.MouseEvent) => void;
  /** Tick box / long-press. Absent → no selection on this page. */
  toggleSelect?: (entry: DriveEntry, shift: boolean) => void;
  /** Can this item be selected, dragged and changed here? */
  canChange: (entry: DriveEntry) => boolean;
  /** Narrower than ``canChange`` where only some items take part in bulk
   *  actions (a workspace drive's files, not its folders). */
  canSelect?: (entry: DriveEntry) => boolean;
  /** Everything the item's menu offers (disabled items greyed). */
  menu: (entry: DriveEntry) => ContextMenuItem[];
  /** Show ``menu(entry)`` at a point — one menu for the whole page. */
  showMenu: (entry: DriveEntry, x: number, y: number) => void;
  /** The sharing pill on an item you own. */
  share?: (entry: DriveEntry) => void;
  download?: (file: FileItem) => void;
  /** Grid quick action. */
  toggleStar?: (entry: DriveEntry) => void;
  /** Inline rename (list view): the new full name. */
  rename?: (entry: DriveEntry, name: string) => void;
  cancelRename?: () => void;
  /** Dropping a dragged item on a folder. */
  dropOnFolder?: (folderId: string, payload: DragPayload) => Promise<DropOutcome>;
  /** A second line under the name (where it was, a search snippet…). */
  extra?: (entry: DriveEntry) => ReactNode;
}

const DriveListContext = createContext<DriveListController | null>(null);
export const DriveListProvider = DriveListContext.Provider;

function useController(): DriveListController {
  const c = useContext(DriveListContext);
  if (!c) throw new Error("DriveItemRow needs a DriveListProvider");
  return c;
}

// ---------------------------------------------------------------- helpers

/** A row's main button under the Drive click model (Part C §2.2). */
/** After a click opens something, the rest of a double-click lands on
 *  whatever took the row's place (the next folder's rows, the preview's
 *  backdrop) — swallow it. */
function swallowDoubleClickTail() {
  const stop = (ev: MouseEvent) => {
    if (ev.detail > 1) {
      ev.stopPropagation();
      ev.preventDefault();
    }
  };
  const kinds = ["mousedown", "mouseup", "click", "dblclick"] as const;
  kinds.forEach((k) => window.addEventListener(k, stop, true));
  window.setTimeout(() => kinds.forEach((k) => window.removeEventListener(k, stop, true)), 600);
}

/** A click opens (a folder navigates); Ctrl/Cmd- or Shift-click selects,
 *  as do the checkboxes. */
function activate(e: React.MouseEvent, open: () => void, select?: (e: React.MouseEvent) => void) {
  if (e.detail > 1) return;
  if (select && (e.metaKey || e.ctrlKey || e.shiftKey)) {
    select(e);
    return;
  }
  open();
  swallowDoubleClickTail();
}

function itemButtonProps(key: string, open: () => void, select?: (e: React.MouseEvent) => void) {
  return {
    "data-drive-item": key,
    onClick: (e: React.MouseEvent) => activate(e, open, select),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        open();
      }
    },
  };
}

/** A click anywhere on a row acts like one on its name — except on its own
 *  controls (the name button handles its own clicks). */
function rowClick(open: () => void, select?: (e: React.MouseEvent) => void) {
  return (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, input, a, label, [role='menu'], [role='checkbox']")) return;
    activate(e, open, select);
  };
}

let pressTimer: number | null = null;
let swallowClick = false;

/** Long-press selects on a touch screen (a tap opens). */
export function longPressToSelect(onSelect: () => void) {
  const cancel = () => {
    if (pressTimer !== null) window.clearTimeout(pressTimer);
    pressTimer = null;
  };
  return {
    onTouchStart: () => {
      cancel();
      pressTimer = window.setTimeout(() => {
        pressTimer = null;
        swallowClick = true;
        navigator.vibrate?.(10);
        onSelect();
      }, 500);
    },
    onTouchMove: cancel,
    onTouchEnd: cancel,
    onTouchCancel: cancel,
    onContextMenuCapture: (e: React.MouseEvent) => {
      // Android fires contextmenu on a long press — the selection already
      // happened, don't also open the menu.
      if (swallowClick) e.preventDefault();
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (swallowClick) {
        swallowClick = false;
        e.stopPropagation();
        e.preventDefault();
      }
    },
  };
}

export function InlineRenameField({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const doneRef = useRef(false);
  const commit = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    const t = value.trim();
    if (t && t !== initial) onCommit(t);
    else onCancel();
  };
  return (
    <input
      // eslint-disable-next-line jsx-a11y/no-autofocus
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          doneRef.current = true;
          onCancel();
        }
      }}
      onBlur={commit}
      aria-label="New name"
      className="min-w-0 flex-1 rounded border border-[var(--accent)] bg-[var(--bg)] px-1.5 py-0.5 text-sm text-[var(--text)] outline-none"
    />
  );
}

function SelectCheckbox({
  checked,
  active,
  onToggle,
  className,
}: {
  checked: boolean;
  active: boolean;
  onToggle: (shift: boolean) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={checked ? "Deselect item" : "Select item"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(e.shiftKey);
      }}
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border transition",
        checked
          ? "border-[var(--accent)] bg-[var(--accent)] text-white"
          : "border-[var(--border)] bg-[var(--surface)] text-transparent hover:border-[var(--accent)]/60",
        !checked && !active && "opacity-0 group-hover:opacity-100 touch-reveal",
        className
      )}
    >
      <Check className="h-3.5 w-3.5" />
    </button>
  );
}

function QuickAction({ title, onClick, children }: { title: string; onClick: (e: React.MouseEvent) => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-white/15 text-white backdrop-blur-sm transition hover:bg-white/30"
    >
      {children}
    </button>
  );
}

function MenuButton({ onOpen, className }: { onOpen: (x: number, y: number) => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        onOpen(r.right - 176, r.bottom + 4);
      }}
      aria-label="More actions"
      title="More"
      className={cn(
        "rounded-md p-1.5 text-[var(--text-muted)] transition hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]",
        className
      )}
    >
      <MoreVertical className="h-4 w-4" />
    </button>
  );
}

function systemFolderTooltip(kind: SystemFolderKind): string | undefined {
  switch (kind) {
    case "chat_uploads":
      return "Files attached from chats land here automatically.";
    case "generated_root":
      return "Files generated by the assistant land in here.";
    case "generated_files":
      return "Generated documents (text, PDFs, code, etc.).";
    case "generated_media":
      return "Generated images, audio, and video.";
    case "camera_uploads":
      return "Phone backups and shared photos land here, in a folder for each year and month.";
    default:
      return undefined;
  }
}

const Badge = ({ children }: { children: ReactNode }) => (
  <span className="rounded bg-[var(--text-muted)]/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
    {children}
  </span>
);

const StarMark = ({ small }: { small?: boolean }) => (
  <Star className={cn("shrink-0 fill-yellow-400 text-yellow-400", small ? "h-3 w-3" : "h-3.5 w-3.5")} />
);

// ---------------------------------------------------------------- the row

export interface DriveItemRowProps {
  entry: DriveEntry;
  selected?: boolean;
  /** Anything selected on the page — checkboxes stay visible. */
  selectionActive?: boolean;
  /** Renaming in place (list view). */
  editing?: boolean;
  /** Placement in a virtualised list (list view): its index, its offset
   *  and the measuring ref. Primitive props, so memo still holds. */
  vIndex?: number;
  vTop?: number;
  vMeasure?: (el: Element | null) => void;
}

export const DriveItemRow = memo(function DriveItemRow({
  entry,
  selected = false,
  selectionActive = false,
  editing = false,
  vIndex,
  vTop,
  vMeasure,
}: DriveItemRowProps) {
  const c = useController();
  const [over, setOver] = useState(false);
  const grid = c.layout === "grid";
  const changeable = c.canChange(entry);
  const selectable = !!c.toggleSelect && changeable && (c.canSelect?.(entry) ?? true);
  const open = () => c.open(entry);
  const select = c.select && changeable ? (e: React.MouseEvent) => c.select!(entry, e) : undefined;
  const toggle = (shift: boolean) => c.toggleSelect?.(entry, shift);
  const menuItems = () => c.menu(entry);
  const hasMenu = changeable || entry.kind === "file" || !grid;
  const showMenu = (x: number, y: number) => c.showMenu(entry, x, y);

  const isFolder = entry.kind === "folder";
  const sharing = isFolder ? entry.folder.sharing : entry.file.sharing;
  const starred = isFolder ? !!entry.folder.starred_at : !!entry.file.starred_at;
  const systemKind = isFolder ? entry.folder.system_kind : null;
  const extra = c.extra?.(entry);

  // Drag to move; folders take drops.
  const draggable = changeable && !!c.dropOnFolder;
  const acceptsDrop = isFolder && !!c.dropOnFolder;
  const dragProps = {
    draggable,
    onDragStart: (e: React.DragEvent) => {
      if (!draggable) return;
      e.dataTransfer.effectAllowed = "move";
      if (entry.kind === "file") {
        e.dataTransfer.setData(DRAG_FILE, entry.file.id);
        e.dataTransfer.setData(DRAG_SOURCE_PARENT, entry.file.folder_id ?? "");
      } else {
        e.dataTransfer.setData(DRAG_FOLDER, entry.folder.id);
        e.dataTransfer.setData(DRAG_SOURCE_PARENT, entry.folder.parent_id ?? "");
      }
    },
    ...(acceptsDrop
      ? {
          onDragEnter: (e: React.DragEvent) => {
            if (dragHasItem(e.dataTransfer)) setOver(true);
          },
          onDragOver: (e: React.DragEvent) => {
            if (dragHasItem(e.dataTransfer)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }
          },
          onDragLeave: (e: React.DragEvent) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setOver(false);
          },
          onDrop: async (e: React.DragEvent) => {
            if (!dragHasItem(e.dataTransfer)) return;
            e.preventDefault();
            setOver(false);
            const payload = readDragPayload(e.dataTransfer);
            if (payload && entry.kind === "folder") await c.dropOnFolder!(entry.folder.id, payload);
          },
        }
      : {}),
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY);
    },
  };
  const rowHandlers = {
    ...dragProps,
    onClick: editing ? undefined : rowClick(open, select),
    ...(selectable ? longPressToSelect(() => toggle(false)) : {}),
  };

  const pill = sharing ? (
    <GranteesPill
      sharing={sharing}
      variant="compact"
      className={grid ? "hidden shrink-0 sm:inline-flex" : "hidden shrink-0 sm:inline-flex"}
      onClick={
        sharing.role === "owner" && c.share
          ? (e) => {
              e.stopPropagation();
              c.share!(entry);
            }
          : undefined
      }
    />
  ) : null;

  const nameNode = isFolder ? (
    entry.folder.name
  ) : (
    displayFileName(entry.file)
  );

  // ---------------------------------------------------------------- grid tile
  if (grid) {
    return (
      <li
        {...rowHandlers}
        className={cn(
          "group relative flex h-full flex-col rounded-card border bg-[var(--surface)] p-3 transition",
          "hover:border-[var(--accent)]/60 hover:shadow-sm",
          selected ? "border-[var(--accent)] ring-1 ring-inset ring-[var(--accent)]/40" : "border-[var(--border)]",
          draggable && "cursor-grab",
          over && "border-[var(--accent)]/60 bg-[var(--accent)]/10 ring-1 ring-inset ring-[var(--accent)]/40"
        )}
      >
        {selectable && (
          <SelectCheckbox checked={selected} active={selectionActive} onToggle={toggle} className="absolute left-1.5 top-1.5 z-[1]" />
        )}
        {changeable && (
          <div className="absolute right-1 top-1 z-[1] opacity-0 transition group-hover:opacity-100 touch-reveal">
            <MenuButton onOpen={showMenu} />
          </div>
        )}
        <button
          {...itemButtonProps(entry.key, open, select)}
          className="flex w-full flex-1 flex-col gap-2 text-left"
          title={systemKind ? systemFolderTooltip(systemKind) : entry.kind === "file" ? displayFileName(entry.file) : undefined}
        >
          {entry.kind === "folder" ? (
            <div className="flex aspect-square w-full items-center justify-center rounded-md bg-[var(--accent-soft)]">
              <DriveItemIcon folder={entry.folder} className="h-12 w-12" />
            </div>
          ) : (
            <div className="relative w-full">
              <DriveThumb
                file={entry.file}
                className={cn("aspect-square w-full rounded-md border border-[var(--border)]", fileKindTint(entry.file).tile)}
              />
              <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 rounded-b-md bg-gradient-to-t from-black/55 to-transparent p-1.5 opacity-0 transition group-hover:opacity-100 touch-reveal">
                <QuickAction
                  title="Preview"
                  onClick={(e) => {
                    e.stopPropagation();
                    open();
                  }}
                >
                  <Eye className="h-3.5 w-3.5" />
                </QuickAction>
                {c.download && (
                  <QuickAction
                    title="Download"
                    onClick={(e) => {
                      e.stopPropagation();
                      c.download!(entry.file);
                    }}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </QuickAction>
                )}
                {changeable && c.toggleStar && (
                  <QuickAction
                    title={starred ? "Unstar" : "Star"}
                    onClick={(e) => {
                      e.stopPropagation();
                      c.toggleStar!(entry);
                    }}
                  >
                    <Star className={cn("h-3.5 w-3.5", starred && "fill-yellow-400 text-yellow-400")} />
                  </QuickAction>
                )}
              </div>
            </div>
          )}
          <span className="line-clamp-2 w-full break-words text-sm font-medium">{nameNode}</span>
          {entry.kind === "file" && (
            <span className="flex w-full items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
              <span className={cn("shrink-0 rounded px-1.5 py-0.5 font-medium", fileKindTint(entry.file).tile, fileKindTint(entry.file).text)}>
                {kindLabel(entry.file)}
              </span>
              <span className="truncate">
                {humanSize(entry.file.size_bytes)}
                {(entry.file.updated_at ?? entry.file.created_at) &&
                  ` · ${formatRelativeTime(entry.file.updated_at ?? entry.file.created_at)}`}
              </span>
            </span>
          )}
          {extra && (
            <span className="flex w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-[var(--text-muted)]">{extra}</span>
          )}
        </button>
        <div className="mt-1.5 flex min-h-[18px] items-center justify-center gap-1">
          {starred && <StarMark />}
          {systemKind && <Badge>system</Badge>}
          {isFolder && c.currentFolderId && c.currentFolderId === entry.folder.id && <Badge>current</Badge>}
          {pill}
        </div>
      </li>
    );
  }

  // ---------------------------------------------------------------- list row
  const icon = entry.kind === "file" ? <DriveItemIcon file={entry.file} tile /> : <DriveItemIcon folder={entry.folder} tile />;
  return (
    <li
      {...rowHandlers}
      ref={vMeasure}
      data-index={vIndex}
      style={vTop === undefined ? undefined : { position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vTop}px)` }}
      className={cn(
        "group flex items-center gap-3 px-3 py-2 transition",
        selected ? "bg-[var(--accent)]/10" : "hover:bg-[var(--hover)]",
        draggable && "cursor-grab",
        over && "bg-[var(--accent)]/10 ring-1 ring-inset ring-[var(--accent)]/40"
      )}
    >
      {selectable ? (
        <SelectCheckbox checked={selected} active={selectionActive} onToggle={toggle} />
      ) : c.toggleSelect ? (
        <span className="w-5 shrink-0" aria-hidden />
      ) : null}
      {/* The name cell takes the slack (sharing pill included), so Kind /
          Modified / Size line up on every row. */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
      {editing && c.rename ? (
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {icon}
          <InlineRenameField
            initial={entry.kind === "file" ? splitFileExt(entry.file.filename).base : entry.folder.name}
            onCommit={(v) => c.rename!(entry, entry.kind === "file" ? withFileExt(v, entry.file.filename) : v)}
            onCancel={() => c.cancelRename?.()}
          />
        </div>
      ) : (
        <button
          {...itemButtonProps(entry.key, open, select)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          title={systemKind ? systemFolderTooltip(systemKind) : undefined}
        >
          {icon}
          <span className="flex min-w-0 flex-col">
            <span className={cn("flex min-w-0 items-center gap-1.5 text-sm", isFolder && "font-medium")}>
              <span className="truncate">{nameNode}</span>
              {starred && <StarMark small={!isFolder} />}
              {systemKind && <Badge>system</Badge>}
              {isFolder && c.currentFolderId && c.currentFolderId === entry.folder.id && <Badge>current</Badge>}
            </span>
            {extra && <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--text-muted)]">{extra}</span>}
          </span>
        </button>
      )}
      {pill}
      </div>

      <span className="hidden w-24 shrink-0 truncate text-xs text-[var(--text-muted)] lg:block">
        {entry.kind === "file" ? kindLabel(entry.file) : "Folder"}
      </span>
      <span className="hidden w-28 shrink-0 text-xs text-[var(--text-muted)] lg:block">
        {isFolder
          ? entry.folder.updated_at
            ? formatRelativeTime(entry.folder.updated_at)
            : ""
          : entry.file.updated_at
            ? formatRelativeTime(entry.file.updated_at)
            : ""}
      </span>
      <span className="hidden w-16 shrink-0 text-right text-xs tabular-nums text-[var(--text-muted)] sm:block">
        {entry.kind === "file" ? humanSize(entry.file.size_bytes) : ""}
      </span>

      {/* Fixed-width action slot so the columns line up with the header. */}
      <div className="flex w-16 shrink-0 items-center justify-end gap-1">
        {entry.kind === "file" && c.download && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              c.download!(entry.file);
            }}
            title="Download"
            aria-label={`Download ${entry.file.filename}`}
            className="rounded-md p-1.5 text-[var(--text-muted)] opacity-0 transition hover:bg-[var(--hover)] hover:text-[var(--text)] group-hover:opacity-100 touch-reveal"
          >
            <Download className="h-4 w-4" />
          </button>
        )}
        {hasMenu && menuItems().some((it) => !it.disabled) && (
          <MenuButton onOpen={showMenu} className="opacity-100 md:opacity-0 md:group-hover:opacity-100" />
        )}
      </div>
    </li>
  );
});

/** Column header for list views. ``children`` replaces the plain labels
 *  (the browse page's sortable headers). */
export function DriveListHeader({ children, selectable = true }: { children?: ReactNode; selectable?: boolean }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-3 rounded-t-card border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
      {selectable && <span className="w-5 shrink-0" aria-hidden />}
      {children ?? (
        <>
          <span className="flex-1">Name</span>
          <span className="hidden w-24 shrink-0 lg:block">Kind</span>
          <span className="hidden w-28 shrink-0 lg:block">Modified</span>
          <span className="hidden w-16 shrink-0 text-right sm:block">Size</span>
        </>
      )}
      <span className="w-16 shrink-0" aria-hidden />
    </div>
  );
}
