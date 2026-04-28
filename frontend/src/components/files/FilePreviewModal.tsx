import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import DOMPurify from "dompurify";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Pencil,
  Share2,
  Star,
  X,
} from "lucide-react";

import { apiClient } from "@/api/client";
import {
  filesApi,
  type FileItem,
} from "@/api/files";
import { Button } from "@/components/shared/Button";
import { CodeArtifactView } from "@/components/codeArtifacts/CodeArtifactView";
import {
  artifactLanguageFromFile,
  type ArtifactLanguage,
} from "@/components/codeArtifacts/previewable";
import { cn } from "@/utils/cn";

import {
  classifyMime,
  downloadAuthed,
  extractError,
  humanSize,
  languageFromFilename,
  type PreviewKind,
} from "./helpers";

interface FilePreviewModalProps {
  open: boolean;
  /** The currently previewed file. ``null`` closes the modal. */
  file: FileItem | null;
  /** The sibling list — lets Prev/Next walk through e.g. search hits
   *  or a folder listing. When omitted the arrows are hidden. */
  siblings?: FileItem[];
  onClose: () => void;
  /** Select a new file to preview. Called by Prev/Next. */
  onSelect?: (file: FileItem) => void;
  /** Optional Star toggle — if provided the modal renders a star
   *  button in the toolbar. */
  onToggleStar?: (file: FileItem) => void;
  /** Optional Share trigger — opens the ShareLinkDialog upstream. */
  onShare?: (file: FileItem) => void;
  /** Optional Edit trigger — only rendered for Drive Documents. The
   *  parent wires this to open the DocumentEditorModal. */
  onEdit?: (file: FileItem) => void;
}

/**
 * Stage 1 preview surface — the main new UX for Drive.
 *
 * We purposefully use `<iframe>` for PDFs (no new dep) and the
 * existing ``rehype-highlight`` chunk that already ships for the
 * chat bubble renderer (so code highlighting doesn't double the
 * bundle). Binary types fall back to a metadata card + Download
 * button.
 *
 * Keyboard handlers are wired at the modal level:
 *   - Esc      — close
 *   - ←  /  →  — Prev / Next (when siblings are provided)
 *   - Space    — toggle Prev/Next focus to the nearest sibling
 */
export function FilePreviewModal({
  open,
  file,
  siblings,
  onClose,
  onSelect,
  onToggleStar,
  onShare,
  onEdit,
}: FilePreviewModalProps) {
  const index = useMemo(() => {
    if (!file || !siblings?.length) return -1;
    return siblings.findIndex((s) => s.id === file.id);
  }, [file, siblings]);

  const hasPrev = index > 0;
  const hasNext = index >= 0 && siblings !== undefined && index < siblings.length - 1;

  const goPrev = useCallback(() => {
    if (hasPrev && siblings && onSelect) onSelect(siblings[index - 1]);
  }, [hasPrev, siblings, onSelect, index]);
  const goNext = useCallback(() => {
    if (hasNext && siblings && onSelect) onSelect(siblings[index + 1]);
  }, [hasNext, siblings, onSelect, index]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, goPrev, goNext]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open || !file) return null;

  const kind = classifyMime(file.mime_type ?? "", file.filename, file.source_kind);
  const isDocument = kind === "document";

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="preview-title"
    >
      {/* Header — pads the iOS notch / Android status-bar inset so
          the close button is always tap-reachable, and uses larger
          touch targets (40px) than the desktop chrome.*/}
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-black/40 px-3 py-2 pt-[max(env(safe-area-inset-top,0),0.5rem)] text-white md:px-4 md:py-2.5">
        <div className="min-w-0 flex-1">
          <h2
            id="preview-title"
            className="truncate text-sm font-semibold"
            title={file.filename}
          >
            {file.filename}
          </h2>
          <div className="truncate text-[11px] text-white/60">
            {humanSize(file.size_bytes)} · {file.mime_type || "unknown"}
          </div>
        </div>
        <div className="flex items-center gap-0.5 md:gap-1">
          {isDocument && onEdit && (
            <PreviewIconButton label="Edit" onClick={() => onEdit(file)}>
              <Pencil className="h-5 w-5 md:h-4 md:w-4" />
            </PreviewIconButton>
          )}
          {onToggleStar && (
            <PreviewIconButton
              label={file.starred_at ? "Unstar" : "Star"}
              onClick={() => onToggleStar(file)}
              active={!!file.starred_at}
            >
              <Star className={cn("h-5 w-5 md:h-4 md:w-4", file.starred_at && "fill-current")} />
            </PreviewIconButton>
          )}
          {onShare && (
            <PreviewIconButton label="Share" onClick={() => onShare(file)}>
              <Share2 className="h-5 w-5 md:h-4 md:w-4" />
            </PreviewIconButton>
          )}
          <PreviewIconButton label="Download" onClick={() => downloadAuthed(file)}>
            <Download className="h-5 w-5 md:h-4 md:w-4" />
          </PreviewIconButton>
          <PreviewIconButton label="Close" onClick={onClose}>
            <X className="h-5 w-5 md:h-4 md:w-4" />
          </PreviewIconButton>
        </div>
      </div>

      {/* Viewport */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2 pb-safe md:p-4">
        {/* Prev / Next arrows — rendered outside the body so they
            don't overlap pinch-zoom gestures on touch devices.
            Larger tap targets on mobile than desktop. */}
        {hasPrev && (
          <button
            type="button"
            onClick={goPrev}
            aria-label="Previous file"
            className="absolute left-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/50 p-3 text-white transition hover:bg-black/70 md:left-4 md:p-2"
          >
            <ChevronLeft className="h-6 w-6 md:h-5 md:w-5" />
          </button>
        )}
        {hasNext && (
          <button
            type="button"
            onClick={goNext}
            aria-label="Next file"
            className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/50 p-3 text-white transition hover:bg-black/70 md:right-4 md:p-2"
          >
            <ChevronRight className="h-6 w-6 md:h-5 md:w-5" />
          </button>
        )}

        <PreviewBody file={file} kind={kind} />
      </div>
    </div>,
    document.body
  );
}

function PreviewIconButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        // 44px on mobile (Apple touch target), 32px on desktop to keep
        // the slim chrome the desktop UX expects.
        "inline-flex h-11 w-11 items-center justify-center rounded-md transition md:h-8 md:w-8",
        active
          ? "bg-yellow-400/20 text-yellow-300"
          : "text-white/80 hover:bg-white/10 hover:text-white"
      )}
    >
      {children}
    </button>
  );
}

function PreviewBody({ file, kind }: { file: FileItem; kind: PreviewKind }) {
  switch (kind) {
    case "image":
      return <ImagePreview file={file} />;
    case "pdf":
      return <PdfPreview file={file} />;
    case "document":
      return <DocumentPreview file={file} />;
    case "code_artifact":
      return <CodeArtifactPreview file={file} />;
    case "markdown":
      return <MarkdownPreview file={file} />;
    case "code":
    case "text":
      return <TextPreview file={file} kind={kind} />;
    default:
      return <BinaryFallback file={file} />;
  }
}

// ----------------------------------------------------------------
// Image — authenticated fetch → object URL → <img>
// ----------------------------------------------------------------
function ImagePreview({ file }: { file: FileItem }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    let blobUrl: string | null = null;
    (async () => {
      try {
        const res = await apiClient.get<Blob>(
          filesApi.downloadUrl(file.id).replace(/^\/api/, ""),
          { responseType: "blob" }
        );
        if (revoked) return;
        blobUrl = URL.createObjectURL(res.data);
        setUrl(blobUrl);
      } catch (e) {
        if (!revoked) setErr(extractError(e));
      }
    })();
    return () => {
      revoked = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [file.id]);

  if (err) return <PreviewError>{err}</PreviewError>;
  if (!url) return <PreviewLoading />;
  return (
    <img
      src={url}
      alt={file.filename}
      className="max-h-full max-w-full select-none rounded-md shadow-2xl"
      draggable={false}
    />
  );
}

// ----------------------------------------------------------------
// PDF — stream through auth header then point an <iframe> at the
// resulting object URL. We could also use <object> but <iframe>
// gets us Chromium's built-in toolbar for free.
// ----------------------------------------------------------------
function PdfPreview({ file }: { file: FileItem }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    let blobUrl: string | null = null;
    (async () => {
      try {
        const res = await apiClient.get<Blob>(
          filesApi.downloadUrl(file.id).replace(/^\/api/, ""),
          { responseType: "blob" }
        );
        if (revoked) return;
        blobUrl = URL.createObjectURL(res.data);
        setUrl(blobUrl);
      } catch (e) {
        if (!revoked) setErr(extractError(e));
      }
    })();
    return () => {
      revoked = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [file.id]);

  if (err) return <PreviewError>{err}</PreviewError>;
  if (!url) return <PreviewLoading />;
  return (
    <iframe
      key={file.id}
      src={url}
      title={file.filename}
      className="h-full w-full rounded-md border-0 bg-white shadow-2xl"
    />
  );
}

// ----------------------------------------------------------------
// Drive Document — fetch the HTML snapshot written by the Hocuspocus
// -> backend snapshot pipeline, sanitize with DOMPurify (belt +
// braces; the backend already sanitizes) and render inside a
// prose-styled shell. Opens via the Edit button on the header.
// ----------------------------------------------------------------
function DocumentPreview({ file }: { file: FileItem }) {
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiClient.get<Blob>(
          filesApi.downloadUrl(file.id).replace(/^\/api/, ""),
          { responseType: "blob" }
        );
        const body = await res.data.text();
        if (cancelled) return;
        // ADD_TAGS covers the TipTap-specific elements we emit
        // server-side (details/summary, <audio>, YouTube iframe).
        const safe = DOMPurify.sanitize(body, {
          ADD_TAGS: ["iframe", "details", "summary", "audio", "source"],
          ADD_ATTR: [
            "allow",
            "allowfullscreen",
            "frameborder",
            "scrolling",
            "controls",
            "src",
            "type",
            "target",
            "rel",
            "data-type",
            "data-checked",
          ],
          FORBID_TAGS: ["script", "style"],
        });
        setHtml(safe);
      } catch (e) {
        if (!cancelled) setErr(extractError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file.id, file.updated_at]);

  if (err) return <PreviewError>{err}</PreviewError>;
  if (html === null) return <PreviewLoading />;
  if (!html.trim()) {
    return (
      <div className="flex h-full w-full max-w-4xl flex-col items-center justify-center rounded-md bg-[var(--bg)] px-6 py-10 text-center text-sm text-[var(--text-muted)] shadow-2xl">
        <div className="mb-2 text-base font-medium text-[var(--text)]">
          This document is empty
        </div>
        <div>Click Edit in the header to start writing.</div>
      </div>
    );
  }
  return (
    <div className="h-full w-full max-w-4xl overflow-y-auto rounded-md bg-[var(--bg)] px-6 py-5 text-[var(--text)] shadow-2xl">
      {/* Reuse the editor's stylesheet so the preview is pixel-identical
          to what the user just typed — no surprise re-layout when the
          modal switches from edit to read-only. */}
      <div className="promptly-doc" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

// ----------------------------------------------------------------
// Markdown / Text / Code — fetch as text, cap at 512KB to keep the
// bundle-compiled highlighter from choking. Uses the exact same
// ReactMarkdown pipeline as MessageBubble so chat renderer stays
// in one place bundle-wise.
// ----------------------------------------------------------------
const TEXT_PREVIEW_CAP = 512 * 1024;

function useTextContent(file: FileItem): {
  text: string | null;
  err: string | null;
  truncated: boolean;
} {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setText(null);
    setErr(null);
    setTruncated(false);
    (async () => {
      try {
        const res = await apiClient.get<Blob>(
          filesApi.downloadUrl(file.id).replace(/^\/api/, ""),
          { responseType: "blob", signal: controller.signal }
        );
        const fullSize = file.size_bytes;
        const blob = res.data;
        const slice =
          fullSize > TEXT_PREVIEW_CAP ? blob.slice(0, TEXT_PREVIEW_CAP) : blob;
        const body = await slice.text();
        if (controller.signal.aborted) return;
        setText(body);
        setTruncated(fullSize > TEXT_PREVIEW_CAP);
      } catch (e) {
        if (controller.signal.aborted) return;
        setErr(extractError(e));
      }
    })();
    return () => controller.abort();
  }, [file.id, file.size_bytes]);
  return { text, err, truncated };
}

function MarkdownPreview({ file }: { file: FileItem }) {
  const { text, err, truncated } = useTextContent(file);
  if (err) return <PreviewError>{err}</PreviewError>;
  if (text === null) return <PreviewLoading />;
  return (
    <div className="h-full w-full max-w-4xl overflow-y-auto rounded-md bg-[var(--bg)] px-6 py-5 text-[var(--text)] shadow-2xl">
      {truncated && <TruncatedBanner />}
      <div className="prose prose-sm max-w-none dark:prose-invert">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
        >
          {text}
        </ReactMarkdown>
      </div>
    </div>
  );
}

function TextPreview({ file, kind }: { file: FileItem; kind: PreviewKind }) {
  const { text, err, truncated } = useTextContent(file);
  if (err) return <PreviewError>{err}</PreviewError>;
  if (text === null) return <PreviewLoading />;
  const lang = kind === "code" ? languageFromFilename(file.filename) : undefined;
  // Wrap ``text`` in a fenced code block and run it through the
  // exact same ReactMarkdown pipeline so syntax highlighting comes
  // "for free" without us pulling in a second highlighter.
  const wrapped = "```" + (lang ?? "") + "\n" + text + "\n```";
  return (
    <div className="h-full w-full max-w-5xl overflow-y-auto rounded-md bg-[var(--bg)] px-5 py-4 text-[var(--text)] shadow-2xl">
      {truncated && <TruncatedBanner />}
      <div className="prose prose-sm max-w-none dark:prose-invert">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
        >
          {wrapped}
        </ReactMarkdown>
      </div>
    </div>
  );
}

function TruncatedBanner() {
  return (
    <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
      Preview truncated — download the file to see the full contents.
    </div>
  );
}

// ----------------------------------------------------------------
// Code artifact — the same Preview/Code tabbed experience the chat
// side panel uses. Previewable languages (HTML, SVG, Markdown,
// JSON, CSV) land here so that a file saved from a chat artifact
// panel re-opens in Drive with an identical UI. The code editor
// is mounted read-only: edits in the Drive preview modal would be
// misleading without a Save action (writes to Drive files use the
// dedicated upload / update APIs), and read-only is exactly what
// the rest of the modal's text/code/document surfaces already do.
// ----------------------------------------------------------------
function CodeArtifactPreview({ file }: { file: FileItem }) {
  const { text, err, truncated } = useTextContent(file);
  const language = useMemo<ArtifactLanguage>(() => {
    const resolved = artifactLanguageFromFile(file.mime_type, file.filename);
    return resolved ?? "plain";
  }, [file.mime_type, file.filename]);

  if (err) return <PreviewError>{err}</PreviewError>;
  if (text === null) return <PreviewLoading />;

  return (
    <div className="flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-md bg-[var(--bg)] text-[var(--text)] shadow-2xl">
      {truncated && (
        <div className="shrink-0 px-3 pt-3">
          <TruncatedBanner />
        </div>
      )}
      <div className="min-h-0 flex-1">
        <CodeArtifactView source={text} language={language} readOnly />
      </div>
    </div>
  );
}

function BinaryFallback({ file }: { file: FileItem }) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg)] p-8 text-center text-[var(--text)] shadow-2xl">
      <h3 className="text-base font-semibold">No preview available</h3>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        {file.filename} is a binary file that can't be previewed in the
        browser.
      </p>
      <div className="mt-5">
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Download className="h-3.5 w-3.5" />}
          onClick={() => downloadAuthed(file)}
        >
          Download
        </Button>
      </div>
      <div className="mt-3 text-xs text-[var(--text-muted)]">
        {humanSize(file.size_bytes)} · {file.mime_type || "unknown"}
      </div>
    </div>
  );
}

function PreviewLoading() {
  return (
    <div className="flex items-center gap-2 text-sm text-white/80">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading preview…
    </div>
  );
}

function PreviewError({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
      {children}
    </div>
  );
}
