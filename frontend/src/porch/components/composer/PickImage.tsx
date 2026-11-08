import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Loader2, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { thumbHashToDataURL } from "thumbhash";

import { filesApi } from "@/api/files";
import type { EditOps } from "@/api/photos";
import { cssFilter } from "@/components/photos/filterPresets";
import { ProgressRing } from "@/items/ui";
import { cn } from "@/utils/cn";

import type { Pick } from "./model";

const DONE = new Set(["ready", "failed", "skipped"]);

/** Fresh signed links to one of your files (refreshed while the media worker
 *  is still making its tile). */
export function useFileUrls(fileId: string | null) {
  return useQuery({
    queryKey: ["porch", "compose", "urls", fileId],
    queryFn: () => filesApi.signedUrls(fileId as string),
    enabled: !!fileId,
    staleTime: 5 * 60_000,
    refetchInterval: (q) => (q.state.data && (!q.state.data.state || DONE.has(q.state.data.state)) ? false : 3000),
  });
}

function blur(hash: string | null): string | undefined {
  if (!hash) return undefined;
  try {
    return thumbHashToDataURL(Uint8Array.from(atob(hash), (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

export function duration(ms: number | null): string {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * A picture with this post's crop, turn, flip and look applied, drawn the
 * way the server draws it (``photos/edits.apply``): turned and flipped,
 * then cropped (a share of the turned picture), with the adjustments as a
 * CSS filter.
 */
export function EditedPicture({ src, ops, label, className }: { src: string; ops: EditOps | null; label: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    const im = new Image();
    im.onload = () => setImg(im);
    im.onerror = () => setFailed(true);
    im.src = src;
    return () => {
      im.onload = null;
      im.onerror = null;
    };
  }, [src]);
  const rotate = ops?.rotate ?? 0;
  const flip = !!ops?.flip;
  const crop = ops?.crop ?? null;
  useEffect(() => {
    const c = ref.current;
    if (!c || !img) return;
    const turned = rotate === 90 || rotate === 270;
    const fw = turned ? img.naturalHeight : img.naturalWidth;
    const fh = turned ? img.naturalWidth : img.naturalHeight;
    const t = document.createElement("canvas");
    t.width = fw;
    t.height = fh;
    const tctx = t.getContext("2d");
    if (!tctx) return;
    tctx.translate(fw / 2, fh / 2);
    if (flip) tctx.scale(-1, 1);
    tctx.rotate((rotate * Math.PI) / 180);
    tctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    const k = crop ?? { x: 0, y: 0, w: 1, h: 1 };
    const w = Math.max(1, Math.round(fw * k.w));
    const h = Math.max(1, Math.round(fh * k.h));
    const s = Math.min(1, 1600 / Math.max(w, h));
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(t, k.x * fw, k.y * fh, w, h, 0, 0, c.width, c.height);
  }, [img, rotate, flip, crop]);
  if (failed) return <div className={cn("flex items-center justify-center bg-[var(--surface-2)]", className)} role="img" aria-label={label} />;
  if (!ops) return <img src={src} alt={label} className={className} draggable={false} />;
  return <canvas ref={ref} role="img" aria-label={label} className={className} style={{ filter: cssFilter(ops) }} />;
}

/**
 * One pick as a picture: the upload's own copy while it's on its way, else
 * the library's tile (or the larger preview with ``big``), with this post's
 * edit applied. Progress, "getting it ready" and a failed upload say so.
 */
export function PickImage({ pick, big = false, label, className }: { pick: Pick; big?: boolean; label: string; className?: string }) {
  const urls = useFileUrls(pick.localUrl && pick.kind === "image" && !pick.fileId ? null : pick.fileId);
  const placeholder = useMemo(() => blur(pick.thumbhash), [pick.thumbhash]);
  const d = urls.data;
  const src =
    pick.kind === "video"
      ? d?.thumb || d?.poster || pick.thumb || null
      : big
        ? d?.source || d?.preview || pick.localUrl || d?.thumb || pick.thumb || null
        : d?.thumb || pick.thumb || pick.localUrl || d?.preview || null;
  const fit = big ? "h-full w-full object-contain" : "h-full w-full object-cover";
  let inner;
  if (pick.kind === "video" && !src && pick.localUrl) {
    inner = <video src={pick.localUrl} muted playsInline preload="metadata" className={fit} aria-label={label} />;
  } else if (src) {
    inner = <EditedPicture key={src} src={src} ops={pick.kind === "image" ? pick.edit : null} label={label} className={fit} />;
  } else {
    inner = (
      <div
        role="img"
        aria-label={label}
        className="flex h-full w-full items-center justify-center bg-[var(--surface-2)] bg-cover bg-center text-[var(--text-muted)]"
        style={placeholder ? { backgroundImage: `url(${placeholder})` } : undefined}
      >
        {!pick.error && pick.fileId && <Loader2 className="h-5 w-5 animate-spin" aria-hidden />}
      </div>
    );
  }
  const uploading = !pick.fileId && !pick.error;
  return (
    <div className={cn("relative overflow-hidden bg-[var(--surface-2)]", className)}>
      {inner}
      {pick.kind === "video" && (
        <span className="pointer-events-none absolute bottom-1 left-1 inline-flex items-center gap-0.5 rounded bg-black/60 px-1 text-[11px] font-medium text-white">
          <Play className="h-3 w-3" aria-hidden />
          {duration(pick.durationMs)}
        </span>
      )}
      {uploading && (
        <span className="absolute inset-0 flex items-center justify-center bg-black/35">
          <span className="rounded-full bg-black/40">
            <ProgressRing value={pick.progress ?? 0} size={big ? 56 : 34} stroke={big ? 5 : 4} color="#fff" />
          </span>
          <span className="sr-only">Uploading</span>
        </span>
      )}
      {pick.error && (
        <span className="absolute inset-0 flex items-center justify-center bg-black/55 text-white" title={pick.error}>
          <AlertCircle className="h-5 w-5" aria-hidden />
          <span className="sr-only">Couldn't upload: {pick.error}</span>
        </span>
      )}
    </div>
  );
}
