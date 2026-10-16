/**
 * Shared helpers for Drive surfaces. Extracted from FilesPage so the
 * new Recent / Starred / Trash / Search pages don't have to recreate
 * the same download + size + error-string + mime-classification
 * boilerplate.
 */
import { apiClient } from "@/api/client";
import { filesApi, type FileItem } from "@/api/files";
import { apiErrorMessage } from "@/utils/apiError";

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  const gb = n / (1024 * 1024 * 1024);
  // Big storage caps ("10000 GB") read better in TB. Trim trailing zeros
  // so round caps show as "2 TB", not "2.00 TB".
  if (gb >= 1024) return `${trimZeros((gb / 1024).toFixed(2))} TB`;
  return `${trimZeros(gb.toFixed(2))} GB`;
}

function trimZeros(s: string): string {
  return s.replace(/\.?0+$/, "");
}

/** Short, human-readable file-kind label for the Drive list's "Kind"
 *  column (e.g. "PDF", "Image", "Doc", "Markdown"). Derived from the
 *  mime type + extension + source_kind so it reads like a real drive's
 *  type column rather than a raw mime string. */
export function kindLabel(file: FileItem): string {
  const mime = (file.mime_type || "").toLowerCase();
  const name = (file.filename || "").toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";

  if (file.source_kind === "document") return "Doc";
  if (file.source_kind === "sheet") return "Sheet";
  if (file.source_kind === "whiteboard") return "Whiteboard";
  if (mime.startsWith("image/")) return "Image";
  if (mime === "application/pdf" || ext === "pdf") return "PDF";
  if (mime.startsWith("video/")) return "Video";
  if (mime.startsWith("audio/")) return "Audio";
  if (/^(zip|tar|gz|tgz|rar|7z)$/.test(ext)) return "Archive";
  if (mime === "text/markdown" || ext === "md" || ext === "markdown")
    return "Markdown";
  if (mime === "text/csv" || ext === "csv") return "CSV";
  if (mime === "application/json" || ext === "json") return "JSON";
  if (mime === "text/html" || ext === "html" || ext === "htm") return "HTML";
  if (mime === "image/svg+xml" || ext === "svg") return "SVG";
  if (mime.startsWith("text/")) return "Text";
  // Fall back to the uppercased extension ("DOCX", "XLSX") or a generic
  // label when there's nothing useful to show.
  return ext ? ext.toUpperCase() : "File";
}

/** User-facing file name for the Drive list / details / previews.
 *
 *  The Kind column already names the file type, so the extension in the
 *  title is redundant noise — we strip it for display (and for renaming, so
 *  the user never has to type ``.pdf``). The real extension is preserved on
 *  the stored ``filename`` and re-appended on rename via ``withFileExt``. */
export function displayFileName(file: FileItem): string {
  return splitFileExt(file.filename || "").base;
}

/** Split a filename into its base + trailing extension (``".pdf"`` incl. the
 *  dot). Only treats a short alphanumeric run after a non-leading dot as an
 *  extension, so hidden files (``.env``) and dotted names without a real
 *  extension (``report v1.2 draft``) are left whole. */
export function splitFileExt(filename: string): { base: string; ext: string } {
  const m = filename.match(/\.[A-Za-z0-9]{1,8}$/);
  if (m && m.index !== undefined && m.index > 0) {
    return { base: filename.slice(0, m.index), ext: m[0] };
  }
  return { base: filename, ext: "" };
}

/** Re-attach the original file's extension to a user-typed base name, so a
 *  rename of "Birth Certificate" keeps ".pdf". No-ops when the user already
 *  typed the extension, or when the original had none. */
export function withFileExt(base: string, originalFilename: string): string {
  const trimmed = base.trim();
  const { ext } = splitFileExt(originalFilename);
  if (!ext) return trimmed;
  return trimmed.toLowerCase().endsWith(ext.toLowerCase())
    ? trimmed
    : trimmed + ext;
}

export function extractError(e: unknown): string {
  return apiErrorMessage(e);
}

/** The filename in a ``Content-Disposition`` header (RFC 6266, the UTF-8
 *  ``filename*`` form first), else ``fallback``. */
export function filenameFromDisposition(dispo: string, fallback: string): string {
  const utf8 = dispo.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = dispo.match(/filename="([^"]+)"/i) ?? dispo.match(/filename=([^;]+)/i);
  return plain ? plain[1].trim() : fallback;
}

/** Authenticated download helper — Axios adds the Bearer token, we
 *  turn the blob into a temporary object URL the browser can save. */
export async function downloadAuthed(
  file: Pick<FileItem, "id" | "filename">
): Promise<void> {
  // A Promptly document downloads as Word, not its HTML snapshot
  // (WP-4.3, Part C §3.7). Other formats are in the editor's menu.
  if ((file as { source_kind?: string | null }).source_kind === "document") {
    const { downloadDocx } = await import("@/lib/office/wordActions");
    return downloadDocx(file);
  }
  // A file's own bytes: the browser downloads them itself from a signed
  // link — its own progress and resume, no size or time limit (WP-7.5,
  // R-048). Sheets and whiteboards (exported on the fly) have no such
  // link and come through the API below.
  try {
    const { original } = await filesApi.signedUrls(file.id);
    if (original) {
      const a = document.createElement("a");
      a.href = original;
      a.download = file.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
  } catch {
    /* the API path below says what's wrong */
  }
  const res = await apiClient.get<Blob>(
    filesApi.downloadUrl(file.id).replace(/^\/api/, ""),
    {
      responseType: "blob",
    }
  );
  const url = window.URL.createObjectURL(res.data);
  const a = document.createElement("a");
  a.href = url;
  // The server names exports (a sheet → .xlsx, a whiteboard → .excalidraw);
  // the row's own filename is only right for plain uploads.
  a.download = filenameFromDisposition(String(res.headers?.["content-disposition"] ?? ""), file.filename);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => window.URL.revokeObjectURL(url), 1000);
}

export type PreviewKind =
  | "image"
  /** Played from a signed link (WP-7.5). */
  | "video"
  | "pdf"
  | "document"
  | "code_artifact"
  | "markdown"
  | "text"
  | "code"
  /** An uploaded .docx — rendered by docx-preview (WP-4.3). */
  | "word"
  /** PowerPoint / OpenDocument text & slides / RTF — a text outline. */
  | "office"
  /** An uploaded .xlsx / .xlsm / .ods — a read-only grid (WP-4.4). */
  | "spreadsheet"
  | "binary";

export function classifyMime(
  mime: string,
  filename: string,
  sourceKind?: string | null
): PreviewKind {
  // Drive Documents (TipTap + Y.js) are technically ``text/html`` but
  // we route them into the dedicated preview renderer so the HTML
  // gets the sanitized-body treatment + an Edit button.
  if (sourceKind === "document") return "document";
  const lower = (filename ?? "").toLowerCase();
  const m = (mime ?? "").toLowerCase();
  if (lower.endsWith(".docx")) return "word";
  if (/\.(xlsx|xlsm|ods)$/.test(lower)) return "spreadsheet";
  // Legacy Office and PowerPoint: a faithful PDF with the ``convert``
  // profile (Stage 12), else the text outline.
  if (/\.(pptx|ppt|pps|ppsx|odt|odp|rtf|doc|xls)$/.test(lower)) return "office";

  // Code artifact types get the Preview/Code tabbed view —
  // identical UX to the chat side panel. Classify these *before*
  // the generic image/markdown/text fall-throughs so (for example)
  // ``image/svg+xml`` renders in the live-preview tab instead of
  // being shown as an opaque bitmap.
  if (
    m === "text/html" ||
    m === "image/svg+xml" ||
    lower.endsWith(".svg") ||
    lower.endsWith(".html") ||
    lower.endsWith(".htm")
  ) {
    return "code_artifact";
  }
  if (m === "application/json" || lower.endsWith(".json")) return "code_artifact";
  if (m === "text/csv" || lower.endsWith(".csv")) return "code_artifact";

  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
  if (m === "text/markdown" || lower.endsWith(".md") || lower.endsWith(".markdown"))
    return "code_artifact";
  if (
    m.startsWith("text/") ||
    m === "application/xml" ||
    m === "application/x-yaml" ||
    m === "application/javascript"
  ) {
    // Distinguish "pure prose" from "code-like" text so the preview
    // only enables syntax highlighting when it's useful.
    if (CODE_EXTENSIONS.test(lower)) return "code";
    return "text";
  }
  if (CODE_EXTENSIONS.test(lower)) return "code";
  return "binary";
}

const CODE_EXTENSIONS =
  /\.(js|jsx|ts|tsx|py|rs|go|java|c|h|cpp|cs|rb|php|sh|bash|zsh|fish|ps1|yaml|yml|toml|ini|sql|css|scss|sass|less|html|htm|vue|svelte|kt|swift|dart|lua|r)$/i;

/** Map the first path segment of a filename's extension to a
 *  highlight.js "language" hint. Returns undefined for plain text so
 *  ``rehype-highlight`` doesn't guess wildly. */
export function languageFromFilename(filename: string): string | undefined {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;
  const map: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c",
    h: "c",
    cpp: "cpp",
    cs: "csharp",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    ps1: "powershell",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    ini: "ini",
    sql: "sql",
    css: "css",
    scss: "scss",
    sass: "sass",
    less: "less",
    html: "xml",
    htm: "xml",
    xml: "xml",
    json: "json",
    md: "markdown",
    markdown: "markdown",
    vue: "xml",
    svelte: "xml",
    kt: "kotlin",
    swift: "swift",
    dart: "dart",
    lua: "lua",
    r: "r",
  };
  return map[ext];
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  const now = Date.now();
  const delta = Math.max(0, now - then);
  const s = Math.floor(delta / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  const y = Math.floor(d / 365);
  return `${y}y ago`;
}

/** Open a file from anywhere in Files (WP-3.4): a Document, Spreadsheet
 *  or Whiteboard goes to its editor page (``/files/doc|sheet|whiteboard/:id``)
 *  and this returns true; anything else returns false so the caller shows
 *  its preview. Trashed files always preview. */
export function openFile(
  file: Pick<FileItem, "id" | "source_kind" | "trashed_at">,
  navigate: (to: string) => void
): boolean {
  if (file.trashed_at) return false;
  const seg =
    file.source_kind === "document"
      ? "doc"
      : file.source_kind === "sheet"
        ? "sheet"
        : file.source_kind === "whiteboard"
          ? "whiteboard"
          : null;
  if (!seg) return false;
  navigate(`/files/${seg}/${file.id}`);
  return true;
}
