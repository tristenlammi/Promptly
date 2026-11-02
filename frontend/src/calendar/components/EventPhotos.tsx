import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, Images, Loader2 } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { Link } from "react-router-dom";

import { calendarReachApi } from "@/api/calendarReach";
import { extractError } from "@/components/files/helpers";
import { toast } from "@/store/toastStore";

// The full-screen viewer only loads when a photo is tapped.
const PhotoViewer = lazy(() => import("@/components/photos/PhotoViewer").then((m) => ({ default: m.PhotoViewer })));

/** "Photos from this event": the viewer's own photos taken while it was on
 *  (a little before and after). Shows nothing until it has started, or when
 *  there are none. Tap one to look; "Make an album" keeps them together. */
export function EventPhotos({ eventId, occurrence, start }: { eventId: string; occurrence: string; start: Date }) {
  const started = start.getTime() <= Date.now();
  const qc = useQueryClient();
  const key = ["calendar", "event-photos", eventId, occurrence];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => calendarReachApi.photos(eventId, occurrence),
    enabled: started,
    staleTime: 60_000,
    retry: false,
  });
  const [viewing, setViewing] = useState<string | null>(null);
  const [making, setMaking] = useState(false);

  if (!started || !data?.started || data.count === 0) return null;
  const album = data.album;
  const more = data.count - data.items.length;

  const makeAlbum = async () => {
    setMaking(true);
    try {
      const r = await calendarReachApi.makeAlbum(eventId, occurrence);
      toast.success(`Album “${r.album.title}” made with ${r.album.count ?? data.count} photos`);
      await qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      toast.error(extractError(err));
    } finally {
      setMaking(false);
    }
  };

  return (
    <div className="flex gap-3">
      <span className="mt-0.5 shrink-0 text-[var(--text-muted)]">
        <Images className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 text-xs text-[var(--text-muted)]">
          Photos from this event · {data.count} {data.count === 1 ? "photo" : "photos"} of yours
        </div>
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="list">
          {data.items.map((p) => (
            <button
              key={p.id}
              type="button"
              role="listitem"
              onClick={() => setViewing(p.id)}
              aria-label={`Open ${p.filename}`}
              className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
            >
              {p.thumb ? <img src={p.thumb} alt="" loading="lazy" className="h-full w-full object-cover" /> : <Images className="m-auto h-5 w-5 text-[var(--text-muted)]" />}
            </button>
          ))}
          {more > 0 && (
            <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-2)] text-xs font-medium text-[var(--text-muted)]">+{more}</span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {album ? (
            <Link
              to={`/files/photos/albums/${album.id}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 text-xs font-medium text-[var(--text)] hover:bg-[var(--hover)]"
            >
              <Images className="h-3.5 w-3.5" />
              Open album
            </Link>
          ) : (
            <button
              type="button"
              onClick={makeAlbum}
              disabled={making}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 text-xs font-medium text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-60"
            >
              {making ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderPlus className="h-3.5 w-3.5" />}
              Make an album
            </button>
          )}
        </div>
      </div>
      {viewing && (
        <Suspense fallback={null}>
          <PhotoViewer items={data.items} startId={viewing} loadMore={async () => []} onClose={() => setViewing(null)} onChanged={() => void qc.invalidateQueries({ queryKey: key })} />
        </Suspense>
      )}
    </div>
  );
}
