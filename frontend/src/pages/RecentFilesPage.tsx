import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Clock } from "lucide-react";

import { isDocumentFile, type FileItem } from "@/api/files";
import { DocumentEditorModal } from "@/components/files/documents/DocumentEditorModal";
import { FilePreviewModal } from "@/components/files/FilePreviewModal";
import { DriveEmptyState, DriveFileRow } from "@/components/files/DriveRows";
import { DriveSubNav } from "@/components/files/DriveSubNav";
import { ShareLinkDialog } from "@/components/files/ShareLinkDialog";
import { TopNav } from "@/components/layout/TopNav";
import { FilesTopNavSearch } from "@/components/files/FilesTopNavSearch";
import { downloadAuthed } from "@/components/files/helpers";
import {
  useRecentFiles,
  useStarFile,
  useTrashFile,
  useUnstarFile,
} from "@/hooks/useFiles";

// Drive stage 5 — Recent only reports files *you* touched. Previews
// of someone else's shared file shouldn't hijack your recents, and
// the sub-nav already provides cross-surface navigation, so the
// legacy scope-tab row was retired here.
const SCOPE = "mine" as const;

export function RecentFilesPage() {
  const { data, isLoading } = useRecentFiles(SCOPE);
  const [preview, setPreview] = useState<FileItem | null>(null);
  // Drive Documents jump straight into the editor on click — every
  // other file type still falls back to the generic preview modal.
  const [editingDoc, setEditingDoc] = useState<FileItem | null>(null);
  const [shareFor, setShareFor] = useState<FileItem | null>(null);

  const openFile = (f: FileItem) => {
    if (isDocumentFile(f)) setEditingDoc(f);
    else setPreview(f);
  };

  const star = useStarFile();
  const unstar = useUnstarFile();
  const trash = useTrashFile();
  const navigate = useNavigate();

  const files = useMemo(() => data?.files ?? [], [data]);

  return (
    <>
      <TopNav
        title="Recent"
        subtitle="Files you've touched recently, across every folder."
        actions={<FilesTopNavSearch />}
      />
      <DriveSubNav />

      <div className="promptly-scroll flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-6 py-6">
          {isLoading && (
            <div className="text-sm text-[var(--text-muted)]">Loading…</div>
          )}

          {!isLoading && files.length === 0 && (
            <DriveEmptyState
              icon={<Clock className="h-5 w-5" />}
              title="No recent files"
              description="Upload or edit a file to see it here."
            />
          )}

          {files.length > 0 && (
            <div className="rounded-card border border-[var(--border)] bg-[var(--surface)]">
              <ul className="divide-y divide-[var(--border)]">
                {files.map((f) => (
                  <DriveFileRow
                    key={f.id}
                    file={f}
                    actions={{
                      onPreview: () => openFile(f),
                      onDownload: () => downloadAuthed(f),
                      onShare: () => setShareFor(f),
                      onStar: f.starred_at
                        ? undefined
                        : () => star.mutate({ id: f.id, scope: SCOPE }),
                      onUnstar: f.starred_at
                        ? () => unstar.mutate({ id: f.id, scope: SCOPE })
                        : undefined,
                      onMove:
                        f.folder_id !== undefined
                          ? () =>
                              navigate(
                                f.folder_id
                                  ? `/files/folder/${f.folder_id}`
                                  : "/files"
                              )
                          : undefined,
                      onTrash: () => trash.mutate({ id: f.id, scope: SCOPE }),
                    }}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <FilePreviewModal
        open={!!preview}
        file={preview}
        siblings={files}
        onSelect={setPreview}
        onClose={() => setPreview(null)}
        onShare={setShareFor}
        onToggleStar={(f) => {
          if (f.starred_at) unstar.mutate({ id: f.id, scope: SCOPE });
          else star.mutate({ id: f.id, scope: SCOPE });
        }}
      />

      <ShareLinkDialog
        open={!!shareFor}
        resource={
          shareFor
            ? { kind: "file", id: shareFor.id, name: shareFor.filename }
            : null
        }
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
