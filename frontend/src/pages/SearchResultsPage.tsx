import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { FolderSearch, Search, Sparkles, X } from "lucide-react";

import {
  type FileItem,
  type FileSearchFilters,
  type FileSearchType,
  supportsEditGrant,
  shareRolesFor,
} from "@/api/files";
import { FilePreviewModal } from "@/components/files/FilePreviewModal";
import { DriveEmptyState, DriveSimpleList } from "@/components/files/DriveSimpleList";
import { DriveSubNav } from "@/components/files/DriveSubNav";
import { FilesTopNavSearch } from "@/components/files/FilesTopNavSearch";
import { ShareGrantsModal } from "@/components/files/ShareGrantsModal";
import { TopNav } from "@/components/layout/TopNav";
import { Button } from "@/components/shared/Button";
import {
  useSearchFilesPaged,
  useStarFile,
  useTrashFile,
  useUnstarFile,
  invalidateFileQueries,
} from "@/hooks/useFiles";
import { downloadAuthed, openFile as openInEditor } from "@/components/files/helpers";
import { cn } from "@/utils/cn";

// Search covers your own files plus what's shared with you; ``scope``
// stays "mine" for the cache key and the row actions.
const SCOPE = "mine" as const;

// Filter chips (WP-5.4): the common kinds one tap away, the rest in "More".
const TYPE_CHIPS: { value: FileSearchType | null; label: string }[] = [
  { value: null, label: "All" },
  { value: "document", label: "Docs" },
  { value: "sheet", label: "Sheets" },
  { value: "pdf", label: "PDFs" },
  { value: "office", label: "Office" },
  { value: "image", label: "Images" },
  { value: "folder", label: "Folders" },
];
const MORE_TYPES: { value: FileSearchType; label: string }[] = [
  { value: "whiteboard", label: "Whiteboards" },
  { value: "video", label: "Videos" },
  { value: "audio", label: "Audio" },
  { value: "text", label: "Text" },
];

const MODIFIED: { value: number | null; label: string }[] = [
  { value: null, label: "Any time" },
  { value: 7, label: "Past 7 days" },
  { value: 30, label: "Past 30 days" },
  { value: 365, label: "Past year" },
];

const OWNERS: { value: NonNullable<FileSearchFilters["owner"]>; label: string }[] = [
  { value: "any", label: "Anyone" },
  { value: "me", label: "Owned by me" },
  { value: "others", label: "Shared with me" },
];

export function SearchResultsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = (params.get("q") ?? "").trim();
  const openId = params.get("open");
  const within = params.get("in");
  const [type, setType] = useState<FileSearchType | null>(null);
  const [days, setDays] = useState<number | null>(null);
  const [owner, setOwner] = useState<NonNullable<FileSearchFilters["owner"]>>("any");
  const filters = useMemo<Omit<FileSearchFilters, "offset">>(
    () => ({
      type,
      owner,
      modifiedAfter: days
        ? new Date(Date.now() - days * 86_400_000).toISOString()
        : null,
      folderId: within,
      semantic: true,
    }),
    [type, owner, days, within]
  );
  const search = useSearchFilesPaged(q, SCOPE, filters);
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

  const pages = search.data?.pages ?? [];
  const hits = useMemo(() => pages.flatMap((p) => p.hits), [pages]);
  const folders = pages[0]?.folders ?? [];
  const folderTrails = pages[0]?.folder_breadcrumbs ?? {};
  const related = pages[0]?.related ?? [];
  const withinTrail = pages[0]?.within_trail ?? null;
  const files = useMemo(() => [...hits, ...related].map((h) => h.file), [hits, related]);
  const hitFiles = useMemo(() => hits.map((h) => h.file), [hits]);
  const hitById = useMemo(() => new Map(hits.map((h) => [h.file.id, h])), [hits]);
  const relatedFiles = useMemo(() => related.map((h) => h.file), [related]);
  const relatedById = useMemo(() => new Map(related.map((h) => [h.file.id, h])), [related]);
  const clearWithin = () => {
    const next = new URLSearchParams(params);
    next.delete("in");
    setParams(next, { replace: true });
  };

  // A pick from the instant results opens straight away.
  useEffect(() => {
    if (!openId) return;
    const hit = files.find((f) => f.id === openId);
    if (!hit) return;
    openFile(hit);
    const next = new URLSearchParams(params);
    next.delete("open");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, files]);

  const loading = search.isLoading;
  const empty = q && !loading && hits.length === 0 && folders.length === 0 && related.length === 0;

  return (
    <>
      <TopNav
        title="Search"
        subtitle={q ? `Results for "${q}"` : "Search Drive by filename or content."}
        actions={<FilesTopNavSearch />}
      />
      <DriveSubNav />

      <div className="promptly-scroll flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
          {!q && (
            <DriveEmptyState
              icon={<Search className="h-5 w-5" />}
              title="Type to search"
              description="Use the search bar above to find files by name or content."
            />
          )}

          {q && (
            <div className="mb-4 space-y-2">
              <div role="radiogroup" aria-label="Kind" className="flex flex-wrap gap-1.5">
                {TYPE_CHIPS.map((t) => (
                  <Chip
                    key={t.label}
                    active={type === t.value}
                    onClick={() => setType(t.value)}
                  >
                    {t.label}
                  </Chip>
                ))}
                <FilterSelect
                  label="More kinds"
                  value={MORE_TYPES.some((m) => m.value === type) ? (type as string) : ""}
                  options={[{ value: "", label: "More…" }, ...MORE_TYPES.map((m) => ({ value: m.value, label: m.label }))]}
                  onChange={(v) => setType((v || null) as FileSearchType | null)}
                />
              </div>
              <div className="flex flex-wrap gap-2">
              {within && (
                <span className="inline-flex items-center gap-1 rounded-full border border-[var(--accent)] bg-[var(--accent)]/10 py-1 pl-2.5 pr-1 text-xs text-[var(--accent-text)]">
                  <FolderSearch className="h-3 w-3" />
                  In {withinTrail ?? "this folder"}
                  <button
                    type="button"
                    onClick={clearWithin}
                    aria-label="Search everywhere"
                    title="Search everywhere"
                    className="rounded-full p-0.5 hover:bg-[var(--accent)]/20"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )}
              <FilterSelect
                label="Modified"
                value={days ? String(days) : ""}
                options={MODIFIED.map((m) => ({ value: m.value ? String(m.value) : "", label: m.label }))}
                onChange={(v) => setDays(v ? Number(v) : null)}
              />
              <FilterSelect
                label="Owner"
                value={owner}
                options={OWNERS}
                onChange={(v) => setOwner(v as NonNullable<FileSearchFilters["owner"]>)}
              />
              </div>
            </div>
          )}

          {q && loading && (
            <div className="text-sm text-[var(--text-muted)]">Searching…</div>
          )}

          {empty && (
            <DriveEmptyState
              icon={<Search className="h-5 w-5" />}
              title="No results"
              description={`Nothing matched "${q}".`}
            />
          )}

          {(hits.length > 0 || folders.length > 0) && (
            <DriveSimpleList
              folders={folders}
              files={hitFiles}
              open={(e) =>
                e.kind === "folder"
                  ? navigate(e.folder.scope === "mine" ? `/files/folder/${e.folder.id}` : `/files/folder/${e.folder.id}?scope=shared`)
                  : openFile(e.file)
              }
              extra={(e) => {
                if (e.kind === "folder")
                  return folderTrails[e.folder.id] ? (
                    <span className="text-[var(--text-muted)]">{folderTrails[e.folder.id]}</span>
                  ) : undefined;
                const hit = hitById.get(e.file.id);
                return hit ? <Snippet snippet={hit.snippet} breadcrumb={hit.breadcrumb} /> : undefined;
              }}
              actions={(e) => {
                if (e.kind === "folder") return {};
                const hit = hitById.get(e.file.id);
                const f = e.file;
                return {
                  onPreview: () => openFile(f),
                  onDownload: () => downloadAuthed(f),
                  onShowInFolder: hit?.parent_link ? () => navigate(hit.parent_link!) : undefined,
                  onShare: f.scope === "mine" ? () => setShareFor(f) : undefined,
                  onStar: f.starred_at ? undefined : () => star.mutate({ id: f.id, scope: SCOPE }),
                  onUnstar: f.starred_at ? () => unstar.mutate({ id: f.id, scope: SCOPE }) : undefined,
                  onTrash: f.scope === "mine" ? () => trash.mutate({ id: f.id, scope: SCOPE }) : undefined,
                };
              }}
            />
          )}

          {related.length > 0 && (
            <section className="mt-6" aria-label="Related by meaning">
              <h2 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                <Sparkles className="h-3.5 w-3.5 text-[var(--accent-text)]" />
                Related by meaning
                <span className="normal-case tracking-normal">· from AI search of your files</span>
              </h2>
              <DriveSimpleList
                files={relatedFiles}
                open={(e) => e.kind === "file" && openFile(e.file)}
                extra={(e) => {
                  const hit = e.kind === "file" ? relatedById.get(e.file.id) : undefined;
                  return hit ? <Snippet snippet={hit.snippet} breadcrumb={hit.breadcrumb} /> : undefined;
                }}
                actions={(e) => {
                  if (e.kind !== "file") return {};
                  const hit = relatedById.get(e.file.id);
                  return {
                    onPreview: () => openFile(e.file),
                    onDownload: () => downloadAuthed(e.file),
                    onShowInFolder: hit?.parent_link ? () => navigate(hit.parent_link!) : undefined,
                  };
                }}
              />
            </section>
          )}

          {search.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                loading={search.isFetchingNextPage}
                onClick={() => void search.fetchNextPage()}
              >
                Load more
              </Button>
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

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs transition",
        active
          ? "border-[var(--accent)] bg-[var(--accent)]/10 font-medium text-[var(--accent-text)]"
          : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]"
      )}
    >
      {children}
    </button>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <label
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs",
        value && value !== "any"
          ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent-text)]"
          : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]"
      )}
    >
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent text-xs outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
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
  /** Where it lives ("My files / Taxes"); the row menu's "Show in folder"
   *  opens it — the row itself is a button, so the trail is plain text. */
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
export function sanitizeSnippet(raw: string): string {
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
