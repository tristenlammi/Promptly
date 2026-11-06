import { Check, ChevronLeft, ChevronRight, Download, File as FileIcon, FolderDown, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { PdfCanvasPreview } from "@/components/files/PdfCanvasPreview";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { mailApi, type MailAttachment } from "./api";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const TEXT_EXT = /\.(txt|md|csv|tsv|log|json|xml|ya?ml|ics|vcf|ini|conf|html?)$/i;
const OFFICE_EXT = /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i;

type Shown =
  | { kind: "loading" }
  | { kind: "image" | "video" | "audio"; url: string }
  | { kind: "pdf"; data: ArrayBuffer }
  | { kind: "text"; text: string; cut: boolean }
  | { kind: "none"; why: string; retry?: boolean };

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Fades in a tick where the save icon was, so you can see it worked. */
export function SaveToFiles({ saved, saving, onSave, name, size = "h-3.5 w-3.5", className = "" }: { saved: boolean; saving: boolean; onSave: () => void; name: string; size?: string; className?: string }) {
  return (
    <button
      type="button"
      disabled={saved || saving}
      onClick={(e) => { e.stopPropagation(); onSave(); }}
      aria-label={saved ? `${name} saved to Files` : `Save ${name} to Files`}
      title={saved ? "Saved to Email Attachments in Files" : "Save to Files"}
      className={`flex shrink-0 items-center justify-center transition-colors disabled:cursor-default ${saved ? "text-[#3FA66B]" : "text-[var(--text-muted)] hover:text-[var(--text)]"} ${className}`}
    >
      {saved ? <Check className={`mail-tick ${size}`} strokeWidth={3} /> : saving ? <Loader2 className={`${size} animate-spin`} /> : <FolderDown className={size} />}
    </button>
  );
}

/** Saving an attachment, shared between its chip and the viewer. */
export function useSavedAttachments(messageId: string) {
  const [saved, setSaved] = useState<ReadonlySet<number>>(new Set());
  const [saving, setSaving] = useState<ReadonlySet<number>>(new Set());
  const save = useCallback(async (part: number) => {
    setSaving((v) => new Set(v).add(part));
    try {
      await mailApi.saveAttachment(messageId, part);
      setSaved((v) => new Set(v).add(part));
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't save that to Files."));
    } finally {
      setSaving((v) => {
        const next = new Set(v);
        next.delete(part);
        return next;
      });
    }
  }, [messageId]);
  return { saved, saving, save };
}

/** Any attachment, in a window of its own. What's shown is built here from the bytes,
 *  so nothing a sender attached ever runs: images and media play in their own elements,
 *  PDFs draw on a canvas, and anything else that's text is shown as plain text. */
export function AttachmentViewer({ messageId, attachments, start, saved, saving, onSave, onClose }: {
  messageId: string;
  attachments: MailAttachment[];
  start: number;
  saved: ReadonlySet<number>;
  saving: ReadonlySet<number>;
  onSave: (part: number) => void;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(start);
  const [shown, setShown] = useState<Shown>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const file = attachments[index];
  const many = attachments.length > 1;
  const step = useCallback((by: number) => setIndex((i) => (i + by + attachments.length) % attachments.length), [attachments.length]);

  useEffect(() => {
    let live = true;
    let url: string | null = null;
    const mime = file.mime.toLowerCase();
    const show = (s: Shown) => { if (live) setShown(s); };
    setShown({ kind: "loading" });
    void (async () => {
      try {
        if (OFFICE_EXT.test(file.name)) {
          const pdf = await mailApi.attachmentPreview(messageId, file.part).catch(() => null);
          return show(pdf ? { kind: "pdf", data: pdf } : { kind: "none", why: "This file can't be previewed here. You can download it or save it to Files." });
        }
        const blob = await mailApi.attachmentBlob(messageId, file.part);
        if (mime === "application/pdf" || /\.pdf$/i.test(file.name)) return show({ kind: "pdf", data: await blob.arrayBuffer() });
        if (mime.startsWith("image/") || mime.startsWith("video/") || mime.startsWith("audio/")) {
          url = URL.createObjectURL(new Blob([blob], { type: mime }));
          return show({ kind: mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "audio", url });
        }
        if (mime.startsWith("text/") || TEXT_EXT.test(file.name)) {
          const text = await blob.slice(0, MAX_TEXT_BYTES).text();
          return show({ kind: "text", text, cut: blob.size > MAX_TEXT_BYTES });
        }
        show({ kind: "none", why: "This type of file can't be previewed here. You can download it or save it to Files." });
      } catch (e) {
        // Not found there doesn't mean deleted: it may be moving between folders.
        const missing = (e as { response?: { status?: number } }).response?.status === 404;
        show({ kind: "none", retry: true, why: missing ? "Couldn't find this in your mailbox just now. If you've just moved the email, give it a moment." : apiErrorMessage(e, "Couldn't get that attachment from your mailbox.") });
      }
    })();
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file, messageId, attempt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Only this window: the email behind it stays open.
        e.stopPropagation();
        onClose();
      } else if (many && e.key === "ArrowLeft") step(-1);
      else if (many && e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [many, step, onClose]);

  const icon = "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white";
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={file.name} className="mail-fade fixed inset-0 z-[60] flex flex-col bg-black/85 pt-[env(safe-area-inset-top)]">
      <header className="flex shrink-0 items-center gap-1 px-3 py-2 text-white">
        <div className="min-w-0 flex-1 pl-1">
          <p className="truncate text-sm font-medium">{file.name}</p>
          <p className="text-xs text-white/60">{sizeOf(file.size)}{many ? ` · ${index + 1} of ${attachments.length}` : ""}</p>
        </div>
        <button type="button" onClick={() => void mailApi.download(messageId, file.part, file.name).catch(() => toast.error("Couldn't get that attachment."))} aria-label={`Download ${file.name}`} title="Download" className={icon}><Download className="h-[18px] w-[18px]" /></button>
        <SaveToFiles saved={saved.has(file.part)} saving={saving.has(file.part)} onSave={() => onSave(file.part)} name={file.name} size="h-[18px] w-[18px]" className={`${icon} ${saved.has(file.part) ? "!text-[#5BD08B]" : ""}`} />
        <button type="button" onClick={onClose} aria-label="Close" title="Close" className={icon}><X className="h-5 w-5" /></button>
      </header>
      <div className="relative flex min-h-0 flex-1 items-center justify-center" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        {shown.kind === "loading" && <Loader2 className="h-7 w-7 animate-spin text-white/70" />}
        {shown.kind === "image" && <img src={shown.url} alt={file.name} onError={() => setShown({ kind: "none", why: "This picture can't be shown here. You can download it or save it to Files." })} className="max-h-full max-w-full object-contain" />}
        {shown.kind === "video" && <video src={shown.url} controls autoPlay className="max-h-full max-w-full" />}
        {shown.kind === "audio" && <audio src={shown.url} controls autoPlay className="w-[min(32rem,90vw)]" />}
        {shown.kind === "pdf" && <div className="promptly-scroll h-full w-full max-w-4xl overflow-y-auto"><PdfCanvasPreview data={shown.data} filename={file.name} onError={() => setShown({ kind: "none", why: "This PDF can't be shown here. You can download it or save it to Files." })} /></div>}
        {shown.kind === "text" && (
          <pre className="promptly-scroll h-full w-full max-w-4xl overflow-auto whitespace-pre-wrap break-words bg-[var(--surface)] p-4 text-sm text-[var(--text)]">
            {shown.text}{shown.cut ? "\n\n… This is only the start of the file. Download it to see the rest." : ""}
          </pre>
        )}
        {shown.kind === "none" && (
          <div className="mx-4 max-w-sm rounded-2xl bg-[var(--surface)] p-6 text-center">
            <FileIcon className="mx-auto h-9 w-9 text-[var(--text-muted)]" />
            <p className="mt-3 break-words text-sm font-medium text-[var(--text)]">{file.name}</p>
            <p className="mt-1 text-sm text-[var(--text-muted)]">{shown.why}</p>
            {shown.retry && <button type="button" onClick={() => setAttempt((n) => n + 1)} className="mt-3 h-9 rounded-lg bg-[#D97757] px-4 text-sm font-medium text-white hover:opacity-90">Try again</button>}
          </div>
        )}
        {many && (
          <>
            <button type="button" onClick={() => step(-1)} aria-label="Previous attachment" className="absolute left-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70"><ChevronLeft className="h-5 w-5" /></button>
            <button type="button" onClick={() => step(1)} aria-label="Next attachment" className="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70"><ChevronRight className="h-5 w-5" /></button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
