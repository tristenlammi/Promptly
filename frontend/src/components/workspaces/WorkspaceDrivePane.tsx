import { useMemo, useRef, useState } from "react";
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

import { filesApi, type FileItem } from "@/api/files";
import type {
  WorkspaceDriveFile,
  WorkspaceDriveFolder,
} from "@/api/workspaces";
import { FilePreviewModal } from "@/components/files/FilePreviewModal";
import {
  downloadAuthed,
  formatRelativeTime,
  humanSize,
} from "@/components/files/helpers";
import { Button } from "@/components/shared/Button";
import { DriveItemIcon } from "@/components/files/DriveItemIcon";
import { EmptyState } from "@/components/shared/EmptyState";
import { Modal } from "@/components/shared/Modal";
import { confirm } from "@/components/shared/ConfirmDialog";
import {
  useCreateDriveFolder,
  useDeleteDriveFolder,
  useMoveDriveFile,
  useRenameDriveFolder,
  useSetFileContext,
  useUnpinWorkspaceFile,
  useUploadDriveFile,
  useWorkspace,
  useWorkspaceDrive,
} from "@/hooks/useWorkspaces";
import { ContextBudgetBar } from "./WorkspaceSettingsDrawer";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";
import { apiErrorMessage } from "@/utils/apiError";

const ACCEPT =
  "image/*,.pdf,.txt,.md,.markdown,.csv,.json,.docx,.doc,.rtf,.html";

/**
 * The Workspace Drive (Phases 6-7) — a real file browser for the
 * workspace's shared files, replacing the flat pinned-files list.
 *
 * Everything here is workspace context: uploads land in the workspace's
 * own folder (owner-owned, no matter who uploads), get pinned + indexed
 * automatically, and carry the per-file context-⚡ toggle and indexing
 * badge over from the old surface. Folders are real Drive folders inside
 * the workspace subtree; search filters the whole drive flat.
 */
export function WorkspaceDrivePane({
  workspaceId,
  canEdit,
}: {
  workspaceId: string;
  canEdit: boolean;
}) {
  const { data: drive, isLoading } = useWorkspaceDrive(workspaceId);
  const { data: workspace } = useWorkspace(workspaceId);
  const upload = useUploadDriveFile(workspaceId);
  const createFolder = useCreateDriveFolder(workspaceId);
  const renameFolder = useRenameDriveFolder(workspaceId);
  const deleteFolder = useDeleteDriveFolder(workspaceId);
  const moveFile = useMoveDriveFile(workspaceId);
  const unpin = useUnpinWorkspaceFile(workspaceId);
  const setContext = useSetFileContext(workspaceId);

  // null = drive root.
  const [folderId, setFolderId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<FileItem | null>(null);
  const [moveTarget, setMoveTarget] = useState<string[] | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const folders = drive?.folders ?? [];
  const files = drive?.files ?? [];
  const searching = query.trim().length > 0;

  const childFolders = useMemo(
    () =>
      folders
        .filter((f) => f.parent_id === folderId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [folders, folderId]
  );
  const visibleFiles = useMemo(() => {
    if (searching) {
      const q = query.trim().toLowerCase();
      return files.filter((f) => f.filename.toLowerCase().includes(q));
    }
    return files.filter((f) => f.folder_id === folderId);
  }, [files, folderId, query, searching]);

  // Breadcrumb trail root → current folder.
  const trail = useMemo(() => {
    const byId = new Map(folders.map((f) => [f.id, f]));
    const out: WorkspaceDriveFolder[] = [];
    let cur = folderId ? byId.get(folderId) : undefined;
    let hops = 0;
    while (cur && hops < 32) {
      out.unshift(cur);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
      hops++;
    }
    return out;
  }, [folders, folderId]);

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleFiles = async (picked: FileList | File[]) => {
    const list = Array.from(picked);
    if (!list.length) return;
    setUploading((u) => [...u, ...list.map((f) => f.name)]);
    for (const file of list) {
      try {
        await upload.mutateAsync({ file, folderId });
      } catch (err) {
        toast.error(apiErrorMessage(err, `Couldn't add "${file.name}".`));
      } finally {
        setUploading((u) => {
          const i = u.indexOf(file.name);
          if (i === -1) return u;
          const next = u.slice();
          next.splice(i, 1);
          return next;
        });
      }
    }
  };

  const handleNewFolder = async () => {
    const name = window.prompt("Folder name");
    if (!name || !name.trim()) return;
    await createFolder.mutateAsync({ name: name.trim(), parentId: folderId });
  };

  const handlePreview = async (f: WorkspaceDriveFile) => {
    try {
      setPreview(await filesApi.getFile(f.file_id));
    } catch {
      toast.error("Couldn't open a preview for this file.");
    }
  };

  const handleRemove = async (ids: string[]) => {
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
  };

  const bulkContext = async (enabled: boolean) => {
    for (const id of selected) {
      const f = files.find((x) => x.file_id === id);
      if (f && (f.context_enabled !== false) !== enabled) {
        await setContext.mutateAsync({ fileId: id, enabled });
      }
    }
    setSelected(new Set());
  };

  const used = drive?.used_bytes ?? 0;
  const quota = drive?.quota_bytes ?? null;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => {
        if (!canEdit) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (canEdit && e.dataTransfer.files?.length)
          void handleFiles(e.dataTransfer.files);
      }}
    >
      {/* Header: identity + usage + actions */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--bg)] px-3 py-1.5">
        <HardDrive className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
        <span className="text-sm font-semibold text-[var(--text)]">Drive</span>
        <span
          className="text-[11px] text-[var(--text-muted)]"
          title="Everything here is context for this workspace's chats"
        >
          {files.length} file{files.length === 1 ? "" : "s"} · {humanSize(used)}
          {quota !== null && ` of ${humanSize(quota)}`}
        </span>
        {quota !== null && (
          <span className="h-1.5 w-20 overflow-hidden rounded-full bg-[var(--hover-strong)]">
            <span
              className={cn(
                "block h-full rounded-full",
                used / quota >= 0.95
                  ? "bg-[var(--danger)]"
                  : used / quota >= 0.8
                    ? "bg-[var(--warning)]"
                    : "bg-[var(--success)]"
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
          {canEdit && (
            <>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<FolderPlus className="h-3.5 w-3.5" />}
                onClick={() => void handleNewFolder()}
              >
                New folder
              </Button>
              <Button
                size="sm"
                variant="primary"
                leftIcon={<Upload className="h-3.5 w-3.5" />}
                onClick={() => inputRef.current?.click()}
              >
                Upload
              </Button>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept={ACCEPT}
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) void handleFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </>
          )}
        </span>
      </div>

      {/* Breadcrumbs (hidden while searching — results are drive-wide) */}
      {!searching && (
        <nav className="flex shrink-0 items-center gap-1 border-b border-[var(--border)] bg-[var(--bg)] px-3 py-1 text-xs text-[var(--text-muted)]">
          <button
            type="button"
            onClick={() => setFolderId(null)}
            className={cn(
              "rounded px-1 py-0.5 transition hover:bg-[var(--hover)]",
              folderId === null && "font-semibold text-[var(--text)]"
            )}
          >
            All files
          </button>
          {trail.map((f) => (
            <span key={f.id} className="flex items-center gap-1">
              <span aria-hidden>›</span>
              <button
                type="button"
                onClick={() => setFolderId(f.id)}
                className={cn(
                  "rounded px-1 py-0.5 transition hover:bg-[var(--hover)]",
                  folderId === f.id && "font-semibold text-[var(--text)]"
                )}
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
          <span className="font-medium text-[var(--text)]">
            {selected.size} selected
          </span>
          <Button size="sm" variant="ghost" onClick={() => void bulkContext(true)}>
            Include in context
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void bulkContext(false)}>
            Exclude
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setMoveTarget([...selected])}
          >
            Move to…
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-[var(--danger)]"
            onClick={() => void handleRemove([...selected])}
          >
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
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto px-3 py-2",
          dragOver && "bg-[var(--accent)]/5"
        )}
      >
        {workspace && <ContextBudgetBar workspace={workspace} />}
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-[var(--text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            Opening drive…
          </div>
        ) : childFolders.length === 0 &&
          visibleFiles.length === 0 &&
          uploading.length === 0 ? (
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
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                <th className="w-7 py-1.5" aria-label="Select" />
                <th className="py-1.5 font-medium">Name</th>
                <th className="hidden w-24 py-1.5 font-medium lg:table-cell">
                  Added
                </th>
                <th className="w-20 py-1.5 text-right font-medium">Size</th>
                <th className="w-24 py-1.5 font-medium">Status</th>
                <th className="w-28 py-1.5" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {!searching &&
                childFolders.map((f) => (
                  <FolderRow
                    key={f.id}
                    folder={f}
                    canEdit={canEdit}
                    onOpen={() => setFolderId(f.id)}
                    onRename={async () => {
                      const name = window.prompt("Rename folder", f.name);
                      if (!name || !name.trim() || name.trim() === f.name)
                        return;
                      await renameFolder.mutateAsync({
                        folderId: f.id,
                        name: name.trim(),
                      });
                    }}
                    onDelete={() => deleteFolder.mutate(f.id)}
                  />
                ))}
              {uploading.map((name) => (
                <tr key={`up-${name}`} className="text-[var(--text-muted)]">
                  <td />
                  <td className="flex items-center gap-2 py-2">
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                    <span className="truncate">{name}</span>
                  </td>
                  <td className="hidden lg:table-cell" />
                  <td />
                  <td className="text-[11px]">Uploading…</td>
                  <td />
                </tr>
              ))}
              {visibleFiles.map((f) => (
                <FileRow
                  key={f.file_id}
                  file={f}
                  canEdit={canEdit}
                  checked={selected.has(f.file_id)}
                  onToggleSelect={() => toggleSelect(f.file_id)}
                  onPreview={() => void handlePreview(f)}
                  onDownload={async () => {
                    try {
                      await downloadAuthed(await filesApi.getFile(f.file_id));
                    } catch {
                      toast.error("Download failed.");
                    }
                  }}
                  onToggleContext={() =>
                    setContext.mutate({
                      fileId: f.file_id,
                      enabled: !(f.context_enabled !== false),
                    })
                  }
                  onMove={
                    f.movable ? () => setMoveTarget([f.file_id]) : undefined
                  }
                  onRemove={() => void handleRemove([f.file_id])}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <FilePreviewModal
        open={preview !== null}
        file={preview}
        onClose={() => setPreview(null)}
      />

      {moveTarget && (
        <MoveDialog
          folders={folders}
          count={moveTarget.length}
          onClose={() => setMoveTarget(null)}
          onPick={async (dest) => {
            for (const id of moveTarget) {
              const f = files.find((x) => x.file_id === id);
              if (f?.movable)
                await moveFile.mutateAsync({ fileId: id, folderId: dest });
            }
            setMoveTarget(null);
            setSelected(new Set());
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------

function FolderRow({
  folder,
  canEdit,
  onOpen,
  onRename,
  onDelete,
}: {
  folder: WorkspaceDriveFolder;
  canEdit: boolean;
  onOpen: () => void;
  onRename: () => Promise<void>;
  onDelete: () => void;
}) {
  return (
    <tr className="group border-b border-[var(--border)]/60 transition hover:bg-[var(--hover)]">
      <td />
      <td className="py-1.5">
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full items-center gap-2 text-left"
        >
          <DriveItemIcon folder={folder} tile />
          <span className="truncate font-medium text-[var(--text)]">
            {folder.name}
          </span>
        </button>
      </td>
      <td className="hidden lg:table-cell" />
      <td />
      <td className="text-[11px] text-[var(--text-muted)]">Folder</td>
      <td className="py-1.5">
        {canEdit && (
          <span className="flex items-center justify-end gap-0.5 opacity-0 transition group-hover:opacity-100">
            <IconBtn title="Rename folder" onClick={() => void onRename()}>
              <Pencil className="h-3.5 w-3.5" />
            </IconBtn>
            <IconBtn title="Delete folder (must be empty)" onClick={onDelete} danger>
              <Trash2 className="h-3.5 w-3.5" />
            </IconBtn>
          </span>
        )}
      </td>
    </tr>
  );
}

function FileRow({
  file,
  canEdit,
  checked,
  onToggleSelect,
  onPreview,
  onDownload,
  onToggleContext,
  onMove,
  onRemove,
}: {
  file: WorkspaceDriveFile;
  canEdit: boolean;
  checked: boolean;
  onToggleSelect: () => void;
  onPreview: () => void;
  onDownload: () => void;
  onToggleContext: () => void;
  onMove?: () => void;
  onRemove: () => void;
}) {
  const isImage = file.mime_type.startsWith("image/");
  const contextOn = file.context_enabled !== false;
  return (
    <tr
      className={cn(
        "group border-b border-[var(--border)]/60 transition hover:bg-[var(--hover)]",
        checked && "bg-[var(--accent)]/[0.06]"
      )}
    >
      <td className="py-1.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggleSelect}
          aria-label={`Select ${file.filename}`}
          className="h-3.5 w-3.5 accent-[var(--accent)]"
        />
      </td>
      <td className="py-1.5">
        <button
          type="button"
          onClick={onPreview}
          className="flex w-full items-center gap-2 text-left"
          title={`Preview ${file.filename}`}
        >
          <DriveItemIcon file={file} tile />
          <span
            className={cn(
              "truncate",
              contextOn
                ? "font-medium text-[var(--text)]"
                : "text-[var(--text-muted)]"
            )}
          >
            {file.filename}
          </span>
          {!file.movable && (
            <span
              className="shrink-0 text-[10px] text-[var(--text-muted)]"
              title="Lives in a member's personal Drive (added before the workspace drive existed)"
            >
              legacy
            </span>
          )}
        </button>
      </td>
      <td className="hidden text-xs text-[var(--text-muted)] lg:table-cell">
        {formatRelativeTime(file.pinned_at)}
      </td>
      <td className="text-right text-xs tabular-nums text-[var(--text-muted)]">
        {humanSize(file.size_bytes)}
      </td>
      <td>
        <IndexBadge
          status={file.indexing_status}
          error={file.indexing_error}
          isImage={isImage}
        />
      </td>
      <td className="py-1.5">
        <span className="flex items-center justify-end gap-0.5 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
          <IconBtn title="Preview" onClick={onPreview}>
            <Eye className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn title="Download" onClick={onDownload}>
            <Download className="h-3.5 w-3.5" />
          </IconBtn>
          {canEdit && (
            <>
              <IconBtn
                title={
                  contextOn
                    ? "In workspace context — click to exclude"
                    : "Not in context — click to include"
                }
                onClick={onToggleContext}
                accent={contextOn}
              >
                {contextOn ? (
                  <Zap className="h-3.5 w-3.5 fill-current" />
                ) : (
                  <ZapOff className="h-3.5 w-3.5" />
                )}
              </IconBtn>
              {onMove && (
                <IconBtn title="Move to folder…" onClick={onMove}>
                  <FolderInput className="h-3.5 w-3.5" />
                </IconBtn>
              )}
              <IconBtn title="Remove from workspace" onClick={onRemove} danger>
                <Trash2 className="h-3.5 w-3.5" />
              </IconBtn>
            </>
          )}
        </span>
      </td>
    </tr>
  );
}

function IconBtn({
  title,
  onClick,
  children,
  danger,
  accent,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "rounded p-1 transition",
        danger
          ? "text-[var(--text-muted)] hover:bg-[var(--danger-bg)] hover:text-[var(--danger)]"
          : accent
            ? "text-[var(--accent)] hover:bg-[var(--accent)]/10"
            : "text-[var(--text-muted)] hover:bg-[var(--hover-strong)] hover:text-[var(--text)]"
      )}
    >
      {children}
    </button>
  );
}

function IndexBadge({
  status,
  error,
  isImage,
}: {
  status: string;
  error: string | null;
  isImage: boolean;
}) {
  if (status === "embedding") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--border)]/40 px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        indexing
      </span>
    );
  }
  if (status === "ready") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
        <Zap className="h-2.5 w-2.5" />
        searchable
      </span>
    );
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
  if (isImage) {
    return (
      <span
        className="text-[10px] text-[var(--text-muted)]"
        title="Images reach chats through the vision path, not the search index"
      >
        image
      </span>
    );
  }
  return null;
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
  // Indent by depth for a readable flat tree.
  const depthOf = (f: WorkspaceDriveFolder): number => {
    let d = 0;
    let cur: WorkspaceDriveFolder | undefined = f;
    const byId = new Map(folders.map((x) => [x.id, x]));
    while (cur?.parent_id && d < 32) {
      cur = byId.get(cur.parent_id);
      d++;
    }
    return d;
  };
  const ordered = [...folders].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Modal
      open
      onClose={onClose}
      title={`Move ${count} file${count === 1 ? "" : "s"} to…`}
    >
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
            <Folder className="h-4 w-4 text-[var(--accent)]" />
            {f.name}
          </button>
        ))}
      </div>
    </Modal>
  );
}
