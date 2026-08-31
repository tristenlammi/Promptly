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
}: PdfCanvasPreviewProps) {
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let loaded: PdfDocument | null = null;
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        // Vite emits the worker as its own asset and hands back a URL on
        // our own origin, which is what ``worker-src 'self'`` allows.
        const workerUrl = (
          await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
        ).default;
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        // pdf.js transfers the buffer to its worker, which detaches it —
        // and the caller may re-render us with the same ArrayBuffer. Hand
        // over a copy so a second mount doesn't get an empty buffer.
        const task = pdfjs.getDocument({ data: data.slice(0) });
        const document_ = await task.promise;
        if (cancelled) {
          void document_.destroy();
          return;
        }
        loaded = document_;
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
      void loaded?.destroy();
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
          {doc.numPages} page{doc.numPages === 1 ? "" : "s"}
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
}: {
  doc: PdfDocument;
  pageNumber: number;
  containerWidth: number;
  zoom: number;
}) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(pageNumber === 1);
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
    const task = page.render({ canvasContext: ctx, viewport });
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
      className="bg-white shadow-lg"
      style={
        // Reserve the right height before render so the scrollbar doesn't
        // lurch. Falls back to A4 proportions until the page is measured.
        ratio && containerWidth
          ? { width: (containerWidth - 24) * zoom, height: (containerWidth - 24) * zoom * ratio }
          : undefined
      }
    >
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}

export default PdfCanvasPreview;
