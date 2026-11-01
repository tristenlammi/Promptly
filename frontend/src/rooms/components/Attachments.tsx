import { ChevronLeft, ChevronRight, Download, FileText, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import type { Attachment } from "@/api/rooms";
import { cn } from "@/utils/cn";

import { fileSize } from "../format";

export function isImage(a: Pick<Attachment, "mime">) {
  return a.mime.startsWith("image/");
}

export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const images = attachments.filter(isImage);
  const files = attachments.filter((a) => !isImage(a));
  if (!attachments.length) return null;
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {images.length > 0 && (
        <div
          className={cn(
            "grid max-w-[min(100%,420px)] gap-1 overflow-hidden rounded-xl",
            images.length === 1 ? "grid-cols-1" : images.length === 2 || images.length === 4 ? "grid-cols-2" : "grid-cols-3",
          )}
        >
          {images.map((a, i) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setOpen(i)}
              aria-label={`Open ${a.filename}`}
              className="group relative block overflow-hidden bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
              style={
                images.length === 1 && a.width && a.height
                  ? { aspectRatio: `${a.width} / ${a.height}`, maxHeight: 340 }
                  : { aspectRatio: "1 / 1" }
              }
            >
              <img
                src={a.thumb_url ?? a.url}
                alt={a.filename}
                loading="lazy"
                className={cn("h-full w-full transition group-hover:brightness-95", images.length === 1 ? "object-contain" : "object-cover")}
              />
            </button>
          ))}
        </div>
      )}
      {files.map((a) => (
        <a
          key={a.id}
          href={a.url}
          download={a.filename}
          target="_blank"
          rel="noopener noreferrer"
          className="flex w-fit max-w-full items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 hover:bg-[var(--hover)]"
        >
          <FileText className="h-5 w-5 shrink-0 text-[var(--item-accent)]" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-[var(--text)]">{a.filename}</span>
            <span className="text-xs text-[var(--text-muted)]">{fileSize(a.size)}</span>
          </span>
          <Download className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
        </a>
      ))}
      {open !== null && <Lightbox images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </div>
  );
}

export function Lightbox({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: Attachment[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const a = images[index];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      else if (e.key === "ArrowRight" && index < images.length - 1) onIndex(index + 1);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [index, images.length, onClose, onIndex]);
  if (!a) return null;
  const btn =
    "flex h-11 w-11 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white";
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={a.filename} className="fixed inset-0 z-[90] flex flex-col bg-black/90" onClick={onClose}>
      <div className="flex items-center justify-between gap-2 p-3 pt-safe" onClick={(e) => e.stopPropagation()}>
        <span className="truncate text-sm text-white/80">
          {a.filename} {images.length > 1 && `· ${index + 1} of ${images.length}`}
        </span>
        <div className="flex gap-2">
          <a href={a.url} download={a.filename} target="_blank" rel="noopener noreferrer" aria-label="Download" className={btn}>
            <Download className="h-5 w-5" />
          </a>
          <button type="button" aria-label="Close" onClick={onClose} className={btn}>
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-2 pb-safe">
        <img src={a.url} alt={a.filename} className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
        {index > 0 && (
          <button
            type="button"
            aria-label="Previous image"
            className={cn(btn, "absolute left-3 top-1/2 -translate-y-1/2")}
            onClick={(e) => {
              e.stopPropagation();
              onIndex(index - 1);
            }}
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        {index < images.length - 1 && (
          <button
            type="button"
            aria-label="Next image"
            className={cn(btn, "absolute right-3 top-1/2 -translate-y-1/2")}
            onClick={(e) => {
              e.stopPropagation();
              onIndex(index + 1);
            }}
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
