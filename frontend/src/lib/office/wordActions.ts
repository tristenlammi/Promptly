/**
 * Word in and out, as Files actions (WP-4.3, Part C §3.7).
 *
 * * :func:`openWordAsDocument` — "Open in Promptly Docs": a new editable
 *   document next to the .docx, linked by ``source_file_id``. The original
 *   is never changed. Conversion runs here in the browser; the result is
 *   seeded as the new document's first state, once, before anyone opens it.
 * * :func:`downloadDocx` — a Promptly document as a .docx (the default
 *   download for documents).
 */
import { apiClient } from "@/api/client";
import { documentsApi } from "@/api/documents";
import { filesApi, type FileItem } from "@/api/files";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import type { PageSetup } from "@/lib/pageSetup";

import { rememberImportNotes } from "./importNotes";

export { takeImportNotes } from "./importNotes";

export function isWordFile(file: Pick<FileItem, "filename" | "source_kind">): boolean {
  return !file.source_kind && /\.(docx|md|markdown)$/i.test(file.filename);
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

/** Convert ``file`` (an uploaded .docx) into a new Promptly document and
 *  open it. Returns the new document, or null when it failed (a toast has
 *  said why). */
export async function openWordAsDocument(
  file: Pick<FileItem, "id" | "filename">,
  navigate: (to: string) => void
): Promise<FileItem | null> {
  const working = toast.info(`Converting “${file.filename}”…`, { duration: 0 });
  let created: FileItem | null = null;
  if (/\.(md|markdown)$/i.test(file.filename)) {
    // Markdown converts on the server, in the same request (R-229).
    try {
      created = await documentsApi.importDocument(file.id);
      toast.dismiss(working);
      navigate(`/files/doc/${created.id}`);
      return created;
    } catch (e) {
      toast.dismiss(working);
      toast.error(apiErrorMessage(e, "Couldn't open that Markdown file as a document."));
      return null;
    }
  }
  try {
    const res = await apiClient.get<Blob>(filesApi.downloadUrl(file.id).replace(/^\/api/, ""), {
      responseType: "blob",
      timeout: 120_000,
    });
    const data = await res.data.arrayBuffer();
    created = await documentsApi.importDocument(file.id);
    const docId = created.id;
    const { convertDocx } = await import("./docxImport");
    const { state, notes } = await convertDocx(data, async (image, name) => {
      const asset = await documentsApi.uploadAsset(docId, new File([image], name, { type: image.type }));
      return asset.url;
    });
    created = await documentsApi.seedState(docId, toBase64(state));
    rememberImportNotes(docId, file.filename, notes);
    toast.dismiss(working);
    navigate(`/files/doc/${docId}`);
    return created;
  } catch (e) {
    toast.dismiss(working);
    toast.error(apiErrorMessage(e, "Couldn't convert that Word file."));
    // Don't leave a blank half-made document behind.
    if (created) await filesApi.trashFile(created.id).catch(() => undefined);
    return null;
  }
}

/** Save a Promptly document as .docx. ``html`` and ``setup`` are the live
 *  editor's when it's open; otherwise the server reads the current state. */
export async function downloadDocx(
  file: Pick<FileItem, "id" | "filename">,
  html?: string,
  setup?: PageSetup
): Promise<void> {
  const source = html ?? (await (await documentsApi.download(file.id, "fragment")).blob.text());
  const page = setup ?? (await documentsApi.pageSetup(file.id).catch(() => undefined));
  const base = file.filename.replace(/\.(html?|md)$/i, "") || "Document";
  const { htmlToDocx } = await import("./docxExport");
  const blob = await htmlToDocx(source, base, page);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${base}.docx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
