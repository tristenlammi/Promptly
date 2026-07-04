import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { History, Loader2, RotateCcw, X } from "lucide-react";

import {
  documentsApi,
  type DocumentVersionMeta,
} from "@/api/documents";
import { humanSize } from "@/components/files/helpers";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

const SOURCE_LABEL: Record<string, string> = {
  auto: "Autosaved",
  manual: "Saved",
  restore: "Restored",
};

/**
 * Version-history slide-over for a Drive Document (Phase 9). Lists
 * snapshots newest-first; selecting one shows a read-only HTML preview
 * and, for editors, a Restore button. Restore is handled by the parent
 * (``onRestore`` sets the live editor content, which flows back through
 * Yjs) so this panel never touches the CRDT itself.
 */
export function DocumentHistoryPanel({
  documentId,
  canEdit,
  onRestore,
  onClose,
}: {
  documentId: string;
  canEdit: boolean;
  onRestore: (html: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const { data: versions, isLoading } = useQuery({
    queryKey: ["document-versions", documentId],
    queryFn: () => documentsApi.listVersions(documentId),
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);

  // Default-select the newest version once the list loads.
  useEffect(() => {
    if (!selectedId && versions && versions.length > 0) {
      setSelectedId(versions[0].id);
    }
  }, [versions, selectedId]);

  // Fetch the selected version's HTML for preview.
  useEffect(() => {
    if (!selectedId) {
      setPreviewHtml(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    documentsApi
      .getVersion(documentId, selectedId)
      .then((v) => {
        if (!cancelled) setPreviewHtml(v.html);
      })
      .catch(() => {
        if (!cancelled) setPreviewHtml(null);
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [documentId, selectedId]);

  const handleRestore = async () => {
    if (!previewHtml || restoring) return;
    setRestoring(true);
    try {
      await onRestore(previewHtml);
      toast.success("Restored this version");
      onClose();
    } catch {
      toast.error("Couldn't restore this version.");
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="absolute inset-0 z-30 flex bg-[var(--bg)]/40">
      {/* Backdrop click closes */}
      <button
        type="button"
        aria-label="Close history"
        onClick={onClose}
        className="flex-1"
      />
      <div className="flex h-full w-full max-w-2xl flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
          <History className="h-4 w-4 text-[var(--text-muted)]" />
          <h2 className="text-sm font-semibold text-[var(--text)]">
            Version history
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Version list */}
          <div className="w-56 shrink-0 overflow-y-auto border-r border-[var(--border)]">
            {isLoading ? (
              <div className="flex items-center gap-2 px-3 py-3 text-xs text-[var(--text-muted)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading…
              </div>
            ) : !versions || versions.length === 0 ? (
              <p className="px-3 py-4 text-xs text-[var(--text-muted)]">
                No saved versions yet. History builds up as you edit — check
                back after a few edits.
              </p>
            ) : (
              versions.map((v, i) => (
                <VersionRow
                  key={v.id}
                  version={v}
                  isCurrent={i === 0}
                  selected={v.id === selectedId}
                  onSelect={() => setSelectedId(v.id)}
                />
              ))
            )}
          </div>

          {/* Preview + restore */}
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {previewLoading ? (
                <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading preview…
                </div>
              ) : previewHtml !== null ? (
                <div
                  className="prose-doc max-w-none text-sm text-[var(--text)] [&_a]:text-[var(--accent)] [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_img]:max-w-full [&_li]:my-0.5 [&_p]:my-1.5"
                  // Version HTML was sanitised on the way in (both the
                  // collab-snapshot and manual-save paths run the allowlist),
                  // so it's safe to render for preview.
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              ) : (
                <p className="text-sm text-[var(--text-muted)]">
                  Select a version to preview it.
                </p>
              )}
            </div>
            {canEdit && selectedId && previewHtml !== null && (
              <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-2.5">
                <span className="mr-auto text-xs text-[var(--text-muted)]">
                  Restoring replaces the current content — a new version is
                  saved first, so this is reversible.
                </span>
                <button
                  type="button"
                  onClick={() => void handleRestore()}
                  disabled={restoring}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  {restoring ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                  Restore this version
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function VersionRow({
  version,
  isCurrent,
  selected,
  onSelect,
}: {
  version: DocumentVersionMeta;
  isCurrent: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const when = new Date(version.created_at);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full flex-col gap-0.5 border-b border-[var(--border)]/60 px-3 py-2 text-left transition",
        selected ? "bg-[var(--accent)]/[0.08]" : "hover:bg-[var(--hover)]"
      )}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--text)]">
        {when.toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })}
        {isCurrent && (
          <span className="rounded-full bg-[var(--accent)]/10 px-1.5 text-[10px] font-semibold text-[var(--accent)]">
            Current
          </span>
        )}
      </span>
      <span className="text-[11px] text-[var(--text-muted)]">
        {SOURCE_LABEL[version.source] ?? "Saved"}
        {version.author_username ? ` · ${version.author_username}` : ""} ·{" "}
        {humanSize(version.size_bytes)}
      </span>
    </button>
  );
}
