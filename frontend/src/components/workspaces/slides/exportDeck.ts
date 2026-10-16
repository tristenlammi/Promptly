import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import type { FrameLike } from "./deck";
import { canvasToBlob, renderSlide } from "./render";

/** Exporting a deck (Stage 12): each slide rendered to a picture, then a
 *  PowerPoint file (pptxgenjs — one picture per slide, speaker notes kept)
 *  or a PDF (one page per slide, written here: JPEG pages need nothing
 *  more than a few PDF objects). */

const EXPORT_PX = 1920;

function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function safeName(title: string): string {
  return (title.replace(/\.whiteboard$/i, "").replace(/[\\/:*?"<>|]+/g, " ").trim() || "Presentation").slice(0, 120);
}

export async function exportPptx(
  api: ExcalidrawImperativeAPI,
  slides: FrameLike[],
  notes: (frameId: string) => string,
  title: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const pres = new PptxGenJS();
  pres.layout = "LAYOUT_16x9"; // 10 × 5.625 in
  pres.title = safeName(title);
  const W = 10;
  const H = 5.625;
  for (const [i, frame] of slides.entries()) {
    const canvas = await renderSlide(api, frame, EXPORT_PX);
    const slide = pres.addSlide();
    // Fitted (and centred) when someone made a slide that isn't 16:9.
    const scale = Math.min(W / canvas.width, H / canvas.height);
    const w = canvas.width * scale;
    const h = canvas.height * scale;
    slide.background = { color: "FFFFFF" };
    slide.addImage({ data: canvas.toDataURL("image/png"), x: (W - w) / 2, y: (H - h) / 2, w, h });
    const n = notes(frame.id).trim();
    if (n) slide.addNotes(n);
    onProgress?.(i + 1, slides.length);
  }
  const blob = (await pres.write({ outputType: "blob" })) as Blob;
  save(blob, `${safeName(title)}.pptx`);
}

export async function exportPdf(
  api: ExcalidrawImperativeAPI,
  slides: FrameLike[],
  title: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const pages: { jpeg: Uint8Array; w: number; h: number }[] = [];
  for (const [i, frame] of slides.entries()) {
    const canvas = await renderSlide(api, frame, EXPORT_PX);
    const jpeg = new Uint8Array(await (await canvasToBlob(canvas, "image/jpeg", 0.92)).arrayBuffer());
    pages.push({ jpeg, w: canvas.width, h: canvas.height });
    onProgress?.(i + 1, slides.length);
  }
  save(new Blob([pdfOfJpegs(pages).buffer as ArrayBuffer], { type: "application/pdf" }), `${safeName(title)}.pdf`);
}

/** A PDF with one full-page JPEG per page; each page 960 pt wide (13⅓ in,
 *  a widescreen slide), its height by the picture's shape. */
export function pdfOfJpegs(pages: { jpeg: Uint8Array; w: number; h: number }[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (b: Uint8Array | string) => {
    const bytes = typeof b === "string" ? enc.encode(b) : b;
    chunks.push(bytes);
    size += bytes.length;
  };
  const obj = (n: number, body: () => void) => {
    offsets[n] = size;
    push(`${n} 0 obj\n`);
    body();
    push("\nendobj\n");
  };
  push("%PDF-1.4\n%âãÏÓ\n");
  // 1 catalog, 2 pages, then per page: page, contents, image.
  const pageIds = pages.map((_, i) => 3 + i * 3);
  obj(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
  obj(2, () => push(`<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`));
  pages.forEach((p, i) => {
    const id = pageIds[i];
    const pw = 960;
    const ph = Math.round((960 * p.h) / p.w);
    const draw = `q ${pw} 0 0 ${ph} 0 0 cm /Im${i} Do Q`;
    obj(id, () =>
      push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im${i} ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`),
    );
    obj(id + 1, () => {
      push(`<< /Length ${draw.length} >>\nstream\n`);
      push(draw);
      push("\nendstream");
    });
    obj(id + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
      push(p.jpeg);
      push("\nendstream");
    });
  });
  const count = 3 + pages.length * 3;
  const xref = size;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) table += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
