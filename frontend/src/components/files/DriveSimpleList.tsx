import { useMemo, useRef, useState, type ReactNode } from "react";
import { Download, Eye, Folder as FolderIcon, FolderOpen, Pencil, RotateCcw, Share2, Star, Trash2 } from "lucide-react";

import type { FileItem, FolderItem } from "@/api/files";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { DriveItemList } from "./DriveItemList";
import {
  DriveListHeader,
  DriveListProvider,
  fileEntry,
  folderEntry,
  type DriveEntry,
  type DriveListController,
} from "./DriveItemRow";

/**
 * Recent, Starred, Trash and search results (WP-7.6): the same row and the
 * same virtualised list as My files, for pages whose rows have a fixed
 * set of actions. Each page says what an item can do ({@link RowActions});
 * this turns that into the list's controller, with one context menu.
 */

/** What a row offers. Absent → not offered. */
export interface RowActions {
  onPreview?: () => void;
  onDownload?: () => void;
  onShare?: () => void;
  onStar?: () => void;
  onUnstar?: () => void;
  onRename?: () => void;
  onMove?: () => void;
  /** Open the folder the file is in (search results, WP-5.4). */
  onShowInFolder?: () => void;
  onTrash?: () => void;
  onRestore?: () => void;
  onDeleteForever?: () => void;
}

export interface DriveSelection {
  count: number;
  isFileSelected: (id: string) => boolean;
  isFolderSelected: (id: string) => boolean;
  toggleFile: (id: string) => void;
  toggleFolder: (id: string) => void;
}

export function DriveSimpleList({
  folders = [],
  files,
  actions,
  open,
  selection,
  extra,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  folders?: FolderItem[];
  files: FileItem[];
  actions: (entry: DriveEntry) => RowActions;
  /** Clicking an item (a folder navigates, a file previews…). */
  open: (entry: DriveEntry) => void;
  selection?: DriveSelection;
  extra?: (entry: DriveEntry) => ReactNode;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}) {
  const [menu, setMenu] = useState<{ entry: DriveEntry; x: number; y: number } | null>(null);
  const latest = useRef({ actions, open, selection, extra });
  latest.current = { actions, open, selection, extra };

  const controller = useMemo<DriveListController>(
    () => ({
      layout: "list",
      open: (entry) => latest.current.open(entry),
      toggleSelect: (entry) => {
        const s = latest.current.selection;
        if (!s) return;
        if (entry.kind === "file") s.toggleFile(entry.file.id);
        else s.toggleFolder(entry.folder.id);
      },
      canChange: () => !!latest.current.selection,
      menu: (entry) =>
        entry.kind === "file"
          ? fileMenu(entry.file, latest.current.actions(entry))
          : folderMenu(entry.folder, latest.current.actions(entry), () => latest.current.open(entry)),
      showMenu: (entry, x, y) => setMenu({ entry, x, y }),
      download: (file) => latest.current.actions(fileEntry(file)).onDownload?.(),
      extra: (entry) => latest.current.extra?.(entry),
    }),
    []
  );

  const items = useMemo(() => [...folders.map(folderEntry), ...files.map(fileEntry)], [folders, files]);

  return (
    <DriveListProvider value={controller}>
      <DriveItemList
        items={items}
        layout="list"
        isSelected={(e) =>
          !!selection && (e.kind === "file" ? selection.isFileSelected(e.file.id) : selection.isFolderSelected(e.folder.id))
        }
        selectionActive={(selection?.count ?? 0) > 0}
        header={<DriveListHeader selectable={!!selection} />}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={onLoadMore}
      />
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menu ? controller.menu(menu.entry) : []}
        onClose={() => setMenu(null)}
      />
    </DriveListProvider>
  );
}

const ic = "h-3.5 w-3.5";

function fileMenu(file: FileItem, a: RowActions): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (a.onPreview) items.push({ icon: <Eye className={ic} />, label: "Preview", onClick: a.onPreview });
  if (a.onDownload) items.push({ icon: <Download className={ic} />, label: "Download", onClick: a.onDownload });
  if (a.onShowInFolder) items.push({ icon: <FolderOpen className={ic} />, label: "Show in folder", onClick: a.onShowInFolder });
  if (a.onStar && !file.starred_at) items.push({ icon: <Star className={ic} />, label: "Star", onClick: a.onStar });
  if (a.onUnstar && file.starred_at) items.push({ icon: <Star className={ic} />, label: "Unstar", onClick: a.onUnstar });
  return [...items, ...tail(a)];
}

function folderMenu(folder: FolderItem, a: RowActions, onOpen: () => void): ContextMenuItem[] {
  const items: ContextMenuItem[] = [{ icon: <FolderIcon className={ic} />, label: "Open", onClick: onOpen }];
  if (a.onStar && !folder.starred_at) items.push({ icon: <Star className={ic} />, label: "Star", onClick: a.onStar });
  if (a.onUnstar && folder.starred_at) items.push({ icon: <Star className={ic} />, label: "Unstar", onClick: a.onUnstar });
  return [...items, ...tail(a)];
}

function tail(a: RowActions): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (a.onShare) items.push({ icon: <Share2 className={ic} />, label: "Share", onClick: a.onShare });
  if (a.onRename) items.push({ icon: <Pencil className={ic} />, label: "Rename", onClick: a.onRename });
  if (a.onMove) items.push({ icon: <FolderIcon className={ic} />, label: "Move to…", onClick: a.onMove });
  if (a.onTrash) items.push({ icon: <Trash2 className={ic} />, label: "Trash", destructive: true, onClick: a.onTrash });
  if (a.onRestore) items.push({ icon: <RotateCcw className={ic} />, label: "Restore", onClick: a.onRestore });
  if (a.onDeleteForever)
    items.push({ icon: <Trash2 className={ic} />, label: "Delete forever", destructive: true, onClick: a.onDeleteForever });
  return items;
}

/** "Nothing here yet" — the shared empty state. */
export { EmptyState as DriveEmptyState } from "@/components/shared/EmptyState";
