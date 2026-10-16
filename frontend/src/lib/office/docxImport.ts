/**
 * .docx → Promptly document, in the browser (WP-4.3, Part C §3.7).
 *
 * mammoth reads the Word file into semantic HTML (headings, lists, tables
 * with merged cells, links, images, footnotes). That HTML is sanitised and
 * parsed through the editor's own TipTap schema — so anything the editor
 * can't represent is dropped here, not stored — and turned into the
 * Y.Doc the new document starts with. Images are uploaded as the new
 * document's assets on the way. A probe of the .docx XML says what didn't
 * come across (mammoth's own messages only cover unknown styles).
 *
 * The file was uploaded first, so the server's zip guard has already
 * vetted it; the size pre-check here is a second, cheap line.
 */
import { generateJSON, getSchema } from "@tiptap/core";
import { prosemirrorJSONToYDoc } from "@tiptap/y-tiptap";
import DOMPurify from "dompurify";
import JSZip from "jszip";
import * as Y from "yjs";

import { buildExtensions } from "@/components/files/documents/extensions";
import { writePageSetup } from "@/lib/pageSetup";

import { pageSetupFromDocx } from "./docxPageSetup";

const MAX_UNCOMPRESSED = 200 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

/** Word styles mapped onto what the editor has (mammoth's defaults cover
 *  headings and lists; these add the common rest). */
const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
  "u => u",
  "strike => s",
  "highlight => mark",
];

/** Image types the document-asset endpoint accepts. */
const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

export interface DocxImportResult {
  /** The new document's first state (a Y.Doc update). */
  state: Uint8Array;
  /** Plain-language notes on what didn't come across. */
  notes: string[];
}

export class DocxTooLargeError extends Error {}

function count(re: RegExp, text: string): number {
  return (text.match(re) ?? []).length;
}

/** What's in the file that the conversion won't keep. */
async function probe(zip: JSZip): Promise<string[]> {
  const notes: string[] = [];
  const doc = (await zip.file("word/document.xml")?.async("string")) ?? "";
  const comments = (await zip.file("word/comments.xml")?.async("string")) ?? "";
  const nComments = count(/<w:comment\b/g, comments);
  if (nComments) notes.push(`${nComments} comment${nComments === 1 ? " wasn't" : "s weren't"} brought over.`);
  if (/<w:(ins|del|moveFrom|moveTo)\b/.test(doc)) {
    notes.push("Tracked changes were accepted — deletions are gone and insertions kept.");
  }
  if (/<w:color w:val="(?!auto|000000)[0-9A-Fa-f]{6}"/.test(doc)) notes.push("Text colours aren't kept.");
  if (/<w:jc w:val="(center|right|end|both|distribute)"/.test(doc)) {
    notes.push("Centred, right-aligned and justified paragraphs are left-aligned.");
  }
  if (/<w:rFonts\b|<w:sz\b/.test(doc)) notes.push("Fonts and text sizes follow the editor's style.");
  if (/<w:txbxContent\b/.test(doc)) notes.push("Text boxes became ordinary paragraphs.");
  if (/<w:footnoteReference\b|<w:endnoteReference\b/.test(doc)) notes.push("Footnotes are listed at the end.");
  const headers = Object.keys(zip.files).filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n));
  for (const name of headers) {
    const xml = (await zip.file(name)?.async("string")) ?? "";
    if (/<w:t[^>]*>[^<]*\S/.test(xml)) {
      notes.push("Headers and footers aren't brought over.");
      break;
    }
  }
  return notes;
}

export async function convertDocx(
  data: ArrayBuffer,
  /** Upload one image as the new document's asset; returns its URL. */
  uploadImage: (image: Blob, filename: string) => Promise<string>
): Promise<DocxImportResult> {
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files);
  const total = entries.reduce(
    (n, f) => n + ((f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0),
    0
  );
  if (entries.length > MAX_ENTRIES || total > MAX_UNCOMPRESSED) {
    throw new DocxTooLargeError("This Word file is too large to open as a document.");
  }
  let notes = await probe(zip);
  // Paper, margins, header/footer and page numbers come across (WP-6.4).
  const setup = await pageSetupFromDocx(zip).catch(() => null);
  if (setup && (setup.header || setup.footer || setup.pageNumbers !== "none")) {
    notes = notes.filter((n) => !n.startsWith("Headers and footers"));
  }

  const mammoth = (await import("mammoth")).default;
  let skippedImages = 0;
  let failedImages = 0;
  let n = 0;
  const result = await mammoth.convertToHtml(
    { arrayBuffer: data },
    {
      styleMap: STYLE_MAP,
      externalFileAccess: false,
      convertImage: mammoth.images.imgElement(async (image) => {
        const ext = IMAGE_EXT[(image.contentType || "").toLowerCase()];
        if (!ext) {
          skippedImages += 1;
          return { src: "" };
        }
        try {
          const bytes = await image.readAsArrayBuffer();
          const src = await uploadImage(new Blob([bytes], { type: image.contentType }), `image-${++n}.${ext}`);
          return { src };
        } catch {
          failedImages += 1;
          return { src: "" };
        }
      }),
    }
  );
  if (skippedImages) {
    notes.push(
      `${skippedImages} image${skippedImages === 1 ? " is" : "s are"} in a format the editor can't show (such as EMF or TIFF) and ${skippedImages === 1 ? "was" : "were"} left out.`
    );
  }
  if (failedImages) notes.push(`${failedImages} image${failedImages === 1 ? "" : "s"} couldn't be uploaded.`);
  const unknownStyles = result.messages.filter((m) => /unrecognised (paragraph|run) style/i.test(m.message)).length;
  if (unknownStyles) {
    notes.push(
      `${unknownStyles} custom style${unknownStyles === 1 ? " is" : "s are"} shown as normal text.`
    );
  }

  // mammoth doesn't sanitise; the editor schema then keeps only what it
  // knows. Images that didn't make it (src="") are dropped too.
  const clean = DOMPurify.sanitize(result.value, { USE_PROFILES: { html: true } }).replace(
    /<img\b[^>]*\bsrc=""[^>]*>/g,
    ""
  );
  const extensions = buildExtensions({ ydoc: null, provider: null, user: null });
  const json = generateJSON(clean || "<p></p>", extensions);
  const ydoc = prosemirrorJSONToYDoc(getSchema(extensions), json, "default");
  if (setup) writePageSetup(ydoc, setup);
  const state = Y.encodeStateAsUpdate(ydoc);
  ydoc.destroy();
  return { state, notes };
}
