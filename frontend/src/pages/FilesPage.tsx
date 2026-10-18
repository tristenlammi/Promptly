import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  ChevronRight,
  Download,
  Eye,
  Folder as FolderClosedIcon,
  FolderInput,
  FolderPlus,
  Home,
  Images,
  LayoutGrid,
  Pencil,
  Share2,
  Star,
  Trash2,
  Upload,
  Sparkles,
} from "lucide-react";

import {
  filesApi,
  type DriveSort,
  type DriveSortKey,
  type FileItem,
  type FileScope,
  type FolderItem,
  type SharedView,
  supportsEditGrant,
  shareRolesFor,
  type ShareLinkRole,
} from "@/api/files";
import { ContextMenu, type ContextMenuItem } from "@/components/files/ContextMenu";
import { DriveDetailsPanel } from "@/components/files/DriveDetailsPanel";
import { useFilesShellStore } from "@/store/filesShellStore";
import { DriveSubNav } from "@/components/files/DriveSubNav";
import { FilePreviewModal } from "@/components/files/FilePreviewModal";
import { FilesTopNavSearch } from "@/components/files/FilesTopNavSearch";
import { MoveItemModal } from "@/components/files/MoveItemModal";
import { ShareGrantsModal } from "@/components/files/ShareGrantsModal";
import { NewFolderModal, NewMenu } from "@/components/files/NewMenu";
import { askAboutFiles } from "@/components/files/askAbout";
import { useDriveAi } from "@/components/files/DriveAiDialog";
import { isSpreadsheetFile, openSpreadsheetAsSheet } from "@/lib/office/sheetActions";
import { isWordFile, openWordAsDocument } from "@/lib/office/wordActions";
import {
  displayFileName,
  downloadAuthed,
  extractError,
  humanSize,
  splitFileExt,
  withFileExt,
  openFile as openInEditor,
} from "@/components/files/helpers";
import { DriveSelectionBar } from "@/components/files/DriveSelectionBar";
import { ViewToggle } from "@/components/files/ViewToggle";
import { treeFromDrop, uploadTree } from "@/lib/folderUpload";
import { VersionHistoryPanel } from "@/components/files/VersionHistoryPanel";
import { DriveItemList, type DriveItemListHandle, type DriveListItem } from "@/components/files/DriveItemList";
import {
  DriveListHeader,
  DriveListProvider,
  dragHasItem,
  entryId,
  fileEntry,
  folderEntry,
  readDragPayload,
  type DragPayload,
  type DriveEntry,
  type DriveListController,
  type DropOutcome,
} from "@/components/files/DriveItemRow";
import { TopNav } from "@/components/layout/TopNav";
import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import { Modal } from "@/components/shared/Modal";
import { Skeleton } from "@/components/shared/Skeleton";
import {
  useBrowsePaged,
  useBulkMove,
  useBulkStar,
  useBulkTrash,
  useCreateFolder,
  useMoveFile,
  useMoveFolder,
  useRenameFile,
  useRenameFolder,
  useStarFile,
  useStorageQuota,
  useStarFolder,
  useTrashFile,
  useTrashFolder,
  useUnstarFile,
  useUnstarFolder,
  invalidateFileQueries,
  undoToast,
} from "@/hooks/useFiles";
import { usePopoverDismiss } from "@/hooks/usePopoverDismiss";
import { useUploadStore } from "@/store/uploadStore";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

type ViewMode = "list" | "grid";
const VIEW_MODE_KEY = "promptly.filesViewMode";
const SORT_KEY = "promptly.filesSort";
const GRID_TILE_KEY = "promptly.filesGridTile";

// Grid tile size (px min-width) bounds for the resize slider.
const GRID_TILE_MIN = 96;
const GRID_TILE_MAX = 200;
const GRID_TILE_DEFAULT = 132;

function readStoredViewMode(): ViewMode {
  if (typeof window === "undefined") return "list";
  try {
    return window.localStorage.getItem(VIEW_MODE_KEY) === "grid"
      ? "grid"
      : "list";
  } catch {
    return "list";
  }
}

function readStoredSort(): DriveSort {
  if (typeof window === "undefined") return { key: "name", dir: "asc" };
  try {
    const raw = window.localStorage.getItem(SORT_KEY);
    if (raw) {
      const p = JSON.parse(raw) as DriveSort;
      if (
        (p.key === "name" || p.key === "modified" || p.key === "size") &&
        (p.dir === "asc" || p.dir === "desc")
      )
        return p;
    }
  } catch {
    /* ignore */
  }
  return { key: "name", dir: "asc" };
}

function readStoredGridTile(): number {
  if (typeof window === "undefined") return GRID_TILE_DEFAULT;
  try {
    const n = Number(window.localStorage.getItem(GRID_TILE_KEY));
    if (Number.isFinite(n) && n >= GRID_TILE_MIN && n <= GRID_TILE_MAX)
      return n;
  } catch {
    /* ignore */
  }
  return GRID_TILE_DEFAULT;
}

interface MoveModalState {
  open: boolean;
  kind: "file" | "folder";
  id: string;
  name: string;
  currentParentId: string | null;
}

interface FilesPageProps {
  /** Lock the page to a specific scope. The ``/files/shared`` route
   *  passes ``"shared"`` here; the default ``/files`` route omits it
   *  and falls back to ``"mine"``. The runtime scope toggle was
   *  retired with Drive stage 5 — switching now happens via the top
   *  sub-nav, so ``forcedScope`` effectively pins every render. */
  forcedScope?: FileScope;
  /** Display title / subtitle overrides. */
  title?: string;
  subtitle?: string;
}

export function FilesPage({
  forcedScope,
  title = "Files",
  subtitle = "Upload and organise files you can attach to any chat.",
}: FilesPageProps = {}) {
  const navigate = useNavigate();
  const routeParams = useParams<{ folderId?: string }>();
  const routeFolderId = routeParams.folderId ?? null;
  const [searchParams, setSearchParams] = useSearchParams();
  // A folder reached from Shared keeps its scope in the URL
  // (``/files/folder/:id?scope=shared``) — it used to land in My files
  // and fail (R-023, defect 13).
  const urlScope: FileScope | undefined = searchParams.get("scope") === "shared" ? "shared" : undefined;
  const sharedView: SharedView = searchParams.get("view") === "by_me" ? "by_me" : "with_me";

  // Files shared into the installed Files app ("Share → Promptly Files")
  // wait in the worker's stash; upload them to My files (R-211).
  useSharedFilesPickup();

  const effectiveForced = forcedScope ?? urlScope;
  const [scope, setScope] = useState<FileScope>(effectiveForced ?? "mine");
  const [folderId, setFolderId] = useState<string | null>(routeFolderId);

  // Sync scope + folderId whenever the caller's ``forcedScope`` prop
  // or the URL route param changes. Without this, clicking a sidebar
  // link after navigating into a subfolder wouldn't reset the view.
  useEffect(() => {
    const want = effectiveForced ?? "mine";
    if (scope !== want) setScope(want);
  }, [effectiveForced, scope]);
  useEffect(() => {
    setFolderId(routeFolderId);
  }, [routeFolderId]);

  // Sort + grid tile size — persisted view preferences (like viewMode).
  const [sort, setSort] = useState<DriveSort>(() => readStoredSort());
  useEffect(() => {
    try {
      window.localStorage.setItem(SORT_KEY, JSON.stringify(sort));
    } catch {
      /* non-fatal */
    }
  }, [sort]);
  const [gridTile, setGridTile] = useState<number>(() => readStoredGridTile());
  useEffect(() => {
    try {
      window.localStorage.setItem(GRID_TILE_KEY, String(gridTile));
    } catch {
      /* non-fatal */
    }
  }, [gridTile]);

  const qc = useQueryClient();
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useBrowsePaged(scope, folderId, sort, scope === "shared" && !folderId ? sharedView : undefined);
  const listRef = useRef<DriveItemListHandle>(null);
  const loadMore = useCallback(() => void fetchNextPage(), [fetchNextPage]);

  const crumbs = data?.breadcrumbs ?? [];
  const writable = data?.writable ?? false;

  // Surface storage pressure: a warning chip once the user is ≥80% of a
  // capped quota, so they notice before an upload is refused.
  const { data: quota } = useStorageQuota();
  const quotaPct =
    quota?.cap_bytes && quota.cap_bytes > 0
      ? quota.used_bytes / quota.cap_bytes
      : 0;

  const moveFile = useMoveFile();
  const moveFolder = useMoveFolder();
  const [moveModal, setMoveModal] = useState<MoveModalState | null>(null);

  // Drive stage 1 — preview / share / star state.
  const [preview, setPreview] = useState<FileItem | null>(null);
  // A file's earlier versions (WP-8.1), over the page.
  const [historyFor, setHistoryFor] = useState<FileItem | null>(null);
  // List vs. grid layout for the browse view. Persisted so the
  // choice sticks across navigations and reloads.
  const [viewMode, setViewMode] = useState<ViewMode>(() => readStoredViewMode());
  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_MODE_KEY, viewMode);
    } catch {
      /* storage unavailable (private mode) — non-fatal */
    }
  }, [viewMode]);
  // A folder change reloads the rail's folder tree too (WP-3.5).
  const bumpTree = useFilesShellStore((s) => s.bumpTree);
  const refreshAll = useCallback(() => {
    void refetch();
    bumpTree();
  }, [refetch, bumpTree]);

  // Right-click-empty-space menu (New folder / Upload) — the drive-native
  // way to act on the current folder without aiming at a row.
  const [emptyMenu, setEmptyMenu] = useState<{ x: number; y: number } | null>(
    null
  );
  const [showNewFolderPage, setShowNewFolderPage] = useState(false);
  const createFolderPage = useCreateFolder();
  const pageFileInputRef = useRef<HTMLInputElement | null>(null);
  // Drive stage 5: the single "Share" row action opens the
  // peer-to-peer grants modal. Public link sharing has been retired
  // from the UI.
  const [shareGrantsFor, setShareGrantsFor] = useState<
    {
      kind: "file" | "folder";
      id: string;
      name: string;
      /** Stage 5.1 — only Drive Documents accept ``can_edit`` grants;
       *  everything else hides the Editor option in the role picker. */
      supportsEdit?: boolean;
      /** WP-6.6 — roles a link / person can have (``shareRolesFor``). */
      roles?: ShareLinkRole[];
    } | null
  >(null);

  // Multi-select for bulk actions. Kept as separate file / folder id sets
  // so a bulk delete routes each id to the right trash mutation. Cleared
  // whenever the view changes (navigating folders or switching scope) so a
  // stale selection can't leak across folders.
  const [selFiles, setSelFiles] = useState<Set<string>>(new Set());
  const [selFolders, setSelFolders] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const bulkTrash = useBulkTrash();
  const bulkStar = useBulkStar();
  const bulkMove = useBulkMove();
  const selectionCount = selFiles.size + selFolders.size;
  const bulkIds = () => ({
    file_ids: [...selFiles],
    folder_ids: [...selFolders],
  });

  // The single selected item (file or folder), or null when zero / many
  // are selected. Drives the right-hand details pane.
  const detailFile =
    selectionCount === 1 && selFiles.size === 1
      ? data?.files.find((f) => selFiles.has(f.id)) ?? null
      : null;
  const detailFolder =
    selectionCount === 1 && selFolders.size === 1
      ? data?.folders.find((f) => selFolders.has(f.id)) ?? null
      : null;
  const hasDetail = !!detailFile || !!detailFolder;

  // Anchor for shift-click range selection — the last item toggled
  // without shift. A ref so the toggle callbacks stay stable.
  const selAnchorRef = useRef<{ kind: "file" | "folder"; id: string } | null>(
    null
  );

  useEffect(() => {
    setSelFiles(new Set());
    setSelFolders(new Set());
    selAnchorRef.current = null;
  }, [folderId, scope]);

  // Keyboard order: folders then files, as displayed (WP-3.5).
  const keyItemsRef = useRef<{ kind: "file" | "folder"; id: string; name: string }[]>([]);
  keyItemsRef.current = [
    ...(data?.folders ?? []).filter((f) => !f.system_kind).map((f) => ({ kind: "folder" as const, id: f.id, name: f.name })),
    ...(data?.files ?? []).map((f) => ({ kind: "file" as const, id: f.id, name: displayFileName(f) })),
  ];
  const typeAheadRef = useRef({ buffer: "", at: 0 });

  // The user-selectable items in display order (system folders aren't
  // selectable). Drives shift-click range math.
  const orderedSelectable = useMemo(
    () => [
      ...(data?.folders ?? [])
        .filter((f) => !f.system_kind)
        .map((f) => ({ kind: "folder" as const, id: f.id })),
      ...(data?.files ?? []).map((f) => ({ kind: "file" as const, id: f.id })),
    ],
    [data]
  );

  // Add every item between the anchor and ``to`` (inclusive) to the
  // selection. Falls back to a plain toggle when there's no valid anchor.
  const selectRangeTo = useCallback(
    (to: { kind: "file" | "folder"; id: string }) => {
      const anchor = selAnchorRef.current;
      const list = orderedSelectable;
      const ai = anchor
        ? list.findIndex((x) => x.kind === anchor.kind && x.id === anchor.id)
        : -1;
      const bi = list.findIndex((x) => x.kind === to.kind && x.id === to.id);
      if (ai < 0 || bi < 0) return false;
      const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai];
      const range = list.slice(lo, hi + 1);
      setSelFiles((prev) => {
        const next = new Set(prev);
        range.forEach((x) => x.kind === "file" && next.add(x.id));
        return next;
      });
      setSelFolders((prev) => {
        const next = new Set(prev);
        range.forEach((x) => x.kind === "folder" && next.add(x.id));
        return next;
      });
      return true;
    },
    [orderedSelectable]
  );

  const toggleFile = useCallback(
    (id: string, shift = false) => {
      if (shift && selectRangeTo({ kind: "file", id })) return;
      selAnchorRef.current = { kind: "file", id };
      setSelFiles((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [selectRangeTo]
  );
  const toggleFolder = useCallback(
    (id: string, shift = false) => {
      if (shift && selectRangeTo({ kind: "folder", id })) return;
      selAnchorRef.current = { kind: "folder", id };
      setSelFolders((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [selectRangeTo]
  );
  const clearSelection = useCallback(() => {
    setSelFiles(new Set());
    setSelFolders(new Set());
  }, []);

  // Drive click model (WP-3.5): a plain click selects just this item and
  // fills the details pane; ⌘/Ctrl-click adds, Shift-click extends.
  const selectOnly = useCallback((kind: "file" | "folder", id: string) => {
    selAnchorRef.current = { kind, id };
    setSelFiles(new Set(kind === "file" ? [id] : []));
    setSelFolders(new Set(kind === "folder" ? [id] : []));
  }, []);
  const handleSelectItem = useCallback(
    (kind: "file" | "folder", id: string, e: React.MouseEvent) => {
      if (e.shiftKey) {
        if (kind === "file") toggleFile(id, true);
        else toggleFolder(id, true);
      } else if (e.metaKey || e.ctrlKey) {
        if (kind === "file") toggleFile(id);
        else toggleFolder(id);
      } else {
        selectOnly(kind, id);
      }
    },
    [toggleFile, toggleFolder, selectOnly]
  );
  // Something just made here (a new folder, a lone upload): scroll it into
  // view and focus it once it's listed (WP-7.6 — the list is virtualised,
  // so it may land far below what's on screen).
  const revealKey = useFilesShellStore((s) => s.revealKey);
  useEffect(() => {
    if (!revealKey || !data) return;
    const [kind, id] = revealKey.split(":") as ["file" | "folder", string];
    const listed = kind === "folder" ? data.folders.some((f) => f.id === id) : data.files.some((f) => f.id === id);
    if (!listed) return; // wait for the refetch
    useFilesShellStore.getState().reveal(null);
    requestAnimationFrame(() => listRef.current?.reveal(revealKey));
  }, [revealKey, data]);

  // F2 → rename the single selected item in place.
  const [renameKey, setRenameKey] = useState<string | null>(null);

  // "Ask about this / these": a chat with the selected files — a folder
  // contributes the files directly inside it.
  const handleAsk = useCallback(async () => {
    const files = (data?.files ?? []).filter((f) => selFiles.has(f.id));
    for (const folderId of selFolders) {
      try {
        const inside = await filesApi.browse(scope, folderId);
        files.push(...inside.files);
      } catch {
        /* a folder we can't list just adds nothing */
      }
    }
    if (files.length === 0) {
      toast.info("There are no files to ask about in that selection.");
      return;
    }
    askAboutFiles(files, navigate);
  }, [data, selFiles, selFolders, scope, navigate]);

  const handleBulkTrash = useCallback(async () => {
    const count = selFiles.size + selFolders.size;
    if (count === 0) return;
    const ok = await confirm({
      title: "Move to trash?",
      message: `${count} item${count === 1 ? "" : "s"} will be moved to the trash. You can restore ${count === 1 ? "it" : "them"} from the Trash view.`,
      confirmLabel: "Move to trash",
      danger: true,
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      const ids = bulkIds();
      const res = await bulkTrash.mutateAsync(ids);
      const moved = res.files + res.folders;
      undoToast(`Moved ${moved} item${moved === 1 ? "" : "s"} to trash`, async () => {
        await filesApi.bulkRestore(ids);
        refreshAll();
      });
      if (res.skipped) toast.info(workspaceSkipNote(res.skipped));
      clearSelection();
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setBulkBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selFiles, selFolders, bulkTrash, clearSelection]);

  const handleBulkStar = useCallback(
    async (star: boolean) => {
      if (selFiles.size + selFolders.size === 0) return;
      setBulkBusy(true);
      try {
        await bulkStar.mutateAsync({ ...bulkIds(), star });
        clearSelection();
      } catch (e) {
        toast.error(extractError(e));
      } finally {
        setBulkBusy(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [selFiles, selFolders, bulkStar, clearSelection]
  );

  const handleBulkDownload = useCallback(async () => {
    if (selFiles.size + selFolders.size === 0) return;
    setBulkBusy(true);
    try {
      await filesApi.bulkZipDownload(bulkIds());
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setBulkBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selFiles, selFolders]);

  const handleBulkMove = useCallback(
    async (target: string | null) => {
      // Where everything was, so Undo can put it back.
      const fromFiles = (data?.files ?? []).filter((f) => selFiles.has(f.id)).map((f) => [f.id, f.folder_id] as const);
      const fromFolders = (data?.folders ?? [])
        .filter((f) => selFolders.has(f.id))
        .map((f) => [f.id, f.parent_id] as const);
      const res = await bulkMove.mutateAsync({
        ...bulkIds(),
        target_folder_id: target,
        move_to_root: target === null,
      });
      const count = res.files + res.folders;
      undoToast(`Moved ${count} item${count === 1 ? "" : "s"}`, async () => {
        for (const [id, parent] of fromFiles) await filesApi.moveFile(id, parent ?? null);
        for (const [id, parent] of fromFolders) await filesApi.moveFolder(id, parent ?? null);
        refreshAll();
      });
      if (res.skipped) toast.info(workspaceSkipNote(res.skipped));
      setBulkMoveOpen(false);
      clearSelection();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selFiles, selFolders, bulkMove, clearSelection, data]
  );

  // Drive-style keyboard shortcuts: Ctrl/Cmd+A select all, Esc clear,
  // Delete/Backspace move the selection to trash. Ignored while typing
  // in a field or when a modal/picker owns the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
      // A dialog (preview, move, share…) owns the keyboard.
      if (document.querySelector('[role="dialog"], [aria-modal="true"]')) return;
      const mod = e.ctrlKey || e.metaKey;
      const items = keyItemsRef.current;
      const current =
        selFiles.size + selFolders.size === 1
          ? items.findIndex((it) =>
              it.kind === "file" ? selFiles.has(it.id) : selFolders.has(it.id)
            )
          : -1;
      const focusItem = (i: number) => {
        const it = items[i];
        if (!it) return;
        selectOnly(it.kind, it.id);
        // The row may be off screen (the list is virtualised).
        listRef.current?.reveal(`${it.kind}:${it.id}`);
      };
      if (!mod && ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
        if (!items.length) return;
        // In the grid, Left/Right step and Up/Down jump a row of tiles.
        const perRow = viewMode === "grid" ? listRef.current?.columns() ?? 1 : 1;
        const step =
          e.key === "ArrowDown"
            ? perRow
            : e.key === "ArrowUp"
              ? -perRow
              : e.key === "ArrowRight"
                ? viewMode === "grid" ? 1 : 0
                : e.key === "ArrowLeft"
                  ? viewMode === "grid" ? -1 : 0
                  : 0;
        if (!step && e.key !== "Home" && e.key !== "End") return;
        e.preventDefault();
        const next =
          e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : current < 0 ? 0 : current + step;
        focusItem(Math.max(0, Math.min(items.length - 1, next)));
        return;
      }
      if (e.key === "F2" && current >= 0 && writable) {
        e.preventDefault();
        setRenameKey(`${items[current].kind}:${items[current].id}`);
        return;
      }
      // Quick Look: Space previews the focused file (folders open with Enter).
      if (e.key === " " && !mod && current >= 0 && items[current].kind === "file") {
        const f = (data?.files ?? []).find((x) => x.id === items[current].id);
        if (f) {
          e.preventDefault();
          setPreview(f);
        }
        return;
      }
      // Type-ahead: letters jump to the first name that starts with them.
      if (!mod && !e.altKey && e.key.length === 1 && /\S/.test(e.key)) {
        const ta = typeAheadRef.current;
        ta.buffer = (Date.now() - ta.at < 800 ? ta.buffer : "") + e.key.toLowerCase();
        ta.at = Date.now();
        const hit = items.findIndex((it) => it.name.toLowerCase().startsWith(ta.buffer));
        if (hit >= 0) focusItem(hit);
        return;
      }
      if (mod && (e.key === "a" || e.key === "A")) {
        const allFiles = (data?.files ?? []).map((f) => f.id);
        const allFolders = (data?.folders ?? []).map((f) => f.id);
        if (allFiles.length + allFolders.length === 0) return;
        e.preventDefault();
        setSelFiles(new Set(allFiles));
        setSelFolders(new Set(allFolders));
        return;
      }
      if (e.key === "Escape" && selFiles.size + selFolders.size > 0) {
        clearSelection();
        return;
      }
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selFiles.size + selFolders.size > 0
      ) {
        e.preventDefault();
        void handleBulkTrash();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [data, selFiles, selFolders, clearSelection, handleBulkTrash, selectOnly, viewMode, writable]);

  const navigateToFolder = useCallback(
    (id: string | null) => {
      // Keep URLs deep-linkable: sidebar / Drive PWA start_url both
      // depend on every folder having its own path. Within the same
      // top-level view we just swap the route so history works.
      if (scope === "shared") {
        navigate(id ? `/files/folder/${id}?scope=shared` : "/files/shared");
      } else if (id) navigate(`/files/folder/${id}`);
      else navigate("/files");
    },
    [navigate, scope]
  );

  const handleDropOnto = useCallback(
    async (
      targetFolderId: string | null,
      payload: DragPayload
    ): Promise<DropOutcome> => {
      if (!writable) return { ok: false };
      if (payload.sourceParent === (targetFolderId ?? "")) {
        return { ok: false };
      }
      if (payload.kind === "folder" && payload.id === targetFolderId) {
        return { ok: false };
      }
      try {
        const from = payload.sourceParent || null;
        if (payload.kind === "file") {
          await moveFile.mutateAsync({
            id: payload.id,
            folderId: targetFolderId,
            scope,
            from,
            name: data?.files.find((f) => f.id === payload.id)?.filename,
          });
        } else {
          await moveFolder.mutateAsync({
            id: payload.id,
            parentId: targetFolderId,
            scope,
            from,
            name: data?.folders.find((f) => f.id === payload.id)?.name,
          });
        }
        return { ok: true };
      } catch (e) {
        const msg = extractError(e);
        toast.error(msg);
        return { ok: false, error: msg };
      }
    },
    [moveFile, moveFolder, scope, writable, data]
  );

  const openMoveModal = useCallback((s: MoveModalState) => {
    setMoveModal(s);
  }, []);

  const visibleFiles = data?.files ?? [];

  // Drag-to-upload: drop OS files anywhere on the page to upload them
  // into the current folder. Gated on the native "Files" drag type so it
  // never collides with the *internal* file/folder move drags (which use
  // custom MIME types) — those keep flowing to the row/breadcrumb drop
  // targets untouched.
  const startUploads = useUploadStore((s) => s.startUploads);
  const [externalDragOver, setExternalDragOver] = useState(false);
  const isExternalFileDrag = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types || []).includes("Files");

  const handlePageDragOver = (e: React.DragEvent) => {
    if (!writable || !isExternalFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!externalDragOver) setExternalDragOver(true);
  };
  const handlePageDragLeave = (e: React.DragEvent) => {
    if (!externalDragOver) return;
    // Only dismiss when the pointer actually leaves the dropzone, not
    // when it crosses between child rows inside it.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setExternalDragOver(false);
  };
  const handlePageDrop = (e: React.DragEvent) => {
    if (!writable || !isExternalFileDrag(e)) return;
    e.preventDefault();
    setExternalDragOver(false);
    // Folders dragged in keep their structure (WP-8.2). The entries must be
    // read now, inside the event.
    const reading = treeFromDrop(e.dataTransfer);
    void reading.then(async ({ files: tree, hasFolders }) => {
      if (tree.length === 0) return;
      try {
        if (hasFolders) await uploadTree(tree, folderId, scope, startUploads);
        else startUploads({ files: tree.map((t) => t.file), scope, folderId, onConflict: "ask" });
        toast.info(`Uploading ${tree.length} file${tree.length === 1 ? "" : "s"}…`);
        if (hasFolders) bumpTree();
        void refetch();
      } catch (err) {
        toast.error(extractError(err));
      }
    });
  };

  // Right-click anywhere in the content pane that isn't a row → offer the
  // folder-level actions. Rows keep their own context menu (we bail when
  // the click lands inside an <li> or an interactive control).
  const handleContentContextMenu = (e: React.MouseEvent) => {
    if (!writable) return;
    const t = e.target as HTMLElement;
    if (t.closest("li, button, input, a, [role='menu']")) return;
    e.preventDefault();
    setEmptyMenu({ x: e.clientX, y: e.clientY });
  };
  const handleEmptyUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;
    startUploads({ files, scope, folderId, onConflict: "ask" });
    toast.info(
      `Uploading ${files.length} file${files.length === 1 ? "" : "s"}…`
    );
    refreshAll();
  };

  return (
    <>
      <TopNav
        title={title}
        subtitle={subtitle}
        actions={<FilesTopNavSearch />}
      />
      <DriveSubNav />
      {scope === "shared" && !folderId && (
        <div role="tablist" aria-label="Shared" className="flex items-center gap-1.5 border-b border-[var(--border)] px-4 py-2 md:px-6">
          {(
            [
              ["with_me", "With me"],
              ["by_me", "By me"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={sharedView === key}
              onClick={() => setSearchParams(key === "with_me" ? {} : { view: key })}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition",
                sharedView === key
                  ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text)]"
                  : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)]"
              )}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => navigate("/files/links")}
            className="rounded-full border border-[var(--border)] px-3 py-1 text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--hover)]"
          >
            Links
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div
          className="promptly-scroll relative min-w-0 flex-1 overflow-y-auto"
          onDragEnter={handlePageDragOver}
          onDragOver={handlePageDragOver}
          onDragLeave={handlePageDragLeave}
          onDrop={handlePageDrop}
          onContextMenu={handleContentContextMenu}
        >
        {externalDragOver && (
          <div className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-[var(--accent)]/10 backdrop-blur-[1px]">
            <div className="flex flex-col items-center gap-2 rounded-card border-2 border-dashed border-[var(--accent)] bg-[var(--surface)] px-8 py-6 shadow-lg">
              <Upload className="h-7 w-7 text-[var(--accent-text)]" />
              <span className="text-sm font-medium text-[var(--text)]">
                Drop files to upload
              </span>
              <span className="text-xs text-[var(--text-muted)]">
                They'll land in this folder
              </span>
            </div>
          </div>
        )}
        <div className="w-full px-4 py-4 md:px-6 md:py-6">
          {/* Drive stage 5 — the legacy "My files / Shared pool" scope
              toggle was retired here. Switching between owned files
              and the peer-to-peer Shared view now happens via the
              top sub-nav (DriveSubNav) so there's exactly one place
              to navigate, and "Shared" sits naturally next to its
              siblings (Recent / Starred / Trash). The deep-linked
              ``/files`` and ``/files/shared`` routes already round-
              trip the scope; ``forcedScope`` keeps the wrappers
              honest. */}

          {/* Breadcrumbs + folder actions: stack vertically on phones
              so the breadcrumb trail gets its own line and the Upload
              button stays full-width + tap-sized. */}
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <Breadcrumbs
              crumbs={crumbs}
              scope={scope}
              onNavigate={navigateToFolder}
              writable={writable}
              onDrop={handleDropOnto}
            />
            <div className="flex items-center gap-2">
              {/* Grid icon-size slider — only meaningful (and shown) in
                  grid view; lets the user "zoom" the tiles like a drive. */}
              {viewMode === "grid" && (
                <GridSizeSlider value={gridTile} onChange={setGridTile} />
              )}
              {/* Grid view has no column headers, so it keeps the sort
                  dropdown. List view sorts via its clickable column
                  headers, so the dropdown is redundant there and hidden. */}
              {viewMode === "grid" && (
                <SortControl sort={sort} onChange={setSort} />
              )}
              <ViewToggle mode={viewMode} onChange={setViewMode} />
              {writable && (
                <FolderActions
                  scope={scope}
                  parentId={folderId}
                  onChanged={refreshAll}
                />
              )}
            </div>
          </div>

          {isLoading &&
            (viewMode === "grid" ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div
                    key={i}
                    className="rounded-card border border-[var(--border)] bg-[var(--surface)] p-3"
                  >
                    <Skeleton className="aspect-square w-full" />
                    <Skeleton className="mt-2 h-3 w-3/4" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-1.5">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 px-2 py-2">
                    <Skeleton className="h-8 w-8" />
                    <Skeleton className="h-3.5 w-1/3" />
                    <Skeleton className="ml-auto h-3 w-16" />
                  </div>
                ))}
              </div>
            ))}

          {isError && (
            <div
              role="alert"
              className="rounded-card border border-[var(--danger-border)] bg-[var(--danger-bg)] px-4 py-3 text-sm text-[var(--danger)]"
            >
              Failed to load files: {error instanceof Error ? error.message : "Unknown"}
              <Button size="sm" variant="ghost" className="ml-3" onClick={() => refetch()}>
                Retry
              </Button>
            </div>
          )}

          {data?.workspace_id && (
            <div
              role="status"
              className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs text-[var(--text-muted)]"
            >
              <span>
                These files belong to the workspace{" "}
                <span className="font-medium text-[var(--text)]">
                  {data.workspace_title}
                </span>
                . Rename, move or delete them from the workspace.
              </span>
              <button
                type="button"
                onClick={() => navigate(`/workspaces/${data.workspace_id}`)}
                className="font-medium text-[var(--accent-text)] hover:underline"
              >
                Open workspace
              </button>
            </div>
          )}

                    {quotaPct >= 0.8 && quota?.cap_bytes != null && (
            <div
              role="status"
              className={cn(
                "mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-card border px-3 py-2 text-xs",
                quotaPct >= 0.95
                  ? "border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger)]"
                  : "border-[var(--warning-border)] bg-[var(--warning-bg)] text-[var(--warning)]"
              )}
            >
              <span className="font-medium">
                Storage {Math.round(quotaPct * 100)}% full
              </span>
              <span className="text-[var(--text-muted)]">
                {humanSize(quota.used_bytes)} of {humanSize(quota.cap_bytes)} used
                {quotaPct >= 0.95
                  ? " — uploads may be refused. Free up space in Trash."
                  : " — consider clearing space soon."}
              </span>
            </div>
          )}

          {/* Multi-select uses the top action bar; a single selection
              uses the right-hand details pane instead. */}
          {selectionCount > 0 && (
            <div className={cn(selectionCount === 1 && "lg:hidden")}>
            <DriveSelectionBar
              count={selectionCount}
              busy={bulkBusy}
              onClear={clearSelection}
              onDownload={() => void handleBulkDownload()}
              onStar={writable ? () => void handleBulkStar(true) : undefined}
              onUnstar={writable ? () => void handleBulkStar(false) : undefined}
              onMove={writable ? () => setBulkMoveOpen(true) : undefined}
              onTrash={writable ? () => void handleBulkTrash() : undefined}
              onAsk={() => void handleAsk()}
            />
            </div>
          )}

          {data && (
            <ContentGrid
              data={data}
              scope={scope}
              layout={viewMode}
              currentFolderId={folderId}
              sort={sort}
              onSort={setSort}
              gridTile={gridTile}
              selFiles={selFiles}
              selFolders={selFolders}
              onToggleFile={toggleFile}
              onToggleFolder={toggleFolder}
              onOpenFolder={navigateToFolder}
              onDropOnFolder={handleDropOnto}
              onOpenMove={openMoveModal}
              // Drive Documents jump straight into the editor on
              // click (matches Notion / Google Docs muscle memory)
              // — every other file type still gets the generic
              // preview modal. Trashed docs deliberately stay in
              // preview because the editor would 404 on the read
              // path anyway.
              onPreview={(f) => {
                if (!openInEditor(f, navigate)) setPreview(f);
              }}
              onShare={setShareGrantsFor}
              onSelectItem={handleSelectItem}
              renameKey={renameKey}
              onRenameStarted={() => setRenameKey(null)}
              listRef={listRef}
              hasMore={!!hasNextPage}
              loadingMore={isFetchingNextPage}
              onLoadMore={loadMore}
            />
          )}
        </div>
        </div>

        {/* Right-hand details pane for a single selection. Desktop-only;
            on mobile a single selection still uses the top action bar. */}
        {hasDetail && (
          <aside className="hidden w-72 shrink-0 overflow-hidden border-l border-[var(--border)] bg-[var(--surface)] lg:block">
            <DriveDetailsPanel
              file={detailFile}
              folder={detailFolder}
              writable={writable}
              onClose={clearSelection}
              onOpen={() => {
                if (detailFolder) {
                  navigateToFolder(detailFolder.id);
                } else if (detailFile) {
                  if (!openInEditor(detailFile, navigate)) setPreview(detailFile);
                }
              }}
              onDownload={
                detailFile ? () => void downloadAuthed(detailFile) : undefined
              }
              onShare={() => {
                if (detailFolder) {
                  setShareGrantsFor({
                    kind: "folder",
                    id: detailFolder.id,
                    name: detailFolder.name,
                  });
                } else if (detailFile) {
                  setShareGrantsFor({
                    kind: "file",
                    id: detailFile.id,
                    name: detailFile.filename,
                    supportsEdit: supportsEditGrant(detailFile),
                    roles: shareRolesFor(detailFile),
                  });
                }
              }}
              onMove={() => {
                if (detailFolder) {
                  openMoveModal({
                    open: true,
                    kind: "folder",
                    id: detailFolder.id,
                    name: detailFolder.name,
                    currentParentId: detailFolder.parent_id,
                  });
                } else if (detailFile) {
                  openMoveModal({
                    open: true,
                    kind: "file",
                    id: detailFile.id,
                    name: detailFile.filename,
                    currentParentId: detailFile.folder_id,
                  });
                }
              }}
              onStar={() => void handleBulkStar(true)}
              onUnstar={() => void handleBulkStar(false)}
              onTrash={() => void handleBulkTrash()}
              onAsk={() => void handleAsk()}
              onOpenAsDocument={
                detailFile && isWordFile(detailFile) && !detailFile.trashed_at
                  ? () => void openWordAsDocument(detailFile, navigate).then((d) => d && refreshAll())
                  : undefined
              }
              onHistory={detailFile && !detailFile.trashed_at ? () => setHistoryFor(detailFile) : undefined}
              onOpenAsSheet={
                detailFile && isSpreadsheetFile(detailFile) && !detailFile.trashed_at
                  ? () => void openSpreadsheetAsSheet(detailFile, navigate).then((d) => d && refreshAll())
                  : undefined
              }
            />
          </aside>
        )}
      </div>

      {/* Right-click-empty-space menu + its hidden upload input and
          page-level New folder modal. */}
      <input
        ref={pageFileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleEmptyUpload}
      />
      <ContextMenu
        open={emptyMenu !== null}
        x={emptyMenu?.x ?? 0}
        y={emptyMenu?.y ?? 0}
        onClose={() => setEmptyMenu(null)}
        items={[
          {
            icon: <FolderPlus className="h-3.5 w-3.5" />,
            label: "New folder",
            onClick: () => setShowNewFolderPage(true),
          },
          {
            icon: <Upload className="h-3.5 w-3.5" />,
            label: "Upload files",
            onClick: () => pageFileInputRef.current?.click(),
          },
        ]}
      />
      <NewFolderModal
        open={showNewFolderPage}
        onClose={() => setShowNewFolderPage(false)}
        onSubmit={async (name) => {
          const made = await createFolderPage.mutateAsync({ scope, name, parentId: folderId });
          useFilesShellStore.getState().reveal(`folder:${made.id}`);
          refreshAll();
          setShowNewFolderPage(false);
        }}
      />

      {moveModal && (
        <MoveItemModal
          open={moveModal.open}
          scope={scope}
          kind={moveModal.kind}
          itemId={moveModal.id}
          itemName={moveModal.name}
          currentParentId={moveModal.currentParentId}
          onClose={() => setMoveModal(null)}
          onSubmit={async (target) => {
            if (moveModal.kind === "file") {
              await moveFile.mutateAsync({
                id: moveModal.id,
                folderId: target,
                scope,
                from: moveModal.currentParentId ?? null,
                name: moveModal.name,
              });
            } else {
              await moveFolder.mutateAsync({
                id: moveModal.id,
                parentId: target,
                scope,
                from: moveModal.currentParentId ?? null,
                name: moveModal.name,
              });
            }
            setMoveModal(null);
          }}
        />
      )}

      {/* Batch move — reuses the folder picker. ``kind="file"`` so it
          doesn't try to hide a single source folder; the backend skips
          any illegal per-item move (e.g. a folder into its own subtree). */}
      {bulkMoveOpen && (
        <MoveItemModal
          open={bulkMoveOpen}
          scope={scope}
          kind="file"
          itemId=""
          itemName={`${selectionCount} item${selectionCount === 1 ? "" : "s"}`}
          currentParentId={folderId}
          onClose={() => setBulkMoveOpen(false)}
          onSubmit={handleBulkMove}
        />
      )}

      <FilePreviewModal
        open={!!preview}
        file={preview}
        siblings={visibleFiles}
        onSelect={setPreview}
        onClose={() => setPreview(null)}
        onShare={(f) =>
          setShareGrantsFor({
            kind: "file",
            id: f.id,
            name: f.filename,
            supportsEdit: supportsEditGrant(f),
            roles: shareRolesFor(f),
          })
        }
        onEdit={(f) => {
          setPreview(null);
          openInEditor({ ...f, trashed_at: null }, navigate);
        }}
        onCopyToMine={async (f) => {
          // Drive stage 5 — recipient with ``can_copy`` clones a
          // shared file into their own drive root. Refetch all
          // ``files`` queries so the new row appears in My files
          // immediately.
          try {
            await filesApi.copyFileToMine(f.id);
            void invalidateFileQueries(qc);
            setPreview(null);
          } catch (e) {
            // Surface the message via a transient banner-style
            // alert. We don't have a toast system on this page so
            // a simple alert covers the rare error case.
            // eslint-disable-next-line no-alert
            alert(extractError(e));
          }
        }}
        onToggleStar={undefined}
      />

      {historyFor && (
        <div className="fixed inset-y-0 right-0 z-40 w-full sm:w-96">
          <div className="relative h-full">
            <VersionHistoryPanel
              fileId={historyFor.id}
              onClose={() => setHistoryFor(null)}
              onRestored={() => {
                void invalidateFileQueries(qc);
              }}
            />
          </div>
        </div>
      )}

      <ShareGrantsModal
        open={!!shareGrantsFor}
        resource={
          shareGrantsFor
            ? {
                type: shareGrantsFor.kind,
                id: shareGrantsFor.id,
                name: shareGrantsFor.name,
                supports_edit: shareGrantsFor.supportsEdit ?? false,
                roles: shareGrantsFor.roles,
              }
            : null
        }
        onClose={() => setShareGrantsFor(null)}
        onChanged={() => {
          // Pill data lives on file/folder rows; refetch the active
          // browse view so the chips reflect the latest grants.
          void invalidateFileQueries(qc);
          void qc.invalidateQueries({ queryKey: ["workspaces"] });
        }}
      />

    </>
  );
}

function Breadcrumbs({
  crumbs,
  scope,
  onNavigate,
  writable,
  onDrop,
}: {
  crumbs: { id: string | null; name: string }[];
  scope: FileScope;
  onNavigate: (id: string | null) => void;
  writable: boolean;
  onDrop: (
    targetFolderId: string | null,
    payload: DragPayload
  ) => Promise<DropOutcome>;
}) {
  const rootLabel = scope === "mine" ? "My files" : "Shared";
  return (
    <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-sm text-[var(--text-muted)]">
      <CrumbButton
        targetId={null}
        active={crumbs.length === 0}
        writable={writable}
        onClick={() => onNavigate(null)}
        onDrop={onDrop}
      >
        <Home className="h-3.5 w-3.5" />
        <span className="font-medium">{rootLabel}</span>
      </CrumbButton>
      {crumbs.map((c, i) => {
        const isActive = i === crumbs.length - 1;
        return (
          <span key={c.id ?? `c-${i}`} className="flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5" />
            {isActive ? (
              <span className="px-1.5 py-1 font-medium text-[var(--text)]">
                {c.name}
              </span>
            ) : (
              <CrumbButton
                targetId={c.id}
                active={false}
                writable={writable}
                onClick={() => onNavigate(c.id)}
                onDrop={onDrop}
              >
                {c.name}
              </CrumbButton>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function CrumbButton({
  targetId,
  active,
  writable,
  onClick,
  onDrop,
  children,
}: {
  targetId: string | null;
  active: boolean;
  writable: boolean;
  onClick: () => void;
  onDrop: (
    targetFolderId: string | null,
    payload: DragPayload
  ) => Promise<DropOutcome>;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState(false);

  const allow = (e: React.DragEvent) => {
    if (!writable || active) return false;
    return dragHasItem(e.dataTransfer);
  };

  return (
    <button
      onClick={onClick}
      onDragEnter={(e) => {
        if (allow(e)) setOver(true);
      }}
      onDragOver={(e) => {
        if (allow(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOver(false);
      }}
      onDrop={async (e) => {
        if (!allow(e)) return;
        e.preventDefault();
        setOver(false);
        const payload = readDragPayload(e.dataTransfer);
        if (!payload) return;
        await onDrop(targetId, payload);
      }}
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-1.5 py-1 transition",
        "hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]",
        over && "bg-[var(--accent)]/15 text-[var(--text)] ring-1 ring-[var(--accent)]/40"
      )}
    >
      {children}
    </button>
  );
}

/** The page's New menu — below 1024 px; the Files rail has it above. */
function FolderActions({
  scope,
  parentId,
  onChanged,
}: {
  scope: FileScope;
  parentId: string | null;
  onChanged: () => void;
}) {
  return (
    <div className="hidden md:block lg:hidden">
      <NewMenu scope={scope} folderId={parentId} onChanged={onChanged} />
    </div>
  );
}

const RAIL_SYSTEM_KINDS = new Set<string>([
  "chat_uploads",
  "generated_root",
  "workspaces_root",
]);

function ContentGrid({
  data,
  scope,
  layout,
  currentFolderId,
  sort,
  onSort,
  gridTile,
  selFiles,
  selFolders,
  onToggleFile,
  onToggleFolder,
  onOpenFolder,
  onDropOnFolder,
  onOpenMove,
  onPreview,
  onShare,
  onSelectItem,
  renameKey,
  onRenameStarted,
  listRef,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  data: { folders: FolderItem[]; files: FileItem[]; writable: boolean };
  scope: FileScope;
  layout: ViewMode;
  currentFolderId: string | null;
  sort: DriveSort;
  onSort: (s: DriveSort) => void;
  gridTile: number;
  selFiles: Set<string>;
  selFolders: Set<string>;
  onToggleFile: (id: string, shift: boolean) => void;
  onToggleFolder: (id: string, shift: boolean) => void;
  onOpenFolder: (id: string | null) => void;
  onDropOnFolder: (targetFolderId: string | null, payload: DragPayload) => Promise<DropOutcome>;
  onOpenMove: (s: MoveModalState) => void;
  onPreview: (file: FileItem) => void;
  /** Share action — opens the peer-to-peer grants modal. */
  onShare: (r: {
    kind: "file" | "folder";
    id: string;
    name: string;
    supportsEdit?: boolean;
    roles?: ShareLinkRole[];
  }) => void;
  onSelectItem?: (kind: "file" | "folder", id: string, e: React.MouseEvent) => void;
  /** "file:<id>" / "folder:<id>" whose rename F2 asked for. */
  renameKey?: string | null;
  onRenameStarted?: () => void;
  listRef: React.RefObject<DriveItemListHandle>;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}) {
  // System folders are grouped into a collapsible section at the bottom,
  // collapsed by default — they're rarely what the user came to find.
  const [systemOpen, setSystemOpen] = useState(false);

  // One set of mutations and one menu / rename / trash dialog for the
  // whole page (WP-7.6) — rows don't carry their own.
  const renameFile = useRenameFile();
  const renameFolder = useRenameFolder();
  const trashFile = useTrashFile();
  const trashFolder = useTrashFolder();
  const starFile = useStarFile();
  const unstarFile = useUnstarFile();
  const starFolder = useStarFolder();
  const unstarFolder = useUnstarFolder();
  const driveAi = useDriveAi();
  const qcList = useQueryClient();
  const [menu, setMenu] = useState<{ entry: DriveEntry; x: number; y: number } | null>(null);
  const [renameDialog, setRenameDialog] = useState<{ entry: DriveEntry; value: string } | null>(null);
  const [trashAsk, setTrashAsk] = useState<DriveEntry | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);

  // The latest props for the controller's callbacks, so the controller
  // itself (and with it every memoised row) stays the same object.
  const latest = useRef({ data, scope, onOpenFolder, onPreview, onSelectItem, onToggleFile, onToggleFolder, onShare, onOpenMove, onDropOnFolder, driveAi });
  latest.current = { data, scope, onOpenFolder, onPreview, onSelectItem, onToggleFile, onToggleFolder, onShare, onOpenMove, onDropOnFolder, driveAi };
  const mut = useRef({ renameFile, renameFolder, trashFile, trashFolder, starFile, unstarFile, starFolder, unstarFolder });
  mut.current = { renameFile, renameFolder, trashFile, trashFolder, starFile, unstarFile, starFolder, unstarFolder };

  const startRename = useCallback(
    (entry: DriveEntry) => {
      if (layout === "grid")
        setRenameDialog({ entry, value: entry.kind === "file" ? splitFileExt(entry.file.filename).base : entry.folder.name });
      else setEditingKey(entry.key);
    },
    [layout]
  );

  // F2 on the selected item.
  useEffect(() => {
    if (!renameKey) return;
    const [kind, id] = renameKey.split(":");
    const entry =
      kind === "file"
        ? (() => {
            const f = data.files.find((x) => x.id === id);
            return f ? fileEntry(f) : null;
          })()
        : (() => {
            const f = data.folders.find((x) => x.id === id);
            return f && !f.system_kind ? folderEntry(f) : null;
          })();
    if (entry && data.writable) startRename(entry);
    onRenameStarted?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameKey]);

  const controller = useMemo<DriveListController>(() => {
    const share = (entry: DriveEntry) => {
      const L = latest.current;
      if (entry.kind === "folder") L.onShare({ kind: "folder", id: entry.folder.id, name: entry.folder.name });
      else
        L.onShare({
          kind: "file",
          id: entry.file.id,
          name: entry.file.filename,
          supportsEdit: supportsEditGrant(entry.file),
          roles: shareRolesFor(entry.file),
        });
    };
    const toggleStar = (entry: DriveEntry) => {
      const M = mut.current;
      const s = latest.current.scope;
      if (entry.kind === "file") (entry.file.starred_at ? M.unstarFile : M.starFile).mutate({ id: entry.file.id, scope: s });
      else (entry.folder.starred_at ? M.unstarFolder : M.starFolder).mutate({ id: entry.folder.id, scope: s });
    };
    const open = (entry: DriveEntry) =>
      entry.kind === "folder" ? latest.current.onOpenFolder(entry.folder.id) : latest.current.onPreview(entry.file);
    return {
      layout,
      currentFolderId,
      open,
      select: (entry, e) => latest.current.onSelectItem?.(entry.kind, entryId(entry), e),
      toggleSelect: (entry, shift) =>
        entry.kind === "file" ? latest.current.onToggleFile(entry.file.id, shift) : latest.current.onToggleFolder(entry.folder.id, shift),
      canChange: (entry) => latest.current.data.writable && !(entry.kind === "folder" && entry.folder.system_kind),
      showMenu: (entry, x, y) => setMenu({ entry, x, y }),
      share,
      download: (file) => void downloadAuthed(file),
      toggleStar,
      rename: (entry, name) => {
        setEditingKey(null);
        const s = latest.current.scope;
        if (entry.kind === "file") {
          if (name !== entry.file.filename) void mut.current.renameFile.mutateAsync({ id: entry.file.id, filename: name, scope: s });
        } else if (name !== entry.folder.name) {
          void mut.current.renameFolder.mutateAsync({ id: entry.folder.id, name, scope: s });
        }
      },
      cancelRename: () => setEditingKey(null),
      dropOnFolder: (folderId, payload) => latest.current.onDropOnFolder(folderId, payload),
      menu: (entry) => {
        const L = latest.current;
        const writable = L.data.writable;
        const move: ContextMenuItem = {
          icon: <FolderInput className="h-3.5 w-3.5" />,
          label: "Move to…",
          onClick: () =>
            L.onOpenMove(
              entry.kind === "file"
                ? { open: true, kind: "file", id: entry.file.id, name: entry.file.filename, currentParentId: entry.file.folder_id }
                : { open: true, kind: "folder", id: entry.folder.id, name: entry.folder.name, currentParentId: entry.folder.parent_id }
            ),
          disabled: !writable,
        };
        const starItem: ContextMenuItem = {
          icon: <Star className="h-3.5 w-3.5" />,
          label: (entry.kind === "file" ? entry.file.starred_at : entry.folder.starred_at) ? "Unstar" : "Star",
          onClick: () => toggleStar(entry),
          disabled: !writable,
        };
        const common: ContextMenuItem[] = [
          starItem,
          { icon: <Share2 className="h-3.5 w-3.5" />, label: "Share", onClick: () => share(entry), disabled: !writable },
          { icon: <Pencil className="h-3.5 w-3.5" />, label: "Rename", onClick: () => startRename(entry), disabled: !writable },
          move,
        ];
        const trash: ContextMenuItem = {
          icon: <Trash2 className="h-3.5 w-3.5" />,
          label: "Trash",
          destructive: true,
          onClick: () => setTrashAsk(entry),
          disabled: !writable,
        };
        if (entry.kind === "file") {
          return [
            { icon: <Eye className="h-3.5 w-3.5" />, label: "Preview", onClick: () => open(entry) },
            { icon: <Download className="h-3.5 w-3.5" />, label: "Download", onClick: () => void downloadAuthed(entry.file) },
            ...common,
            trash,
          ];
        }
        const folder = entry.folder;
        // Leave a folder out of AI search (WP-5.1) — your own folders,
        // Generated Files and Chat Uploads too (Templates is never indexed).
        const ai: ContextMenuItem[] =
          L.driveAi.data?.enabled && L.scope === "mine" && L.data.writable && folder.system_kind !== "templates"
            ? [
                {
                  icon: <Sparkles className="h-3.5 w-3.5" />,
                  label: L.driveAi.isExcluded(folder.id) ? "Include in AI search" : "Leave out of AI search",
                  onClick: () => L.driveAi.setExcluded(folder.id, !L.driveAi.isExcluded(folder.id)),
                },
              ]
            : [];
        // Leave a folder (scans, work, receipts) out of Photos (WP-9.1).
        const photos: ContextMenuItem[] =
          L.scope === "mine" && writable && !folder.system_kind
            ? [
                {
                  icon: <Images className="h-3.5 w-3.5" />,
                  label: folder.hide_from_photos ? "Show in Photos" : "Hide from Photos",
                  onClick: () =>
                    void filesApi
                      .setHideFromPhotos(folder.id, !folder.hide_from_photos)
                      .then(() => {
                        toast.success(folder.hide_from_photos ? "Its photos are back in Photos." : "Its photos are left out of Photos.");
                        void qcList.invalidateQueries({ queryKey: ["files-browse"] });
                        void qcList.invalidateQueries({ queryKey: ["photos"] });
                      })
                      .catch((e) => toast.error(extractError(e))),
                },
              ]
            : [];
        return [
          { icon: <FolderClosedIcon className="h-3.5 w-3.5" />, label: "Open", onClick: () => open(entry) },
          // A whole folder as a zip (R-210).
          {
            icon: <Download className="h-3.5 w-3.5" />,
            label: "Download",
            onClick: () =>
              void filesApi.bulkZipDownload({ file_ids: [], folder_ids: [folder.id] }).catch((e) => toast.error(extractError(e))),
          },
          ...(folder.system_kind ? [] : [...common, ...ai, ...photos, trash]),
        ];
      },
    };
  }, [layout, currentFolderId, startRename]);

  const empty = data.folders.length === 0 && data.files.length === 0;
  if (empty) {
    return (
      <div className="rounded-card border border-dashed border-[var(--border)] bg-[var(--surface)] px-6 py-12 text-center">
        <h2 className="text-base font-semibold">Nothing here yet</h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          {data.writable
            ? "Upload a file or create a folder to get started."
            : "No files have been added to this pool yet."}
        </p>
      </div>
    );
  }

  // User folders, then files, then (collapsed) the system folders. At the
  // top of My files the chat buckets live under the rail's "From chats" and
  // workspaces under its Workspaces (WP-3.5) — only Templates stays here.
  const userFolders = data.folders.filter((f) => !f.system_kind);
  const systemFolders = data.folders.filter(
    (f) => !!f.system_kind && !(currentFolderId === null && RAIL_SYSTEM_KINDS.has(f.system_kind))
  );
  const items: DriveListItem[] = [...userFolders.map(folderEntry), ...data.files.map(fileEntry)];
  if (systemFolders.length > 0) {
    items.push({
      kind: "section",
      key: "section:system",
      node: (
        <button
          type="button"
          onClick={() => setSystemOpen((o) => !o)}
          aria-expanded={systemOpen}
          className={cn(
            "flex w-full items-center gap-1.5 text-left transition",
            layout === "grid" ? "pt-1" : "bg-[var(--bg)] px-3 py-1.5 hover:bg-[var(--hover)]"
          )}
        >
          <ChevronRight
            className={cn("h-3 w-3 shrink-0 text-[var(--text-muted)] transition-transform", systemOpen && "rotate-90")}
          />
          <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">System</span>
          <span className="text-[10px] tabular-nums text-[var(--text-muted)]/70">{systemFolders.length}</span>
          {layout === "grid" && <span className="flex-1 border-t border-[var(--border)]" />}
        </button>
      ),
    });
    if (systemOpen) items.push(...systemFolders.map(folderEntry));
  }

  const menuItems = menu ? controller.menu(menu.entry) : [];
  const renaming = renameDialog?.entry;

  return (
    <DriveListProvider value={controller}>
      <DriveItemList
        ref={listRef}
        items={items}
        layout={layout}
        gridTile={gridTile}
        isSelected={(e) => (e.kind === "file" ? selFiles.has(e.file.id) : selFolders.has(e.folder.id))}
        selectionActive={selFiles.size + selFolders.size > 0}
        editingKey={editingKey}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={onLoadMore}
        header={
          <DriveListHeader>
            <SortHeader className="flex-1" label="Name" col="name" sort={sort} onSort={onSort} />
            {/* Kind isn't a sort key, so it's a static label. */}
            <span className="hidden w-24 shrink-0 lg:block">Kind</span>
            <SortHeader className="hidden w-28 shrink-0 lg:block" label="Modified" col="modified" sort={sort} onSort={onSort} />
            <SortHeader className="hidden w-16 shrink-0 sm:block" align="right" label="Size" col="size" sort={sort} onSort={onSort} />
          </DriveListHeader>
        }
      />

      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menuItems}
        onClose={() => setMenu(null)}
      />

      <InlinePromptModal
        open={!!renameDialog}
        title={renaming?.kind === "folder" ? "Rename folder" : "Rename file"}
        value={renameDialog?.value ?? ""}
        onChange={(v) => setRenameDialog((r) => (r ? { ...r, value: v } : r))}
        onClose={() => setRenameDialog(null)}
        onSubmit={async (v) => {
          if (!renaming) return;
          if (renaming.kind === "file") {
            await renameFile.mutateAsync({ id: renaming.file.id, filename: withFileExt(v, renaming.file.filename), scope });
          } else {
            await renameFolder.mutateAsync({ id: renaming.folder.id, name: v, scope });
          }
          setRenameDialog(null);
        }}
      />

      <ConfirmModal
        open={!!trashAsk}
        title={trashAsk?.kind === "folder" ? "Move folder to trash?" : "Move file to trash?"}
        description={
          trashAsk?.kind === "folder"
            ? `"${trashAsk.folder.name}" and everything inside it will be moved to the trash. You can restore it from the Trash view.`
            : trashAsk
              ? `"${trashAsk.file.filename}" will be moved to the trash. You can restore it from the Trash view.`
              : ""
        }
        confirmLabel="Move to trash"
        confirmIcon={<Trash2 className="h-3.5 w-3.5" />}
        onClose={() => setTrashAsk(null)}
        onConfirm={async () => {
          if (!trashAsk) return;
          if (trashAsk.kind === "folder") await trashFolder.mutateAsync({ id: trashAsk.folder.id, scope });
          else await trashFile.mutateAsync({ id: trashAsk.file.id, scope });
          setTrashAsk(null);
        }}
      />
    </DriveListProvider>
  );
}

/** A clickable column header that toggles the sort. Clicking the active
 *  column flips direction; clicking another switches to it (asc). */
function SortHeader({
  label,
  col,
  sort,
  onSort,
  className,
  align = "left",
}: {
  label: string;
  col: DriveSortKey;
  sort: DriveSort;
  onSort: (s: DriveSort) => void;
  className?: string;
  align?: "left" | "right";
}) {
  const active = sort.key === col;
  return (
    <button
      type="button"
      onClick={() =>
        onSort(
          active
            ? { key: col, dir: sort.dir === "asc" ? "desc" : "asc" }
            : { key: col, dir: "asc" }
        )
      }
      className={cn(
        "flex items-center gap-1 uppercase tracking-wide transition hover:text-[var(--text)]",
        active && "text-[var(--text)]",
        align === "right" && "justify-end text-right",
        className
      )}
    >
      <span>{label}</span>
      {active &&
        (sort.dir === "asc" ? (
          <ArrowUp className="h-3 w-3" />
        ) : (
          <ArrowDown className="h-3 w-3" />
        ))}
    </button>
  );
}

/** In-place filename editor for a Drive list row. Enter or blur commits a
 *  changed name; Escape cancels. A guard ref stops Enter→blur double-firing
 *  the commit. */
const SORT_LABELS: Record<DriveSortKey, string> = {
  name: "Name",
  modified: "Last modified",
  size: "Size",
};

/** Compact sort picker. Works in both list and grid (the list also has
 *  clickable column headers, but this keeps sorting reachable in grid
 *  view and on mobile). */
function SortControl({
  sort,
  onChange,
}: {
  sort: DriveSort;
  onChange: (s: DriveSort) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  usePopoverDismiss(open, ref, () => setOpen(false));

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Sort"
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 text-xs text-[var(--text-muted)] transition hover:text-[var(--text)]"
      >
        <ArrowDownUp className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{SORT_LABELS[sort.key]}</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-30 w-44 overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)] py-1 text-sm shadow-lg"
        >
          {(Object.keys(SORT_LABELS) as DriveSortKey[]).map((key) => {
            const active = sort.key === key;
            return (
              <button
                key={key}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() =>
                  onChange(
                    active
                      ? { key, dir: sort.dir === "asc" ? "desc" : "asc" }
                      : { key, dir: "asc" }
                  )
                }
                className={cn(
                  "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left transition hover:bg-[var(--hover)]",
                  active && "text-[var(--accent-text)]"
                )}
              >
                <span>{SORT_LABELS[key]}</span>
                {active &&
                  (sort.dir === "asc" ? (
                    <ArrowUp className="h-3.5 w-3.5" />
                  ) : (
                    <ArrowDown className="h-3.5 w-3.5" />
                  ))}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Small slider that "zooms" the grid tiles, like a drive's icon-size
 *  control. Hidden in list view (the caller only renders it for grid). */
function GridSizeSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label
      className="hidden items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 sm:inline-flex"
      title="Icon size"
    >
      <LayoutGrid className="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
      <input
        type="range"
        min={GRID_TILE_MIN}
        max={GRID_TILE_MAX}
        step={4}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Grid icon size"
        className="h-8 w-20 cursor-ew-resize accent-[var(--accent)]"
      />
    </label>
  );
}

function InlinePromptModal({
  open,
  title,
  value,
  onChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
  onSubmit: (v: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(trimmed);
    } catch (e) {
      setErr(extractError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            loading={busy}
            disabled={!value.trim()}
          >
            Save
          </Button>
        </>
      }
    >
      <input
        autoFocus
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        className="w-full rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
      />
      {err && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{err}</p>}
    </Modal>
  );
}

function ConfirmModal({
  open,
  title,
  description,
  confirmLabel,
  confirmIcon,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  confirmIcon?: React.ReactNode;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onConfirm();
    } catch (e) {
      setErr(extractError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={run}
            loading={busy}
            leftIcon={confirmIcon}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-[var(--text-muted)]">{description}</p>
      {err && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{err}</p>}
    </Modal>
  );
}

/**
 * Thin wrapper used by the ``/files/shared`` route. Pins ``scope``
 * to ``"shared"`` so the page renders the peer-to-peer Shared view:
 * folders/files shared *with* the caller (by other Promptly users)
 * **plus** the caller's own folders/files that have at least one
 * outstanding grant. Mirrors the wrapper pattern used for Trash /
 * Starred / Recent so every Drive surface keeps one canonical
 * implementation.
 */
export function SharedWithMePage() {
  return (
    <FilesPage
      forcedScope="shared"
      title="Shared"
      subtitle="Folders and files shared with you, or by you, with other Promptly users."
    />
  );
}

function useSharedFilesPickup() {
  const navigate = useNavigate();
  const startUploads = useUploadStore((s) => s.startUploads);
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("shared")) return;
    let cancelled = false;
    void (async () => {
      const { takeSharedFiles } = await import("@/lib/shareTargetStash");
      const files = await takeSharedFiles();
      if (cancelled) return;
      navigate("/files", { replace: true });
      if (!files.length) return;
      // Photos and videos go where the phone's backups do — Camera Uploads,
      // by month taken, not twice (WP-8.5); anything else to My files.
      const isMedia = (f: File) => /^(image|video)\//.test(f.type) || /\.(heic|heif|mov)$/i.test(f.name);
      const media = files.filter(isMedia);
      const other = files.filter((f) => !isMedia(f));
      if (media.length) startUploads({ files: media, scope: "mine", folderId: null, route: "camera" });
      if (other.length) startUploads({ files: other, scope: "mine", folderId: null });
      const n = files.length;
      toast.info(
        other.length === 0
          ? `Uploading ${n} shared photo${n === 1 ? "" : "s"} to Camera Uploads…`
          : `Uploading ${n} shared file${n === 1 ? "" : "s"}…`,
      );
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function workspaceSkipNote(n: number): string {
  return `${n} item${n === 1 ? " belongs" : "s belong"} to a workspace and ${n === 1 ? "was" : "were"} left alone — manage ${n === 1 ? "it" : "them"} from the workspace.`;
}
