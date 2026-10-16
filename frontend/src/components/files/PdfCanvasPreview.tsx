import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Minus, Plus } from "lucide-react";

import { cn } from "@/utils/cn";

/**
 * PDF preview rendered by pdf.js into canvases.
 *
 * The previous implementation pointed an ``<iframe>`` at a blob URL and
 * relied on the browser's built-in PDF plugin. That plugin is not ours
 * to depend on: Chrome ships a "Download PDFs instead of automatically
 * opening them" setting that is off by default but widely turned on,
 * and when it is set — or when the plugin document is otherwise refused
 * — the browser *downloads the file and leaves the frame blank*. From
 * inside the app that reads as "preview is broken and something stole
 * my click", with a stray file in ~/Downloads for a button the user
 * never pressed. There is a Download button in the header precisely so
 * downloading is a choice.
 *
 * Rendering to canvas ourselves removes the dependency entirely: same
 * result in every browser, no plugin, no download fallback, and no
 * interaction with the page's ``object-src`` policy.
 *
 * pdf.js is ~350 kB, so this whole module is lazy-loaded (see the
 * ``React.lazy`` in FilePreviewModal) and the library import below is
 * dynamic — nothing is fetched until someone opens a PDF.
 */

// Pages are rendered on demand as they scroll into view. A 400-page
// document at ~1.5 MB of canvas bitmap per page would otherwise take
// the tab down before the first page appeared.
const RENDER_MARGIN = "400px";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

interface PdfCanvasPreviewProps {
  /** The PDF bytes. Owned by the caller. */
  data: ArrayBuffer;
  filename: string;
  /** Rendered instead of the canvases when pdf.js can't parse the file. */
  onError?: (message: string) => void;
  /** Open scrolled to this page, outlined — where a chat citation points
   *  (WP-5.2). Out-of-range values are clamped. */
  initialPage?: number;
}

// Type-only, so nothing from pdf.js is pulled into this chunk at build
// time — but the calls below are checked against the real API instead
// of a hand-written approximation that can drift on upgrade.
type PdfDocument = import("pdfjs-dist").PDFDocumentProxy;
type PdfRenderTask = import("pdfjs-dist").RenderTask;

export function PdfCanvasPreview({
  data,
  filename,
  onError,
  initialPage,
}: PdfCanvasPreviewProps) {
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  // Page 1's shape, used as every unrendered page's placeholder size so a
  // jump to page N lands where page N will be (pages before it haven't
  // rendered yet).
  const [baseRatio, setBaseRatio] = useState<number | null>(null);
  const scrolledToTarget = useRef(false);
  const [err, setErr] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let task: import("pdfjs-dist").PDFDocumentLoadingTask | null = null;
    (async () => {
      try {
        // Worker, CMaps and fonts from our own origin; the bytes are copied
        // (pdf.js detaches what it's given) — lib/pdfjs.
        const { openPdf } = await import("@/lib/pdfjs");
        task = await openPdf(data);
        if (cancelled) {
          void task.destroy();
          return;
        }
        const document_ = await task.promise;
        if (cancelled) return;
        setDoc(document_);
      } catch (e) {
        if (cancelled) return;
        const message =
          e instanceof Error ? e.message : "This PDF could not be opened.";
        setErr(message);
        onError?.(message);
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
    // ``onError`` is a render-scoped callback in practice; re-running the
    // whole document load when it changes identity would refetch on every
    // parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Fit-to-width, measured rather than assumed — the modal is a flex
  // child whose width depends on the viewport and the safe-area insets.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setContainerWidth(el.clientWidth);
    });
    observer.observe(el);
    setContainerWidth(el.clientWidth);
    return () => observer.disconnect();
  }, [doc]);

  const pages = useMemo(
    () => (doc ? Array.from({ length: doc.numPages }, (_, i) => i + 1) : []),
    [doc]
  );

  const target =
    doc && initialPage && Number.isFinite(initialPage)
      ? Math.min(Math.max(1, Math.floor(initialPage)), doc.numPages)
      : null;

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    void doc.getPage(1).then((p) => {
      if (cancelled) return;
      const v = p.getViewport({ scale: 1 });
      setBaseRatio(v.height / v.width);
    });
    return () => {
      cancelled = true;
    };
  }, [doc]);

  useEffect(() => {
    if (!target || target === 1 || scrolledToTarget.current || !baseRatio || containerWidth <= 0) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-page="${target}"]`);
    if (!el) return;
    scrolledToTarget.current = true;
    el.scrollIntoView({ block: "start" });
  }, [target, baseRatio, containerWidth]);

  if (err) {
    return (
      <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
        {filename} couldn&rsquo;t be rendered: {err}
      </div>
    );
  }
  if (!doc) {
    return (
      <div className="flex items-center gap-2 text-sm text-white/80">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading preview…
      </div>
    );
  }

  return (
    <div className="flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-md bg-[var(--surface)] shadow-2xl">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-xs text-[var(--text-muted)]">
        <span>
          {target ? `Page ${target} of ${doc.numPages}` : `${doc.numPages} page${doc.numPages === 1 ? "" : "s"}`}
        </span>
        <div className="flex items-center gap-1">
          <ZoomButton
            label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP))}
          >
            <Minus className="h-3.5 w-3.5" />
          </ZoomButton>
          <span className="w-10 text-center tabular-nums">
            {Math.round(zoom * 100)}%
          </span>
          <ZoomButton
            label="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP))}
          >
            <Plus className="h-3.5 w-3.5" />
          </ZoomButton>
        </div>
      </div>
      <div
        ref={scrollRef}
        data-pdf-scroll
        className="min-h-0 flex-1 overflow-auto bg-[var(--surface-muted,#3f3f46)] px-3 py-3"
      >
        <div className="mx-auto flex w-fit flex-col items-center gap-3">
          {pages.map((n) => (
            <PdfPageCanvas
              key={n}
              doc={doc}
              pageNumber={n}
              containerWidth={containerWidth}
              zoom={zoom}
              fallbackRatio={baseRatio}
              target={n === target}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ZoomButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex h-6 w-6 items-center justify-center rounded transition",
        disabled
          ? "opacity-40"
          : "hover:bg-[var(--surface-hover,rgba(0,0,0,0.06))] hover:text-[var(--text)]"
      )}
    >
      {children}
    </button>
  );
}

function PdfPageCanvas({
  doc,
  pageNumber,
  containerWidth,
  zoom,
  fallbackRatio,
  target = false,
}: {
  doc: PdfDocument;
  pageNumber: number;
  containerWidth: number;
  zoom: number;
  fallbackRatio?: number | null;
  /** The page a citation points at: rendered straight away, outlined. */
  target?: boolean;
}) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(pageNumber === 1 || target);
  // Keeps the scroll height honest before a page has rendered, so
  // scrolling doesn't jump as pages fill in behind the viewport.
  const [ratio, setRatio] = useState<number | null>(null);

  useEffect(() => {
    const el = holderRef.current;
    if (!el || visible) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { root: el.closest("[data-pdf-scroll]") ?? null, rootMargin: RENDER_MARGIN }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  const render = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || !visible || containerWidth <= 0) return undefined;
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    setRatio(base.height / base.width);
    // Fit the page to the available width, then apply the user's zoom.
    // Multiply by DPR so the bitmap is sharp on retina displays, and
    // scale it back down in CSS pixels.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const fit = (containerWidth - 24) / base.width;
    const cssScale = Math.max(0.1, fit * zoom);
    const viewport = page.getViewport({ scale: cssScale * dpr });
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
    canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
    const task = page.render({ canvas, canvasContext: ctx, viewport });
    return task;
  }, [doc, pageNumber, containerWidth, zoom, visible]);

  useEffect(() => {
    let cancelled = false;
    let task: PdfRenderTask | undefined;
    (async () => {
      task = await render();
      if (!task) return;
      try {
        await task.promise;
      } catch {
        // A cancelled render (zoom changed mid-paint) rejects. The
        // replacement pass is already queued, so there is nothing to do.
      }
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [render]);

  return (
    <div
      ref={holderRef}
      data-page={pageNumber}
      data-target={target || undefined}
      className={cn("bg-white shadow-lg", target && "ring-4 ring-[var(--accent)]")}
      style={
        // Reserve the right height before render so the scrollbar doesn't
        // lurch — its own shape once measured, else page 1's.
        (ratio ?? fallbackRatio) && containerWidth
          ? {
              width: (containerWidth - 24) * zoom,
              height: (containerWidth - 24) * zoom * (ratio ?? fallbackRatio ?? 1),
            }
          : undefined
      }
    >
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}

export default PdfCanvasPreview;
