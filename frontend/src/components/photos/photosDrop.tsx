import { createContext, useContext, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Upload } from "lucide-react";

import "./photos.css";

/**
 * Drop photos anywhere on a Photos page to upload them. The shell owns the
 * drop area; a page can take the files itself instead (an album adds them
 * to that album).
 */

export interface DropTarget {
  /** What the overlay says: "Drop to add to 'Summer'". */
  label: string;
  onFiles: (files: File[]) => void;
}

const Ctx = createContext<((t: DropTarget | null) => void) | null>(null);

/** A page claims dropped files while it is on screen. Pass null for none. */
export function usePhotosDrop(target: DropTarget | null) {
  const set = useContext(Ctx);
  const latest = useRef(target);
  latest.current = target;
  const label = target?.label ?? null;
  useEffect(() => {
    if (!set || label === null) return;
    set({ label, onFiles: (f) => latest.current?.onFiles(f) });
    return () => set(null);
  }, [set, label]);
}

const MEDIA = /\.(jpe?g|png|gif|webp|avif|heic|heif|dng|tiff?|bmp|mov|mp4|m4v|webm|mkv|avi|3gp)$/i;

function mediaOnly(list: FileList | null): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/") || MEDIA.test(f.name));
}

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

export function PhotosDropZone({
  onFiles,
  onNothing,
  className,
  children,
}: {
  /** Where they go when no page has claimed them: your Photos. */
  onFiles: (files: File[]) => void;
  /** Something was dropped, but none of it was a photo or video. */
  onNothing?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<DropTarget | null>(null);
  const [over, setOver] = useState(false);
  // dragenter/leave fire for every child crossed: count them.
  const depth = useRef(0);

  return (
    <Ctx.Provider value={setTarget}>
      <div
        className={className}
        onDragEnter={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          depth.current += 1;
          setOver(true);
        }}
        onDragOver={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(e) => {
          if (!hasFiles(e)) return;
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setOver(false);
        }}
        onDrop={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          depth.current = 0;
          setOver(false);
          const files = mediaOnly(e.dataTransfer.files);
          if (!files.length) return onNothing?.();
          (target?.onFiles ?? onFiles)(files);
        }}
      >
        {children}
        {over && (
          <div
            aria-hidden
            className="photos-fade-in pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-[var(--accent)] bg-[var(--bg)]/85 backdrop-blur-sm"
          >
            <div className="flex flex-col items-center gap-2 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent-strong)] text-white">
                <Upload className="h-5 w-5" />
              </span>
              <p className="text-sm font-medium text-[var(--text)]">{target?.label ?? "Drop to add to your photos"}</p>
            </div>
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}
