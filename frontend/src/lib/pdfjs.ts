/**
 * Loading pdf.js (6.x) the same way everywhere: the worker from our own
 * origin (``worker-src 'self'``), and its data files — CMaps, the standard
 * fonts, wasm decoders, ICC profiles — from ``/pdfjs/`` (see the
 * ``pdfjsAssets`` Vite plugin). Lazy: nothing loads until a PDF opens.
 *
 * pdf.js transfers the buffer it's given to its worker, detaching it, so
 * every caller's bytes are copied first.
 */
type PdfjsModule = typeof import("pdfjs-dist");

let loading: Promise<PdfjsModule> | null = null;

export function loadPdfjs(): Promise<PdfjsModule> {
  loading ??= (async () => {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    return pdfjs;
  })().catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** Open ``data`` (copied). Destroy the returned task to free the worker —
 *  pdf.js 6 dropped ``PDFDocumentProxy.destroy``. */
export async function openPdf(data: ArrayBuffer | Uint8Array): Promise<import("pdfjs-dist").PDFDocumentLoadingTask> {
  const pdfjs = await loadPdfjs();
  const copy = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
  return pdfjs.getDocument({
    data: copy,
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
    iccUrl: "/pdfjs/iccs/",
  });
}

type ViewerModule = typeof import("pdfjs-dist/web/pdf_viewer.mjs");
let viewerLoading: Promise<{ pdfjs: PdfjsModule; viewer: ViewerModule }> | null = null;

/** pdf.js plus its full viewer component (WP-6.5). The viewer module reads
 *  ``globalThis.pdfjsLib`` when it runs, so pdf.js must load first. */
export function loadPdfViewer(): Promise<{ pdfjs: PdfjsModule; viewer: ViewerModule }> {
  viewerLoading ??= (async () => {
    const pdfjs = await loadPdfjs();
    (globalThis as unknown as { pdfjsLib?: PdfjsModule }).pdfjsLib ??= pdfjs;
    const [viewer] = await Promise.all([
      import("pdfjs-dist/web/pdf_viewer.mjs"),
      import("pdfjs-dist/web/pdf_viewer.css"),
    ]);
    return { pdfjs, viewer };
  })().catch((e) => {
    viewerLoading = null;
    throw e;
  });
  return viewerLoading;
}
