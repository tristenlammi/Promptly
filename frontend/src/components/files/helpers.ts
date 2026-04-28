/**
 * Shared helpers for Drive surfaces. Extracted from FilesPage so the
 * new Recent / Starred / Trash / Search pages don't have to recreate
 * the same download + size + error-string + mime-classification
 * boilerplate.
 */
import { apiClient } from "@/api/client";
import { filesApi, type FileItem } from "@/api/files";

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function extractError(e: unknown): string {
  if (typeof e === "object" && e && "response" in e) {
    const resp = (e as { response?: { data?: { detail?: unknown } } }).response;
    const detail = resp?.data?.detail;
    if (typeof detail === "string") return detail;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Authenticated download helper — Axios adds the Bearer token, we
 *  turn the blob into a temporary object URL the browser can save. */
export async function downloadAuthed(file: FileItem): Promise<void> {
  const res = await apiClient.get<Blob>(
    filesApi.downloadUrl(file.id).replace(/^\/api/, ""),
    {
      responseType: "blob",
    }
  );
  const url = window.URL.createObjectURL(res.data);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => window.URL.revokeObjectURL(url), 1000);
}

export type PreviewKind =
  | "image"
  | "pdf"
  | "document"
  | "code_artifact"
  | "markdown"
  | "text"
  | "code"
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
