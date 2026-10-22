import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Archive, ArchiveRestore, BookImage, Download, Eraser, Heart, ImagePlus, Images, MapPin, Search, Sparkles, Settings2, Trash2, Upload, UsersRound, X } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { filesApi } from "@/api/files";
import { albumsApi } from "@/api/albums";
import { photosApi, type PhotoBucket, type PhotoItem, type PhotoView } from "@/api/photos";
import { AddToAlbumDialog } from "@/components/photos/AlbumDialogs";
import { MemoriesStrip } from "@/components/photos/MemoriesStrip";
import { PhotoTile } from "@/components/photos/PhotoTile";
import { PhotoViewer } from "@/components/photos/PhotoViewer";
import { FamilyDialog } from "@/components/photos/FamilyDialog";
import { PhotoSettingsDialog } from "@/components/photos/PhotoSettingsDialog";
import { UnderstandingStatus } from "@/components/photos/UnderstandingStatus";
import { justify, rowsHeight, type JustifiedRow } from "@/lib/justify";
import { toast } from "@/store/toastStore";
import { useUploadStore } from "@/store/uploadStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * Photos (WP-9.2, Part E PH-1): every photo and video you own, newest
 * first, as a justified grid by day.
 *
 * The page is a list of month sections sized from the month counts (the
 * scrubber's buckets), so it's as tall as the whole library from the start
 * and any year is one jump away; a month loads its photos only when it
 * comes near the screen, and then lays itself out exactly.
 */

const GAP = 4;
const HEADER = 44; // a month's title
const DAY_HEADER = 32;

const VIEWS: { id: PhotoView; label: string }[] = [
  { id: "all", label: "Photos" },
  { id: "favorites", label: "Favourites" },
  { id: "archive", label: "Archive" },
  { id: "family", label: "Family" },
];

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function aspect(p: PhotoItem): number | null {
  return p.width && p.height ? p.width / p.height : p.kind === "video" ? 16 / 9 : null;
}

interface DayLayout {
  day: string;
  items: PhotoItem[];
  rows: JustifiedRow[];
}

function layoutMonth(items: PhotoItem[], width: number, target: number): { days: DayLayout[]; height: number } {
  const byDay = new Map<string, PhotoItem[]>();
  for (const p of items) {
    const day = p.taken_local.slice(0, 10);
    const list = byDay.get(day) ?? [];
    list.push(p);
    byDay.set(day, list);
  }
  const days: DayLayout[] = [];
  let height = HEADER;
  for (const [day, list] of byDay) {
    const rows = justify(list.map((p) => ({ aspect: aspect(p) })), { width, targetHeight: target, gap: GAP });
    days.push({ day, items: list, rows });
    height += DAY_HEADER + rowsHeight(rows, GAP) + 12;
  }
  return { days, height };
}

export function PhotosPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  // Picking photos for an album (its Add photos button, WP-9.4).
  const addTo = params.get("addTo");
  const { data: addToAlbum } = useQuery({ queryKey: ["album", addTo], queryFn: () => albumsApi.get(addTo!), enabled: !!addTo });
  const [albumPick, setAlbumPick] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Uploads go into the Photos folder, by the month each was taken.
  const uploadInput = useRef<HTMLInputElement>(null);
  const startUploads = useUploadStore((s) => s.startUploads);
  const [familyOpen, setFamilyOpen] = useState(false);
  const view = (params.get("view") as PhotoView) || "all";
  const qc = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const width = useWidth(scrollRef);
  const phone = width > 0 && width < 640;
  const target = phone ? 110 : 200;
  const gridWidth = Math.max(width - (phone ? 16 : 56), 0);

  const { data, isLoading } = useQuery({ queryKey: ["photos", "buckets", view], queryFn: () => photosApi.buckets(view) });
  const months = useMemo(() => data?.buckets ?? [], [data]);

  // Measured heights of months that have loaded (estimates otherwise).
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const estimate = useCallback(
    (b: PhotoBucket) => {
      if (measured[b.month]) return measured[b.month];
      const perRow = Math.max(1, Math.floor(gridWidth / (target * 1.3)));
      return HEADER + Math.ceil(b.count / perRow) * (target + GAP) + 3 * (DAY_HEADER + 12);
    },
    [measured, gridWidth, target],
  );

  // Memories above the timeline (PH-5): the months start below them.
  const showMemories = view === "all" && !addTo;
  const [strip, setStrip] = useState<HTMLDivElement | null>(null);
  const [stripH, setStripH] = useState(0);
  useEffect(() => {
    if (!strip) return setStripH(0);
    const ro = new ResizeObserver(([e]) => setStripH(Math.round(e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height)));
    ro.observe(strip);
    return () => ro.disconnect();
  }, [strip]);

  const virtualizer = useVirtualizer({
    count: months.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => estimate(months[i]),
    overscan: 1,
    scrollMargin: showMemories ? stripH : 0,
  });
  // A jump made just before months finished laying out would land in the
  // wrong place as their real heights replace the estimates: re-apply it.
  const lastJump = useRef<{ index: number; at: number } | null>(null);
  const jump = useCallback(
    (index: number) => {
      lastJump.current = { index, at: Date.now() };
      virtualizer.scrollToIndex(index, { align: "start" });
    },
    [virtualizer],
  );
  useEffect(() => {
    virtualizer.measure();
    const j = lastJump.current;
    if (j && Date.now() - j.at < 2000) virtualizer.scrollToIndex(j.index, { align: "start" });
  }, [measured, gridWidth, virtualizer]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  useEffect(() => setSelected(new Set()), [view]);

  const loadedInOrder = useCallback((): PhotoItem[] => {
    const out: PhotoItem[] = [];
    for (const b of months) {
      const items = qc.getQueryData<PhotoItem[]>(["photos", "month", view, b.month]);
      if (items) out.push(...items);
    }
    return out;
  }, [months, qc, view]);

  const toggle = useCallback(
    (p: PhotoItem, range: boolean) => {
      setSelected((cur) => {
        const next = new Set(cur);
        if (range && anchor.current) {
          const all = loadedInOrder();
          const a = all.findIndex((x) => x.id === anchor.current);
          const b = all.findIndex((x) => x.id === p.id);
          if (a >= 0 && b >= 0) {
            for (const x of all.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(x.id);
            return next;
          }
        }
        if (next.has(p.id)) next.delete(p.id);
        else next.add(p.id);
        anchor.current = p.id;
        return next;
      });
    },
    [loadedInOrder],
  );

  const [open, setOpen] = useState<{ id: string; items: PhotoItem[] } | null>(null);
  const openPhoto = useCallback((p: PhotoItem) => setOpen({ id: p.id, items: loadedInOrder() }), [loadedInOrder]);
  // The viewer reached the end of what's loaded: the next (older, dir 1) or
  // previous (newer, dir -1) month with photos.
  const loadMore = useCallback(
    async (dir: 1 | -1, edgeId: string): Promise<PhotoItem[]> => {
      const edge = loadedInOrder().find((p) => p.id === edgeId);
      if (!edge) return [];
      const at = months.findIndex((b) => b.month === edge.taken_local.slice(0, 7));
      const target = months[at + dir];
      if (!target) return [];
      return qc.fetchQuery({
        queryKey: ["photos", "month", view, target.month],
        queryFn: () => photosApi.month(view, target.month, target.count),
        staleTime: 60_000,
      });
    },
    [loadedInOrder, months, qc, view],
  );

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["photos"] });
  }, [qc]);

  const act = async (what: "favorite" | "unfavorite" | "archive" | "unarchive" | "download" | "trash") => {
    const ids = [...selected];
    if (!ids.length) return;
    const bulk = { file_ids: ids, folder_ids: [] };
    try {
      if (what === "favorite") await filesApi.bulkStar(bulk);
      else if (what === "unfavorite") await filesApi.bulkUnstar(bulk);
      else if (what === "archive" || what === "unarchive") {
        await photosApi.archive(ids, what === "archive");
        toast.success(what === "archive" ? `Archived ${ids.length} — find them under Archive.` : `Back in Photos.`);
      } else if (what === "download") await filesApi.bulkZipDownload(bulk);
      else if (what === "trash") {
        await filesApi.bulkTrash(bulk);
        toast.success(`${ids.length} moved to the trash.`);
      }
      setSelected(new Set());
      refresh();
    } catch (e) {
      toast.error(apiErrorMessage(e, "That didn't work."));
    }
  };

  const total = data?.total ?? 0;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
        {addTo ? (
          <div role="toolbar" aria-label="Adding to an album" className="flex w-full flex-wrap items-center gap-2">
            <button type="button" aria-label="Cancel" onClick={() => navigate(`/files/photos/albums/${addTo}`)} className="rounded-md p-1 hover:bg-[var(--hover)]">
              <X className="h-4 w-4" />
            </button>
            <span className="flex-1 text-sm text-[var(--text)]">
              {selected.size ? `${selected.size} selected` : "Select photos"} to add to <b>{addToAlbum?.title ?? "the album"}</b>
            </span>
            <button
              type="button"
              disabled={!selected.size}
              onClick={async () => {
                try {
                  const n = await albumsApi.addItems(addTo, [...selected]);
                  toast.success(n ? `Added ${n} to “${addToAlbum?.title ?? "the album"}”.` : "Only your own photos can be added.");
                  void qc.invalidateQueries({ queryKey: ["album", addTo] });
                  navigate(`/files/photos/albums/${addTo}`);
                } catch (e) {
                  toast.error(apiErrorMessage(e, "Couldn't add them."));
                }
              }}
              className="flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
            >
              <ImagePlus className="h-3.5 w-3.5" /> Add
            </button>
          </div>
        ) : selected.size > 0 ? (
          <SelectionBar count={selected.size} view={view} onClear={() => setSelected(new Set())} onAct={act} onAlbum={() => setAlbumPick(true)} />
        ) : (
          <>
            <h1 className="mr-2 text-base font-semibold text-[var(--text)]">Photos</h1>
            <nav aria-label="Photo views" className="flex flex-wrap gap-1">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  aria-current={view === v.id ? "page" : undefined}
                  onClick={() => setParams(v.id === "all" ? {} : { view: v.id }, { replace: true })}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs transition",
                    view === v.id
                      ? "bg-[var(--accent-soft)] font-medium text-[var(--accent-text)]"
                      : "text-[var(--text-muted)] hover:bg-[var(--hover)]",
                  )}
                >
                  {v.label}
                </button>
              ))}
              {view === "family" && (
                <button type="button" onClick={() => setFamilyOpen(true)} className="flex items-center gap-1 rounded-full px-3 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]">
                  <UsersRound className="h-3.5 w-3.5" /> Family…
                </button>
              )}
              <Link to="/files/photos/albums" className="flex items-center gap-1 rounded-full px-3 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]">
                <BookImage className="h-3.5 w-3.5" /> Albums
              </Link>
              <Link to="/files/photos/people" className="flex items-center gap-1 rounded-full px-3 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]">
                <UsersRound className="h-3.5 w-3.5" /> People
              </Link>
              <Link to="/files/photos/places" className="flex items-center gap-1 rounded-full px-3 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]">
                <MapPin className="h-3.5 w-3.5" /> Places
              </Link>
              <Link to="/files/photos/cleanup" className="flex items-center gap-1 rounded-full px-3 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]">
                <Eraser className="h-3.5 w-3.5" /> Clean up
              </Link>
              <Link to="/files/photos/search" aria-label="Search photos" className="flex items-center gap-1 rounded-full px-3 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]">
                <Search className="h-3.5 w-3.5" /> Search
              </Link>
              {/* Labelled, not a lone gear: it's where "Use photos from",
                  faces and descriptions live. */}
              <button
                type="button"
                aria-label="Photos settings"
                onClick={() => setSettingsOpen(true)}
                className="flex items-center gap-1 rounded-full px-3 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]"
              >
                <Settings2 className="h-3.5 w-3.5" /> Settings
              </button>
            </nav>
            <span className="ml-auto flex items-center gap-3 text-xs text-[var(--text-muted)]">
              {!phone && <UnderstandingStatus />}
              <input
                ref={uploadInput}
                type="file"
                multiple
                accept="image/*,video/*,.heic,.heif,.dng,.mov"
                className="hidden"
                aria-hidden
                tabIndex={-1}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  if (files.length) startUploads({ files, scope: "mine", folderId: null, route: "camera" });
                }}
              />
              <button
                type="button"
                onClick={() => uploadInput.current?.click()}
                className="flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white"
              >
                <Upload className="h-3.5 w-3.5" /> Upload
              </button>
              {total ? `${total.toLocaleString()} ${total === 1 ? "item" : "items"}` : ""}
            </span>
          </>
        )}
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto overscroll-contain" data-photos-scroller>
          {isLoading ? (
            <p className="p-6 text-sm text-[var(--text-muted)]">Loading…</p>
          ) : months.length === 0 ? (
            <Empty view={view} onFamily={() => setFamilyOpen(true)} />
          ) : (
            <>
            {showMemories && (
              <div ref={setStrip}>
                <SetupBanner />
                <MemoriesStrip />
              </div>
            )}
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }} className={phone ? "mx-2" : "ml-4 mr-10"}>
              {virtualizer.getVirtualItems().map((v) => {
                const b = months[v.index];
                return (
                  <div key={b.month} style={{ position: "absolute", top: v.start - virtualizer.options.scrollMargin, left: 0, right: 0 }}>
                    <MonthSection
                      view={view}
                      bucket={b}
                      width={gridWidth}
                      target={target}
                      estimate={estimate(b)}
                      selected={selected}
                      selecting={selected.size > 0}
                      onMeasured={(h) => setMeasured((m) => (m[b.month] === h ? m : { ...m, [b.month]: h }))}
                      onToggle={toggle}
                      onOpen={openPhoto}
                    />
                  </div>
                );
              })}
            </div>
            </>
          )}
        </div>
        {!phone && months.length > 1 && (
          <Scrubber months={months} onJump={jump} />
        )}
      </div>

      {settingsOpen && <PhotoSettingsDialog onClose={() => setSettingsOpen(false)} />}
      {familyOpen && <FamilyDialog onClose={() => setFamilyOpen(false)} />}
      {albumPick && (
        <AddToAlbumDialog
          fileIds={[...selected]}
          onClose={() => setAlbumPick(false)}
          onDone={(album, added) => {
            setAlbumPick(false);
            setSelected(new Set());
            toast.success(added ? `Added ${added} to “${album.title}”.` : `Nothing added — only your own photos can go in.`);
          }}
        />
      )}
      {open && (
        <PhotoViewer
          items={open.items}
          startId={open.id}
          loadMore={loadMore}
          onClose={() => {
            setOpen(null);
            refresh();
          }}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function MonthSection({
  view,
  bucket,
  width,
  target,
  estimate,
  selected,
  selecting,
  onMeasured,
  onToggle,
  onOpen,
}: {
  view: PhotoView;
  bucket: PhotoBucket;
  width: number;
  target: number;
  estimate: number;
  selected: Set<string>;
  selecting: boolean;
  onMeasured: (h: number) => void;
  onToggle: (p: PhotoItem, range: boolean) => void;
  onOpen: (p: PhotoItem) => void;
}) {
  const { data: items } = useQuery({
    queryKey: ["photos", "month", view, bucket.month],
    queryFn: () => photosApi.month(view, bucket.month, bucket.count),
    staleTime: 60_000,
  });
  const layout = useMemo(() => (items && width > 0 ? layoutMonth(items, width, target) : null), [items, width, target]);
  useEffect(() => {
    if (layout) onMeasured(Math.round(layout.height));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  return (
    <section aria-label={monthLabel(bucket.month)} data-month={bucket.month}>
      <h2 className="flex h-11 items-end pb-2 text-sm font-semibold text-[var(--text)]">{monthLabel(bucket.month)}</h2>
      {!layout ? (
        <div className="animate-pulse rounded-md bg-[var(--hover)]" style={{ height: estimate - HEADER - 12 }} />
      ) : (
        layout.days.map((d) => (
          <div key={d.day} className="mb-3">
            <h3 className="flex h-8 items-center text-xs font-medium text-[var(--text-muted)]">{dayLabel(d.day)}</h3>
            <div className="flex flex-col" style={{ gap: GAP }}>
              {d.rows.map((r, ri) => (
                <div key={ri} className="flex" style={{ gap: GAP, height: r.height }}>
                  {r.items.map((idx, k) => {
                    const p = d.items[idx];
                    return (
                      <PhotoTile
                        key={p.id}
                        photo={p}
                        width={r.widths[k]}
                        height={r.height}
                        selected={selected.has(p.id)}
                        selecting={selecting}
                        onToggle={onToggle}
                        onOpen={onOpen}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </section>
  );
}

function SelectionBar({
  count,
  view,
  onClear,
  onAct,
  onAlbum,
}: {
  count: number;
  view: PhotoView;
  onClear: () => void;
  onAct: (what: "favorite" | "unfavorite" | "archive" | "unarchive" | "download" | "trash") => void;
  onAlbum: () => void;
}) {
  const btn = "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[var(--text)] hover:bg-[var(--hover)]";
  return (
    <div role="toolbar" aria-label="Selected photos" className="flex w-full flex-wrap items-center gap-1">
      <button type="button" onClick={onClear} aria-label="Clear selection" className="rounded-md p-1 hover:bg-[var(--hover)]">
        <X className="h-4 w-4" />
      </button>
      <span className="mr-2 text-sm font-medium text-[var(--text)]">{count} selected</span>
      {view === "family" ? (
        // Others' photos: look, keep a copy — changing them is theirs to do.
        <button type="button" className={btn} onClick={() => onAct("download")}>
          <Download className="h-3.5 w-3.5" /> Download
        </button>
      ) : (
      <>
      <button type="button" className={btn} onClick={() => onAct(view === "favorites" ? "unfavorite" : "favorite")}>
        <Heart className="h-3.5 w-3.5" /> {view === "favorites" ? "Unfavourite" : "Favourite"}
      </button>
      <button type="button" className={btn} onClick={() => onAct(view === "archive" ? "unarchive" : "archive")}>
        {view === "archive" ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
        {view === "archive" ? "Unarchive" : "Archive"}
      </button>
      <button type="button" className={btn} onClick={onAlbum}>
        <BookImage className="h-3.5 w-3.5" /> Add to album
      </button>
      <button type="button" className={btn} onClick={() => onAct("download")}>
        <Download className="h-3.5 w-3.5" /> Download
      </button>
      <button type="button" className={btn} onClick={() => onAct("trash")}>
        <Trash2 className="h-3.5 w-3.5" /> Move to trash
      </button>
      </>
      )}
    </div>
  );
}

/** Years and months down the right edge; drag or click to jump. */
function Scrubber({ months, onJump }: { months: PhotoBucket[]; onJump: (index: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const total = months.reduce((a, b) => a + b.count, 0) || 1;
  // Each month gets room in proportion to its photos (and a little regardless).
  const weights = months.map((b) => b.count / total + 0.15 / months.length);
  const sum = weights.reduce((a, b) => a + b, 0);
  const tops: number[] = [];
  let acc = 0;
  for (const w of weights) {
    tops.push(acc / sum);
    acc += w;
  }
  const indexAt = (clientY: number) => {
    const rect = ref.current!.getBoundingClientRect();
    const f = Math.min(Math.max((clientY - rect.top) / rect.height, 0), 0.9999);
    let i = 0;
    while (i + 1 < tops.length && tops[i + 1] <= f) i++;
    return i;
  };
  const years: { year: string; top: number }[] = [];
  months.forEach((b, i) => {
    const y = b.month.slice(0, 4);
    if (!years.length || years[years.length - 1].year !== y) years.push({ year: y, top: tops[i] });
  });
  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label="Jump to a date"
      aria-valuemin={0}
      aria-valuemax={months.length - 1}
      aria-valuenow={hover ?? 0}
      aria-valuetext={hover !== null ? monthLabel(months[hover].month) : undefined}
      className="absolute bottom-2 right-0 top-2 w-9 cursor-ns-resize select-none"
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        onJump(indexAt(e.clientY));
      }}
      onPointerMove={(e) => {
        const i = indexAt(e.clientY);
        setHover(i);
        if (e.buttons) onJump(i);
      }}
      onPointerLeave={() => setHover(null)}
      onKeyDown={(e) => {
        const cur = hover ?? 0;
        if (e.key === "ArrowDown") {
          const i = Math.min(cur + 1, months.length - 1);
          setHover(i);
          onJump(i);
        } else if (e.key === "ArrowUp") {
          const i = Math.max(cur - 1, 0);
          setHover(i);
          onJump(i);
        }
      }}
    >
      {years.map((y) => (
        <span
          key={y.year}
          className="absolute right-1 text-[10px] font-medium text-[var(--text-muted)]"
          style={{ top: `${y.top * 100}%` }}
        >
          {y.year}
        </span>
      ))}
      {hover !== null && (
        <span
          className="pointer-events-none absolute right-10 -translate-y-1/2 whitespace-nowrap rounded-md bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text)] shadow"
          style={{ top: `${tops[hover] * 100}%` }}
        >
          {monthLabel(months[hover].month)}
        </span>
      )}
    </div>
  );
}

/** "Set up Photos" (PH-7) until it's done or put away. */
function SetupBanner() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["photos", "settings"], queryFn: photosApi.settings });
  if (!data || data.setup_done) return null;
  return (
    <div role="region" aria-label="Set up Photos" className="mx-4 mt-3 flex flex-wrap items-center gap-3 rounded-card border border-[var(--border)] bg-[var(--accent-soft)] px-4 py-3">
      <Sparkles className="h-5 w-5 text-[var(--accent-text)]" />
      <p className="min-w-0 flex-1 text-sm text-[var(--text)]">
        <b>Set up Photos</b> — bring your photos in, name the people and pets, then ask for anything in them.
      </p>
      <Link to="/files/photos/setup" className="rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white">Start</Link>
      <button type="button" aria-label="Not now" className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)]"
        onClick={() => void photosApi.saveSettings({ setup_done: true }).then((s) => qc.setQueryData(["photos", "settings"], s))}>
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function Empty({ view, onFamily }: { view: PhotoView; onFamily: () => void }) {
  const text =
    view === "family"
      ? "A family library pools photos with people on this server — each chooses what of theirs goes in."
      : view === "favorites"
      ? "Star a photo and it shows up here."
      : view === "archive"
        ? "Archived photos are kept but left out of the timeline."
        : "Upload photos or videos (they go in your Photos folder), back up a phone into it (Account → Devices), or share photos to the Promptly Files app.";
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <Images className="h-10 w-10 text-[var(--text-muted)]" />
      <p className="text-sm font-medium text-[var(--text)]">{view === "all" ? "No photos yet" : "Nothing here yet"}</p>
      <p className="max-w-sm text-xs text-[var(--text-muted)]">{text}</p>
      {view === "all" && (
        <Link to="/files/photos/setup" className="mt-2 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white">
          Set up Photos
        </Link>
      )}
      {view === "family" && (
        <button type="button" onClick={onFamily} className="mt-2 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white">
          Family library…
        </button>
      )}
    </div>
  );
}
