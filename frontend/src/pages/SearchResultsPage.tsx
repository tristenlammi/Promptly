import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Search } from "lucide-react";

import { isDocumentFile, type FileItem } from "@/api/files";
import { DocumentEditorModal } from "@/components/files/documents/DocumentEditorModal";
import { FilePreviewModal } from "@/components/files/FilePreviewModal";
import { DriveEmptyState, DriveFileRow } from "@/components/files/DriveRows";
import { DriveSubNav } from "@/components/files/DriveSubNav";
import { FilesTopNavSearch } from "@/components/files/FilesTopNavSearch";
import { ShareLinkDialog } from "@/components/files/ShareLinkDialog";
import { TopNav } from "@/components/layout/TopNav";
import {
  useSearchFiles,
  useStarFile,
  useTrashFile,
  useUnstarFile,
} from "@/hooks/useFiles";
import { downloadAuthed } from "@/components/files/helpers";

// Drive stage 5 — search runs against the caller's own files. The
// legacy "My files / Shared" tab was retired here alongside Recent
// / Starred / Trash so the sub-nav is the single source of truth
// for Drive-surface navigation.
const SCOPE = "mine" as const;

export function SearchResultsPage() {
  const [params] = useSearchParams();
  const q = (params.get("q") ?? "").trim();
  const { data, isLoading, isFetching } = useSearchFiles(q, SCOPE);
  const [preview, setPreview] = useState<FileItem | null>(null);
  // Drive Documents jump straight into the editor on click.
  const [editingDoc, setEditingDoc] = useState<FileItem | null>(null);
  const [shareFor, setShareFor] = useState<FileItem | null>(null);

  const openFile = (f: FileItem) => {
    if (isDocumentFile(f)) setEditingDoc(f);
    else setPreview(f);
  };

  const star = useStarFile();
  const unstar = useUnstarFile();
  const trash = useTrashFile();

  const hits = data?.hits ?? [];
  const files = useMemo(() => hits.map((h) => h.file), [hits]);

  return (
    <>
      <TopNav
        title="Search"
        subtitle={q ? `Results for "${q}"` : "Search Drive by filename or content."}
        actions={<FilesTopNavSearch />}
      />
      <DriveSubNav />

      <div className="promptly-scroll flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-6 py-6">
          {!q && (
            <DriveEmptyState
              icon={<Search className="h-5 w-5" />}
              title="Type to search"
              description="Use the search bar above to find files by name or content."
            />
          )}

          {q && (isLoading || isFetching) && (
            <div className="text-sm text-[var(--text-muted)]">Searching…</div>
          )}

          {q && !isLoading && hits.length === 0 && (
            <DriveEmptyState
              icon={<Search className="h-5 w-5" />}
              title="No results"
              description={`Nothing matched "${q}".`}
            />
          )}

          {hits.length > 0 && (
            <div className="rounded-card border border-[var(--border)] bg-[var(--surface)]">
              <ul className="divide-y divide-[var(--border)]">
                {hits.map((hit) => (
                  <DriveFileRow
                    key={hit.file.id}
                    file={hit.file}
                    extra={
                      <Snippet
                        snippet={hit.snippet}
                        breadcrumb={hit.breadcrumb}
                      />
                    }
                    actions={{
                      onPreview: () => openFile(hit.file),
                      onDownload: () => downloadAuthed(hit.file),
                      onShare: () => setShareFor(hit.file),
                      onStar: hit.file.starred_at
                        ? undefined
                        : () => star.mutate({ id: hit.file.id, scope: SCOPE }),
                      onUnstar: hit.file.starred_at
                        ? () => unstar.mutate({ id: hit.file.id, scope: SCOPE })
                        : undefined,
                      onTrash: () =>
                        trash.mutate({ id: hit.file.id, scope: SCOPE }),
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

/** Inline snippet + breadcrumb renderer. The snippet arrives from
 *  Postgres's ``ts_headline`` already wrapped in ``<b>`` tags so we
 *  render it through ``dangerouslySetInnerHTML`` — the backend
 *  configures ``ts_headline`` with a whitelisted marker so the
 *  output is safe to insert. We still cap the length defensively. */
function Snippet({
  snippet,
  breadcrumb,
}: {
  snippet: string | null;
  breadcrumb: string | null;
}) {
  if (!snippet && !breadcrumb) return null;
  const safe = snippet ? sanitizeSnippet(snippet) : null;
  return (
    <>
      {breadcrumb && (
        <span className="text-[var(--text-muted)]">{breadcrumb}</span>
      )}
      {safe && breadcrumb && " · "}
      {safe && (
        <span
          className="italic text-[var(--text-muted)]"
          dangerouslySetInnerHTML={{ __html: safe }}
        />
      )}
    </>
  );
}

/** Keep only ``<mark>`` tags from ``ts_headline`` output and escape
 *  everything else — the backend configures StartSel/StopSel as
 *  ``<mark>`` / ``</mark>`` so this is the only marker we have to
 *  whitelist. Snippets are capped defensively to 320 chars. */
function sanitizeSnippet(raw: string): string {
  const capped = raw.length > 320 ? raw.slice(0, 320) + "…" : raw;
  return capped
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(
      /&lt;mark&gt;/g,
      '<mark class="rounded bg-yellow-400/30 px-0.5 font-semibold text-[var(--text)]">'
    )
    .replace(/&lt;\/mark&gt;/g, "</mark>");
}
