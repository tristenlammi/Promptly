import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleAlert,
  Download,
  Eye,
  Folder,
  FolderInput,
  FolderPlus,
  HardDrive,
  Loader2,
  Pencil,
  Search,
  Trash2,
  Upload,
  X,
  Zap,
  ZapOff,
} from "lucide-react";

import { filesApi, type FileItem, type FolderItem } from "@/api/files";
import type { WorkspaceDriveFile, WorkspaceDriveFolder } from "@/api/workspaces";
import { ContextMenu, type ContextMenuItem } from "@/components/files/ContextMenu";
import { DriveItemList, type DriveListItem } from "@/components/files/DriveItemList";
import {
  DriveListHeader,
  DriveListProvider,
  fileEntry,
  folderEntry,
  type DriveEntry,
  type DriveListController,
} from "@/components/files/DriveItemRow";
import { FilePreviewModal } from "@/components/files/FilePreviewModal";
import { downloadAuthed, formatRelativeTime, humanSize } from "@/components/files/helpers";
import { NewFolderModal } from "@/components/files/NewMenu";
import { ViewToggle } from "@/components/files/ViewToggle";
import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import { EmptyState } from "@/components/shared/EmptyState";
import { Modal } from "@/components/shared/Modal";
import { UserAvatar } from "@/components/shared/UserAvatar";
import {
  useCreateDriveFolder,
  useDeleteDriveFolder,
  useMoveDriveFile,
  useRenameDriveFolder,
  useSetFileContext,
  useUnpinWorkspaceFile,
  useWorkspace,
  useWorkspaceDrive,
} from "@/hooks/useWorkspaces";
import { useUploadStore } from "@/store/uploadStore";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";
import { ContextBudgetBar } from "./WorkspaceSettingsDrawer";

// What the server accepts (R-212) — Office files since WP-4.3; .html
// stays out (stored-XSS on a shared host).
const ACCEPT =
  "image/*,audio/*,video/*,.pdf,.txt,.md,.markdown,.csv,.json,.log,.yaml,.yml,.xml,.docx,.xlsx,.pptx,.odt,.ods,.odp,.rtf,.heic,.heif";

const LAYOUT_KEY = "promptly.workspaceDrive.layout";

/**
 * A workspace's drive (WP-7.6, Part C §2.3) — the Files browser, scoped to
 * the workspace's own folder: the same rows and virtualised list (list or
 * grid), the same preview, and the same upload queue, so a workspace
 * upload is staged, checked, audited and shows in the upload panel like
 * any other.
 *
 * What's the workspace's own stays: everything here is context for its
 * chats — who added each file, whether it's indexed, and whether it's in
 * context (⚡) — and "Remove" takes a file out of the workspace (it stays
 * in the owner's Drive). Files live in the workspace owner's storage
 * whoever adds them.
 */
export function WorkspaceDrivePane({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const { data: drive, isLoading } = useWorkspaceDrive(workspaceId);
  const { data: workspace } = useWorkspace(workspaceId);
  const createFolder = useCreateDriveFolder(workspaceId);
  const renameFolder = useRenameDriveFolder(workspaceId);
  const deleteFolder = useDeleteDriveFolder(workspaceId);
  const moveFile = useMoveDriveFile(workspaceId);
  const unpin = useUnpinWorkspaceFile(workspaceId);
  const setContext = useSetFileContext(workspaceId);
  const startUploads = useUploadStore((s) => s.startUploads);

  // null = drive root.
  const [folderId, setFolderId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<FileItem | null>(null);
  const [moveTarget, setMoveTarget] = useState<string[] | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [renaming, setRenaming] = useState<WorkspaceDriveFolder | null>(null);
  const [menu, setMenu] = useState<{ entry: DriveEntry; x: number; y: number } | null>(null);
  const [layout, setLayout] = useState<"list" | "grid">(() => {
    try {
      return window.localStorage.getItem(LAYOUT_KEY) === "grid" ? "grid" : "list";
    } catch {
      return "list";
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(LAYOUT_KEY, layout);
    } catch {
      /* private mode */
    }
  }, [layout]);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const folders = useMemo(() => drive?.folders ?? [], [drive]);
  const files = useMemo(() => drive?.files ?? [], [drive]);
  const searching = query.trim().length > 0;

  // The drive's rows as Drive items — one object per row object, so the
  // memoised rows only re-render when a file changes (indexing, context…).
  const pinById = useMemo(() => new Map(files.map((f) => [f.file_id, f])), [files]);
  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);

  const childFolders = useMemo(
    () => (searching ? [] : folders.filter((f) => f.parent_id === folderId).sort((a, b) => a.name.localeCompare(b.name))),
    [folders, folderId, searching]
  );
  const visibleFiles = useMemo(() => {
    if (searching) {
      const q = query.trim().toLowerCase();
      return files.filter((f) => f.filename.toLowerCase().includes(q));
    }
    return files.filter((f) => f.folder_id === folderId);
  }, [files, folderId, query, searching]);

  const items = useMemo<DriveListItem[]>(
    () => [...childFolders.map((f) => folderEntry(asFolder(f))), ...visibleFiles.map((f) => fileEntry(asFile(f)))],
    [childFolders, visibleFiles]
  );

  // Breadcrumb trail root → current folder.
  const trail = useMemo(() => {
    const out: WorkspaceDriveFolder[] = [];
    let cur = folderId ? folderById.get(folderId) : undefined;
    for (let hops = 0; cur && hops < 32; hops++) {
      out.unshift(cur);
      cur = cur.parent_id ? folderById.get(cur.parent_id) : undefined;
    }
    return out;
  }, [folderById, folderId]);

  // Moving away from a folder (or searching) drops a selection there.
  useEffect(() => setSelected(new Set()), [folderId, searching]);

  const upload = useCallback(
    (picked: FileList | File[]) => {
      const list = Array.from(picked);
      if (!list.length) return;
      // The one upload queue (WP-7.6): progress, retries, the rejection
      // audit — into this workspace's drive.
      startUploads({ files: list, scope: "mine", folderId, workspaceId, onConflict: "keep_both" });
      toast.info(`Adding ${list.length} file${list.length === 1 ? "" : "s"} to the workspace…`);
    },
    [startUploads, folderId, workspaceId]
  );

  const openPreview = useCallback(async (fileId: string) => {
    try {
      setPreview(await filesApi.getFile(fileId));
    } catch {
      toast.error("Couldn't open a preview for this file.");
    }
  }, []);

  const remove = useCallback(
    async (ids: string[]) => {
      const ok = await confirm({
        title: "Remove from workspace",
        message:
          ids.length === 1
            ? "Remove this file from the workspace? It stays in the owner's Drive; chats here just stop seeing it."
            : `Remove ${ids.length} files from the workspace? They stay in the owner's Drive; chats here just stop seeing them.`,
        confirmLabel: "Remove",
        danger: true,
      });
      if (!ok) return;
      for (const id of ids) await unpin.mutateAsync(id);
      setSelected(new Set());
    },
    [unpin]
  );

  const bulkContext = async (enabled: boolean) => {
    for (const id of selected) {
      const f = pinById.get(id);
      if (f && (f.context_enabled !== false) !== enabled) await setContext.mutateAsync({ fileId: id, enabled });
    }
    setSelected(new Set());
  };

  // The list's controller: one per pane, reading the latest state.
  const latest = useRef({ canEdit, pinById, folderById, remove, openPreview, setContext, deleteFolder });
  latest.current = { canEdit, pinById, folderById, remove, openPreview, setContext, deleteFolder };
  const controller = useMemo<DriveListController>(
    () => ({
      layout,
      open: (e) => (e.kind === "folder" ? setFolderId(e.folder.id) : void latest.current.openPreview(e.file.id)),
      toggleSelect: (e) => {
        if (e.kind !== "file") return;
        const id = e.file.id;
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      },
      canChange: () => latest.current.canEdit,
      canSelect: (e) => e.kind === "file",
      showMenu: (entry, x, y) => setMenu({ entry, x, y }),
      download: (file) => void downloadAuthed(file).catch(() => toast.error("Download failed.")),
      menu: (e) => {
        const L = latest.current;
        if (e.kind === "folder") {
          const items: ContextMenuItem[] = [{ icon: <Folder className="h-3.5 w-3.5" />, label: "Open", onClick: () => setFolderId(e.folder.id) }];
          if (L.canEdit) {
            const f = L.folderById.get(e.folder.id);
            items.push(
              { icon: <Pencil className="h-3.5 w-3.5" />, label: "Rename", onClick: () => f && setRenaming(f) },
              {
                icon: <Trash2 className="h-3.5 w-3.5" />,
                label: "Delete folder",
                destructive: true,
                onClick: () => L.deleteFolder.mutate(e.folder.id),
              }
            );
          }
          return items;
        }
        const pin = L.pinById.get(e.file.id);
        const contextOn = pin?.context_enabled !== false;
        const items: ContextMenuItem[] = [
          { icon: <Eye className="h-3.5 w-3.5" />, label: "Preview", onClick: () => void L.openPreview(e.file.id) },
          {
            icon: <Download className="h-3.5 w-3.5" />,
            label: "Download",
            onClick: () => void downloadAuthed(e.file).catch(() => toast.error("Download failed.")),
          },
        ];
        if (L.canEdit && pin) {
          items.push({
            icon: contextOn ? <ZapOff className="h-3.5 w-3.5" /> : <Zap className="h-3.5 w-3.5" />,
            label: contextOn ? "Leave out of context" : "Include in context",
            onClick: () => L.setContext.mutate({ fileId: pin.file_id, enabled: !contextOn }),
          });
          if (pin.movable)
            items.push({ icon: <FolderInput className="h-3.5 w-3.5" />, label: "Move to…", onClick: () => setMoveTarget([pin.file_id]) });
          items.push({
            icon: <Trash2 className="h-3.5 w-3.5" />,
            label: "Remove from workspace",
            destructive: true,
            onClick: () => void L.remove([pin.file_id]),
          });
        }
        return items;
      },
      // What a workspace knows about each file: who added it, when, and
      // whether its chats can draw on it.
      extra: (e) => {
        if (e.kind !== "file") return null;
        const pin = latest.current.pinById.get(e.file.id);
        return pin ? <PinDetails pin={pin} /> : null;
      },
    }),
    [layout]
  );

  const used = drive?.used_bytes ?? 0;
  const quota = drive?.quota_bytes ?? null;
  const empty = !isLoading && items.length === 0;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => {
        if (!canEdit || !Array.from(e.dataTransfer.types || []).includes("Files")) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragOver(false);
      }}
      onDrop={(e) => {
        if (!canEdit || !e.dataTransfer.files?.length) return;
        e.preventDefault();
        setDragOver(false);
        upload(e.dataTransfer.files);
      }}
    >
      {/* Header: identity + usage + actions */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--bg)] px-3 py-1.5">
        <HardDrive className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
        <span className="text-sm font-semibold text-[var(--text)]">Drive</span>
        <span className="text-[11px] text-[var(--text-muted)]" title="Everything here is context for this workspace's chats">
          {files.length} file{files.length === 1 ? "" : "s"} · {humanSize(used)}
          {quota !== null && ` of ${humanSize(quota)}`}
        </span>
        {quota !== null && (
          <span className="h-1.5 w-20 overflow-hidden rounded-full bg-[var(--hover-strong)]">
            <span
              className={cn(
                "block h-full rounded-full",
                used / quota >= 0.95 ? "bg-[var(--danger)]" : used / quota >= 0.8 ? "bg-[var(--warning)]" : "bg-[var(--success)]"
              )}
              style={{ width: `${Math.min(100, (used / quota) * 100)}%` }}
            />
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <span className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search drive…"
              aria-label="Search drive"
              className="w-44 rounded-md border border-[var(--border)] bg-[var(--surface)] py-1 pl-7 pr-6 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]/60"
            />
            {searching && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
          <ViewToggle mode={layout} onChange={setLayout} />
          {canEdit && (
            <>
              <Button size="sm" variant="secondary" leftIcon={<FolderPlus className="h-3.5 w-3.5" />} onClick={() => setNewFolderOpen(true)}>
                New folder
              </Button>
              <Button size="sm" variant="primary" leftIcon={<Upload className="h-3.5 w-3.5" />} onClick={() => inputRef.current?.click()}>
                Upload
              </Button>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept={ACCEPT}
                className="hidden"
                aria-label="Upload to the workspace drive"
                onChange={(e) => {
                  if (e.target.files?.length) upload(e.target.files);
                  e.target.value = "";
                }}
              />
            </>
          )}
        </span>
      </div>

      {/* Breadcrumbs (hidden while searching — results are drive-wide) */}
      {!searching && (
        <nav aria-label="Drive folders" className="flex shrink-0 items-center gap-1 border-b border-[var(--border)] bg-[var(--bg)] px-3 py-1 text-xs text-[var(--text-muted)]">
          <button
            type="button"
            onClick={() => setFolderId(null)}
            className={cn("rounded px-1 py-0.5 transition hover:bg-[var(--hover)]", folderId === null && "font-semibold text-[var(--text)]")}
          >
            All files
          </button>
          {trail.map((f) => (
            <span key={f.id} className="flex items-center gap-1">
              <span aria-hidden>›</span>
              <button
                type="button"
                onClick={() => setFolderId(f.id)}
                className={cn("rounded px-1 py-0.5 transition hover:bg-[var(--hover)]", folderId === f.id && "font-semibold text-[var(--text)]")}
              >
                {f.name}
              </button>
            </span>
          ))}
        </nav>
      )}

      {/* Bulk-selection bar */}
      {selected.size > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--accent)]/[0.06] px-3 py-1.5 text-xs">
          <span className="font-medium text-[var(--text)]">{selected.size} selected</span>
          <Button size="sm" variant="ghost" onClick={() => void bulkContext(true)}>
            Include in context
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void bulkContext(false)}>
            Exclude
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMoveTarget([...selected])}>
            Move to…
          </Button>
          <Button size="sm" variant="ghost" className="text-[var(--danger)]" onClick={() => void remove([...selected])}>
            Remove
          </Button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            aria-label="Clear selection"
            className="ml-auto rounded p-1 text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Listing */}
      <div className={cn("promptly-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2", dragOver && "bg-[var(--accent)]/5")}>
        {workspace && <ContextBudgetBar workspace={workspace} />}
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-[var(--text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            Opening drive…
          </div>
        ) : empty ? (
          <div className="py-8">
            <EmptyState
              icon={<HardDrive className="h-5 w-5" />}
              title={searching ? "No matches" : "Nothing here yet"}
              description={
                searching
                  ? `No drive files match "${query.trim()}".`
                  : canEdit
                    ? "Drop files anywhere on this pane (or hit Upload). Everything added becomes context this workspace's chats can draw on."
                    : "No files in this workspace yet."
              }
            />
          </div>
        ) : (
          <DriveListProvider value={controller}>
            <DriveItemList
              items={items}
              layout={layout}
              gridTile={150}
              isSelected={(e) => e.kind === "file" && selected.has(e.file.id)}
              selectionActive={selected.size > 0}
              header={<DriveListHeader selectable={canEdit} />}
            />
          </DriveListProvider>
        )}
      </div>

      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menu ? controller.menu(menu.entry) : []}
        onClose={() => setMenu(null)}
      />

      <FilePreviewModal open={preview !== null} file={preview} onClose={() => setPreview(null)} />

      <NewFolderModal
        open={newFolderOpen}
        onClose={() => setNewFolderOpen(false)}
        onSubmit={async (name) => {
          await createFolder.mutateAsync({ name, parentId: folderId });
          setNewFolderOpen(false);
        }}
      />

      {renaming && (
        <RenameFolderDialog
          folder={renaming}
          onClose={() => setRenaming(null)}
          onRename={async (name) => {
            await renameFolder.mutateAsync({ folderId: renaming.id, name });
            setRenaming(null);
          }}
        />
      )}

      {moveTarget && (
        <MoveDialog
          folders={folders}
          count={moveTarget.length}
          onClose={() => setMoveTarget(null)}
          onPick={async (dest) => {
            for (const id of moveTarget) {
              if (pinById.get(id)?.movable) await moveFile.mutateAsync({ fileId: id, folderId: dest });
            }
            setMoveTarget(null);
            setSelected(new Set());
          }}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------------- rows

// One Drive item per drive row object (see the pane's comment).
const fileCache = new WeakMap<WorkspaceDriveFile, FileItem>();
const folderCache = new WeakMap<WorkspaceDriveFolder, FolderItem>();

function asFile(f: WorkspaceDriveFile): FileItem {
  let item = fileCache.get(f);
  if (!item) {
    item = {
      id: f.file_id,
      folder_id: f.folder_id,
      filename: f.filename,
      mime_type: f.mime_type,
      size_bytes: f.size_bytes,
      scope: "mine",
      created_at: f.pinned_at,
      updated_at: f.pinned_at,
      starred_at: null,
      trashed_at: null,
    };
    fileCache.set(f, item);
  }
  return item;
}

function asFolder(f: WorkspaceDriveFolder): FolderItem {
  let item = folderCache.get(f);
  if (!item) {
    item = {
      id: f.id,
      parent_id: f.parent_id,
      name: f.name,
      scope: "mine",
      created_at: "",
      system_kind: null,
      updated_at: null,
      starred_at: null,
      trashed_at: null,
    };
    folderCache.set(f, item);
  }
  return item;
}

/** Who added a file, when, and whether this workspace's chats use it. */
function PinDetails({ pin }: { pin: WorkspaceDriveFile }) {
  const contextOn = pin.context_enabled !== false;
  return (
    <>
      {pin.owner && (
        <span className="inline-flex items-center gap-1">
          <UserAvatar
            name={pin.owner.username}
            userId={pin.owner.user_id}
            avatarUrl={pin.owner.avatar_url}
            color={pin.owner.avatar_color}
            size={14}
          />
          {pin.owner.username}
        </span>
      )}
      <span>added {formatRelativeTime(pin.pinned_at)}</span>
      <IndexBadge status={pin.indexing_status} error={pin.indexing_error} isImage={pin.mime_type.startsWith("image/")} />
      {contextOn ? (
        <span className="inline-flex items-center gap-0.5 text-[var(--accent-text)]" title="This workspace's chats can draw on it">
          <Zap className="h-3 w-3 fill-current" /> in context
        </span>
      ) : (
        <span className="inline-flex items-center gap-0.5" title="Left out of this workspace's chats">
          <ZapOff className="h-3 w-3" /> not in context
        </span>
      )}
      {!pin.movable && (
        <span title="Lives in a member's personal Drive (added before the workspace drive existed)">legacy</span>
      )}
    </>
  );
}

function IndexBadge({ status, error, isImage }: { status: string; error: string | null; isImage: boolean }) {
  if (status === "embedding") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--border)]/40 px-1.5 py-0.5 text-[10px]">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        indexing
      </span>
    );
  }
  if (status === "ready") {
    return <span className="rounded-full bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] text-[var(--accent-text)]">searchable</span>;
  }
  if (status === "failed") {
    return (
      <span
        title={error ?? undefined}
        className="inline-flex items-center gap-1 rounded-full bg-[var(--danger-bg)] px-1.5 py-0.5 text-[10px] text-[var(--danger)]"
      >
        <CircleAlert className="h-2.5 w-2.5" />
        not indexed
      </span>
    );
  }
  // queued: images never index (vision path) — say so instead of nothing.
  if (isImage) return <span title="Images reach chats through the vision path, not the search index">image</span>;
  return null;
}

function RenameFolderDialog({
  folder,
  onClose,
  onRename,
}: {
  folder: WorkspaceDriveFolder;
  onClose: () => void;
  onRename: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(folder.name);
  const [busy, setBusy] = useState(false);
  return (
    <Modal open onClose={onClose} title="Rename folder">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const t = name.trim();
          if (!t || t === folder.name) return onClose();
          setBusy(true);
          try {
            await onRename(t);
          } finally {
            setBusy(false);
          }
        }}
        className="space-y-3"
      >
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Folder name"
          className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1.5 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
        />
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={busy}>
            Rename
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Minimal folder picker for Move to…. */
function MoveDialog({
  folders,
  count,
  onClose,
  onPick,
}: {
  folders: WorkspaceDriveFolder[];
  count: number;
  onClose: () => void;
  onPick: (folderId: string | null) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const pick = async (dest: string | null) => {
    setBusy(true);
    try {
      await onPick(dest);
    } finally {
      setBusy(false);
    }
  };
  const byId = new Map(folders.map((x) => [x.id, x]));
  // Indent by depth for a readable flat tree.
  const depthOf = (f: WorkspaceDriveFolder): number => {
    let d = 0;
    let cur: WorkspaceDriveFolder | undefined = f;
    while (cur?.parent_id && d < 32) {
      cur = byId.get(cur.parent_id);
      d++;
    }
    return d;
  };
  const ordered = [...folders].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Modal open onClose={onClose} title={`Move ${count} file${count === 1 ? "" : "s"} to…`}>
      <div className="max-h-72 space-y-0.5 overflow-y-auto">
        <button
          type="button"
          disabled={busy}
          onClick={() => void pick(null)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--text)] transition hover:bg-[var(--hover)] disabled:opacity-50"
        >
          <HardDrive className="h-4 w-4 text-[var(--text-muted)]" />
          All files (drive root)
        </button>
        {ordered.map((f) => (
          <button
            key={f.id}
            type="button"
            disabled={busy}
            onClick={() => void pick(f.id)}
            style={{ paddingLeft: 8 + depthOf(f) * 16 }}
            className="flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm text-[var(--text)] transition hover:bg-[var(--hover)] disabled:opacity-50"
          >
            <Folder className="h-4 w-4 text-[var(--accent-text)]" />
            {f.name}
          </button>
        ))}
      </div>
    </Modal>
  );
}
