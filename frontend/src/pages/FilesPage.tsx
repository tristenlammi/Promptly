import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ChevronRight,
  Download,
  Eye,
  File as FileIcon,
  FileText,
  Folder as FolderClosedIcon,
  FolderInput,
  FolderPlus,
  Home,
  Image as ImageIcon,
  Inbox,
  Loader2,
  MoreVertical,
  Pencil,
  Share2,
  Sparkles,
  Star,
  Trash2,
  Upload,
  Users,
} from "lucide-react";

import {
  type FileItem,
  type FileScope,
  type FolderItem,
  type SystemFolderKind,
} from "@/api/files";
import { ContextMenu, type ContextMenuItem } from "@/components/files/ContextMenu";
import { DocumentEditorModal } from "@/components/files/documents/DocumentEditorModal";
import { DriveSubNav } from "@/components/files/DriveSubNav";
import { FilePreviewModal } from "@/components/files/FilePreviewModal";
import { FilesTopNavSearch } from "@/components/files/FilesTopNavSearch";
import { MoveItemModal } from "@/components/files/MoveItemModal";
import { ShareLinkDialog } from "@/components/files/ShareLinkDialog";
import { documentsApi } from "@/api/documents";
import {
  downloadAuthed,
  extractError,
  humanSize,
} from "@/components/files/helpers";
import { TopNav } from "@/components/layout/TopNav";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import {
  useBrowseFiles,
  useCreateFolder,
  useMoveFile,
  useMoveFolder,
  useRenameFile,
  useRenameFolder,
  useStarFile,
  useStarFolder,
  useTrashFile,
  useTrashFolder,
  useUnstarFile,
  useUnstarFolder,
} from "@/hooks/useFiles";
import { useAuthStore } from "@/store/authStore";
import { useUploadStore } from "@/store/uploadStore";
import { cn } from "@/utils/cn";

const DRAG_FILE = "application/x-promptly-file";
const DRAG_FOLDER = "application/x-promptly-folder";
const DRAG_SOURCE_PARENT = "application/x-promptly-source-parent";

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
  /** Lock the page to a specific scope — used by the ``/files/shared``
   *  deep link, which displays only the shared pool. */
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
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");
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

  const { data, isLoading, isError, error, refetch } = useBrowseFiles(
    scope,
    folderId
  );

  const crumbs = data?.breadcrumbs ?? [];
  const writable = data?.writable ?? false;

  const moveFile = useMoveFile();
  const moveFolder = useMoveFolder();
  const [moveModal, setMoveModal] = useState<MoveModalState | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);

  // Drive stage 1 — preview / share / star state.
  const [preview, setPreview] = useState<FileItem | null>(null);
  const [shareFor, setShareFor] = useState<
    { kind: "file" | "folder"; id: string; name: string } | null
  >(null);
  const [editingDoc, setEditingDoc] = useState<FileItem | null>(null);

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

  const changeScope = (next: FileScope) => {
    if (forcedScope || next === scope) return;
    setScope(next);
    setDropError(null);
    // Changing scopes always drops you back to the root of the new
    // scope, otherwise the URL's folder id belongs to the *old*
    // scope and the backend will 404 it.
    navigateToFolder(null);
  };

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
        setDropError(null);
        return { ok: true };
      } catch (e) {
        const msg = extractError(e);
        setDropError(msg);
        return { ok: false, error: msg };
      }
    },
    [moveFile, moveFolder, scope, writable]
  );

  const openMoveModal = useCallback((s: MoveModalState) => {
    setMoveModal(s);
  }, []);

  const visibleFiles = data?.files ?? [];

  return (
    <>
      <TopNav
        title={title}
        subtitle={subtitle}
        actions={<FilesTopNavSearch />}
      />
      <DriveSubNav />

      <div className="promptly-scroll flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-4 py-4 md:px-6 md:py-6">
          {!forcedScope && (
            <div className="mb-4 flex items-center gap-1 rounded-input border border-[var(--border)] bg-[var(--surface)] p-1">
              <ScopeTab
                active={scope === "mine"}
                onClick={() => changeScope("mine")}
                icon={<FolderClosedIcon className="h-3.5 w-3.5" />}
                label="My files"
              />
              <ScopeTab
                active={scope === "shared"}
                onClick={() => changeScope("shared")}
                icon={<Users className="h-3.5 w-3.5" />}
                label={isAdmin ? "Shared pool" : "Shared"}
                hint={!isAdmin ? "read-only" : undefined}
              />
            </div>
          )}

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
            {writable && (
              <FolderActions
                scope={scope}
                parentId={folderId}
                onChanged={() => refetch()}
              />
            )}
          </div>

          {dropError && (
            <div
              role="alert"
              className="mb-3 flex items-center justify-between gap-3 rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400"
            >
              <span>{dropError}</span>
              <button
                onClick={() => setDropError(null)}
                className="rounded p-1 hover:bg-red-500/10"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          )}

          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading...
            </div>
          )}

          {isError && (
            <div
              role="alert"
              className="rounded-card border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400"
            >
              Failed to load files: {error instanceof Error ? error.message : "Unknown"}
              <Button size="sm" variant="ghost" className="ml-3" onClick={() => refetch()}>
                Retry
              </Button>
            </div>
          )}

          {data && (
            <ContentGrid
              data={data}
              scope={scope}
              currentFolderId={folderId}
              onOpenFolder={navigateToFolder}
              onDropOnFolder={handleDropOnto}
              onOpenMove={openMoveModal}
              onPreview={setPreview}
              onShare={setShareFor}
            />
          )}
        </div>
      </div>

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

      <FilePreviewModal
        open={!!preview}
        file={preview}
        siblings={visibleFiles}
        onSelect={setPreview}
        onClose={() => setPreview(null)}
        onShare={(f) =>
          setShareFor({ kind: "file", id: f.id, name: f.filename })
        }
        onEdit={(f) => {
          setEditingDoc(f);
          setPreview(null);
        }}
        onToggleStar={undefined}
      />

      <ShareLinkDialog
        open={!!shareFor}
        resource={shareFor}
        onClose={() => setShareFor(null)}
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

function ScopeTab({
  active,
  onClick,
  icon,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  hint?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm transition",
        active
          ? "bg-[var(--bg)] text-[var(--text)] shadow-sm"
          : "text-[var(--text-muted)] hover:text-[var(--text)]"
      )}
    >
      {icon}
      <span className="font-medium">{label}</span>
      {hint && (
        <span className="rounded bg-[var(--text-muted)]/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
          {hint}
        </span>
      )}
    </button>
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
  const [docError, setDocError] = useState<string | null>(null);
  const [activeDocument, setActiveDocument] = useState<FileItem | null>(null);
  const createFolder = useCreateFolder();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const startUploads = useUploadStore((s) => s.startUploads);

  const handleNewDocument = async () => {
    if (creatingDoc) return;
    setCreatingDoc(true);
    setDocError(null);
    try {
      const doc = await documentsApi.create({
        scope,
        folder_id: parentId,
      });
      setActiveDocument(doc);
      onChanged();
    } catch (e) {
      setDocError(extractError(e));
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
    // Three actions on mobile now (New file / New folder / Upload) so
    // the row expands to ``grid-cols-3`` on phones. Desktop still gets
    // the inline flex layout.
    <div className="grid shrink-0 grid-cols-3 items-center gap-2 sm:flex">
      <Button
        size="sm"
        variant="secondary"
        leftIcon={<FileText className="h-3.5 w-3.5" />}
        onClick={handleNewDocument}
        loading={creatingDoc}
        className="w-full sm:w-auto"
      >
        New file
      </Button>
      <Button
        size="sm"
        variant="secondary"
        leftIcon={<FolderPlus className="h-3.5 w-3.5" />}
        onClick={() => setShowNewFolder(true)}
        className="w-full sm:w-auto"
      >
        New folder
      </Button>
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
        leftIcon={<Upload className="h-3.5 w-3.5" />}
        onClick={() => fileInputRef.current?.click()}
        className="w-full sm:w-auto"
      >
        Upload
      </Button>

      {docError && (
        <div className="col-span-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1 text-xs text-red-500 sm:col-span-1">
          {docError}
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
  currentFolderId,
  onOpenFolder,
  onDropOnFolder,
  onOpenMove,
  onPreview,
  onShare,
}: {
  data: { folders: FolderItem[]; files: FileItem[]; writable: boolean };
  scope: FileScope;
  currentFolderId: string | null;
  onOpenFolder: (id: string | null) => void;
  onDropOnFolder: (
    targetFolderId: string | null,
    payload: DragPayload
  ) => Promise<DropOutcome>;
  onOpenMove: (s: MoveModalState) => void;
  onPreview: (file: FileItem) => void;
  onShare: (r: { kind: "file" | "folder"; id: string; name: string }) => void;
}) {
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

  const sortedFolders = [...data.folders].sort((a, b) => {
    const aSys = a.system_kind ? 0 : 1;
    const bSys = b.system_kind ? 0 : 1;
    return aSys - bSys;
  });

  return (
    <div className="rounded-card border border-[var(--border)] bg-[var(--surface)]">
      <ul className="divide-y divide-[var(--border)]">
        {sortedFolders.map((f) => (
          <FolderRow
            key={f.id}
            folder={f}
            scope={scope}
            writable={data.writable}
            currentFolderId={currentFolderId}
            onOpen={() => onOpenFolder(f.id)}
            onDropOnFolder={onDropOnFolder}
            onOpenMove={onOpenMove}
            onShare={() =>
              onShare({ kind: "folder", id: f.id, name: f.name })
            }
          />
        ))}
        {data.files.map((f) => (
          <FileRow
            key={f.id}
            file={f}
            scope={scope}
            writable={data.writable}
            onOpenMove={onOpenMove}
            onPreview={() => onPreview(f)}
            onShare={() =>
              onShare({ kind: "file", id: f.id, name: f.filename })
            }
          />
        ))}
      </ul>
    </div>
  );
}

function FolderRow({
  folder,
  scope,
  writable,
  currentFolderId,
  onOpen,
  onDropOnFolder,
  onOpenMove,
  onShare,
}: {
  folder: FolderItem;
  scope: FileScope;
  writable: boolean;
  currentFolderId: string | null;
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
          onClick: () => setRename({ open: true, value: folder.name }),
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

  return (
    <li
      draggable={userCanMutate}
      onDragStart={(e) => {
        if (!userCanMutate) return;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(DRAG_FOLDER, folder.id);
        e.dataTransfer.setData(
          DRAG_SOURCE_PARENT,
          folder.parent_id ?? ""
        );
      }}
      onDragEnter={(e) => {
        if (allowDrop(e)) setOver(true);
      }}
      onDragOver={(e) => {
        if (allowDrop(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOver(false);
      }}
      onDrop={async (e) => {
        if (!allowDrop(e)) return;
        e.preventDefault();
        setOver(false);
        const payload = readDragPayload(e.dataTransfer);
        if (!payload) return;
        await onDropOnFolder(folder.id, payload);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setCtx({ x: e.clientX, y: e.clientY });
      }}
      className={cn(
        "group flex items-center gap-3 px-4 py-3 transition",
        "hover:bg-black/[0.02] dark:hover:bg-white/[0.03]",
        userCanMutate && "cursor-grab",
        over && "bg-[var(--accent)]/10 ring-1 ring-inset ring-[var(--accent)]/40"
      )}
    >
      <button
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        title={isSystem ? systemFolderTooltip(folder.system_kind!) : undefined}
      >
        <SystemAwareFolderIcon kind={folder.system_kind} />
        <span className="truncate text-sm font-medium">{folder.name}</span>
        {folder.starred_at && (
          <Star className="h-3.5 w-3.5 shrink-0 fill-yellow-400 text-yellow-400" />
        )}
        {isSystem && (
          <span className="rounded bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--accent)]">
            system
          </span>
        )}
        {currentFolderId !== null && currentFolderId === folder.id && (
          <span className="rounded bg-[var(--text-muted)]/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
            current
          </span>
        )}
      </button>

      {userCanMutate && (
        <RowMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          items={mutationItems}
        />
      )}

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
    </li>
  );
}

function FileRow({
  file,
  scope,
  writable,
  onOpenMove,
  onPreview,
  onShare,
}: {
  file: FileItem;
  scope: FileScope;
  writable: boolean;
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
      onClick: () => setRename({ open: true, value: file.filename }),
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

  return (
    <li
      draggable={writable}
      onDragStart={(e) => {
        if (!writable) return;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(DRAG_FILE, file.id);
        e.dataTransfer.setData(DRAG_SOURCE_PARENT, file.folder_id ?? "");
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setCtx({ x: e.clientX, y: e.clientY });
      }}
      onDoubleClick={onPreview}
      className={cn(
        "group flex items-center gap-3 px-4 py-3 transition",
        "hover:bg-black/[0.02] dark:hover:bg-white/[0.03]",
        writable && "cursor-grab"
      )}
    >
      <button
        onClick={onPreview}
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
          <div className="text-xs text-[var(--text-muted)]">
            {humanSize(file.size_bytes)} · {file.mime_type || "unknown"}
          </div>
        </div>
      </button>

      <button
        onClick={() => downloadAuthed(file)}
        title="Download"
        aria-label={`Download ${file.filename}`}
        className="rounded-md p-1.5 text-[var(--text-muted)] opacity-0 transition hover:bg-black/[0.04] hover:text-[var(--text)] group-hover:opacity-100 dark:hover:bg-white/[0.06]"
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
    </li>
  );
}

function SystemAwareFolderIcon({
  kind,
}: {
  kind: SystemFolderKind | null;
}) {
  switch (kind) {
    case "chat_uploads":
      return <Inbox className="h-5 w-5 shrink-0 text-[var(--accent)]" />;
    case "generated_root":
      return <Sparkles className="h-5 w-5 shrink-0 text-[var(--accent)]" />;
    case "generated_files":
      return <FileText className="h-5 w-5 shrink-0 text-[var(--accent)]" />;
    case "generated_media":
      return <ImageIcon className="h-5 w-5 shrink-0 text-[var(--accent)]" />;
    default:
      return <FolderClosedIcon className="h-5 w-5 shrink-0 text-[var(--accent)]" />;
  }
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
                    : "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
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
 * Thin wrapper used by the ``/files/shared`` route — behaves like
 * ``FilesPage`` but pins the scope to "shared" and updates the
 * chrome to reflect that only read-only shared-pool items live
 * here. Keeping this as a wrapper means every Drive surface (incl.
 * trash/star/recent) keeps one canonical implementation.
 */
export function SharedWithMePage() {
  return (
    <FilesPage
      forcedScope="shared"
      title="Shared"
      subtitle="Files shared with you by other Promptly users."
    />
  );
}
