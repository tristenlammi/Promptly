import { useQuery } from "@tanstack/react-query";
import { ExternalLink, LayoutGrid, Loader2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import type { FileItem } from "@/api/files";
import { filesShellApi, type WorkspaceDriveEntry } from "@/api/filesShell";
import { DriveItemIcon } from "@/components/files/DriveItemIcon";
import { DriveSubNav } from "@/components/files/DriveSubNav";
import { FilePreviewModal } from "@/components/files/FilePreviewModal";
import { FilesTopNavSearch } from "@/components/files/FilesTopNavSearch";
import { displayFileName, formatRelativeTime, humanSize, kindLabel, openFile } from "@/components/files/helpers";
import { TopNav } from "@/components/layout/TopNav";
import { ErrorState } from "@/components/shared/Callout";
import { useWorkspaces } from "@/hooks/useWorkspaces";

const GROUPS: { label: string; kinds: WorkspaceDriveEntry["item_kind"][] }[] = [
  { label: "Documents", kinds: ["note"] },
  { label: "Spreadsheets", kinds: ["sheet"] },
  { label: "Whiteboards", kinds: ["canvas"] },
  { label: "Pinned files", kinds: ["pinned"] },
];

/**
 * Files › Workspaces › one workspace (``/files/workspaces/:wsId``, Part C
 * §2.2): the workspace like a shared drive — its Docs, Sheets, Whiteboards
 * and pinned files, as real files that open on their own pages. Replaces
 * browsing System › Workspaces mirror folders.
 */
export function WorkspaceDrivePage() {
  const { wsId = "" } = useParams<{ wsId: string }>();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<FileItem | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["files-workspace-drive", wsId],
    queryFn: () => filesShellApi.workspaceDrive(wsId),
    enabled: !!wsId,
  });
  const files = data?.entries.map((e) => e.file) ?? [];

  return (
    <>
      <TopNav
        title={data?.title ?? "Workspace"}
        subtitle="Documents, sheets, whiteboards and pinned files in this workspace."
        actions={<FilesTopNavSearch />}
      />
      <DriveSubNav />
      <div className="promptly-scroll flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
          <div className="mb-4 flex items-center gap-2">
            <Link
              to={`/workspaces/${wsId}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--hover)]"
            >
              <ExternalLink className="h-4 w-4" /> Open workspace
            </Link>
            {data && <span className="text-xs text-[var(--text-muted)]">You’re {data.role === "owner" ? "the owner" : `a ${data.role}`}.</span>}
          </div>
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}
          {error && <ErrorState>This workspace isn’t available to you.</ErrorState>}
          {data && data.entries.length === 0 && (
            <p className="text-sm text-[var(--text-muted)]">Nothing here yet — add notes, sheets or whiteboards in the workspace.</p>
          )}
          {data &&
            GROUPS.map((g) => {
              const rows = data.entries.filter((e) => g.kinds.includes(e.item_kind));
              if (!rows.length) return null;
              return (
                <section key={g.label} className="mb-6">
                  <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                    {g.label} <span className="tabular-nums">· {rows.length}</span>
                  </h2>
                  <ul className="divide-y divide-[var(--border)] rounded-card border border-[var(--border)] bg-[var(--surface)]">
                    {rows.map(({ file }) => (
                      <li key={file.id}>
                        <button
                          type="button"
                          onClick={() => {
                            if (!openFile(file, navigate)) setPreview(file);
                          }}
                          className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--hover)]"
                        >
                          <DriveItemIcon file={file} tile />
                          <span className="min-w-0 flex-1 truncate text-sm">{displayFileName(file)}</span>
                          <span className="hidden w-24 shrink-0 text-xs text-[var(--text-muted)] md:block">{kindLabel(file)}</span>
                          <span className="hidden w-28 shrink-0 text-xs text-[var(--text-muted)] sm:block">
                            {file.modified_at ? formatRelativeTime(file.modified_at) : ""}
                          </span>
                          <span className="hidden w-16 shrink-0 text-right text-xs tabular-nums text-[var(--text-muted)] sm:block">
                            {humanSize(file.size_bytes)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
        </div>
      </div>
      <FilePreviewModal open={!!preview} file={preview} siblings={files} onClose={() => setPreview(null)} onSelect={setPreview} />
    </>
  );
}

/** ``/files/workspaces`` — every workspace you're in, as drives. */
export function WorkspaceDrivesIndexPage() {
  const { data, isLoading } = useWorkspaces();
  return (
    <>
      <TopNav title="Workspaces" subtitle="Each workspace you belong to, like a shared drive." actions={<FilesTopNavSearch />} />
      <DriveSubNav />
      <div className="promptly-scroll flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-2 px-4 py-6 sm:grid-cols-2 sm:px-6 lg:grid-cols-3">
          {isLoading && <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />}
          {(data ?? []).map((w) => (
            <Link
              key={w.id}
              to={`/files/workspaces/${w.id}`}
              className="flex items-center gap-3 rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-3 hover:bg-[var(--hover)]"
            >
              <span className="grid h-9 w-9 place-items-center rounded-md bg-[var(--accent)]/10 text-[var(--accent-text)]">
                <LayoutGrid className="h-4 w-4" />
              </span>
              <span className="truncate text-sm font-medium">{w.title || "Untitled workspace"}</span>
            </Link>
          ))}
          {data && data.length === 0 && <p className="text-sm text-[var(--text-muted)]">You’re not in any workspaces yet.</p>}
        </div>
      </div>
    </>
  );
}
