import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Archive, ArchiveRestore, BookImage, Check, Download, Heart, HeartOff, ImagePlus, Images, Sparkles, Trash2, X, UsersRound } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { usePhotosPath } from "@/components/photos/photosPath";
import { filesApi } from "@/api/files";
import { albumsApi } from "@/api/albums";
import { photosApi, type PhotoBucket, type PhotoItem, type PhotoView } from "@/api/photos";
import { AddToAlbumDialog } from "@/components/photos/AlbumDialogs";
import { MemoriesStrip } from "@/components/photos/MemoriesStrip";
import { PhoneScrubber } from "@/components/photos/PhoneScrubber";
import { TileGridSkeleton, TimelineSkeleton } from "@/components/photos/PhotoSkeletons";
import { PhotoTile } from "@/components/photos/PhotoTile";
import { PhotoViewer } from "@/components/photos/PhotoViewer";
import { SelectionBar, type SelectionAction } from "@/components/photos/SelectionBar";
import { TimelineScrubber, type TimelinePosition } from "@/components/photos/TimelineScrubber";
import { FamilyDialog } from "@/components/photos/FamilyDialog";
import { justify, rowsHeight, type JustifiedRow } from "@/lib/justify";
import { porchTrashWarning } from "@/api/porch";
import { confirm } from "@/components/shared/ConfirmDialog";
import { EmptyState } from "@/components/shared/EmptyState";
import { cn } from "@/utils/cn";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

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
  const photosPath = usePhotosPath();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  // Picking photos for an album (its Add photos button, WP-9.4).
  const addTo = params.get("addTo");
  const { data: addToAlbum } = useQuery({ queryKey: ["album", addTo], queryFn: () => albumsApi.get(addTo!), enabled: !!addTo });
  const [albumPick, setAlbumPick] = useState(false);
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
  const lastJump = useRef<(TimelinePosition & { at: number }) | null>(null);
  const scrollTo = useCallback(
    ({ index, within }: TimelinePosition) => {
      // The very top includes the memories above the first month.
      if (index === 0 && within === 0) return virtualizer.scrollToOffset(0);
      const [start] = virtualizer.getOffsetForIndex(index, "start") ?? [0];
      virtualizer.scrollToOffset(start + within * (virtualizer.measurementsCache[index]?.size ?? 0));
    },
    [virtualizer],
  );
  const seek = useCallback(
    (to: TimelinePosition) => {
      lastJump.current = { ...to, at: Date.now() };
      scrollTo(to);
    },
    [scrollTo],
  );
  useEffect(() => {
    virtualizer.measure();
    const j = lastJump.current;
    if (j && Date.now() - j.at < 2000) scrollTo(j);
  }, [measured, gridWidth, virtualizer, scrollTo]);
  // Where the page is now, for the scrubber's marker.
  const position = useCallback((): TimelinePosition => {
    const el = scrollRef.current;
    if (!el || !months.length) return { index: 0, within: 0 };
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) return { index: months.length - 1, within: 1 };
    const item = virtualizer.getVirtualItemForOffset(el.scrollTop);
    if (!item) return { index: 0, within: 0 };
    return { index: item.index, within: Math.min(Math.max((el.scrollTop - item.start) / (item.size || 1), 0), 1) };
  }, [virtualizer, months.length]);
  const hasScrubber = !phone && months.length > 1;

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

  // A day's tick: all of that day in, or (when they all are) all out.
  const toggleDay = useCallback((items: PhotoItem[]) => {
    setSelected((cur) => {
      const next = new Set(cur);
      const all = items.every((p) => next.has(p.id));
      for (const p of items) {
        if (all) next.delete(p.id);
        else next.add(p.id);
      }
      if (!all && items[0]) anchor.current = items[0].id;
      return next;
    });
  }, []);

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

  // Show a change in the grid straight away; the server catches up.
  const patchLoaded = useCallback(
    (ids: Set<string>, change: Partial<PhotoItem>) => {
      qc.setQueriesData<PhotoItem[]>({ queryKey: ["photos", "month", view] }, (items) =>
        items?.map((p) => (ids.has(p.id) ? { ...p, ...change } : p)),
      );
    },
    [qc, view],
  );

  const act = async (what: "favorite" | "unfavorite" | "archive" | "unarchive" | "download" | "trash") => {
    const ids = [...selected];
    if (!ids.length) return;
    const n = ids.length;
    const bulk = { file_ids: ids, folder_ids: [] };
    const failed = (e: unknown) => toast.error(apiErrorMessage(e, "That didn't work."));
    try {
      if (what === "favorite" || what === "unfavorite") {
        // The hearts flip now; if the server says no, they flip back.
        patchLoaded(new Set(ids), { favorite: what === "favorite" });
        setSelected(new Set());
        try {
          if (what === "favorite") await filesApi.bulkStar(bulk);
          else await filesApi.bulkUnstar(bulk);
        } finally {
          refresh();
        }
        return;
      } else if (what === "archive" || what === "unarchive") {
        const archived = what === "archive";
        await photosApi.archive(ids, archived);
        toast.success(archived ? `Archived ${n === 1 ? "1 photo" : `${n} photos`}. Find ${n === 1 ? "it" : "them"} under Archive.` : "Back in Photos.", {
          action: { label: "Undo", onClick: () => void photosApi.archive(ids, !archived).then(refresh).catch(failed) },
        });
      } else if (what === "download") await filesApi.bulkZipDownload(bulk);
      else if (what === "trash") {
        const warn = await porchTrashWarning(ids);
        if (warn && !(await confirm({ title: n === 1 ? "Move this photo to the trash?" : `Move ${n} photos to the trash?`, message: warn, confirmLabel: "Move to trash", danger: true }))) return;
        await filesApi.bulkTrash(bulk);
        toast.success(n === 1 ? "Moved to the trash." : `${n} moved to the trash.`, {
          action: {
            label: "Undo",
            onClick: () =>
              void Promise.allSettled(ids.map((id) => filesApi.restoreFile(id))).then((r) => {
                const lost = r.filter((x) => x.status === "rejected").length;
                if (lost) toast.error(lost === n ? "Couldn't bring them back. Look in the trash." : `${lost} couldn't be brought back. Look in the trash.`);
                refresh();
              }),
          },
        });
      }
      setSelected(new Set());
      refresh();
    } catch (e) {
      failed(e);
    }
  };

  const actions: SelectionAction[] =
    view === "family"
      ? // Others' photos: look, keep a copy. Changing them is theirs to do.
        [{ key: "download", label: "Download", icon: <Download />, onClick: () => void act("download") }]
      : [
          view === "favorites"
            ? { key: "fav", label: "Unfavourite", icon: <HeartOff />, onClick: () => void act("unfavorite") }
            : { key: "fav", label: "Favourite", icon: <Heart />, onClick: () => void act("favorite") },
          view === "archive"
            ? { key: "archive", label: "Unarchive", icon: <ArchiveRestore />, onClick: () => void act("unarchive") }
            : { key: "archive", label: "Archive", icon: <Archive />, onClick: () => void act("archive") },
          { key: "album", label: "Add to album", icon: <BookImage />, onClick: () => setAlbumPick(true) },
          { key: "download", label: "Download", icon: <Download />, onClick: () => void act("download") },
          { key: "trash", label: "Move to trash", icon: <Trash2 />, onClick: () => void act("trash") },
        ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The Photos menu is the shell's (PhotosShell). Picking for an album
          has its own bar; a selection's actions float over the grid, so
          ticking the first photo doesn't move the page. */}
      {addTo && (
        <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2">
          <div role="toolbar" aria-label="Adding to an album" className="flex w-full flex-wrap items-center gap-2">
            <button type="button" aria-label="Cancel" onClick={() => navigate(photosPath(`/albums/${addTo}`))} className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-[var(--hover)] sm:h-8 sm:w-8">
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
                  navigate(photosPath(`/albums/${addTo}`));
                } catch (e) {
                  toast.error(apiErrorMessage(e, "Couldn't add them."));
                }
              }}
              className="flex items-center gap-1.5 rounded-md bg-[var(--accent-strong)] h-10 px-4 text-sm font-medium text-white disabled:opacity-50 sm:h-8"
            >
              <ImagePlus className="h-3.5 w-3.5" /> Add
            </button>
          </div>
        </header>
      )}

      {/* The family library's own settings live here, not in the menu. */}
      {view === "family" && !addTo && months.length > 0 && (
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2 text-xs text-[var(--text-muted)]">
          <span className="flex-1">Photos you and your family share with each other.</span>
          <button
            type="button"
            onClick={() => setFamilyOpen(true)}
            className="flex min-h-10 items-center gap-1 rounded-full px-3 text-[var(--text)] hover:bg-[var(--hover)] sm:min-h-8"
          >
            <UsersRound className="h-3.5 w-3.5" /> Family settings
          </button>
        </div>
      )}
      <div
        className="relative min-h-0 flex-1"
        // A hand on the wheel: don't pull the page back to the last jump.
        onWheel={() => {
          lastJump.current = null;
        }}
      >
        <div
          ref={scrollRef}
          className={`h-full overflow-y-auto overscroll-contain ${hasScrubber ? "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : ""}`}
          data-photos-scroller
        >
          {isLoading ? (
            <TimelineSkeleton phone={phone} />
          ) : months.length === 0 ? (
            <Empty view={view} onFamily={() => setFamilyOpen(true)} />
          ) : (
            <>
            {showMemories && (
              <div ref={setStrip} className={cn("transition-opacity", selected.size > 0 && !addTo && "pointer-events-none opacity-30")} aria-hidden={selected.size > 0 && !addTo ? true : undefined}>
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
                      onToggleDay={toggleDay}
                      onOpen={openPhoto}
                    />
                  </div>
                );
              })}
            </div>
            </>
          )}
        </div>
        {hasScrubber && <TimelineScrubber months={months} scroller={scrollRef} label={monthLabel} position={position} onSeek={seek} />}
        {phone && months.length > 0 && <PhoneScrubber months={months} scroller={scrollRef} label={monthLabel} position={position} />}
        {!addTo && (
          <SelectionBar count={selected.size} onClear={() => setSelected(new Set())} actions={actions} escape={!open && !albumPick && !familyOpen} />
        )}
      </div>

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
  onToggleDay,
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
  onToggleDay: (items: PhotoItem[]) => void;
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
        <div role="status" aria-label={`Loading ${monthLabel(bucket.month)}`}>
          <TileGridSkeleton rows={Math.min(12, Math.max(1, Math.ceil((estimate - HEADER - 12) / (target + GAP))))} tile={target} height={Math.max(estimate - HEADER - 12, target)} />
        </div>
      ) : (
        layout.days.map((d) => (
          <div key={d.day} className="group/day mb-3">
            <DayHeader day={d.day} items={d.items} selected={selected} selecting={selecting} onToggleDay={onToggleDay} />
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

/** A day's date, with a tick that picks (or lets go of) the whole day. */
function DayHeader({
  day,
  items,
  selected,
  selecting,
  onToggleDay,
}: {
  day: string;
  items: PhotoItem[];
  selected: Set<string>;
  selecting: boolean;
  onToggleDay: (items: PhotoItem[]) => void;
}) {
  const all = selecting && items.every((p) => selected.has(p.id));
  const label = dayLabel(day);
  return (
    <h3 className="flex h-8 items-center text-xs font-medium text-[var(--text-muted)]">
      <button
        type="button"
        aria-pressed={all}
        aria-label={all ? `Deselect ${label}` : `Select all of ${label}`}
        title={all ? "Deselect this day" : "Select this whole day"}
        onClick={() => onToggleDay(items)}
        className="-ml-1 flex h-8 items-center gap-1.5 rounded-full pl-1 pr-2 outline-none hover:text-[var(--text)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <span
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded-full border-2 transition",
            !selecting && "photos-day-idle",
            all
              ? "border-[var(--accent)] bg-[var(--accent-strong)] text-white opacity-100"
              : "border-[var(--text-muted)] text-transparent opacity-0 group-hover/day:opacity-100 group-focus-within/day:opacity-100",
            selecting && "opacity-100",
          )}
        >
          <Check className="h-3 w-3" strokeWidth={3} />
        </span>
        {label}
      </button>
    </h3>
  );
}

/** "Set up Photos" (PH-7) until it's done or put away. */
function SetupBanner() {
  const photosPath = usePhotosPath();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["photos", "settings"], queryFn: photosApi.settings });
  if (!data || data.setup_done) return null;
  return (
    <div role="region" aria-label="Set up Photos" className="mx-4 mt-3 flex flex-wrap items-center gap-3 rounded-card border border-[var(--border)] bg-[var(--accent-soft)] px-4 py-3">
      <Sparkles className="h-5 w-5 text-[var(--accent-text)]" />
      <p className="min-w-0 flex-1 text-sm text-[var(--text)]">
        <b>Set up Photos</b> — bring your photos in, name the people and pets, then ask for anything in them.
      </p>
      <Link to={photosPath("/setup")} className="rounded-md bg-[var(--accent-strong)] px-3 py-1 text-xs font-medium text-white">Start</Link>
      <button type="button" aria-label="Not now" className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)]"
        onClick={() => void photosApi.saveSettings({ setup_done: true }).then((s) => qc.setQueryData(["photos", "settings"], s))}>
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function Empty({ view, onFamily }: { view: PhotoView; onFamily: () => void }) {
  const photosPath = usePhotosPath();
  const primary = "flex min-h-10 items-center rounded-md bg-[var(--accent-strong)] px-4 text-sm font-medium text-white hover:bg-[var(--accent-strong-hover)]";
  const text =
    view === "family"
      ? "A shared place for your family's photos. Everyone chooses which of theirs go in."
      : view === "favorites"
        ? "Favourite a photo and it shows up here."
        : view === "archive"
          ? "Archived photos are kept safe, just left out of your timeline."
          : "Upload some, drop them anywhere on this page, or back up your phone.";
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <EmptyState
          icon={view === "favorites" ? <Heart className="h-5 w-5" /> : view === "archive" ? <Archive className="h-5 w-5" /> : <Images className="h-5 w-5" />}
          title={view === "all" ? "No photos yet" : view === "favorites" ? "No favourites yet" : view === "archive" ? "Nothing archived" : "Nothing here yet"}
          description={text}
          action={
            view === "all" ? (
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Link to="/files/devices" className={primary}>
                  Set up phone backup
                </Link>
                <Link to={photosPath("/setup")} className="flex min-h-10 items-center rounded-md px-4 text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)]">
                  Bring photos in
                </Link>
              </div>
            ) : view === "family" ? (
              <button type="button" onClick={onFamily} className={primary}>
                Set up family library
              </button>
            ) : undefined
          }
        />
      </div>
    </div>
  );
}
