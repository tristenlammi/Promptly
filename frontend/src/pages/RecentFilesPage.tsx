import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Clock } from "lucide-react";

import { type FileItem, supportsEditGrant, shareRolesFor } from "@/api/files";
import { FilePreviewModal } from "@/components/files/FilePreviewModal";
import { DriveEmptyState, DriveSimpleList } from "@/components/files/DriveSimpleList";
import { DriveSubNav } from "@/components/files/DriveSubNav";
import { ShareGrantsModal } from "@/components/files/ShareGrantsModal";
import { TopNav } from "@/components/layout/TopNav";
import { FilesTopNavSearch } from "@/components/files/FilesTopNavSearch";
import { downloadAuthed, openFile as openInEditor } from "@/components/files/helpers";
import {
  useRecentFiles,
  useStarFile,
  useTrashFile,
  useUnstarFile,
  invalidateFileQueries,
} from "@/hooks/useFiles";

// Drive stage 5 — Recent only reports files *you* touched. Previews
// of someone else's shared file shouldn't hijack your recents, and
// the sub-nav already provides cross-surface navigation, so the
// legacy scope-tab row was retired here.
const SCOPE = "mine" as const;

export function RecentFilesPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useRecentFiles(SCOPE);
  const [preview, setPreview] = useState<FileItem | null>(null);
  const [shareFor, setShareFor] = useState<FileItem | null>(null);

  // Documents, sheets and whiteboards open on their editor page (WP-3.4);
  // everything else previews.
  const openFile = (f: FileItem) => {
    if (!openInEditor(f, navigate)) setPreview(f);
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
        <div className="w-full px-6 py-6">
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
            <DriveSimpleList
              files={files}
              open={(e) => e.kind === "file" && openFile(e.file)}
              actions={(e) => {
                if (e.kind !== "file") return {};
                const f = e.file;
                return {
                  onPreview: () => openFile(f),
                  onDownload: () => downloadAuthed(f),
                  onShare: () => setShareFor(f),
                  onStar: f.starred_at ? undefined : () => star.mutate({ id: f.id, scope: SCOPE }),
                  onUnstar: f.starred_at ? () => unstar.mutate({ id: f.id, scope: SCOPE }) : undefined,
                  onMove:
                    f.folder_id !== undefined
                      ? () => navigate(f.folder_id ? `/files/folder/${f.folder_id}` : "/files")
                      : undefined,
                  onTrash: () => trash.mutate({ id: f.id, scope: SCOPE }),
                };
              }}
            />
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

      <ShareGrantsModal
        open={!!shareFor}
        resource={
          shareFor
            ? {
                type: "file",
                id: shareFor.id,
                name: shareFor.filename,
                supports_edit: supportsEditGrant(shareFor),
                roles: shareRolesFor(shareFor),
              }
            : null
        }
        onClose={() => setShareFor(null)}
        onChanged={() => {
          void invalidateFileQueries(qc);
          void qc.invalidateQueries({ queryKey: ["workspaces"] });
        }}
      />

    </>
  );
}
