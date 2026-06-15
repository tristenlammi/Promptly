import { useRef, useState } from "react";
import {
  CircleAlert,
  FileText,
  Image as ImageIcon,
  Loader2,
  Trash2,
  Upload,
  Zap,
  ZapOff,
} from "lucide-react";

import {
  usePinWorkspaceFile,
  useSetFileContext,
  useUnpinWorkspaceFile,
  useWorkspace,
} from "@/hooks/useWorkspaces";
import { filesApi } from "@/api/files";
import type { WorkspaceFilePin } from "@/api/workspaces";
import { cn } from "@/utils/cn";

/**
 * Workspace "drive" on the home screen — drag/drop or pick photos and
 * documents; each is uploaded and pinned to the workspace, which RAG-indexes
 * it with the app's configured embedding model so every chat in the workspace
 * can draw on it. Pinned files are the same set surfaced in
 * Settings → Pinned files; this is just a friendlier upload-first surface.
 */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ACCEPT =
  "image/*,.pdf,.txt,.md,.markdown,.csv,.json,.docx,.doc,.rtf,.html";

export function WorkspaceFilesPanel({
  workspaceId,
  canEdit,
}: {
  workspaceId: string;
  canEdit: boolean;
}) {
  const { data: workspace } = useWorkspace(workspaceId);
  const pin = usePinWorkspaceFile(workspaceId);
  const unpin = useUnpinWorkspaceFile(workspaceId);
  const setContext = useSetFileContext(workspaceId);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const files = workspace?.files ?? [];
  const inContext = files.filter((f) => f.context_enabled !== false).length;

  const handleFiles = async (picked: FileList | File[]) => {
    const list = Array.from(picked);
    if (list.length === 0) return;
    setError(null);
    setUploading((u) => [...u, ...list.map((f) => f.name)]);
    // Owners drop files straight into the workspace's ``Files`` Drive
    // subfolder (tidy); collaborators can't write to the owner's folder, so
    // they fall back to their own Drive root. Pinning is what kicks off RAG
    // embedding with the configured provider either way.
    const targetFolderId =
      workspace?.role === "owner" ? (workspace?.files_folder_id ?? null) : null;
    for (const file of list) {
      try {
        const uploaded = await filesApi.upload("mine", file, targetFolderId);
        await pin.mutateAsync(uploaded.id);
      } catch {
        setError(
          `Couldn't add "${file.name}". It may be too large or an unsupported type.`
        );
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

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (!canEdit) return;
    if (e.dataTransfer.files?.length) void handleFiles(e.dataTransfer.files);
  };

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Files
        </h2>
        {files.length > 0 && (
          <span className="text-[11px] text-[var(--text-muted)]">
            {inContext} of {files.length} in context
          </span>
        )}
      </div>

      {canEdit && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={cn(
            "flex w-full flex-col items-center justify-center gap-1 rounded-card border border-dashed px-4 py-6 text-center transition",
            dragOver
              ? "border-[var(--accent)] bg-[var(--accent)]/5"
              : "border-[var(--border)] hover:border-[var(--accent)]/50 hover:bg-[var(--hover)]"
          )}
        >
          <Upload className="h-5 w-5 text-[var(--text-muted)]" />
          <span className="text-sm font-medium text-[var(--text)]">
            Drop photos or documents here, or click to upload
          </span>
          <span className="text-[11px] text-[var(--text-muted)]">
            Added files are indexed so chats in this workspace can use them.
          </span>
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
        </button>
      )}

      {error && (
        <div className="mt-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {(files.length > 0 || uploading.length > 0) && (
        <ul className="mt-3 divide-y divide-[var(--border)] rounded-card border border-[var(--border)] bg-[var(--surface)]">
          {uploading.map((name) => (
            <li
              key={`up-${name}`}
              className="flex items-center gap-2 px-3 py-2 text-sm text-[var(--text-muted)]"
            >
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <span className="shrink-0 text-[11px]">Uploading…</span>
            </li>
          ))}
          {files.map((f) => (
            <FileRow
              key={f.file_id}
              file={f}
              canEdit={canEdit}
              onRemove={() => unpin.mutate(f.file_id)}
              removing={unpin.isPending}
              onToggleContext={() =>
                setContext.mutate({
                  fileId: f.file_id,
                  enabled: !f.context_enabled,
                })
              }
            />
          ))}
        </ul>
      )}

      {files.length === 0 && uploading.length === 0 && !canEdit && (
        <p className="text-sm text-[var(--text-muted)]">No files yet.</p>
      )}
    </section>
  );
}

function FileRow({
  file,
  canEdit,
  onRemove,
  removing,
  onToggleContext,
}: {
  file: WorkspaceFilePin;
  canEdit: boolean;
  onRemove: () => void;
  removing: boolean;
  onToggleContext: () => void;
}) {
  const isImage = file.mime_type.startsWith("image/");
  const contextOn = file.context_enabled !== false;
  return (
    <li className="flex items-center gap-2 px-3 py-2 text-sm">
      {isImage ? (
        <ImageIcon className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
      ) : (
        <FileText className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={
              "truncate font-medium " +
              (contextOn ? "text-[var(--text)]" : "text-[var(--text-muted)]")
            }
          >
            {file.filename}
          </span>
          <FileStatus status={file.indexing_status} error={file.indexing_error} />
          {!contextOn && (
            <span className="shrink-0 text-[10px] text-[var(--text-muted)]">
              not in context
            </span>
          )}
        </div>
        <div className="text-xs text-[var(--text-muted)]">
          {humanSize(file.size_bytes)}
        </div>
      </div>
      {canEdit && (
        <>
          <button
            type="button"
            onClick={onToggleContext}
            title={
              contextOn
                ? "Used as workspace context — click to exclude"
                : "Not used as context — click to include"
            }
            aria-label="Toggle workspace context"
            className={
              "shrink-0 rounded p-1 transition hover:bg-[var(--hover)] " +
              (contextOn
                ? "text-[var(--accent)]"
                : "text-[var(--text-muted)]")
            }
          >
            {contextOn ? (
              <Zap className="h-3.5 w-3.5" />
            ) : (
              <ZapOff className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={removing}
            title="Remove from workspace"
            aria-label={`Remove ${file.filename}`}
            className="shrink-0 rounded p-1 text-[var(--text-muted)] transition hover:bg-red-500/10 hover:text-red-500"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </>
      )}
    </li>
  );
}

function FileStatus({
  status,
  error,
}: {
  status: WorkspaceFilePin["indexing_status"];
  error: string | null;
}) {
  if (status === "embedding") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--border)]/40 px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        indexing
      </span>
    );
  }
  if (status === "ready") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
        <Zap className="h-2.5 w-2.5" />
        searchable
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span
        title={error ?? undefined}
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-500"
      >
        <CircleAlert className="h-2.5 w-2.5" />
        not indexed
      </span>
    );
  }
  // queued (incl. images / non-RAG types) → no chip
  return null;
}
