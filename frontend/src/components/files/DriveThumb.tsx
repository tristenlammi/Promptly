import { useEffect, useRef, useState } from "react";

import { apiClient } from "@/api/client";
import { filesApi, type FileItem, type FolderItem } from "@/api/files";
import { DriveItemIcon } from "./DriveItemIcon";
import { cn } from "@/utils/cn";

function isImageFile(file?: FileItem): boolean {
  return !!file && (file.mime_type || "").toLowerCase().startsWith("image/");
}

function isPdfFile(file?: FileItem): boolean {
  if (!file) return false;
  const mime = (file.mime_type || "").toLowerCase();
  const name = (file.filename || "").toLowerCase();
  return mime === "application/pdf" || name.endsWith(".pdf");
}

/** Anything the server can render a thumbnail for (images + PDF first page). */
function isThumbnailable(file?: FileItem): boolean {
  return isImageFile(file) || isPdfFile(file);
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
  const isPdf = isPdfFile(file);
  const ref = useRef<HTMLDivElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!thumbable || !file) return;
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    let objectUrl: string | null = null;

    const load = async () => {
      try {
        const res = await apiClient.get<Blob>(
          filesApi.thumbnailUrl(file.id).replace(/^\/api/, ""),
          { responseType: "blob" }
        );
        if (cancelled) return;
        objectUrl = URL.createObjectURL(res.data);
        setUrl(objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
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
  }, [thumbable, file?.id]);

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
      {url ? (
        // PDFs render top-aligned so the page header (title) shows; photos
        // centre-crop the way a drive's photo grid does.
        <img
          src={url}
          alt=""
          className={cn(
            "h-full w-full",
            isPdf ? "object-cover object-top" : "object-cover"
          )}
        />
      ) : (
        <DriveItemIcon file={file} className="h-10 w-10 opacity-30" />
      )}
    </div>
  );
}
