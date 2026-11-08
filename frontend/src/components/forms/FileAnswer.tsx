import { Camera, FileText, Loader2, Paperclip, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { formAnswerApi, refusalOf } from "@/api/formAnswer";
import type { FileUploadConfig, FormItem } from "@/api/forms";

import { fileHint } from "./FormRenderer";

/**
 * A file question on the answer page (Forms WP-F1.6): pick photos or files
 * (a phone offers its camera and gallery), each uploads at once with its
 * progress, and shows as a tile you can take back. What the question
 * answers with is the uploads' ids; the files are kept on the server until
 * the answer is sent (and deleted after a day if it never is).
 */

/** What the page knows about a file in an answer. */
export interface FileMeta {
  name: string;
  size?: number;
  mime?: string;
  image?: boolean;
  /** Picked on this page (not yet sent): taking it back deletes it. */
  staged?: boolean;
}

interface Uploading {
  key: string;
  name: string;
  progress: number;
  preview: string | null;
  error: string | null;
}

const MB = 1024 * 1024;

function sizeWords(n?: number): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${Math.round(n / 1024)} KB`;
  return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

/** Does ``accept`` (".jpg,.png,image/*") take this file? */
function accepted(accept: string, file: File): boolean {
  if (!accept) return true;
  const ext = extOf(file.name);
  return accept.split(",").some((a) => a.trim().toLowerCase() === ext);
}

export function FileAnswer({
  token,
  draftKey,
  item,
  accept,
  value,
  onChange,
  files,
  onFiles,
  onBusy,
}: {
  token: string;
  draftKey: string;
  item: FormItem<"file_upload">;
  accept: string;
  value: string[];
  onChange: (ids: string[]) => void;
  files: Record<string, FileMeta>;
  onFiles: (update: (prev: Record<string, FileMeta>) => Record<string, FileMeta>) => void;
  onBusy: (questionId: string, busy: boolean) => void;
}) {
  const cfg = item.config as FileUploadConfig;
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<Uploading[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const previews = useRef<Record<string, string>>({});
  const valueRef = useRef(value);
  valueRef.current = value;
  const hintId = useId();
  const onlyPictures = cfg.kinds.length === 1 && cfg.kinds[0] === "images";
  const room = cfg.max_files - value.length - uploading.filter((u) => !u.error).length;

  useEffect(() => {
    onBusy(item.id, uploading.some((u) => !u.error));
  }, [uploading, item.id, onBusy]);

  // Previews made on this device are let go with the page.
  useEffect(() => {
    const made = previews.current;
    return () => Object.values(made).forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const send = async (file: File) => {
    const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`;
    const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
    setUploading((u) => [...u, { key, name: file.name, progress: 0, preview, error: null }]);
    try {
      const staged = await formAnswerApi.upload(token, item.id, draftKey, file, (f) =>
        setUploading((u) => u.map((x) => (x.key === key ? { ...x, progress: f } : x)))
      );
      if (preview) previews.current[staged.id] = preview;
      onFiles((prev) => ({
        ...prev,
        [staged.id]: { name: staged.name, size: staged.size, mime: staged.mime, image: staged.image, staged: true },
      }));
      const next = [...valueRef.current, staged.id];
      valueRef.current = next;
      onChange(next);
      setUploading((u) => u.filter((x) => x.key !== key));
    } catch (err) {
      const { status, refusal } = refusalOf(err);
      const message =
        refusal?.message ??
        (status === null
          ? "You're offline. Try again when you're back."
          : status === 413
            ? `That file is bigger than ${cfg.max_size_mb} MB.`
            : status === 429
              ? "Lots of files are arriving. Try again in a minute."
              : "That file couldn't be sent. Try again.");
      if (preview) URL.revokeObjectURL(preview);
      setUploading((u) => u.map((x) => (x.key === key ? { ...x, preview: null, progress: 0, error: message } : x)));
    }
  };

  const picked = (list: FileList | null) => {
    setProblem(null);
    if (!list || !list.length) return;
    const chosen = Array.from(list);
    let left = room;
    const notes: string[] = [];
    for (const f of chosen) {
      if (left <= 0) {
        notes.push(cfg.max_files === 1 ? "You can send 1 file here." : `You can send ${cfg.max_files} files here.`);
        break;
      }
      if (!accepted(accept, f)) {
        notes.push(`“${f.name}” isn't a kind of file this question takes.`);
        continue;
      }
      if (f.size > cfg.max_size_mb * MB) {
        notes.push(`“${f.name}” is bigger than ${cfg.max_size_mb} MB.`);
        continue;
      }
      if (f.size === 0) {
        notes.push(`“${f.name}” is empty.`);
        continue;
      }
      left -= 1;
      void send(f);
    }
    if (notes.length) setProblem(notes.join(" "));
    if (input.current) input.current.value = "";
  };

  const remove = async (id: string) => {
    const meta = files[id];
    const next = valueRef.current.filter((x) => x !== id);
    valueRef.current = next;
    onChange(next);
    if (previews.current[id]) {
      URL.revokeObjectURL(previews.current[id]);
      delete previews.current[id];
    }
    // A file already sent with your answer goes when you save the change.
    if (meta?.staged) {
      onFiles((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      try {
        await formAnswerApi.removeUpload(token, id, draftKey);
      } catch {
        /* swept after a day anyway */
      }
    }
  };

  const tileCls = "relative flex items-center gap-3 rounded-xl border p-2 pr-12";
  return (
    <div className="flex flex-col gap-2" data-file-question={item.id}>
      {(value.length > 0 || uploading.length > 0) && (
        <ul className="flex flex-col gap-2" aria-label="Your files">
          {value.map((id) => {
            const meta = files[id];
            const preview = previews.current[id];
            return (
              <li key={id} className={tileCls} style={{ borderColor: "var(--pf-border)" }}>
                <Thumb preview={preview} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{meta?.name ?? "Your file"}</span>
                  <span className="block text-xs" style={{ color: "var(--pf-muted)" }}>
                    {meta?.size !== undefined ? `${sizeWords(meta.size)} · ` : ""}
                    {meta?.staged ? "Ready to send" : "Sent with your answer"}
                  </span>
                </span>
                <button
                  type="button"
                  className="pf-btn pf-btn-ghost absolute right-1 top-1/2 !min-h-[44px] -translate-y-1/2 !px-3"
                  aria-label={`Remove ${meta?.name ?? "this file"}`}
                  onClick={() => void remove(id)}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </li>
            );
          })}
          {uploading.map((u) => (
            <li key={u.key} className={tileCls} style={{ borderColor: u.error ? "var(--pf-error)" : "var(--pf-border)" }}>
              <Thumb preview={u.preview} busy={!u.error} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{u.name}</span>
                {u.error ? (
                  <span role="alert" className="block text-xs font-medium" style={{ color: "var(--pf-error)" }}>
                    {u.error}
                  </span>
                ) : (
                  <span
                    className="mt-1.5 block h-1.5 w-full overflow-hidden rounded-full"
                    style={{ background: "var(--pf-border)" }}
                    role="progressbar"
                    aria-label={`Uploading ${u.name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(u.progress * 100)}
                  >
                    <span
                      className="block h-full rounded-full transition-[width]"
                      style={{ width: `${Math.max(4, Math.round(u.progress * 100))}%`, background: "var(--pf-accent)" }}
                    />
                  </span>
                )}
              </span>
              {u.error && (
                <button
                  type="button"
                  className="pf-btn pf-btn-ghost absolute right-1 top-1/2 !min-h-[44px] -translate-y-1/2 !px-3"
                  aria-label={`Dismiss ${u.name}`}
                  onClick={() => setUploading((list) => list.filter((x) => x.key !== u.key))}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {room > 0 ? (
        <>
          <input
            ref={input}
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            accept={accept}
            multiple={room > 1}
            onChange={(e) => picked(e.target.files)}
          />
          <button
            type="button"
            className="pf-btn pf-btn-ghost self-start border"
            style={{ borderColor: "var(--pf-border)" }}
            aria-describedby={hintId}
            onClick={() => input.current?.click()}
          >
            {onlyPictures ? <Camera className="h-4 w-4" aria-hidden="true" /> : <Paperclip className="h-4 w-4" aria-hidden="true" />}
            {onlyPictures
              ? value.length
                ? "Add another photo"
                : cfg.max_files === 1
                  ? "Add a photo"
                  : "Add photos"
              : value.length
                ? "Add another file"
                : cfg.max_files === 1
                  ? "Add a file"
                  : "Add files"}
          </button>
        </>
      ) : null}
      <p id={hintId} className="text-sm" style={{ color: "var(--pf-muted)" }}>
        {room <= 0 ? "That's as many files as this question takes. " : ""}
        {fileHint(cfg)}
      </p>
      {problem && (
        <p role="alert" className="text-sm font-medium" style={{ color: "var(--pf-error)" }}>
          {problem}
        </p>
      )}
    </div>
  );
}

function Thumb({ preview, busy }: { preview?: string | null; busy?: boolean }) {
  return (
    <span
      className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg"
      style={{ background: "var(--pf-hover)", color: "var(--pf-muted)" }}
      aria-hidden="true"
    >
      {preview ? (
        <img src={preview} alt="" className="h-full w-full object-cover" />
      ) : busy ? (
        <Loader2 className="h-5 w-5 animate-spin" />
      ) : (
        <FileText className="h-5 w-5" />
      )}
    </span>
  );
}
