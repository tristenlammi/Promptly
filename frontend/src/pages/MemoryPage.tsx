import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BookImage, MoreHorizontal, Play } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { memoriesApi } from "@/api/memories";
import type { PhotoItem } from "@/api/photos";
import { PhotoTile } from "@/components/photos/PhotoTile";
import { PhotoViewer } from "@/components/photos/PhotoViewer";
import { Button } from "@/components/shared/Button";
import { justify } from "@/lib/justify";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

/** One memory (PH-5): its photos, played from the start or opened one by
 *  one; kept as an album, or put away. */
export function MemoryPage() {
  const { memoryId = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ["photo-memory", memoryId], queryFn: () => memoriesApi.get(memoryId) });
  const items = useMemo(() => data?.items ?? [], [data]);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!box) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(box);
    return () => ro.disconnect();
  }, [box]);
  const rows = useMemo(
    () => justify(items.map((p) => ({ aspect: p.width && p.height ? p.width / p.height : null })), { width, targetHeight: width < 640 ? 110 : 200, gap: 4 }),
    [items, width],
  );
  const [viewing, setViewing] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [menu, setMenu] = useState(false);

  const away = async (act: () => Promise<void>, done: string) => {
    setMenu(false);
    try {
      await act();
      toast.success(done);
      void qc.invalidateQueries({ queryKey: ["photo-memories"] });
      navigate("/files/photos");
    } catch (e) {
      toast.error(apiErrorMessage(e, "That didn't work."));
    }
  };

  if (error) return <p className="p-6 text-sm text-[var(--text-muted)]">This memory isn't there any more.</p>;
  if (!data) return <p className="p-6 text-sm text-[var(--text-muted)]">Loading…</p>;
  const name = data.kind === "together" ? data.title.replace(/^You & /, "") : data.kind === "first_year" ? data.title.replace(/[’']s? first year$/, "") : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
        <Link to="/files/photos" aria-label="Back to Photos" className="rounded p-1 hover:bg-[var(--hover)]">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold text-[var(--text)]">{data.title}</h1>
          <p className="truncate text-xs text-[var(--text-muted)]">{data.subtitle}</p>
        </div>
        <Button size="sm" variant="secondary" leftIcon={<Play className="h-3.5 w-3.5" />} disabled={!items.length} onClick={() => {
          setPlaying(true);
          setViewing(items[0]?.id ?? null);
        }}>
          Play
        </Button>
        <Button size="sm" variant="ghost" leftIcon={<BookImage className="h-3.5 w-3.5" />} onClick={async () => {
          try {
            const a = await memoriesApi.saveAsAlbum(memoryId);
            void qc.invalidateQueries({ queryKey: ["albums"] });
            navigate(`/files/photos/albums/${a.id}`);
          } catch (e) {
            toast.error(apiErrorMessage(e, "Couldn't make the album."));
          }
        }}>
          <span className="hidden sm:inline">Save as album</span>
        </Button>
        <div className="relative">
          <button type="button" aria-label="More" aria-expanded={menu} onClick={() => setMenu((v) => !v)} className="rounded p-1.5 hover:bg-[var(--hover)]">
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menu && (
            <div role="menu" className="absolute right-0 z-20 mt-1 w-60 rounded-md border border-[var(--border)] bg-[var(--surface)] py-1 text-sm shadow-lg">
              <button type="button" role="menuitem" className="block w-full px-3 py-1.5 text-left hover:bg-[var(--hover)]"
                onClick={() => void away(() => memoriesApi.dismiss(memoryId), "You won't see this memory again.")}>
                Don't show this memory
              </button>
              {data.person_id && (
                <button type="button" role="menuitem" className="block w-full px-3 py-1.5 text-left hover:bg-[var(--hover)]"
                  onClick={() => void away(() => memoriesApi.hidePerson(memoryId), `No more memories of ${name || "them"} — undo from People.`)}>
                  Don't show memories of {name || "them"}
                </button>
              )}
            </div>
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2 sm:p-4">
        <div ref={setBox} aria-label="Memory photos" className="flex flex-col gap-1">
          {items.length === 0 ? (
            <p className="p-8 text-center text-sm text-[var(--text-muted)]">Its photos aren't in your library any more.</p>
          ) : (
            rows.map((r, ri) => (
              <div key={ri} className="flex gap-1" style={{ height: r.height }}>
                {r.items.map((idx, k) => {
                  const p = items[idx];
                  return (
                    <PhotoTile key={p.id} photo={p} width={r.widths[k]} height={r.height} selected={false} selecting={false}
                      onToggle={() => {}} onOpen={(ph: PhotoItem) => {
                      setPlaying(false);
                      setViewing(ph.id);
                    }} />
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
      {viewing && (
        <PhotoViewer items={items} startId={viewing} slideshow={playing} loadMore={async () => []} onClose={() => setViewing(null)}
          onChanged={() => void qc.invalidateQueries({ queryKey: ["photo-memory", memoryId] })} />
      )}
    </div>
  );
}
