import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  Check,
  ChevronRight,
  Download,
  Eye,
  FileText,
  Folder as FolderClosedIcon,
  FolderInput,
  FolderPlus,
  Home,
  LayoutGrid,
  List as ListIcon,
  MoreVertical,
  Pencil,
  Plus,
  Share2,
  Star,
  Trash2,
  Upload,
} from "lucide-react";

import {
  filesApi,
  isDocumentFile,
  type DriveSort,
  type DriveSortKey,
  type FileItem,
  type FileScope,
  type FolderItem,
  type SystemFolderKind,
} from "@/api/files";
import { ContextMenu, type ContextMenuItem } from "@/components/files/ContextMenu";
import { DocumentEditorModal } from "@/components/files/documents/DocumentEditorModal";
import { DriveDetailsPanel } from "@/components/files/DriveDetailsPanel";
import { DriveFolderTree } from "@/components/files/DriveFolderTree";
import { DriveSubNav } from "@/components/files/DriveSubNav";
import { FilePreviewModal } from "@/components/files/FilePreviewModal";
import { FilesTopNavSearch } from "@/components/files/FilesTopNavSearch";
import { GranteesPill } from "@/components/files/GranteesPill";
import { MoveItemModal } from "@/components/files/MoveItemModal";
import { ShareGrantsModal } from "@/components/files/ShareGrantsModal";
import { documentsApi } from "@/api/documents";
import {
  downloadAuthed,
  extractError,
  formatRelativeTime,
  humanSize,
  kindLabel,
} from "@/components/files/helpers";
import { DriveItemIcon } from "@/components/files/DriveItemIcon";
import { DriveSelectionBar } from "@/components/files/DriveSelectionBar";
import { DriveThumb } from "@/components/files/DriveThumb";
import { TopNav } from "@/components/layout/TopNav";
import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import { Modal } from "@/components/shared/Modal";
import { Skeleton } from "@/components/shared/Skeleton";
import {
  useBrowseFiles,
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
} from "@/hooks/useFiles";
import { usePopoverDismiss } from "@/hooks/usePopoverDismiss";
import { useUploadStore } from "@/store/uploadStore";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

const DRAG_FILE = "application/x-promptly-file";
const DRAG_FOLDER = "application/x-promptly-folder";
const DRAG_SOURCE_PARENT = "application/x-promptly-source-parent";

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

interface DragPayload {
  kind: "file" | "folder";
  id: string;
  sourceParent: string | null;
}

function readDragPayload(dt: DataTransfer): DragPayload | null {
  const fileId = dt.getData(DRAG_FILE);
  if (fileId) {
    return {
      kind: "file",
      id: fileId,
      sourceParent: dt.getData(DRAG_SOURCE_PARENT) || null,
    };
  }
  const folderId = dt.getData(DRAG_FOLDER);
  if (folderId) {
    return {
      kind: "folder",
      id: folderId,
      sourceParent: dt.getData(DRAG_SOURCE_PARENT) || null,
    };
  }
  return null;
}

function dragHasItem(dt: DataTransfer): boolean {
  const types = Array.from(dt.types || []);
  return types.includes(DRAG_FILE) || types.includes(DRAG_FOLDER);
}

interface MoveModalState {
  open: boolean;
  kind: "file" | "folder";
  id: string;
  name: string;
  currentParentId: string | null;
}

interface DropOutcome {
  ok: boolean;
  error?: string;
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

  const [scope, setScope] = useState<FileScope>(forcedScope ?? "mine");
  const [folderId, setFolderId] = useState<string | null>(routeFolderId);

  // Sync scope + folderId whenever the caller's ``forcedScope`` prop
  // or the URL route param changes. Without this, clicking a sidebar
  // link after navigating into a subfolder wouldn't reset the view.
  useEffect(() => {
    if (forcedScope && scope !== forcedScope) setScope(forcedScope);
  }, [forcedScope, scope]);
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
  const { data, isLoading, isError, error, refetch } = useBrowseFiles(
    scope,
    folderId,
    sort
  );

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
  // Bumped after a folder mutation so the persistent folder-tree rail
  // reloads its top level. ``refreshAll`` pairs it with the browse refetch.
  const [treeVersion, setTreeVersion] = useState(0);
  const refreshAll = useCallback(() => {
    void refetch();
    setTreeVersion((v) => v + 1);
  }, [refetch]);

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
    } | null
  >(null);
  const [editingDoc, setEditingDoc] = useState<FileItem | null>(null);

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
        next.has(id) ? next.delete(id) : next.add(id);
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
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    },
    [selectRangeTo]
  );
  const clearSelection = useCallback(() => {
    setSelFiles(new Set());
    setSelFolders(new Set());
  }, []);

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
      await bulkTrash.mutateAsync(bulkIds());
      toast.success(`Moved ${count} item${count === 1 ? "" : "s"} to trash`);
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
      const count = selFiles.size + selFolders.size;
      await bulkMove.mutateAsync({
        ...bulkIds(),
        target_folder_id: target,
        move_to_root: target === null,
      });
      toast.success(`Moved ${count} item${count === 1 ? "" : "s"}`);
      setBulkMoveOpen(false);
      clearSelection();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selFiles, selFolders, bulkMove, clearSelection]
  );

  // Drive-style keyboard shortcuts: Ctrl/Cmd+A select all, Esc clear,
  // Delete/Backspace move the selection to trash. Ignored while typing
  // in a field or when a modal/picker owns the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
      const mod = e.ctrlKey || e.metaKey;
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
  }, [data, selFiles, selFolders, clearSelection, handleBulkTrash]);

  const navigateToFolder = useCallback(
    (id: string | null) => {
      // Keep URLs deep-linkable: sidebar / Drive PWA start_url both
      // depend on every folder having its own path. Within the same
      // top-level view we just swap the route so history works.
      if (id) navigate(`/files/folder/${id}`);
      else navigate("/files");
    },
    [navigate]
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
        if (payload.kind === "file") {
          await moveFile.mutateAsync({
            id: payload.id,
            folderId: targetFolderId,
            scope,
          });
        } else {
          await moveFolder.mutateAsync({
            id: payload.id,
            parentId: targetFolderId,
            scope,
          });
        }
        return { ok: true };
      } catch (e) {
        const msg = extractError(e);
        toast.error(msg);
        return { ok: false, error: msg };
      }
    },
    [moveFile, moveFolder, scope, writable]
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
    const dropped = Array.from(e.dataTransfer.files || []);
    if (dropped.length === 0) return;
    startUploads({ files: dropped, scope, folderId });
    toast.info(
      `Uploading ${dropped.length} file${dropped.length === 1 ? "" : "s"}…`
    );
    void refetch();
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
    startUploads({ files, scope, folderId });
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

      <div className="flex min-h-0 flex-1">
        {/* Persistent folder-tree rail — the two-pane "navigate the
            hierarchy without drilling through breadcrumbs" affordance that
            makes Files read like a real drive. Desktop-only; on mobile the
            breadcrumb + sub-nav carry navigation. */}
        <aside className="promptly-scroll hidden w-60 shrink-0 overflow-y-auto border-r border-[var(--border)] bg-[var(--surface)]/30 lg:block">
          <DriveFolderTree
            scope={scope}
            currentFolderId={folderId}
            onNavigate={navigateToFolder}
            version={treeVersion}
          />
        </aside>

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
              <Upload className="h-7 w-7 text-[var(--accent)]" />
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
          {selectionCount > 1 && (
            <DriveSelectionBar
              count={selectionCount}
              busy={bulkBusy}
              onClear={clearSelection}
              onDownload={() => void handleBulkDownload()}
              onStar={() => void handleBulkStar(true)}
              onUnstar={() => void handleBulkStar(false)}
              onMove={writable ? () => setBulkMoveOpen(true) : undefined}
              onTrash={() => void handleBulkTrash()}
            />
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
                if (isDocumentFile(f) && !f.trashed_at) {
                  setEditingDoc(f);
                } else {
                  setPreview(f);
                }
              }}
              onShare={setShareGrantsFor}
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
                  if (isDocumentFile(detailFile) && !detailFile.trashed_at) {
                    setEditingDoc(detailFile);
                  } else {
                    setPreview(detailFile);
                  }
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
                    supportsEdit: isDocumentFile(detailFile),
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
          await createFolderPage.mutateAsync({ scope, name, parentId: folderId });
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
              });
            } else {
              await moveFolder.mutateAsync({
                id: moveModal.id,
                parentId: target,
                scope,
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
            supportsEdit: isDocumentFile(f),
          })
        }
        onEdit={(f) => {
          setEditingDoc(f);
          setPreview(null);
        }}
        onCopyToMine={async (f) => {
          // Drive stage 5 — recipient with ``can_copy`` clones a
          // shared file into their own drive root. Refetch all
          // ``files`` queries so the new row appears in My files
          // immediately.
          try {
            await filesApi.copyFileToMine(f.id);
            void qc.invalidateQueries({ queryKey: ["files"] });
            void qc.invalidateQueries({ queryKey: ["quota"] });
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

      <ShareGrantsModal
        open={!!shareGrantsFor}
        resource={
          shareGrantsFor
            ? {
                type: shareGrantsFor.kind,
                id: shareGrantsFor.id,
                name: shareGrantsFor.name,
                supports_edit: shareGrantsFor.supportsEdit ?? false,
              }
            : null
        }
        onClose={() => setShareGrantsFor(null)}
        onChanged={() => {
          // Pill data lives on file/folder rows; refetch the active
          // browse view so the chips reflect the latest grants.
          void qc.invalidateQueries({ queryKey: ["files"] });
          void qc.invalidateQueries({ queryKey: ["workspace-files"] });
        }}
      />

      {editingDoc && (
        <DocumentEditorModal
          file={editingDoc}
          onClose={() => setEditingDoc(null)}
          onFileUpdated={(f) => setEditingDoc(f)}
        />
      )}
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

function FolderActions({
  scope,
  parentId,
  onChanged,
}: {
  scope: FileScope;
  parentId: string | null;
  onChanged: () => void;
}) {
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [creatingDoc, setCreatingDoc] = useState(false);
  const [activeDocument, setActiveDocument] = useState<FileItem | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  usePopoverDismiss(menuOpen, menuRef, () => setMenuOpen(false));
  const createFolder = useCreateFolder();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const startUploads = useUploadStore((s) => s.startUploads);

  const handleNewDocument = async () => {
    if (creatingDoc) return;
    setCreatingDoc(true);
    try {
      const doc = await documentsApi.create({
        scope,
        folder_id: parentId,
      });
      setActiveDocument(doc);
      onChanged();
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setCreatingDoc(false);
    }
  };

  // Multi-file: picking five files kicks off five uploads that
  // progress in parallel in the background panel. We intentionally
  // don't ``await`` anything here — the store owns the lifetime now,
  // so the Upload button stays snappy even on very large batches.
  const handlePickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files;
    if (!selected || selected.length === 0) {
      e.target.value = "";
      return;
    }
    // IMPORTANT: materialise the FileList into a plain array BEFORE
    // resetting ``e.target.value``. The ``files`` collection is live —
    // setting ``value = ""`` drains it in place (per the HTML spec),
    // which previously left ``startUploads`` with a zero-length array
    // and silently dropped every upload on the floor.
    const fileArray = Array.from(selected);
    e.target.value = "";
    startUploads({
      files: fileArray,
      scope,
      folderId: parentId,
    });
    // ``onChanged`` still fires so the current folder view refetches
    // immediately; completed uploads will pop in as the queue drains.
    onChanged();
  };

  return (
    // One primary "+ New" affordance (upload / new folder / new document)
    // — clean on desktop and on mobile, where three stacked buttons used
    // to chew up a third of the screen.
    <div ref={menuRef} className="relative shrink-0">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handlePickFiles}
      />
      <Button
        size="sm"
        variant="primary"
        leftIcon={<Plus className="h-3.5 w-3.5" />}
        onClick={() => setMenuOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        New
      </Button>
      {menuOpen && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-30 w-48 overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)] py-1 text-sm shadow-lg"
        >
          <NewMenuItem
            icon={<Upload className="h-4 w-4" />}
            label="Upload files"
            onClick={() => {
              setMenuOpen(false);
              fileInputRef.current?.click();
            }}
          />
          <NewMenuItem
            icon={<FolderPlus className="h-4 w-4" />}
            label="New folder"
            onClick={() => {
              setMenuOpen(false);
              setShowNewFolder(true);
            }}
          />
          <NewMenuItem
            icon={<FileText className="h-4 w-4" />}
            label="New document"
            onClick={() => {
              setMenuOpen(false);
              void handleNewDocument();
            }}
          />
        </div>
      )}

      <NewFolderModal
        open={showNewFolder}
        onClose={() => setShowNewFolder(false)}
        onSubmit={async (name) => {
          await createFolder.mutateAsync({ scope, name, parentId });
          onChanged();
          setShowNewFolder(false);
        }}
      />

      {activeDocument && (
        <DocumentEditorModal
          file={activeDocument}
          onClose={() => {
            setActiveDocument(null);
            onChanged();
          }}
          onFileUpdated={(updated) => setActiveDocument(updated)}
        />
      )}
    </div>
  );
}

function NewMenuItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-[var(--hover)]"
    >
      <span className="text-[var(--text-muted)]">{icon}</span>
      {label}
    </button>
  );
}

function NewFolderModal({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(trimmed);
      setName("");
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
      title="New folder"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} size="sm">
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            loading={busy}
            disabled={!name.trim()}
          >
            Create
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block text-[var(--text-muted)]">Folder name</span>
          <input
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
            placeholder="Research papers"
          />
        </label>
        {err && <p className="text-sm text-red-600 dark:text-red-400">{err}</p>}
      </form>
    </Modal>
  );
}

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
  onDropOnFolder: (
    targetFolderId: string | null,
    payload: DragPayload
  ) => Promise<DropOutcome>;
  onOpenMove: (s: MoveModalState) => void;
  onPreview: (file: FileItem) => void;
  /** Share action — opens the peer-to-peer grants modal.
   *  ``supportsEdit`` is forwarded so the modal knows whether to
   *  surface the "Editor" tier; only Drive Documents accept it. */
  onShare: (r: {
    kind: "file" | "folder";
    id: string;
    name: string;
    supportsEdit?: boolean;
  }) => void;
}) {
  // System folders are grouped into a collapsible section pinned at the
  // bottom. Collapsed by default so they don't crowd the user's own
  // content — they're rarely the thing the user came here to find.
  const [systemOpen, setSystemOpen] = useState(false);

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

  // User-created folders respect the active sort; system-managed folders
  // are pinned to a separate "System" section at the bottom so they don't
  // crowd the user's own content or imply they can be renamed / trashed.
  const userFolders = data.folders.filter((f) => !f.system_kind);
  const systemFolders = data.folders.filter((f) => !!f.system_kind);

  const renderFolderRow = (f: (typeof data.folders)[number]) => (
    <FolderRow
      key={f.id}
      folder={f}
      scope={scope}
      layout={layout}
      writable={data.writable}
      currentFolderId={currentFolderId}
      selected={selFolders.has(f.id)}
      selectionActive={selFiles.size + selFolders.size > 0}
      onToggleSelect={(shift) => onToggleFolder(f.id, shift)}
      onOpen={() => onOpenFolder(f.id)}
      onDropOnFolder={onDropOnFolder}
      onOpenMove={onOpenMove}
      onShare={() => onShare({ kind: "folder", id: f.id, name: f.name })}
    />
  );

  const userFolderRows = userFolders.map(renderFolderRow);
  const systemFolderRows = systemFolders.map(renderFolderRow);
  const fileRows = data.files.map((f) => (
    <FileRow
      key={f.id}
      file={f}
      scope={scope}
      layout={layout}
      writable={data.writable}
      selected={selFiles.has(f.id)}
      selectionActive={selFiles.size + selFolders.size > 0}
      onToggleSelect={(shift) => onToggleFile(f.id, shift)}
      onOpenMove={onOpenMove}
      onPreview={() => onPreview(f)}
      onShare={() =>
        onShare({
          kind: "file",
          id: f.id,
          name: f.filename,
          supportsEdit: isDocumentFile(f),
        })
      }
    />
  ));

  if (layout === "grid") {
    return (
      <ul
        className="grid gap-3"
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(${gridTile}px, 1fr))`,
        }}
      >
        {userFolderRows}
        {fileRows}
        {systemFolderRows.length > 0 && (
          <>
            {/* Full-width collapsible divider before system folders. */}
            <li className="col-span-full">
              <button
                type="button"
                onClick={() => setSystemOpen((o) => !o)}
                aria-expanded={systemOpen}
                className="flex w-full items-center gap-2 pt-1 text-left"
              >
                <ChevronRight
                  className={cn(
                    "h-3 w-3 shrink-0 text-[var(--text-muted)] transition-transform",
                    systemOpen && "rotate-90"
                  )}
                />
                <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  System
                </span>
                <span className="text-[10px] tabular-nums text-[var(--text-muted)]/70">
                  {systemFolderRows.length}
                </span>
                <span className="flex-1 border-t border-[var(--border)]" />
              </button>
            </li>
            {systemOpen && systemFolderRows}
          </>
        )}
      </ul>
    );
  }

  return (
    <div className="rounded-card border border-[var(--border)] bg-[var(--surface)]">
      {/* Column header — clickable to sort, giving the list a tabular,
          drive-like read. ``sticky`` pins it to the top of the scroll
          viewport so rows scroll under it (Finder/Drive behaviour); the
          parent card therefore must NOT set ``overflow-hidden`` (it would
          clip the sticky positioning). Columns hide on small screens so
          the row collapses to name-only. */}
      <div className="sticky top-0 z-10 flex items-center gap-3 rounded-t-card border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        {/* Spacer matching the checkbox on user-folder rows. */}
        <span className="w-5 shrink-0" aria-hidden />
        <SortHeader
          className="flex-1"
          label="Name"
          col="name"
          sort={sort}
          onSort={onSort}
        />
        {/* Kind isn't a sort key, so it's a static label. */}
        <span className="hidden w-24 shrink-0 lg:block">Kind</span>
        <SortHeader
          className="hidden w-28 shrink-0 lg:block"
          label="Modified"
          col="modified"
          sort={sort}
          onSort={onSort}
        />
        <SortHeader
          className="hidden w-16 shrink-0 sm:block"
          align="right"
          label="Size"
          col="size"
          sort={sort}
          onSort={onSort}
        />
        {/* Spacer matching the row's fixed-width trailing action slot. */}
        <span className="w-16 shrink-0" aria-hidden />
      </div>
      <ul className="divide-y divide-[var(--border)]">
        {userFolderRows}
        {fileRows}
        {systemFolderRows.length > 0 && (
          <>
            {/* Collapsible section header separating system-managed folders
                (Chat Uploads, Generated Files, etc.) from the user's own
                content. Collapsed by default — these can't be renamed or
                trashed, and are rarely what the user came to find. */}
            <li>
              <button
                type="button"
                onClick={() => setSystemOpen((o) => !o)}
                aria-expanded={systemOpen}
                className="flex w-full items-center gap-1.5 bg-[var(--bg)] px-3 py-1.5 text-left transition hover:bg-[var(--hover)]"
              >
                <ChevronRight
                  className={cn(
                    "h-3 w-3 shrink-0 text-[var(--text-muted)] transition-transform",
                    systemOpen && "rotate-90"
                  )}
                />
                <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  System
                </span>
                <span className="text-[10px] tabular-nums text-[var(--text-muted)]/70">
                  {systemFolderRows.length}
                </span>
              </button>
            </li>
            {systemOpen && systemFolderRows}
          </>
        )}
      </ul>
    </div>
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
function InlineRenameField({
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
      className="min-w-0 flex-1 rounded border border-[var(--accent)] bg-[var(--bg)] px-1.5 py-0.5 text-sm text-[var(--text)] outline-none"
    />
  );
}

function FolderRow({
  folder,
  scope,
  layout,
  writable,
  currentFolderId,
  selected,
  selectionActive,
  onToggleSelect,
  onOpen,
  onDropOnFolder,
  onOpenMove,
  onShare,
}: {
  folder: FolderItem;
  scope: FileScope;
  layout: ViewMode;
  writable: boolean;
  currentFolderId: string | null;
  selected: boolean;
  selectionActive: boolean;
  onToggleSelect: (shift: boolean) => void;
  onOpen: () => void;
  onDropOnFolder: (
    targetFolderId: string | null,
    payload: DragPayload
  ) => Promise<DropOutcome>;
  onOpenMove: (s: MoveModalState) => void;
  onShare: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const [rename, setRename] = useState<{ open: boolean; value: string }>({
    open: false,
    value: folder.name,
  });
  const [trashOpen, setTrashOpen] = useState(false);
  const [over, setOver] = useState(false);
  const renameFolder = useRenameFolder();
  const trashFolder = useTrashFolder();
  const starFolder = useStarFolder();
  const unstarFolder = useUnstarFolder();
  // List view renames in place; grid keeps the modal (tiles are too small
  // for a comfortable inline field).
  const [editing, setEditing] = useState(false);
  const commitRename = (name: string) => {
    setEditing(false);
    if (name !== folder.name)
      void renameFolder.mutateAsync({ id: folder.id, name, scope });
  };

  const isSystem = folder.system_kind != null;
  const userCanMutate = writable && !isSystem;

  const mutationItems: ContextMenuItem[] = isSystem
    ? []
    : [
        folder.starred_at
          ? {
              icon: <Star className="h-3.5 w-3.5" />,
              label: "Unstar",
              onClick: () => unstarFolder.mutate({ id: folder.id, scope }),
              disabled: !writable,
            }
          : {
              icon: <Star className="h-3.5 w-3.5" />,
              label: "Star",
              onClick: () => starFolder.mutate({ id: folder.id, scope }),
              disabled: !writable,
            },
        {
          icon: <Share2 className="h-3.5 w-3.5" />,
          label: "Share",
          onClick: onShare,
          disabled: !writable,
        },
        {
          icon: <Pencil className="h-3.5 w-3.5" />,
          label: "Rename",
          onClick: () =>
            layout === "grid"
              ? setRename({ open: true, value: folder.name })
              : setEditing(true),
          disabled: !writable,
        },
        {
          icon: <FolderInput className="h-3.5 w-3.5" />,
          label: "Move to…",
          onClick: () =>
            onOpenMove({
              open: true,
              kind: "folder",
              id: folder.id,
              name: folder.name,
              currentParentId: folder.parent_id,
            }),
          disabled: !writable,
        },
        {
          icon: <Trash2 className="h-3.5 w-3.5" />,
          label: "Trash",
          destructive: true,
          onClick: () => setTrashOpen(true),
          disabled: !writable,
        },
      ];
  const items: ContextMenuItem[] = [
    {
      icon: <FolderClosedIcon className="h-3.5 w-3.5" />,
      label: "Open",
      onClick: onOpen,
    },
    ...mutationItems,
  ];

  const allowDrop = (e: React.DragEvent) => {
    if (!writable) return false;
    return dragHasItem(e.dataTransfer);
  };

  const dragProps = {
    draggable: userCanMutate,
    onDragStart: (e: React.DragEvent) => {
      if (!userCanMutate) return;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(DRAG_FOLDER, folder.id);
      e.dataTransfer.setData(DRAG_SOURCE_PARENT, folder.parent_id ?? "");
    },
    onDragEnter: (e: React.DragEvent) => {
      if (allowDrop(e)) setOver(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (allowDrop(e)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setOver(false);
    },
    onDrop: async (e: React.DragEvent) => {
      if (!allowDrop(e)) return;
      e.preventDefault();
      setOver(false);
      const payload = readDragPayload(e.dataTransfer);
      if (!payload) return;
      await onDropOnFolder(folder.id, payload);
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      setCtx({ x: e.clientX, y: e.clientY });
    },
  };

  const overlays = (
    <>
      <ContextMenu
        open={ctx !== null}
        x={ctx?.x ?? 0}
        y={ctx?.y ?? 0}
        items={items}
        onClose={() => setCtx(null)}
      />

      <InlinePromptModal
        open={rename.open}
        title="Rename folder"
        value={rename.value}
        onChange={(v) => setRename((r) => ({ ...r, value: v }))}
        onClose={() => setRename({ open: false, value: folder.name })}
        onSubmit={async (v) => {
          await renameFolder.mutateAsync({ id: folder.id, name: v, scope });
          setRename({ open: false, value: v });
        }}
      />

      <ConfirmModal
        open={trashOpen}
        title="Move folder to trash?"
        description={`"${folder.name}" and everything inside it will be moved to the trash. You can restore it from the Trash view.`}
        confirmLabel="Move to trash"
        confirmIcon={<Trash2 className="h-3.5 w-3.5" />}
        onClose={() => setTrashOpen(false)}
        onConfirm={async () => {
          await trashFolder.mutateAsync({ id: folder.id, scope });
          setTrashOpen(false);
        }}
      />
    </>
  );

  if (layout === "grid") {
    return (
      <li
        {...dragProps}
        onDoubleClick={onOpen}
        className={cn(
          "group relative flex flex-col rounded-card border bg-[var(--surface)] p-3 transition",
          "hover:border-[var(--accent)]/60 hover:shadow-sm",
          selected
            ? "border-[var(--accent)] ring-1 ring-inset ring-[var(--accent)]/40"
            : "border-[var(--border)]",
          userCanMutate && "cursor-grab",
          over &&
            "border-[var(--accent)]/60 bg-[var(--accent)]/10 ring-1 ring-inset ring-[var(--accent)]/40"
        )}
      >
        {userCanMutate && (
          <SelectCheckbox
            checked={selected}
            active={selectionActive}
            onToggle={onToggleSelect}
            className="absolute left-1.5 top-1.5"
          />
        )}
        {userCanMutate && (
          <div className="absolute right-1 top-1 opacity-0 transition group-hover:opacity-100">
            <RowMenu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              items={mutationItems}
            />
          </div>
        )}
        <button
          onClick={onOpen}
          className="flex w-full flex-1 flex-col gap-2 text-left"
          title={isSystem ? systemFolderTooltip(folder.system_kind!) : undefined}
        >
          <div className="flex aspect-square w-full items-center justify-center rounded-md bg-[var(--bg)]">
            <DriveItemIcon
              folder={folder}
              className="h-12 w-12"
            />
          </div>
          <span className="line-clamp-2 w-full break-words text-sm font-medium">
            {folder.name}
          </span>
        </button>
        <div className="mt-1.5 flex min-h-[18px] items-center justify-center gap-1">
          {folder.starred_at && (
            <Star className="h-3.5 w-3.5 shrink-0 fill-yellow-400 text-yellow-400" />
          )}
          {isSystem && (
            <span className="rounded bg-[var(--text-muted)]/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
              system
            </span>
          )}
          {currentFolderId !== null && currentFolderId === folder.id && (
            <span className="rounded bg-[var(--text-muted)]/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              current
            </span>
          )}
          {folder.sharing && (
            <GranteesPill
              sharing={folder.sharing}
              variant="compact"
              className="shrink-0"
              onClick={
                folder.sharing.role === "owner"
                  ? (e) => {
                      e.stopPropagation();
                      onShare();
                    }
                  : undefined
              }
            />
          )}
        </div>
        {overlays}
      </li>
    );
  }

  return (
    <li
      {...dragProps}
      className={cn(
        "group flex items-center gap-3 px-3 py-2 transition",
        selected ? "bg-[var(--accent)]/10" : "hover:bg-[var(--hover)]",
        userCanMutate && "cursor-grab",
        over && "bg-[var(--accent)]/10 ring-1 ring-inset ring-[var(--accent)]/40"
      )}
    >
      {/* Checkbox — only for user-owned folders. A spacer keeps the
          name column aligned with file rows and user folder rows. */}
      {userCanMutate ? (
        <SelectCheckbox
          checked={selected}
          active={selectionActive}
          onToggle={onToggleSelect}
        />
      ) : (
        <span className="w-5 shrink-0" aria-hidden />
      )}
      {editing ? (
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <DriveItemIcon folder={folder} />
          <InlineRenameField
            initial={folder.name}
            onCommit={commitRename}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
      <button
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        title={isSystem ? systemFolderTooltip(folder.system_kind!) : undefined}
      >
        <DriveItemIcon folder={folder} />
        <span className="truncate text-sm font-medium">{folder.name}</span>
        {folder.starred_at && (
          <Star className="h-3.5 w-3.5 shrink-0 fill-yellow-400 text-yellow-400" />
        )}
        {isSystem && (
          /* Muted badge — system is informational, not interactive,
             so avoid using the accent colour that implies clickability. */
          <span className="rounded bg-[var(--text-muted)]/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
            system
          </span>
        )}
        {currentFolderId !== null && currentFolderId === folder.id && (
          <span className="rounded bg-[var(--text-muted)]/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
            current
          </span>
        )}
      </button>
      )}

      {/* Kind / Modified columns line up with file rows; folders have
          no size so that column stays blank. */}
      <span className="hidden w-24 shrink-0 truncate text-xs text-[var(--text-muted)] lg:block">
        Folder
      </span>
      <span className="hidden w-28 shrink-0 text-xs text-[var(--text-muted)] lg:block">
        {folder.updated_at ? formatRelativeTime(folder.updated_at) : ""}
      </span>
      <span className="hidden w-16 shrink-0 sm:block" aria-hidden />

      {/* Drive stage 5 — peer-to-peer share grants. Sits inline at
          the right edge (just left of the row menu). Owners get a
          clickable pill so "manage sharing" is one tap away;
          grantees see the same pill but non-interactive (they can't
          change grants they're a recipient of — only the owner can).
          Clicking deliberately stops propagation so the row's
          folder-open doesn't also fire. */}
      {folder.sharing && (
        <GranteesPill
          sharing={folder.sharing}
          variant="compact"
          className="ml-auto shrink-0"
          onClick={
            folder.sharing.role === "owner"
              ? (e) => {
                  e.stopPropagation();
                  onShare();
                }
              : undefined
          }
        />
      )}

      {/* Fixed-width action slot — only user-owned folders get a menu, but
          the slot is always reserved so Kind/Modified/Size stay aligned
          with file rows (which carry a download button here) and the
          column header. */}
      <div className="flex w-16 shrink-0 items-center justify-end">
        {userCanMutate && (
          <RowMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            items={mutationItems}
          />
        )}
      </div>

      {overlays}
    </li>
  );
}

function FileRow({
  file,
  scope,
  layout,
  writable,
  selected,
  selectionActive,
  onToggleSelect,
  onOpenMove,
  onPreview,
  onShare,
}: {
  file: FileItem;
  scope: FileScope;
  layout: ViewMode;
  writable: boolean;
  selected: boolean;
  selectionActive: boolean;
  onToggleSelect: (shift: boolean) => void;
  onOpenMove: (s: MoveModalState) => void;
  onPreview: () => void;
  onShare: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const [rename, setRename] = useState<{ open: boolean; value: string }>({
    open: false,
    value: file.filename,
  });
  const [trashOpen, setTrashOpen] = useState(false);
  const renameFile = useRenameFile();
  const trashFile = useTrashFile();
  const starFile = useStarFile();
  const unstarFile = useUnstarFile();
  // List view renames in place; grid keeps the modal.
  const [editing, setEditing] = useState(false);
  const commitRename = (name: string) => {
    setEditing(false);
    if (name !== file.filename)
      void renameFile.mutateAsync({ id: file.id, filename: name, scope });
  };

  const mutationItems: ContextMenuItem[] = [
    {
      icon: <Eye className="h-3.5 w-3.5" />,
      label: "Preview",
      onClick: onPreview,
    },
    {
      icon: <Download className="h-3.5 w-3.5" />,
      label: "Download",
      onClick: () => downloadAuthed(file),
    },
    file.starred_at
      ? {
          icon: <Star className="h-3.5 w-3.5" />,
          label: "Unstar",
          onClick: () => unstarFile.mutate({ id: file.id, scope }),
          disabled: !writable,
        }
      : {
          icon: <Star className="h-3.5 w-3.5" />,
          label: "Star",
          onClick: () => starFile.mutate({ id: file.id, scope }),
          disabled: !writable,
        },
    {
      icon: <Share2 className="h-3.5 w-3.5" />,
      label: "Share",
      onClick: onShare,
      disabled: !writable,
    },
    {
      icon: <Pencil className="h-3.5 w-3.5" />,
      label: "Rename",
      onClick: () =>
        layout === "grid"
          ? setRename({ open: true, value: file.filename })
          : setEditing(true),
      disabled: !writable,
    },
    {
      icon: <FolderInput className="h-3.5 w-3.5" />,
      label: "Move to…",
      onClick: () =>
        onOpenMove({
          open: true,
          kind: "file",
          id: file.id,
          name: file.filename,
          currentParentId: file.folder_id,
        }),
      disabled: !writable,
    },
    {
      icon: <Trash2 className="h-3.5 w-3.5" />,
      label: "Trash",
      destructive: true,
      onClick: () => setTrashOpen(true),
      disabled: !writable,
    },
  ];

  const dragProps = {
    draggable: writable,
    onDragStart: (e: React.DragEvent) => {
      if (!writable) return;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(DRAG_FILE, file.id);
      e.dataTransfer.setData(DRAG_SOURCE_PARENT, file.folder_id ?? "");
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      setCtx({ x: e.clientX, y: e.clientY });
    },
    onDoubleClick: onPreview,
  };

  const overlays = (
    <>
      <ContextMenu
        open={ctx !== null}
        x={ctx?.x ?? 0}
        y={ctx?.y ?? 0}
        items={mutationItems}
        onClose={() => setCtx(null)}
      />

      <InlinePromptModal
        open={rename.open}
        title="Rename file"
        value={rename.value}
        onChange={(v) => setRename((r) => ({ ...r, value: v }))}
        onClose={() => setRename({ open: false, value: file.filename })}
        onSubmit={async (v) => {
          await renameFile.mutateAsync({ id: file.id, filename: v, scope });
          setRename({ open: false, value: v });
        }}
      />

      <ConfirmModal
        open={trashOpen}
        title="Move file to trash?"
        description={`"${file.filename}" will be moved to the trash. You can restore it from the Trash view.`}
        confirmLabel="Move to trash"
        confirmIcon={<Trash2 className="h-3.5 w-3.5" />}
        onClose={() => setTrashOpen(false)}
        onConfirm={async () => {
          await trashFile.mutateAsync({ id: file.id, scope });
          setTrashOpen(false);
        }}
      />
    </>
  );

  if (layout === "grid") {
    return (
      <li
        {...dragProps}
        className={cn(
          "group relative flex flex-col rounded-card border bg-[var(--surface)] p-3 transition",
          "hover:border-[var(--accent)]/60 hover:shadow-sm",
          selected
            ? "border-[var(--accent)] ring-1 ring-inset ring-[var(--accent)]/40"
            : "border-[var(--border)]",
          writable && "cursor-grab"
        )}
      >
        {writable && (
          <SelectCheckbox
            checked={selected}
            active={selectionActive}
            onToggle={onToggleSelect}
            className="absolute left-1.5 top-1.5"
          />
        )}
        {writable && (
          <div className="absolute right-1 top-1 opacity-0 transition group-hover:opacity-100">
            <RowMenu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              items={mutationItems.filter((it) => !it.disabled)}
            />
          </div>
        )}
        <button
          onClick={onPreview}
          className="flex w-full flex-1 flex-col gap-2 text-left"
          title={file.filename}
        >
          <DriveThumb
            file={file}
            className="aspect-square w-full rounded-md border border-[var(--border)]"
          />
          <span className="line-clamp-2 w-full break-words text-sm font-medium">
            {file.filename}
          </span>
          <span className="text-[10px] text-[var(--text-muted)]">
            {humanSize(file.size_bytes)}
          </span>
        </button>
        <div className="mt-1.5 flex min-h-[18px] items-center justify-center gap-1">
          {file.starred_at && (
            <Star className="h-3.5 w-3.5 shrink-0 fill-yellow-400 text-yellow-400" />
          )}
          {file.sharing && (
            <GranteesPill
              sharing={file.sharing}
              variant="compact"
              className="shrink-0"
              onClick={
                file.sharing.role === "owner"
                  ? (e) => {
                      e.stopPropagation();
                      onShare();
                    }
                  : undefined
              }
            />
          )}
        </div>
        {overlays}
      </li>
    );
  }

  return (
    <li
      {...dragProps}
      className={cn(
        "group flex items-center gap-3 px-3 py-2 transition",
        selected ? "bg-[var(--accent)]/10" : "hover:bg-[var(--hover)]",
        writable && "cursor-grab"
      )}
    >
      {writable ? (
        <SelectCheckbox
          checked={selected}
          active={selectionActive}
          onToggle={onToggleSelect}
        />
      ) : (
        <span className="w-5 shrink-0" aria-hidden />
      )}
      {editing ? (
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <DriveItemIcon file={file} />
          <InlineRenameField
            initial={file.filename}
            onCommit={commitRename}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <button
          onClick={onPreview}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <DriveItemIcon file={file} />
          <span className="flex min-w-0 items-center gap-1.5 truncate text-sm">
            <span className="truncate">{file.filename}</span>
            {file.starred_at && (
              <Star className="h-3 w-3 shrink-0 fill-yellow-400 text-yellow-400" />
            )}
          </span>
        </button>
      )}

      {/* Tabular columns — desktop only; on mobile the name carries
          the row and the metadata is reachable via preview. */}
      <span className="hidden w-24 shrink-0 truncate text-xs text-[var(--text-muted)] lg:block">
        {kindLabel(file)}
      </span>
      <span className="hidden w-28 shrink-0 text-xs text-[var(--text-muted)] lg:block">
        {file.updated_at ? formatRelativeTime(file.updated_at) : ""}
      </span>
      <span className="hidden w-16 shrink-0 text-right text-xs tabular-nums text-[var(--text-muted)] sm:block">
        {humanSize(file.size_bytes)}
      </span>

      {/* Drive stage 5 — share-grants pill. Sits just left of the fixed
          action slot so it lines up with the same indicator on folder
          rows. Owner → pill opens the grants modal; grantee → read-
          only (same reason as FolderRow above). */}
      {file.sharing && (
        <GranteesPill
          sharing={file.sharing}
          variant="compact"
          className="shrink-0"
          onClick={
            file.sharing.role === "owner"
              ? (e) => {
                  e.stopPropagation();
                  onShare();
                }
              : undefined
          }
        />
      )}

      {/* Fixed-width action slot — download + menu. Matches the folder
          row + header width so Kind/Modified/Size line up across rows. */}
      <div className="flex w-16 shrink-0 items-center justify-end gap-1">
        <button
          onClick={() => downloadAuthed(file)}
          title="Download"
          aria-label={`Download ${file.filename}`}
          className="rounded-md p-1.5 text-[var(--text-muted)] opacity-0 transition hover:bg-[var(--hover)] hover:text-[var(--text)] group-hover:opacity-100"
        >
          <Download className="h-4 w-4" />
        </button>
        {writable && (
          <RowMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            items={mutationItems.filter((it) => !it.disabled)}
          />
        )}
      </div>

      {overlays}
    </li>
  );
}

/** Selection checkbox for a file/folder row. Hidden until the row is
 *  hovered (desktop) or selection mode is active, so it doesn't clutter
 *  the default browse view; always visible once checked. */
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
        !checked && !active && "opacity-0 group-hover:opacity-100",
        className
      )}
    >
      <Check className="h-3.5 w-3.5" />
    </button>
  );
}

function systemFolderTooltip(kind: SystemFolderKind): string {
  switch (kind) {
    case "chat_uploads":
      return "Files attached from chats land here automatically.";
    case "generated_root":
      return "Files generated by the assistant land in here.";
    case "generated_files":
      return "Generated documents (text, PDFs, code, etc.).";
    case "generated_media":
      return "Generated images, audio, and video.";
  }
}

function ViewToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
}) {
  const btn = (active: boolean, leading: boolean) =>
    cn(
      "px-2 py-1.5 transition",
      leading && "border-l border-[var(--border)]",
      active
        ? "bg-[var(--accent)]/15 text-[var(--accent)]"
        : "text-[var(--text-muted)] hover:bg-[var(--hover)]"
    );
  return (
    <div className="inline-flex shrink-0 items-stretch overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)]">
      <button
        type="button"
        aria-label="List view"
        aria-pressed={mode === "list"}
        title="List view"
        onClick={() => onChange("list")}
        className={btn(mode === "list", false)}
      >
        <ListIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label="Grid view"
        aria-pressed={mode === "grid"}
        title="Grid view"
        onClick={() => onChange("grid")}
        className={btn(mode === "grid", true)}
      >
        <LayoutGrid className="h-4 w-4" />
      </button>
    </div>
  );
}

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
                  active && "text-[var(--accent)]"
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

function RowMenu({
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
        onClick={() => onOpenChange(!open)}
        className="rounded-md p-1.5 text-[var(--text-muted)] hover:bg-black/[0.04] hover:text-[var(--text)] dark:hover:bg-white/[0.06]"
        aria-label="More actions"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => onOpenChange(false)}
          />
          <div className="absolute right-0 top-9 z-20 w-44 overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)] shadow-lg">
            {items.map((it, i) => (
              <button
                key={`${it.label}-${i}`}
                onClick={() => {
                  onOpenChange(false);
                  it.onClick();
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition",
                  it.destructive
                    ? "text-red-600 hover:bg-red-500/10 dark:text-red-400"
                    : "hover:bg-[var(--hover)]"
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
