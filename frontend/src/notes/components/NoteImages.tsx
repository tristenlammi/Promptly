import { AlertCircle, ChevronLeft, ChevronRight, CloudOff, Download, ImageOff, Loader2, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/utils/cn";

import type { NoteAttachment } from "../types";
import { Sheet } from "./Sheet";

const srcOf = (a: NoteAttachment, big = false) =>
  (big ? a.urls?.preview ?? a.urls?.original : a.urls?.thumb ?? a.urls?.preview ?? a.urls?.original) ?? a.local?.url ?? null;

/**
 * A note's pictures, at the top of the note: one fills the width, more sit
 * in rows of three. Tap one to see it full size. Each shows its upload
 * while it's going, and can be removed.
 */
export function NoteImages({
  images,
  editable,
  onRemove,
  onRetryUpload,
}: {
  images: NoteAttachment[];
  editable: boolean;
  onRemove: (a: NoteAttachment) => void;
  onRetryUpload: (a: NoteAttachment) => void;
}) {
  const [viewing, setViewing] = useState<number | null>(null);
  if (!images.length) return null;
  const one = images.length === 1;
  return (
    <>
      <div className={cn("grid gap-0.5 overflow-hidden", one ? "grid-cols-1" : images.length === 2 ? "grid-cols-2" : "grid-cols-3")}>
        {images.map((a, i) => (
          <Tile key={`${a.id}:${srcOf(a, one)}`} a={a} one={one} editable={editable} onOpen={() => setViewing(i)} onRemove={() => onRemove(a)} onRetry={() => onRetryUpload(a)} />
        ))}
      </div>
      {viewing !== null && images[viewing] && <ImageViewer images={images} start={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

function Tile({ a, one, editable, onOpen, onRemove, onRetry }: { a: NoteAttachment; one: boolean; editable: boolean; onOpen: () => void; onRemove: () => void; onRetry: () => void }) {
  const [broken, setBroken] = useState(false);
  const src = srcOf(a, one);
  const name = a.filename ?? "Picture";
  const up = a.local;
  return (
    <div className={cn("group/img relative bg-[color-mix(in_srgb,var(--note-text)_8%,transparent)]", one ? "max-h-[360px]" : "aspect-square")}>
      <button type="button" onClick={onOpen} aria-label={`View ${name}`} className="block h-full w-full focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]">
        {src && !broken ? (
          <img src={src} alt={name} loading="lazy" onError={() => setBroken(true)} className={cn("h-full w-full object-cover", one && "max-h-[360px]")} />
        ) : (
          <span className="flex h-full min-h-[120px] w-full items-center justify-center note-muted">
            <ImageOff className="h-6 w-6" aria-hidden />
          </span>
        )}
      </button>
      {up && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-black/55 px-2 py-1 text-xs text-white">
          {up.state === "failed" ? (
            <>
              <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">Couldn't upload{up.error ? `: ${up.error}` : ""}</span>
              <button type="button" onClick={onRetry} className="pointer-events-auto flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium hover:bg-white/20">
                <RotateCcw className="h-3 w-3" aria-hidden /> Try again
              </button>
            </>
          ) : up.state === "waiting" ? (
            <>
              <CloudOff className="h-3.5 w-3.5 shrink-0" aria-hidden /> <span className="truncate">Waiting for a connection</span>
            </>
          ) : (
            <span role="status" className="flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden /> Uploading… {Math.round(up.progress * 100)}%
            </span>
          )}
        </div>
      )}
      {editable && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          title="Remove picture"
          className="absolute right-1.5 top-1.5 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition hover:bg-black/75 focus-visible:opacity-100 group-hover/img:opacity-100 [@media(pointer:coarse)]:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/** A note's pictures full size: arrows (or ← →) to move, Escape to close. */
export function ImageViewer({ images, start, onClose }: { images: NoteAttachment[]; start: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  const a = images[Math.min(i, images.length - 1)];
  const many = images.length > 1;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!many) return;
      if (e.key === "ArrowRight") setI((x) => (x + 1) % images.length);
      else if (e.key === "ArrowLeft") setI((x) => (x - 1 + images.length) % images.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [many, images.length]);
  if (!a) return null;
  const src = srcOf(a, true);
  const name = a.filename ?? "Picture";
  const btn = "flex h-11 w-11 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white";
  return (
    <Sheet title={name} onClose={onClose} bare width="max-w-[min(96vw,1400px)]" className="bg-black sm:rounded-xl">
      <div className="relative flex h-[85dvh] items-center justify-center bg-black">
        {src ? <img src={src} alt={name} className="max-h-full max-w-full object-contain" /> : <ImageOff className="h-10 w-10 text-white/60" aria-hidden />}
        <div className="absolute right-2 top-2 flex gap-2">
          {a.urls?.original && (
            <a href={a.urls.original} download={name} aria-label={`Download ${name}`} title="Download" className={btn}>
              <Download className="h-5 w-5" />
            </a>
          )}
          <button type="button" onClick={onClose} aria-label="Close" data-autofocus className={btn}>
            <X className="h-5 w-5" />
          </button>
        </div>
        {many && (
          <>
            <button type="button" onClick={() => setI((x) => (x - 1 + images.length) % images.length)} aria-label="Previous picture" className={cn(btn, "absolute left-2 top-1/2 -translate-y-1/2")}>
              <ChevronLeft className="h-6 w-6" />
            </button>
            <button type="button" onClick={() => setI((x) => (x + 1) % images.length)} aria-label="Next picture" className={cn(btn, "absolute right-2 top-1/2 -translate-y-1/2")}>
              <ChevronRight className="h-6 w-6" />
            </button>
            <p className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-xs text-white" aria-live="polite">
              {i + 1} of {images.length}
            </p>
          </>
        )}
      </div>
    </Sheet>
  );
}
