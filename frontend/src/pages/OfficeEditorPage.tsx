import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Eye,
  LayoutTemplate,
  Loader2,
  MessageSquareText,
  MoreHorizontal,
  Share2,
  Sparkles,
  Star,
} from "lucide-react";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";

import { filesApi, type FileItem } from "@/api/files";
import { officeApi, officeEditorPath, type OfficeEditorInfo } from "@/api/office";
import { askAboutFiles } from "@/components/files/askAbout";
import { AskPanel } from "@/components/files/AskPanel";
import { EditorAiBridgeProvider } from "@/lib/editorAiBridge";
import { DocumentEditorModal } from "@/components/files/documents/DocumentEditorModal";
import { downloadAuthed, extractError } from "@/components/files/helpers";
import { ShareGrantsModal } from "@/components/files/ShareGrantsModal";
import { TopNav } from "@/components/layout/TopNav";
import { ErrorState } from "@/components/shared/Callout";
import { fileSheetBackend } from "@/components/workspaces/sheetBackend";
import { takeImportNotes } from "@/lib/office/importNotes";
import { invalidateFileQueries } from "@/hooks/useFiles";
import { useIsMobile } from "@/hooks/useIsMobile";
import { usePopoverDismiss } from "@/hooks/usePopoverDismiss";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";
import { lazyWithRetry } from "@/utils/lazyWithRetry";

// The sheet and whiteboard editors are big chunks — only fetched when one
// opens (same as in a workspace).
const WorkspaceSheetPane = lazyWithRetry(
  () => import("@/components/workspaces/WorkspaceSheetPane").then((m) => ({ default: m.WorkspaceSheetPane })),
  "WorkspaceSheetPane"
);
const WorkspaceCanvasPane = lazyWithRetry(
  () => import("@/components/workspaces/WorkspaceCanvasPane").then((m) => ({ default: m.WorkspaceCanvasPane })),
  "WorkspaceCanvasPane"
);

const SUFFIX = /\.(html|sheet|whiteboard)$/i;
const KIND_WORD = { document: "document", sheet: "spreadsheet", whiteboard: "whiteboard" } as const;

/**
 * A Document, Spreadsheet or Whiteboard opened from Files (WP-3.4,
 * Part C §3.5): ``/files/doc/:id``, ``/files/sheet/:id``,
 * ``/files/whiteboard/:id``. One header for all three — where it lives,
 * its name, star, Share, Export, Make a copy, Save as template and, for a
 * workspace file, Open in workspace — over the same editor the workspace
 * uses, answered by the file's own access.
 */
export function OfficeEditorPage() {
  const { fileId = "" } = useParams<{ fileId: string }>();
  // Where a chat citation points (WP-5.2): ``?q=`` opens find on a passage,
  // ``?tab=&row=`` selects a sheet row.
  const { search } = useLocation();
  const citeAt = useMemo(() => {
    const p = new URLSearchParams(search);
    return {
      q: p.get("q") || undefined,
      tab: p.get("tab") || undefined,
      row: Number(p.get("row")) || undefined,
      // A comment notification's link (WP-6.1).
      comment: p.get("comment") || undefined,
    };
  }, [search]);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isPhone = useIsMobile();
  const { data: info, error, isLoading } = useQuery({
    queryKey: ["office-info", fileId],
    queryFn: () => officeApi.info(fileId),
    // Opening records "opened" for Recent — once per visit is plenty.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    // A 404 means it's really gone; a 429 / 5xx / network blip (a busy
    // server, a restart) is worth a couple more tries before saying so.
    retry: (count, err) => {
      const status = (err as { response?: { status?: number } })?.response?.status;
      return status !== 403 && status !== 404 && count < 3;
    },
    retryDelay: (attempt) => Math.min(4000, 800 * 2 ** attempt),
  });
  const [file, setFile] = useState<FileItem | null>(null);
  useEffect(() => {
    if (info) setFile(info.file);
  }, [info]);
  // Ask about this file (WP-5.5) — a side panel; tools in the editor can
  // open it with a question (Sheets' "Explain formula").
  const [askOpen, setAskOpen] = useState(false);
  const [askQuestion, setAskQuestion] = useState<string | null>(null);
  // The sheet and whiteboard size themselves from the window — tell them
  // the room changed when the panel opens or closes.
  useEffect(() => {
    const t = window.setTimeout(() => window.dispatchEvent(new Event("resize")), 30);
    return () => window.clearTimeout(t);
  }, [askOpen]);
  // Just converted from Word: say what didn't come across (WP-4.3).
  const [importNotes, setImportNotes] = useState<{ from: string; notes: string[] } | null>(null);
  useEffect(() => {
    setImportNotes(takeImportNotes(fileId));
  }, [fileId]);

  const sheetBackend = useMemo(
    () => (info?.kind === "sheet" && info.content_id ? fileSheetBackend(fileId, info.content_id) : null),
    [fileId, info?.kind, info?.content_id]
  );

  const back = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate("/files");
  };

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-[var(--text-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening…
      </div>
    );
  }
  if (error || !info || !file) {
    return (
      <>
        <TopNav title="Not available" />
        <div className="mx-auto w-full max-w-xl px-4 py-10">
          <ErrorState>
            This file isn’t available — it may have been deleted, moved to the trash, or is no longer shared
            with you.{" "}
            <Link to="/files" className="font-medium underline">
              Back to Files
            </Link>
          </ErrorState>
        </div>
      </>
    );
  }

  const canEdit = info.access === "edit";
  // On a phone (Part C §2.4): documents stay editable; a sheet is a
  // pinch-zoom read view and a whiteboard is view-only.
  const phoneReadOnly = isPhone && info.kind !== "document";
  const editable = canEdit && !phoneReadOnly;
  return (
    <>
      <TopNav
        title={
          <OfficeTitle
            info={info}
            file={file}
            onRenamed={(f) => {
              setFile(f);
              invalidateFileQueries(qc);
            }}
          />
        }
        actions={
          <OfficeActions
            info={info}
            file={file}
            askOpen={askOpen}
            onToggleAsk={() => setAskOpen((o) => !o)}
            onFile={(f) => {
              setFile(f);
              invalidateFileQueries(qc);
            }}
          />
        }
      />
      {!editable && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--accent)]/[0.06] px-4 py-1.5 text-xs text-[var(--text-muted)]">
          <Eye className="h-3.5 w-3.5" />
          {canEdit
            ? `Viewing on a phone — open this ${KIND_WORD[info.kind]} on a computer or tablet to edit it.`
            : `You can view this ${KIND_WORD[info.kind]}. Ask the owner for edit access, or make a copy.`}
        </div>
      )}
      {importNotes && (
        <div
          role="status"
          className="flex shrink-0 items-start gap-2 border-b border-[var(--border)] bg-sky-500/[0.07] px-4 py-2 text-xs text-[var(--text)]"
        >
          <div className="min-w-0 flex-1">
            <span className="font-medium">Converted from “{importNotes.from}”.</span>{" "}
            {importNotes.notes.length === 0 ? (
              "Everything came across. The original is unchanged."
            ) : (
              <>
                The original is unchanged. Not everything came across:
                <ul className="mt-1 list-disc pl-5 text-[var(--text-muted)]">
                  {importNotes.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => setImportNotes(null)}
            className="shrink-0 rounded px-2 py-0.5 text-[var(--text-muted)] hover:bg-[var(--hover)]"
          >
            Dismiss
          </button>
        </div>
      )}
      <EditorAiBridgeProvider
        ask={(q) => {
          setAskQuestion(q);
          setAskOpen(true);
        }}
      >
      <div className="flex min-h-0 flex-1">
      {/* Clipped: the sheet grid draws to the size it measured, so it must
          not spill under the Ask panel. */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center text-sm text-[var(--text-muted)]">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading editor…
            </div>
          }
        >
          {info.kind === "document" && (
            <DocumentEditorModal
              file={file}
              inline
              initialFind={citeAt.q}
              onClose={back}
              onFileUpdated={(f) => {
                setFile(f);
                invalidateFileQueries(qc);
              }}
            />
          )}
          {info.kind === "sheet" && sheetBackend && info.content_id && (
            <WorkspaceSheetPane
              sheetId={info.content_id}
              canEdit={editable}
              backend={sheetBackend}
              fileId={fileId}
              openCommentId={citeAt.comment}
              focusCell={citeAt.row ? { tab: citeAt.tab, row: citeAt.row } : undefined}
            />
          )}
          {info.kind === "whiteboard" && info.content_id && (
            <WorkspaceCanvasPane
              canvasId={info.content_id}
              readOnly={!editable}
              fileId={fileId}
              openCommentId={citeAt.comment}
              deckTitle={file?.filename}
              startDeck={new URLSearchParams(search).get("slides") === "new"}
            />
          )}
        </Suspense>
      </div>
      <AskPanel
        fileId={fileId}
        kind={info.kind}
        open={askOpen}
        onClose={() => setAskOpen(false)}
        pendingQuestion={askQuestion}
        onPendingTaken={() => setAskQuestion(null)}
      />
      </div>
      </EditorAiBridgeProvider>
    </>
  );
}

// ---------------------------------------------------------------------
// Title: where it lives › its name (renamable for the owner's own files)
// ---------------------------------------------------------------------
function OfficeTitle({
  info,
  file,
  onRenamed,
}: {
  info: OfficeEditorInfo;
  file: FileItem;
  onRenamed: (f: FileItem) => void;
}) {
  const name = file.filename.replace(SUFFIX, "") || "Untitled";
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  // A document renames in its own editor header; a workspace file renames
  // in its workspace (Drive refuses with a 409 there).
  const renamable = info.is_owner && !info.workspace_id && info.kind !== "document";

  const commit = async () => {
    const next = draft.trim();
    if (!next || next === name) {
      setDraft(name);
      return;
    }
    try {
      onRenamed(await filesApi.renameFile(file.id, next));
    } catch (e) {
      toast.error(extractError(e));
      setDraft(name);
    }
  };

  const crumb = "truncate text-[var(--text-muted)] hover:text-[var(--text)] hover:underline";
  return (
    <span className="flex min-w-0 items-center gap-1 text-sm">
      {info.workspace_id ? (
        <Link to={`/workspaces/${info.workspace_id}`} className={cn(crumb, "max-w-[12rem]")}>
          {info.workspace_title ?? "Workspace"}
        </Link>
      ) : info.is_owner ? (
        <>
          <Link to="/files" className={cn(crumb, "hidden sm:inline")}>
            My files
          </Link>
          {info.path.map((p) => (
            <span key={p.id} className="hidden min-w-0 items-center gap-1 md:flex">
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
              <Link to={`/files/folder/${p.id}`} className={cn(crumb, "max-w-[10rem]")}>
                {p.name}
              </Link>
            </span>
          ))}
        </>
      ) : (
        <Link to="/files/shared" className={crumb}>
          Shared with me
        </Link>
      )}
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
      {renamable ? (
        <input
          aria-label="Name"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setDraft(name);
              (e.target as HTMLInputElement).blur();
            }
          }}
          className="min-w-0 max-w-[18rem] flex-1 truncate rounded bg-transparent px-1 py-0.5 font-semibold text-[var(--text)] outline-none hover:bg-[var(--hover)] focus:bg-[var(--hover)] focus:ring-1 focus:ring-[var(--accent)]"
        />
      ) : (
        <span className="truncate font-semibold text-[var(--text)]">{name}</span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------
// Actions: star, share, export, and the ⋯ menu
// ---------------------------------------------------------------------
function OfficeActions({
  info,
  file,
  onFile,
  askOpen,
  onToggleAsk,
}: {
  info: OfficeEditorInfo;
  file: FileItem;
  onFile: (f: FileItem) => void;
  askOpen: boolean;
  onToggleAsk: () => void;
}) {
  const navigate = useNavigate();
  const [shareOpen, setShareOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  usePopoverDismiss(menuOpen, menuRef, () => setMenuOpen(false));
  const starred = !!file.starred_at;

  const toggleStar = async () => {
    try {
      onFile(starred ? await filesApi.unstarFile(file.id) : await filesApi.starFile(file.id));
    } catch (e) {
      toast.error(extractError(e));
    }
  };
  const makeCopy = async () => {
    setMenuOpen(false);
    try {
      const { file: copy } = await filesApi.copyFileToMine(file.id);
      toast.success(`Made “${copy.filename.replace(SUFFIX, "")}”`);
      const path = officeEditorPath(copy);
      if (path) navigate(path);
    } catch (e) {
      toast.error(extractError(e));
    }
  };
  const saveAsTemplate = async () => {
    setMenuOpen(false);
    try {
      await officeApi.saveAsTemplate(file.id);
      toast.success("Saved to your Templates");
    } catch (e) {
      toast.error(extractError(e));
    }
  };

  const iconBtn =
    "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-[var(--text)] transition hover:bg-[var(--hover)]";
  const item = "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--hover)]";
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        className={cn(iconBtn, askOpen && "bg-[var(--accent)]/10 text-[var(--accent-text)]")}
        aria-pressed={askOpen}
        aria-label="Ask AI about this file"
        title="Ask AI about this file"
        onClick={onToggleAsk}
      >
        <Sparkles className="h-4 w-4" />
        <span className="hidden lg:inline">Ask AI</span>
      </button>
      {info.workspace_id && (
        <button
          type="button"
          className={iconBtn}
          title="Open in its workspace"
          onClick={() =>
            navigate(
              info.item_id
                ? `/workspaces/${info.workspace_id}?item=${info.item_id}`
                : `/workspaces/${info.workspace_id}`
            )
          }
        >
          <ExternalLink className="h-4 w-4" />
          <span className="hidden lg:inline">Open in workspace</span>
        </button>
      )}
      {info.is_owner && (
        <button
          type="button"
          className={iconBtn}
          aria-pressed={starred}
          title={starred ? "Remove star" : "Star"}
          onClick={() => void toggleStar()}
        >
          <Star className={cn("h-4 w-4", starred && "fill-amber-400 text-amber-400")} />
        </button>
      )}
      <button
        type="button"
        className={iconBtn}
        title="Download a copy"
        onClick={() => void downloadAuthed(file).catch((e) => toast.error(extractError(e)))}
      >
        <Download className="h-4 w-4" />
        <span className="hidden lg:inline">Export</span>
      </button>
      {info.is_owner && (
        <button
          type="button"
          onClick={() => setShareOpen(true)}
          className="ml-1 inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 text-sm font-medium text-white hover:opacity-90"
        >
          <Share2 className="h-4 w-4" />
          Share
        </button>
      )}
      <div ref={menuRef} className="relative">
        <button
          type="button"
          className={iconBtn}
          aria-label="More"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-9 z-40 w-52 overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)] py-1 shadow-lg"
          >
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setMenuOpen(false);
                askAboutFiles([file], navigate);
              }}
            >
              <MessageSquareText className="h-4 w-4" /> Ask about this
            </button>
            <button type="button" role="menuitem" className={item} onClick={() => void makeCopy()}>
              <Copy className="h-4 w-4" /> Make a copy
            </button>
            <button type="button" role="menuitem" className={item} onClick={() => void saveAsTemplate()}>
              <LayoutTemplate className="h-4 w-4" /> Save as template
            </button>
          </div>
        )}
      </div>
      <ShareGrantsModal
        open={shareOpen}
        resource={{
          type: "file",
          id: file.id,
          // A Doc's stored name ends in .html — not what people call it.
          name: file.filename.replace(/\.html?$/i, ""),
          supports_edit: true,
          // Docs, Sheets, Whiteboards: view, comment or edit (WP-6.6).
          roles: ["view", "comment", "edit"],
        }}
        onClose={() => setShareOpen(false)}
        onChanged={() => undefined}
      />
    </div>
  );
}
