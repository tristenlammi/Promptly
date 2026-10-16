import { Loader2 } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { apiClient } from "@/api/client";
import { filesApi, type FileItem } from "@/api/files";
import { filesShellApi, type SheetPreviewResponse } from "@/api/filesShell";
import { apiErrorMessage } from "@/utils/apiError";

import { SheetTable } from "./SheetTable";

/**
 * Previews of uploaded Office files (WP-4.3, Part C §3.7).
 *
 * * Word (.docx) renders with docx-preview inside an iframe that has no
 *   script permission (``sandbox`` without ``allow-scripts``) and a strict
 *   CSP — the document's markup can't run anything, fetch anything, or
 *   reach the app. We draw into it from here.
 * * Excel and OpenDocument spreadsheets (.xlsx / .xlsm / .ods) show as a
 *   read-only grid with their formatting (WP-4.4), converted on the server.
 * * PowerPoint, OpenDocument text / slides and RTF show the text the server
 *   read from them — an outline until those get viewers.
 */
const FRAME_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:";

export function WordPreview({ file }: { file: FileItem }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const frame = frameRef.current;
    if (!frame) return;
    (async () => {
      try {
        const res = await apiClient.get<Blob>(filesApi.downloadUrl(file.id).replace(/^\/api/, ""), {
          responseType: "blob",
          timeout: 120_000,
        });
        const { renderAsync } = await import("docx-preview");
        const doc = frame.contentDocument;
        if (cancelled || !doc) return;
        doc.open();
        doc.write(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><style>html,body{margin:0;background:#e9e9e9}</style></head><body></body></html>`
        );
        doc.close();
        await renderAsync(res.data, doc.body, doc.head, {
          inWrapper: true,
          ignoreLastRenderedPageBreak: true,
          renderComments: false,
          useBase64URL: true,
        });
        if (!cancelled) setState("ready");
      } catch (e) {
        if (cancelled) return;
        setError(apiErrorMessage(e, "This Word file couldn't be shown."));
        setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file.id]);

  return (
    <div className="relative h-full w-full max-w-5xl overflow-hidden rounded-md bg-[#e9e9e9] shadow-2xl">
      {state === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-neutral-600">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading preview…
        </div>
      )}
      {state === "error" && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-neutral-700">
          {error}
        </div>
      )}
      <iframe
        ref={frameRef}
        title={`Preview of ${file.filename}`}
        // Same-origin so we can draw into it, but no scripts run inside.
        sandbox="allow-same-origin"
        className="h-full w-full border-0"
        style={{ visibility: state === "ready" ? "visible" : "hidden" }}
      />
    </div>
  );
}

const PdfViewer = lazy(() => import("./pdf/PdfViewer").then((m) => ({ default: m.PdfViewer })));

export function OfficeTextPreview({ file }: { file: FileItem }) {
  const [text, setText] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The faithful version (Stage 12): its state, then its bytes.
  const [preview, setPreview] = useState<"ready" | "pending" | "failed" | null>(null);
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const load = async (attempt = 0) => {
      try {
        const res = await filesShellApi.text(file.id);
        if (cancelled) return;
        setText(res.text);
        setPending(res.pending);
        setPreview(res.preview ?? null);
        if (res.preview === "ready") {
          const bytes = await filesShellApi.officePdf(file.id);
          if (!cancelled) setPdf(bytes);
          return;
        }
        // The worker reads a fresh upload (and converts it) in a moment — look again.
        if ((res.pending || res.preview === "pending") && attempt < 45) timer = window.setTimeout(() => void load(attempt + 1), 2000);
      } catch (e) {
        if (!cancelled) setError(apiErrorMessage(e, "Couldn't read this file."));
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [file.id]);
  if (pdf) {
    return (
      <Suspense fallback={<Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />}>
        <PdfViewer fileId={file.id} filename={file.filename} data={pdf} revision={null} canEdit={false} copyFolderId={null} />
      </Suspense>
    );
  }
  return (
    <div className="promptly-scroll max-h-full w-full max-w-3xl overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--bg)] p-6 text-[var(--text)] shadow-2xl">
      {preview === "pending" && (
        <p className="mb-3 flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Making a preview that looks like the original…
        </p>
      )}
      {error ? (
        <p className="text-sm text-red-500">{error}</p>
      ) : text ? (
        <>
          <p className="mb-3 text-xs text-[var(--text-muted)]">
            {preview === "pending" ? "Its text, meanwhile:" : "The text in this file — download it to see the layout."}
          </p>
          <div className="whitespace-pre-wrap text-sm leading-relaxed">
            {text.split("\n").map((line, i) =>
              line.startsWith("## ") ? (
                <h3 key={i} className="mb-1 mt-4 text-sm font-semibold first:mt-0">
                  {line.slice(3)}
                </h3>
              ) : (
                <p key={i}>{line}</p>
              )
            )}
          </div>
        </>
      ) : pending ? (
        <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading this file…
        </p>
      ) : (
        <p className="text-sm text-[var(--text-muted)]">There's no text in this file to show. Download it to open it.</p>
      )}
    </div>
  );
}

export function SpreadsheetPreview({ file }: { file: FileItem }) {
  const [view, setView] = useState<SheetPreviewResponse | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setView(null);
    setFailed(false);
    filesShellApi
      .sheetPreview(file.id)
      .then((res) => {
        if (!cancelled) setView(res);
      })
      .catch(() => {
        // Too big or unreadable as a grid — the text outline still works.
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [file.id]);
  if (failed) return <OfficeTextPreview file={file} />;
  return (
    <div className="flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-md border border-[var(--border)] bg-white shadow-2xl">
      {view ? (
        <SheetTable sheets={view.tabs} maxRows={200} maxCols={50} truncated={view.truncated} />
      ) : (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-neutral-600">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading preview…
        </div>
      )}
    </div>
  );
}
