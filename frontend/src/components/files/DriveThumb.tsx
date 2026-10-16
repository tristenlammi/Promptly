import { useEffect, useMemo, useRef, useState } from "react";
import { thumbHashToDataURL } from "thumbhash";

import { apiClient } from "@/api/client";
import { filesApi, type FileItem, type FolderItem } from "@/api/files";
import { DriveItemIcon } from "./DriveItemIcon";
import { cn } from "@/utils/cn";

function isImageFile(file?: FileItem): boolean {
  return !!file && (file.mime_type || "").toLowerCase().startsWith("image/");
}

/** Videos have a poster from the media worker (WP-7.4). */
function isVideoFile(file?: FileItem): boolean {
  return !!file && (file.mime_type || "").toLowerCase().startsWith("video/");
}

/** The ThumbHash as a tiny data-URL image — the blur shown until the real
 *  thumbnail arrives. */
function placeholder(hash?: string | null): string | null {
  if (!hash) return null;
  try {
    const bytes = Uint8Array.from(atob(hash), (c) => c.charCodeAt(0));
    return thumbHashToDataURL(bytes);
  } catch {
    return null;
  }
}

function isPdfFile(file?: FileItem): boolean {
  if (!file) return false;
  const mime = (file.mime_type || "").toLowerCase();
  const name = (file.filename || "").toLowerCase();
  return mime === "application/pdf" || name.endsWith(".pdf");
}

// A photo folder puts ~100 tiles on screen at once. Fetching them all at
// once tripped the edge rate limit and the 429'd tiles stayed icons for
// good (R-207): at most a few in flight, and a failure is retried with
// jittered backoff.
const MAX_IN_FLIGHT = 6;
let inFlight = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  inFlight += 1;
  try {
    return await fn();
  } finally {
    inFlight -= 1;
    waiting.shift()?.();
  }
}

function retryable(e: unknown): boolean {
  const status = (e as { response?: { status?: number } })?.response?.status;
  return status === undefined || status === 429 || status >= 500;
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** Anything the server can render a thumbnail for (images + PDF first page),
 *  plus whiteboards, whose editor pushes a picture of the board (WP-3.4),
 *  Docs (their first page, made on the server) and Office files (page one
 *  of the converter's PDF, when the server has the converter). */
const OFFICE_THUMB = /\.(docx?|xlsx?|pptx?|ppsx?|odt|ods|odp|rtf)$/i;
function isThumbnailable(file?: FileItem): boolean {
  return isImageFile(file) || isVideoFile(file) || isPdfFile(file) || file?.source_kind === "whiteboard"
    || file?.source_kind === "document" || OFFICE_THUMB.test(file?.filename ?? "");
}

/**
 * Square thumbnail tile for the Drive grid. For image files it lazily
 * fetches the server-resized thumbnail (authed blob → object URL) once
 * the tile scrolls near the viewport; everything else (and any fetch
 * failure) falls back to the type-coloured `DriveItemIcon`. This is what
 * makes the grid read like a drive instead of a wall of generic icons.
 */
export function DriveThumb({
  file,
  folder,
  className,
}: {
  file?: FileItem;
  folder?: FolderItem;
  className?: string;
}) {
  const thumbable = isThumbnailable(file);
  // Pages (a PDF, a Doc, an Office file): show the top of the first page.
  const isPage = isPdfFile(file) || file?.source_kind === "document" || OFFICE_THUMB.test(file?.filename ?? "");
  const ref = useRef<HTMLDivElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const blur = useMemo(() => placeholder(file?.thumbhash), [file?.thumbhash]);
  // The media worker's tile on a signed link (WP-7.5): a plain lazy <img>
  // the browser fetches, caches and schedules itself. If it fails (the
  // page was open long enough for the link to lapse), fetch it as before.
  const [signedFailed, setSignedFailed] = useState(false);
  const signed = !signedFailed ? (file?.thumb_url ?? null) : null;

  useEffect(() => {
    if (!thumbable || !file || signed) return;
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    let objectUrl: string | null = null;

    const load = async () => {
      for (let attempt = 0; attempt < 4 && !cancelled; attempt++) {
        try {
          const res = await withSlot(() =>
            apiClient.get<Blob>(
              filesApi.thumbnailUrl(file.id).replace(/^\/api/, ""),
              { responseType: "blob" }
            )
          );
          if (cancelled) return;
          objectUrl = URL.createObjectURL(res.data);
          setUrl(objectUrl);
          return;
        } catch (e) {
          // 415 = no thumbnail for this file: show the icon, don't retry.
          if (!retryable(e) || attempt === 3) break;
          await sleep(400 * 2 ** attempt + Math.random() * 400);
        }
      }
      if (!cancelled) setFailed(true);
    };

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          void load();
        }
      },
      { rootMargin: "300px" }
    );
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // A whiteboard's picture changes as it's edited.
  }, [thumbable, !!signed, file?.id, file?.source_kind === "whiteboard" || file?.source_kind === "document" ? file?.modified_at : null]);

  if (!thumbable || failed) {
    return (
      <div className={cn("flex items-center justify-center", className)}>
        <DriveItemIcon file={file} folder={folder} className="h-10 w-10" />
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className={cn(
        "flex items-center justify-center overflow-hidden bg-[var(--bg)]",
        className
      )}
    >
      {signed ? (
        <img
          src={signed}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setSignedFailed(true)}
          // The blur shows through until the tile has painted.
          style={blur ? { backgroundImage: `url(${blur})`, backgroundSize: "cover" } : undefined}
          className="h-full w-full object-cover"
        />
      ) : url ? (
        // PDFs render top-aligned so the page header (title) shows; photos
        // centre-crop the way a drive's photo grid does.
        <img
          src={url}
          alt=""
          className={cn(
            "h-full w-full",
            isPage ? "object-cover object-top" : "object-cover"
          )}
        />
      ) : blur ? (
        <img src={blur} alt="" aria-hidden className="h-full w-full object-cover" />
      ) : (
        <DriveItemIcon file={file} className="h-10 w-10 opacity-30" />
      )}
    </div>
  );
}
