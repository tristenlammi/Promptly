import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Highlighter,
  History,
  Loader2,
  Minus,
  MousePointer2,
  PanelLeft,
  PenLine,
  Plus,
  Save,
  Search,
  Type,
  Undo2,
  X,
} from "lucide-react";

import { useQueryClient } from "@tanstack/react-query";

import { filesApi } from "@/api/files";
import { pdfApi } from "@/api/pdf";
import { confirm } from "@/components/shared/ConfirmDialog";
import { VersionHistoryPanel } from "@/components/files/VersionHistoryPanel";
import { loadPdfViewer, openPdf } from "@/lib/pdfjs";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { PdfPagesRail, type PageOps } from "./PdfPagesRail";

/**
 * The PDF viewer (WP-6.5): pdf.js 6's own ``PDFViewer`` — selectable text,
 * search, links, form filling — plus its annotation editors (highlight,
 * text, drawing) and page tools (delete, extract, add pages from another
 * PDF or an image). Everything happens in the browser; **Save** sends the
 * result, and what it replaces becomes a version (``PUT /files/{id}/pdf``).
 * Someone who can only view can still fill a form or mark it up and save
 * their own copy.
 */
type PDFDocumentProxy = import("pdfjs-dist").PDFDocumentProxy;
type LoadingTask = import("pdfjs-dist").PDFDocumentLoadingTask;
type ViewerModule = Awaited<ReturnType<typeof loadPdfViewer>>;
type Tool = "none" | "highlight" | "freetext" | "ink";

export interface PdfViewerProps {
  fileId: string;
  filename: string;
  data: ArrayBuffer;
  /** Which bytes ``data`` is (the download's ``X-File-Revision``). */
  revision: string | null;
  canEdit: boolean;
  /** Where "Save a copy" and "Extract" put new files (``null`` = My files). */
  copyFolderId: string | null;
  initialPage?: number;
  onDirtyChange?: (dirty: boolean) => void;
  /** After a save or a restore — the file's size and date changed. */
  onChanged?: () => void;
  /** After a restore: load the file again. */
  onReload?: () => void;
}

export function PdfViewer({
  fileId,
  filename,
  data,
  revision: initialRevision,
  canEdit,
  copyFolderId,
  initialPage,
  onDirtyChange,
  onChanged,
  onReload,
}: PdfViewerProps) {
  const qc = useQueryClient();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerElRef = useRef<HTMLDivElement | null>(null);
  const libRef = useRef<ViewerModule | null>(null);
  const viewerRef = useRef<InstanceType<ViewerModule["viewer"]["PDFViewer"]> | null>(null);
  const eventBusRef = useRef<InstanceType<ViewerModule["viewer"]["EventBus"]> | null>(null);
  const taskRef = useRef<LoadingTask | null>(null);
  const undoRef = useRef<Uint8Array[]>([]);
  // pdf.js's "something to undo" stays true after a save, so it only counts
  // until the first save; after that, drawing on a page with a markup tool
  // (below) is what marks the PDF changed.
  const savedUndoRef = useRef(false);
  const toolRef = useRef<Tool>("none");
  const firstLoad = useRef(true);

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [scale, setScale] = useState(1);
  const [tool, setTool] = useState<Tool>("none");
  const [dirty, setDirtyState] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [revision, setRevision] = useState(initialRevision);
  const [railOpen, setRailOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<{ current: number; total: number }>({ current: 0, total: 0 });
  // pdf.js FindState: 0 found, 1 not found, 2 wrapped, 3 pending.
  const [findState, setFindState] = useState(3);
  const [canUndo, setCanUndo] = useState(false);

  const setDirty = useCallback(
    (d: boolean) => {
      setDirtyState(d);
      onDirtyChange?.(d);
    },
    [onDirtyChange]
  );

  // ---------------------------------------------------------------- set up

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const lib = await loadPdfViewer();
        if (!alive || !containerRef.current || !viewerElRef.current) return;
        libRef.current = lib;
        const { viewer: V, pdfjs } = lib;
        const eventBus = new V.EventBus();
        const linkService = new V.PDFLinkService({ eventBus, externalLinkTarget: V.LinkTarget.BLANK });
        const findController = new V.PDFFindController({ eventBus, linkService });
        const viewer = new V.PDFViewer({
          container: containerRef.current,
          viewer: viewerElRef.current,
          eventBus,
          linkService,
          findController,
          annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
          annotationEditorMode: pdfjs.AnnotationEditorType.NONE,
          removePageBorders: false,
        });
        linkService.setViewer(viewer);
        eventBusRef.current = eventBus;
        viewerRef.current = viewer;
        eventBus.on("pagesinit", () => {
          viewer.currentScaleValue = "page-width";
          if (firstLoad.current && initialPage) {
            // A chat citation's page (WP-5.2): go there and outline it.
            const n = Math.min(Math.max(1, initialPage), viewer.pagesCount);
            viewer.currentPageNumber = n;
            viewerElRef.current?.querySelector(`.page[data-page-number="${n}"]`)?.setAttribute("data-target", "");
          }
          firstLoad.current = false;
        });
        eventBus.on("pagechanging", (e: { pageNumber: number }) => setPage(e.pageNumber));
        eventBus.on("scalechanging", (e: { scale: number }) => setScale(e.scale));
        const onMatches = (e: { matchesCount?: { current: number; total: number } }) => {
          if (e.matchesCount) setMatches(e.matchesCount);
        };
        eventBus.on("updatefindmatchescount", onMatches);
        eventBus.on("updatefindcontrolstate", (e: { state: number; matchesCount?: { current: number; total: number } }) => {
          setFindState(e.state);
          onMatches(e);
        });
        // A drawing or note in progress isn't in the annotation storage
        // until it's committed, but it can be undone — that's unsaved too.
        eventBus.on("editingstateschanged", (e: { details?: { hasSomethingToUndo?: boolean } }) => {
          if (e.details?.hasSomethingToUndo && !savedUndoRef.current) setDirty(true);
        });
        eventBus.on("annotationeditormodechanged", (e: { mode: number }) => {
          const T = pdfjs.AnnotationEditorType;
          const t: Tool = e.mode === T.HIGHLIGHT ? "highlight" : e.mode === T.FREETEXT ? "freetext" : e.mode === T.INK ? "ink" : "none";
          setTool(t);
          toolRef.current = t;
        });
        await load(new Uint8Array(data.slice(0)), false);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "This PDF couldn't be opened.");
      }
    })();
    return () => {
      alive = false;
      void taskRef.current?.destroy();
      taskRef.current = null;
    };
    // The viewer is built once per file; ``data`` changes remount it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Show ``bytes`` (the file, or the result of a page change). */
  const load = useCallback(
    async (bytes: Uint8Array, edited: boolean) => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      const keepPage = viewer.pagesCount ? viewer.currentPageNumber : 0;
      const task = await openPdf(bytes);
      const next = await task.promise;
      const old = taskRef.current;
      taskRef.current = task;
      viewer.setDocument(next);
      viewer.linkService.setDocument(next, null);
      viewer.findController?.setDocument(next);
      void old?.destroy();
      // Typed as ``null`` in pdf.js's declarations; it's a callback slot.
      (next.annotationStorage as unknown as { onSetModified: (() => void) | null }).onSetModified = () =>
        setDirty(true);
      setDoc(next);
      setPages(next.numPages);
      setMatches({ current: 0, total: 0 });
      if (keepPage) {
        const restore = () => {
          viewer.currentPageNumber = Math.min(keepPage, next.numPages);
          eventBusRef.current?.off("pagesinit", restore);
        };
        eventBusRef.current?.on("pagesinit", restore);
      }
      setDirty(edited);
    },
    [setDirty]
  );

  // ---------------------------------------------------------------- tools

  const chooseTool = (next: Tool) => {
    const lib = libRef.current;
    const viewer = viewerRef.current;
    if (!lib || !viewer) return;
    const T = lib.pdfjs.AnnotationEditorType;
    const mode = { none: T.NONE, highlight: T.HIGHLIGHT, freetext: T.FREETEXT, ink: T.INK }[next];
    viewer.annotationEditorMode = { mode };
    setTool(next);
    toolRef.current = next;
  };

  const zoom = (factor: number) => {
    const viewer = viewerRef.current;
    if (viewer) viewer.currentScale = Math.min(4, Math.max(0.25, viewer.currentScale * factor));
  };

  const find = (again: boolean, previous = false, text = query) => {
    eventBusRef.current?.dispatch("find", {
      source: null,
      type: again ? "again" : "",
      query: text,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });
  };

  /** Finish whatever drawing or note is being edited, so it's in the PDF
   *  pdf.js writes (it commits on leaving the tool). */
  const commitEdits = async () => {
    const lib = libRef.current;
    const viewer = viewerRef.current;
    if (!lib || !viewer || tool === "none") return;
    viewer.annotationEditorMode = { mode: lib.pdfjs.AnnotationEditorType.NONE };
    setTool("none");
    toolRef.current = "none";
    await new Promise((r) => window.setTimeout(r, 50));
  };

  // ---------------------------------------------------------------- pages

  /** A page change: rebuild the PDF (with any form or markup edits in it)
   *  and show the result, unsaved. Undo goes back one change. */
  const changePages = async (label: string, make: (d: PDFDocumentProxy) => Promise<Uint8Array>) => {
    if (!doc || busy) return;
    setBusy(label);
    try {
      await commitEdits();
      const before = await doc.saveDocument();
      const after = await make(doc);
      undoRef.current.push(before);
      setCanUndo(true);
      await load(after, true);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't change the pages."));
    } finally {
      setBusy(null);
    }
  };

  const undo = async () => {
    const prev = undoRef.current.pop();
    setCanUndo(undoRef.current.length > 0);
    if (prev) await load(prev, true);
  };

  const base = filename.replace(/\.pdf$/i, "") || "Document";

  const uploadCopy = async (bytes: Uint8Array, name: string) => {
    const file = new File([bytes as BlobPart], name, { type: "application/pdf" });
    return filesApi.upload("mine", file, copyFolderId);
  };

  const pageOps: PageOps = {
    remove: (indices) =>
      changePages("Deleting pages…", (d) => d.extractPages([{ document: null, excludePages: indices }])),
    extract: async (indices) => {
      if (!doc || busy) return;
      setBusy("Extracting pages…");
      try {
        await commitEdits();
        const bytes = await doc.extractPages([{ document: null, includePages: indices }]);
        const made = await uploadCopy(bytes, `${base} (${describePages(indices)}).pdf`);
        toast.success(`Saved “${made.filename}” to your files.`);
        onChanged?.();
      } catch (e) {
        toast.error(apiErrorMessage(e, "Couldn't extract those pages."));
      } finally {
        setBusy(null);
      }
    },
    add: async (file: File, after: number) => {
      const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
      const insertAfter = Math.min(after, pages - 1);
      if (isPdf) {
        const other = new Uint8Array(await file.arrayBuffer());
        return changePages("Adding pages…", (d) =>
          d.extractPages([{ document: null }, { document: other, insertAfter }])
        );
      }
      if (!file.type.startsWith("image/")) {
        toast.error("Add a PDF or a picture.");
        return;
      }
      const image = await createImageBitmap(file);
      return changePages("Adding a page…", (d) => d.extractPages([{ document: null }, { image, insertAfter }]));
    },
  };

  // ---------------------------------------------------------------- save

  const saveCopy = async () => {
    if (!doc || busy) return;
    setBusy("Saving a copy…");
    try {
      await commitEdits();
      const bytes = await doc.saveDocument();
      const made = await uploadCopy(bytes, `${base} (copy).pdf`);
      toast.success(`Saved “${made.filename}” to your files.`);
      onChanged?.();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't save a copy."));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!doc || busy || !canEdit) return;
    if (!revision) {
      toast.error("Reload the PDF before saving it.");
      return;
    }
    setBusy("Saving…");
    try {
      await commitEdits();
      const bytes = await doc.saveDocument();
      const saved = await pdfApi.save(fileId, bytes, revision);
      setRevision(saved.revision);
      doc.annotationStorage.resetModified();
      savedUndoRef.current = true;
      undoRef.current = [];
      setCanUndo(false);
      setDirty(false);
      toast.success("Saved. The previous copy is in the version history.");
      void qc.invalidateQueries({ queryKey: ["file-versions", fileId] });
      onChanged?.();
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status;
      if (status === 409) {
        setBusy(null);
        const ok = await confirm({
          title: "Someone else saved this PDF",
          message: "It changed after you opened it. Save your version as a separate copy instead, so neither is lost?",
          confirmLabel: "Save a copy",
        });
        if (ok) await saveCopy();
        return;
      }
      toast.error(apiErrorMessage(e, "Couldn't save the PDF."));
    } finally {
      setBusy(null);
    }
  };

  // Ctrl/⌘+F searches the PDF, Ctrl/⌘+S saves it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindOpen(true);
        window.setTimeout(() => document.getElementById(`pdf-find-${fileId}`)?.focus(), 0);
      } else if (e.key.toLowerCase() === "s" && dirty && canEdit) {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---------------------------------------------------------------- render

  const toolButton = (t: Tool, label: string, Icon: typeof Highlighter) => (
    <button
      type="button"
      onClick={() => chooseTool(tool === t && t !== "none" ? "none" : t)}
      aria-pressed={tool === t}
      title={label}
      aria-label={label}
      disabled={!doc}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-md transition disabled:opacity-40",
        tool === t ? "bg-white/20 text-white" : "text-white/75 hover:bg-white/10 hover:text-white"
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
  const plain =
    "inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-xs text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-40";

  return (
    <div data-pdf-viewer className="relative flex h-full w-full min-w-0 flex-col overflow-hidden rounded-md bg-neutral-800 text-white">
      <div role="toolbar" aria-label="PDF tools" className="flex shrink-0 flex-wrap items-center gap-1 border-b border-white/10 bg-black/40 px-2 py-1">
        <button
          type="button"
          className={cn(plain, railOpen && "bg-white/15 text-white")}
          onClick={() => setRailOpen((v) => !v)}
          aria-pressed={railOpen}
          aria-label="Pages"
          title="Pages"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
        <span className="px-1 text-xs tabular-nums text-white/70" aria-live="polite">
          {pages ? `Page ${page} of ${pages}` : "…"}
        </span>
        <span className="mx-1 h-5 w-px bg-white/15" />
        <button type="button" className={plain} onClick={() => zoom(1 / 1.2)} aria-label="Zoom out" title="Zoom out">
          <Minus className="h-4 w-4" />
        </button>
        <button
          type="button"
          className={cn(plain, "w-12 tabular-nums")}
          onClick={() => viewerRef.current && (viewerRef.current.currentScaleValue = "page-width")}
          title="Fit to width"
        >
          {Math.round(scale * 100)}%
        </button>
        <button type="button" className={plain} onClick={() => zoom(1.2)} aria-label="Zoom in" title="Zoom in">
          <Plus className="h-4 w-4" />
        </button>
        <span className="mx-1 h-5 w-px bg-white/15" />
        <button
          type="button"
          className={cn(plain, findOpen && "bg-white/15 text-white")}
          onClick={() => setFindOpen((v) => !v)}
          aria-label="Search in the PDF"
          title="Search (Ctrl+F)"
        >
          <Search className="h-4 w-4" />
        </button>
        <span className="mx-1 h-5 w-px bg-white/15" />
        <div role="group" aria-label="Markup tools" className="flex items-center gap-0.5">
          {toolButton("none", "Select", MousePointer2)}
          {toolButton("highlight", "Highlight", Highlighter)}
          {toolButton("freetext", "Add text", Type)}
          {toolButton("ink", "Draw", PenLine)}
        </div>
        {canUndo && (
          <button type="button" className={plain} onClick={() => void undo()} disabled={!!busy} title="Undo the last page change">
            <Undo2 className="h-4 w-4" /> Undo pages
          </button>
        )}
        <div className="ml-auto flex items-center gap-1">
          {busy && (
            <span className="inline-flex items-center gap-1 text-xs text-white/70">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {busy}
            </span>
          )}
          {!busy && dirty && <span className="text-xs text-amber-300">Unsaved changes</span>}
          <button type="button" className={plain} onClick={() => setHistoryOpen(true)} title="Version history">
            <History className="h-4 w-4" /> <span className="hidden lg:inline">History</span>
          </button>
          <button type="button" className={plain} onClick={() => void saveCopy()} disabled={!doc || !!busy} title="Save as a new file in your files">
            <Copy className="h-4 w-4" /> <span className="hidden lg:inline">Save a copy</span>
          </button>
          {canEdit && (
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || !!busy}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-40"
            >
              <Save className="h-4 w-4" /> Save
            </button>
          )}
        </div>
      </div>

      {findOpen && (
        <form
          className="flex shrink-0 items-center gap-1 border-b border-white/10 bg-black/30 px-2 py-1"
          onSubmit={(e) => {
            e.preventDefault();
            find(true);
          }}
        >
          <input
            id={`pdf-find-${fileId}`}
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              find(false, false, e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setFindOpen(false);
              } else if (e.key === "Enter" && e.shiftKey) {
                e.preventDefault();
                find(true, true);
              }
            }}
            placeholder="Find in this PDF"
            aria-label="Find in this PDF"
            className="h-7 w-56 rounded border border-white/15 bg-black/30 px-2 text-xs text-white placeholder:text-white/40 focus:outline-none focus:ring-1 focus:ring-white/40"
          />
          <span className="min-w-16 text-xs tabular-nums text-white/60" aria-live="polite">
            {query ? (matches.total ? `${matches.current} of ${matches.total}` : findState === 1 ? "No matches" : "") : ""}
          </span>
          <button type="button" className={plain} onClick={() => find(true, true)} aria-label="Previous match">
            <ChevronUp className="h-4 w-4" />
          </button>
          <button type="submit" className={plain} aria-label="Next match">
            <ChevronDown className="h-4 w-4" />
          </button>
          <button type="button" className={plain} onClick={() => setFindOpen(false)} aria-label="Close search">
            <X className="h-4 w-4" />
          </button>
        </form>
      )}

      <div className="relative flex min-h-0 flex-1">
        {railOpen && doc && (
          <PdfPagesRail
            doc={doc}
            current={page}
            busy={!!busy}
            onGo={(n) => viewerRef.current && (viewerRef.current.currentPageNumber = n)}
            ops={pageOps}
          />
        )}
        <div className="relative min-w-0 flex-1">
          <div
            ref={containerRef}
            className="pdf-viewer-host absolute inset-0 overflow-auto"
            tabIndex={0}
            onPointerUp={(e) => {
              if (toolRef.current !== "none" && (e.target as HTMLElement).closest?.(".page")) setDirty(true);
            }}
            onKeyUp={(e) => {
              if (toolRef.current !== "none" && (e.target as HTMLElement).isContentEditable) setDirty(true);
            }}
          >
            <div ref={viewerElRef} className="pdfViewer" />
          </div>
          {error && (
            <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-red-300">{error}</div>
          )}
          {!doc && !error && (
            <div className="absolute inset-0 flex items-center justify-center text-white/60">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          )}
        </div>
      </div>

      {historyOpen && (
        <div className="absolute inset-0 z-30">
          <VersionHistoryPanel
            fileId={fileId}
            onClose={() => setHistoryOpen(false)}
            onRestored={() => {
              setHistoryOpen(false);
              setDirty(false);
              onChanged?.();
              onReload?.();
            }}
          />
        </div>
      )}
    </div>
  );
}

/** "page 3" / "pages 2–4, 7" — 0-based indices in, 1-based words out. */
export function describePages(indices: number[]): string {
  const sorted = [...new Set(indices)].sort((a, b) => a - b).map((i) => i + 1);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : `${sorted[i]}`);
    i = j;
  }
  return `${sorted.length === 1 ? "page" : "pages"} ${parts.join(", ")}`;
}
