import { AlertTriangle, Download, FileText, FolderInput, Loader2 } from "lucide-react";
import { useState } from "react";

import { formsApi, type AnswerFile } from "@/api/forms";
import { extractError } from "@/components/files/helpers";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

/**
 * Files people sent with their answers, in the Responses tab (Forms
 * WP-F1.6): a strip of tiles in the summary, and a list with Download and
 * Save to Files under each answer. Files are only ever downloaded — never
 * opened on this page — and the ones from people without an account carry
 * a warning: this server doesn't scan files for viruses.
 */

const MB = 1024 * 1024;

export function sizeWords(n?: number): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${Math.round(n / 1024)} KB`;
  return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
}

function Tile({ f, className }: { f: AnswerFile; className?: string }) {
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-[var(--hover)] text-[var(--text-muted)]", className)}
      aria-hidden="true"
    >
      {f.thumb ? <img src={f.thumb} alt="" loading="lazy" className="h-full w-full object-cover" /> : <FileText className="h-5 w-5" />}
    </span>
  );
}

export const OUTSIDE_WARNING = "From someone outside the server. Open with care: files aren't checked for viruses here.";

/** The summary's strip: the newest files sent to one question. */
export function FileStrip({
  files,
  answered,
  onAnswer,
  onQuestion,
}: {
  files: (AnswerFile & { number: number })[];
  answered: number;
  onAnswer: (n: number) => void;
  onQuestion: () => void;
}) {
  if (!files.length) return <p className="text-sm text-[var(--text-muted)]">No files yet.</p>;
  return (
    <>
      <ul className="flex gap-2 overflow-x-auto pb-1" data-testid="file-strip">
        {files.map((f) => (
          <li key={f.id} className="shrink-0">
            <button
              type="button"
              onClick={() => onAnswer(f.number)}
              className="flex w-24 flex-col gap-1 rounded-md p-1 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              title={`${f.name} · answer #${f.number}`}
              aria-label={`${f.name}, from answer #${f.number}`}
            >
              <Tile f={f} className="h-20 w-full" />
              <span className="truncate text-xs text-[var(--text)]">{f.name}</span>
              <span className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
                #{f.number}
                {f.outside && <AlertTriangle className="h-3 w-3 text-[var(--warning-text,#b45309)]" aria-label="From someone outside the server" />}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {answered > 0 && (
        <button type="button" onClick={onQuestion} className="mt-2 text-sm font-medium text-[var(--accent-text)] hover:underline">
          See every answer with files ({answered.toLocaleString()})
        </button>
      )}
    </>
  );
}

/** One answer's files: tile, name, size, Download and Save to Files. */
export function FileList({ fileId, files, highlight }: { fileId: string; files: AnswerFile[]; highlight?: string | null }) {
  const [saving, setSaving] = useState<string | null>(null);
  if (!files.length) return null;
  const outside = files.some((f) => f.outside && !f.missing);
  const save = async (f: AnswerFile) => {
    setSaving(f.id);
    try {
      const { file } = await formsApi.saveUpload(fileId, f.id);
      toast.success(`Saved “${file.filename}” to your Forms folder in Files`);
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setSaving(null);
    }
  };
  const btn =
    "inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 text-xs font-medium text-[var(--text)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50";
  return (
    <div className="mt-1 flex flex-col gap-2">
      {outside && (
        <p className="flex items-start gap-1.5 text-xs text-[var(--text-muted)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {OUTSIDE_WARNING}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {files.map((f) => (
          <li
            key={f.id}
            id={`form-file-${f.id}`}
            className={cn(
              "flex flex-wrap items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--bg)] p-2",
              highlight === f.id && "ring-2 ring-[var(--accent)]"
            )}
          >
            <Tile f={f} className="h-12 w-12" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-[var(--text)]">{f.name}</span>
              <span className="block text-xs text-[var(--text-muted)]">
                {f.missing ? "This file was deleted." : sizeWords(f.size)}
              </span>
            </span>
            {!f.missing && f.url && (
              <span className="flex gap-1.5">
                <a href={f.url} download={f.name} className={btn}>
                  <Download className="h-3.5 w-3.5" aria-hidden="true" /> Download
                </a>
                <button type="button" className={btn} disabled={saving === f.id} onClick={() => void save(f)}>
                  {saving === f.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <FolderInput className="h-3.5 w-3.5" aria-hidden="true" />}
                  Save to Files
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
