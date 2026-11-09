import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { ArrowLeft, Camera, Images, Loader2, Search, Type, Upload } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { thumbHashToDataURL } from "thumbhash";

import { albumsApi, type Album } from "@/api/albums";
import { photosApi, type PhotoItem } from "@/api/photos";
import { EmptyState, ItemButton, Segmented, TextInput } from "@/items/ui";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { useSentinel } from "../../scroll";
import type { Pick } from "./model";
import { duration } from "./PickImage";

type Source = "recents" | "albums" | "search";

const MONTH = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

function monthOf(p: PhotoItem): string {
  const [y, m] = p.taken_local.split("-").map(Number);
  return MONTH.format(new Date(y, (m || 1) - 1, 1));
}

function blur(hash: string | null): string | undefined {
  if (!hash) return undefined;
  try {
    return thumbHashToDataURL(Uint8Array.from(atob(hash), (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

/** One library photo you can pick: its order number once picked. */
function Tile({ photo, order, onToggle, tooLong }: { photo: PhotoItem; order: number; onToggle: (p: PhotoItem) => void; tooLong: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const bg = useMemo(() => blur(photo.thumbhash), [photo.thumbhash]);
  const picked = order > 0;
  const when = new Date(photo.taken_local).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const what = photo.kind === "video" ? `Video, ${duration(photo.duration_ms)}, ${when}` : `Photo, ${when}`;
  return (
    <button
      type="button"
      data-photo={photo.id}
      aria-pressed={picked}
      aria-label={picked ? `${what}, picked ${order}` : what}
      title={tooLong ? "Too long to post here" : undefined}
      onClick={() => onToggle(photo)}
      className={cn(
        "relative block aspect-square w-full overflow-hidden bg-[var(--surface-2)] bg-cover bg-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]",
        tooLong && "opacity-50",
      )}
      style={bg ? { backgroundImage: `url(${bg})` } : undefined}
    >
      {photo.thumb && (
        <img
          src={photo.thumb}
          alt=""
          loading="lazy"
          draggable={false}
          onLoad={() => setLoaded(true)}
          className={cn("h-full w-full object-cover transition", loaded ? "opacity-100" : "opacity-0", picked && "scale-[0.92] rounded-md")}
        />
      )}
      {photo.kind === "video" && (
        <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[11px] font-medium text-white">{duration(photo.duration_ms)}</span>
      )}
      <span
        aria-hidden
        className={cn(
          "absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full border-2 text-xs font-bold",
          picked ? "border-white bg-[var(--item-accent)] text-white" : "border-white/90 bg-black/20",
        )}
      >
        {picked ? order : null}
      </span>
    </button>
  );
}

function Grid({
  items,
  picks,
  onToggle,
  months,
  maxVideoMs,
}: {
  items: PhotoItem[];
  picks: Pick[];
  onToggle: (p: PhotoItem) => void;
  months?: boolean;
  maxVideoMs: number;
}) {
  const order = useMemo(() => new Map(picks.map((p, i) => [p.fileId, i + 1])), [picks]);
  const groups = useMemo(() => {
    if (!months) return [{ label: "", items }];
    const out: { label: string; items: PhotoItem[] }[] = [];
    for (const it of items) {
      const label = monthOf(it);
      if (out.length && out[out.length - 1].label === label) out[out.length - 1].items.push(it);
      else out.push({ label, items: [it] });
    }
    return out;
  }, [items, months]);
  return (
    <>
      {groups.map((g) => (
        <Fragment key={g.label || "all"}>
          {g.label && <h3 className="px-3 pb-1.5 pt-3 text-sm font-semibold text-[var(--text)] md:px-0">{g.label}</h3>}
          <ul className="grid grid-cols-3 gap-0.5 sm:grid-cols-4 lg:grid-cols-5">
            {g.items.map((p) => (
              <li key={p.id}>
                <Tile photo={p} order={order.get(p.id) ?? 0} onToggle={onToggle} tooLong={p.kind === "video" && !!p.duration_ms && p.duration_ms > maxVideoMs} />
              </li>
            ))}
          </ul>
        </Fragment>
      ))}
    </>
  );
}

const mine = (items: PhotoItem[]) => items.filter((p) => p.mine !== false);

function Recents(props: { picks: Pick[]; onToggle: (p: PhotoItem) => void; maxVideoMs: number }) {
  const q = useInfiniteQuery({
    queryKey: ["porch", "compose", "timeline"],
    queryFn: ({ pageParam }) => photosApi.timeline({ view: "all", before: pageParam, limit: 120 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    staleTime: 60_000,
  });
  const items = useMemo(() => mine((q.data?.pages ?? []).flatMap((p) => p.items)), [q.data]);
  const sentinel = useSentinel(() => {
    if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  });
  if (q.isPending) return <GridSkeleton />;
  if (q.isError) return <PickError text="Couldn't load your photos." onRetry={() => void q.refetch()} />;
  if (!items.length) {
    return (
      <EmptyState
        className="mx-3 mt-4 md:mx-0"
        icon={Images}
        title="No photos in your library yet"
        text="Take one or upload some: they go into your Photos library, and you can post them from there."
      />
    );
  }
  return (
    <>
      <Grid items={items} months {...props} />
      <div ref={sentinel} className="flex justify-center py-4">
        {q.isFetchingNextPage && <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" aria-label="Loading more photos" />}
      </div>
    </>
  );
}

function Albums(props: { picks: Pick[]; onToggle: (p: PhotoItem) => void; maxVideoMs: number }) {
  const [open, setOpen] = useState<Album | null>(null);
  const list = useQuery({ queryKey: ["porch", "compose", "albums"], queryFn: albumsApi.list, staleTime: 60_000 });
  const items = useQuery({
    queryKey: ["porch", "compose", "album", open?.id],
    queryFn: () => albumsApi.items(open!.id),
    enabled: !!open,
    staleTime: 60_000,
  });
  if (open) {
    const own = mine(items.data?.items ?? []);
    const others = (items.data?.items.length ?? 0) - own.length;
    return (
      <div>
        <div className="flex items-center gap-1 px-1 py-1 md:px-0">
          <button
            type="button"
            onClick={() => setOpen(null)}
            className="inline-flex h-10 items-center gap-1 rounded-xl px-2 text-sm font-medium text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden /> Albums
          </button>
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--text)]">{open.title}</h3>
        </div>
        {items.isPending ? (
          <GridSkeleton />
        ) : items.isError ? (
          <PickError text="Couldn't load this album." onRetry={() => void items.refetch()} />
        ) : own.length ? (
          <Grid items={own} {...props} />
        ) : (
          <p className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">None of the photos in this album are yours to post.</p>
        )}
        {others > 0 && own.length > 0 && (
          <p className="px-3 py-3 text-center text-xs text-[var(--text-muted)]">
            {others === 1 ? "1 photo here is someone else's" : `${others} photos here are someone else's`}, so it isn't shown. You can post only your own photos.
          </p>
        )}
      </div>
    );
  }
  if (list.isPending) return <GridSkeleton />;
  if (list.isError) return <PickError text="Couldn't load your albums." onRetry={() => void list.refetch()} />;
  const albums = list.data ?? [];
  if (!albums.length) return <p className="px-3 py-10 text-center text-sm text-[var(--text-muted)]">You haven't made any albums in Photos yet.</p>;
  return (
    <ul className="grid grid-cols-2 gap-3 px-3 py-2 sm:grid-cols-3 md:px-0 lg:grid-cols-4">
      {albums.map((a) => (
        <li key={a.id}>
          <button
            type="button"
            onClick={() => setOpen(a)}
            className="flex w-full flex-col gap-1.5 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
          >
            <span className="block aspect-square w-full overflow-hidden rounded-xl bg-[var(--surface-2)]">
              {a.cover?.thumb && <img src={a.cover.thumb} alt="" className="h-full w-full object-cover" loading="lazy" />}
            </span>
            <span className="truncate text-sm font-medium text-[var(--text)]">{a.title}</span>
            <span className="-mt-1 text-xs text-[var(--text-muted)]">{a.count === 1 ? "1 item" : `${a.count} items`}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function SearchPhotos(props: { picks: Pick[]; onToggle: (p: PhotoItem) => void; maxVideoMs: number }) {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setQ(text.trim()), 350);
    return () => window.clearTimeout(t);
  }, [text]);
  const res = useQuery({
    queryKey: ["porch", "compose", "search", q],
    queryFn: () => photosApi.search(q),
    enabled: q.length >= 2,
    staleTime: 60_000,
    retry: false,
  });
  const items = mine(res.data?.items ?? []);
  return (
    <div className="flex flex-col gap-2">
      <label className="relative mx-3 block md:mx-0">
        <span className="sr-only">Search your photos</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
        <TextInput
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search your photos: “beach”, “Max”, “Christmas 2025”"
          className="pl-9"
          autoFocus
        />
      </label>
      {q.length < 2 ? (
        <p className="px-3 py-6 text-center text-sm text-[var(--text-muted)]">Type what's in the photo, who's in it, or where and when it was taken.</p>
      ) : res.isPending ? (
        <GridSkeleton />
      ) : res.isError ? (
        <p className="px-3 py-6 text-center text-sm text-[var(--text-muted)]">
          {isAxiosError(res.error) && res.error.response?.status === 503
            ? "Searching by what's in a photo isn't ready right now. Try a place, a date or a name, or pick from Recents."
            : apiErrorMessage(res.error, "Couldn't search your photos. Try again.")}
        </p>
      ) : items.length ? (
        <Grid items={items} {...props} />
      ) : (
        <p className="px-3 py-6 text-center text-sm text-[var(--text-muted)]">Nothing in your photos matches “{q}”.</p>
      )}
    </div>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-3 gap-0.5 sm:grid-cols-4 lg:grid-cols-5" aria-hidden>
      {Array.from({ length: 12 }, (_, i) => (
        <span key={i} className="aspect-square animate-pulse bg-[var(--surface-2)]" />
      ))}
    </div>
  );
}

function PickError({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-3 py-10 text-center text-sm text-[var(--text-muted)]">
      <p>{text}</p>
      <ItemButton size="sm" variant="secondary" onClick={onRetry}>
        Try again
      </ItemButton>
    </div>
  );
}

/**
 * Step 1, Pick: your Photos library (newest first, by month), an album, or a
 * search of your photos, plus Camera and Upload. Only your own photos are
 * offered (decision D1). Each picked photo shows its place in the post.
 */
export function PickStep({
  picks,
  onToggle,
  onFiles,
  onTextPost,
  isPhone,
  maxVideoMs,
  showTextLink,
}: {
  picks: Pick[];
  onToggle: (p: PhotoItem) => void;
  onFiles: (files: File[]) => void;
  onTextPost: () => void;
  isPhone: boolean;
  maxVideoMs: number;
  showTextLink: boolean;
}) {
  const [source, setSource] = useState<Source>("recents");
  const upload = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const take = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length) onFiles(files);
  };
  const props = { picks, onToggle, maxVideoMs };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 px-3 md:px-0">
        <Segmented<Source>
          size="sm"
          value={source}
          onChange={setSource}
          options={[
            { value: "recents", label: "Recents" },
            { value: "albums", label: "Albums" },
            { value: "search", label: "Search" },
          ]}
          className="mr-auto"
        />
        {isPhone && (
          <ItemButton size="sm" variant="secondary" icon={<Camera className="h-4 w-4" />} onClick={() => camera.current?.click()}>
            Camera
          </ItemButton>
        )}
        <ItemButton size="sm" variant="secondary" icon={<Upload className="h-4 w-4" />} onClick={() => upload.current?.click()}>
          Upload
        </ItemButton>
        <input ref={upload} type="file" accept="image/*,video/*" multiple hidden onChange={take} data-testid="porch-upload" />
        <input ref={camera} type="file" accept="image/*,video/*" capture="environment" hidden onChange={take} />
      </div>
      <p className="px-3 text-xs text-[var(--text-muted)] md:px-0">
        Your own photos and videos, up to 20. New ones are saved into your Photos library.
      </p>
      <div className="md:overflow-hidden md:rounded-xl">
        {source === "recents" && <Recents {...props} />}
        {source === "albums" && <Albums {...props} />}
        {source === "search" && <SearchPhotos {...props} />}
      </div>
      {showTextLink && (
      <button
        type="button"
        onClick={onTextPost}
        className="mx-auto mb-4 mt-2 inline-flex h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-[var(--accent-text)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
      >
        <Type className="h-4 w-4" aria-hidden /> Write a text post instead
      </button>
      )}
    </div>
  );
}

