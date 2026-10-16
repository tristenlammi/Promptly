/**
 * Print a PDF exactly as it is (WP-6.4 print preview).
 *
 * The pages are drawn by pdf.js at print resolution and printed from a
 * hidden frame. That avoids the browser's PDF plugin, which the app's
 * ``object-src 'none'`` policy and Chrome's "download PDFs instead" setting
 * can both turn into a blank frame or a stray download (see
 * PdfCanvasPreview) — and what prints is the very PDF the preview showed.
 */

const DPI = 200;

export async function printPdf(data: ArrayBuffer, title: string): Promise<void> {
  const { openPdf } = await import("@/lib/pdfjs");
  const task = await openPdf(data);
  const doc = await task.promise;
  const urls: string[] = [];
  let size: [number, number] = [595, 842];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      if (n === 1) size = [base.width, base.height];
      const viewport = page.getViewport({ scale: DPI / 72 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Can't draw the pages to print.");
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Can't draw the pages to print."))), "image/png")
      );
      urls.push(URL.createObjectURL(blob));
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
    }
  } catch (e) {
    urls.forEach((u) => URL.revokeObjectURL(u));
    throw e;
  } finally {
    void task.destroy();
  }

  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none";
  document.body.appendChild(frame);
  const cleanup = () => {
    frame.remove();
    urls.forEach((u) => URL.revokeObjectURL(u));
  };
  const win = frame.contentWindow;
  if (!win) {
    cleanup();
    throw new Error("Printing isn't available here.");
  }
  const d = win.document;
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  d.open();
  d.write(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>` +
      `@page { size: ${size[0]}pt ${size[1]}pt; margin: 0; } html, body { margin: 0; padding: 0; }` +
      `img { display: block; width: ${size[0]}pt; height: ${size[1]}pt; break-after: page; }` +
      `img:last-child { break-after: auto; }</style></head><body>` +
      urls.map((u) => `<img src="${u}" alt="">`).join("") +
      `</body></html>`
  );
  d.close();
  await Promise.all(
    Array.from(d.images).map((img) =>
      img.complete ? Promise.resolve() : new Promise<void>((r) => ((img.onload = () => r()), (img.onerror = () => r())))
    )
  );
  // The print dialog blocks until it's closed in most browsers; clean up
  // after it, or after a minute where it doesn't block.
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    window.setTimeout(cleanup, 500);
  };
  win.addEventListener("afterprint", finish);
  window.setTimeout(finish, 60_000);
  win.focus();
  win.print();
}
