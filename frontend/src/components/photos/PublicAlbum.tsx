import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Images, Loader2, Play, X } from "lucide-react";
import { thumbHashToDataURL } from "thumbhash";

import { justify } from "@/lib/justify";
import { cn } from "@/utils/cn";

/**
 * A shared album, opened from its link (WP-9.5): no account, no location.
 * A justified grid, a lightbox (arrows, keys, swipe), videos that play, and
 * "Download all" as one zip.
 */

interface PublicPhoto {
  id: string;
  kind: "image" | "video";
  taken_local: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  thumbhash: string | null;
  thumb: string | null;
  preview: string | null;
  poster: string | null;
  video: string | null;
  original: string;
  filename: string;
}

interface PublicAlbumPage {
  title: string;
  description: string | null;
  owner: string | null;
  count: number;
  items: PublicPhoto[];
  next_cursor: string | null;
  zip: string;
  /** The owner chose to include where photos were taken. */
  location: boolean;
}

function blur(hash: string | null): string | undefined {
  if (!hash) return undefined;
  try {
    return thumbHashToDataURL(Uint8Array.from(atob(hash), (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

export function PublicAlbum({ token, unlockToken }: { token: string; unlockToken: string | null }) {
  const [page, setPage] = useState<PublicAlbumPage | null>(null);
  const [items, setItems] = useState<PublicPhoto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const [box, setBox] = useState<HTMLDivElement | null>(null);

  const load = useCallback(
    async (before: string | null) => {
      const url = `/api/s/${encodeURIComponent(token)}/album${before ? `?before=${encodeURIComponent(before)}` : ""}`;
      const res = await fetch(url, { headers: unlockToken ? { "X-Share-Unlock": unlockToken } : undefined });
      if (!res.ok) {
        setError(res.status === 410 ? "This album link has been turned off." : "This album couldn't be opened.");
        return;
      }
      const data = (await res.json()) as PublicAlbumPage;
      setPage((p) => p ?? data);
      setItems((cur) => (before ? [...cur, ...data.items] : data.items));
      setCursor(data.next_cursor);
    },
    [token, unlockToken],
  );
  useEffect(() => void load(null), [load]);
  useEffect(() => {
    if (!box) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(box);
    return () => ro.disconnect();
  }, [box]);

  const rows = useMemo(
    () =>
      justify(
        items.map((p) => ({ aspect: p.width && p.height ? p.width / p.height : p.kind === "video" ? 16 / 9 : null })),
        { width, targetHeight: width < 640 ? 120 : 220, gap: 4 },
      ),
    [items, width],
  );

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-2 bg-[var(--bg)] p-8 text-center text-[var(--text)]">
        <Images className="h-10 w-10 text-[var(--text-muted)]" />
        <p className="text-sm">{error}</p>
      </div>
    );
  }
  if (!page) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg)]">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="mx-auto flex max-w-6xl flex-wrap items-end gap-3 px-4 pb-4 pt-8">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">{page.title}</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            {page.count} {page.count === 1 ? "photo" : "photos"}
            {page.owner ? ` · shared by ${page.owner}` : ""}
          </p>
          {page.description && <p className="mt-2 max-w-2xl text-sm">{page.description}</p>}
        </div>
        <a
          href={page.zip}
          download
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
        >
          <Download className="h-4 w-4" /> Download all
        </a>
      </header>
      <main className="mx-auto max-w-6xl px-4 pb-12">
        <div ref={setBox} className="flex flex-col gap-1" aria-label="Photos in this album">
          {rows.map((r, ri) => (
            <div key={ri} className="flex gap-1" style={{ height: r.height }}>
              {r.items.map((idx, k) => {
                const p = items[idx];
                return (
                  <button
                    key={p.id}
                    type="button"
                    data-photo={p.id}
                    aria-label={`${p.kind === "video" ? "Video" : "Photo"} ${idx + 1} of ${page.count}`}
                    onClick={() => setOpen(idx)}
                    className="relative shrink-0 overflow-hidden rounded-sm bg-[var(--hover)]"
                    style={{ width: r.widths[k], height: r.height, backgroundImage: blur(p.thumbhash) ? `url(${blur(p.thumbhash)})` : undefined, backgroundSize: "cover" }}
                  >
                    {(p.thumb || p.poster) && (
                      <img src={(p.thumb || p.poster)!} alt="" loading="lazy" className="h-full w-full object-cover" />
                    )}
                    {p.kind === "video" && (
                      <span className="absolute right-1.5 top-1.5 rounded bg-black/55 p-1 text-white">
                        <Play className="h-3 w-3 fill-current" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        {cursor && (
          <div className="mt-6 text-center">
            <button type="button" onClick={() => void load(cursor)} className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--hover)]">
              Show more
            </button>
          </div>
        )}
        <p className="mt-10 text-center text-xs text-[var(--text-muted)]">
          Shared with Promptly{page.location ? "" : " · photos are shown without where they were taken"}.
        </p>
      </main>
      {open !== null && items[open] && (
        <Lightbox
          items={items}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function Lightbox({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: PublicPhoto[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const p = items[index];
  const go = useCallback((d: number) => onIndex(Math.min(Math.max(index + d, 0), items.length - 1)), [index, items.length, onIndex]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [go, onClose]);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const when = new Date(p.taken_local).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Photo"
      className="fixed inset-0 z-50 flex flex-col bg-black text-white"
      onPointerDown={(e) => setStart({ x: e.clientX, y: e.clientY })}
      onPointerUp={(e) => {
        if (!start) return;
        const dx = e.clientX - start.x;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(e.clientY - start.y)) go(dx < 0 ? 1 : -1);
        setStart(null);
      }}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" aria-label="Close" onClick={onClose} className="rounded-full p-2 hover:bg-white/10">
          <X className="h-5 w-5" />
        </button>
        <span className="flex-1 text-sm">{when}</span>
        <a href={p.original} download aria-label="Download" className="rounded-full p-2 hover:bg-white/10">
          <Download className="h-5 w-5" />
        </a>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        {p.kind === "video" && p.video ? (
          <video key={p.id} src={p.video} poster={p.poster ?? undefined} controls autoPlay playsInline className="max-h-full max-w-full" />
        ) : p.preview || p.thumb ? (
          <img key={p.id} src={(p.preview || p.thumb)!} alt="" className="max-h-full max-w-full object-contain" />
        ) : (
          <Loader2 className="h-6 w-6 animate-spin text-white/60" />
        )}
        <button type="button" aria-label="Previous" disabled={index === 0} onClick={() => go(-1)} className={cn("absolute left-2 rounded-full bg-black/40 p-2 hover:bg-black/60", index === 0 && "invisible")}>
          <ChevronLeft className="h-6 w-6" />
        </button>
        <button type="button" aria-label="Next" disabled={index >= items.length - 1} onClick={() => go(1)} className={cn("absolute right-2 rounded-full bg-black/40 p-2 hover:bg-black/60", index >= items.length - 1 && "invisible")}>
          <ChevronRight className="h-6 w-6" />
        </button>
      </div>
    </div>
  );
}
