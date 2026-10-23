import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Sparkles } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { albumsApi } from "@/api/albums";

import { photosApi, type PhotoItem, type PhotoSearchResult } from "@/api/photos";
import { PhotoTile } from "@/components/photos/PhotoTile";
import { PhotoViewer } from "@/components/photos/PhotoViewer";
import { Button } from "@/components/shared/Button";
import { justify } from "@/lib/justify";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

/** Photos by what's in them (PH-2): "dog on a beach", "birthday cake",
 *  "snow" — best matches first, from the photos-ml service's SigLIP 2. */
export function PhotoSearchPage() {
  const [params, setParams] = useSearchParams();
  const q = (params.get("q") ?? "").trim();
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  const { data, error, isFetching } = useQuery({
    queryKey: ["photos", "search", q],
    queryFn: () => photosApi.search(q),
    enabled: !!q,
    retry: false,
    staleTime: 60_000,
  });
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
  const navigate = useNavigate();
  const qc = useQueryClient();
  // The same question as an album that keeps itself up to date (PH-5).
  const saveSmart = async () => {
    const title = window.prompt("Name the smart album — new photos that match join it by themselves", q);
    if (!title?.trim()) return;
    try {
      const a = await albumsApi.create(title.trim(), [], { q });
      void qc.invalidateQueries({ queryKey: ["albums"] });
      navigate(`/files/photos/albums/${a.id}`);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't make the album."));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
        <form
          role="search"
          className="flex flex-1 items-center gap-2 rounded-full border border-[var(--border)] px-3 py-1 focus-within:border-[var(--accent)]"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) setParams({ q: draft.trim() });
          }}
        >
          <Search className="h-3.5 w-3.5 text-[var(--text-muted)]" />
          <input
            aria-label="Search your photos"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search your photos — “dog on the beach”, “birthday cake”"
            className="min-w-0 flex-1 border-0 bg-transparent text-sm shadow-none outline-none ring-0 focus:shadow-none focus:outline-none focus:ring-0"
            autoFocus
          />
        </form>
        {q && items.length > 0 && !data?.unresolved?.length && (
          <Button size="sm" variant="ghost" aria-label="Save as smart album" leftIcon={<Sparkles className="h-3.5 w-3.5" />} onClick={() => void saveSmart()}>
            <span className="hidden sm:inline">Save as smart album</span>
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div ref={setBox}>
          {!q ? (
            <p className="text-sm text-[var(--text-muted)]">Describe what's in the photo you're looking for.</p>
          ) : error ? (
            <p role="alert" className="text-sm text-[var(--text-muted)]">
              {apiErrorMessage(error, "Search isn't available right now.")}
            </p>
          ) : isFetching && !data ? (
            <p className="text-sm text-[var(--text-muted)]">Looking…</p>
          ) : items.length === 0 ? (
            <>
              <Understood data={data} />
              <p className="text-sm text-[var(--text-muted)]">Nothing matches “{q}”.</p>
            </>
          ) : (
            <>
              <Understood data={data} />
              <p className="mb-2 text-xs text-[var(--text-muted)]">
                {summary(items, q)}
              </p>
              <div className="flex flex-col gap-1" aria-label="Search results">
                {rows.map((r, ri) => (
                  <div key={ri} className="flex gap-1" style={{ height: r.height }}>
                    {r.items.map((idx, k) => {
                      const p = items[idx];
                      return (
                        <PhotoTile
                          key={p.id}
                          photo={p}
                          width={r.widths[k]}
                          height={r.height}
                          selected={false}
                          selecting={false}
                          onToggle={() => {}}
                          onOpen={(ph: PhotoItem) => setViewing(ph.id)}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      {viewing && (
        <PhotoViewer items={items} startId={viewing} loadMore={async () => []} onClose={() => setViewing(null)} onChanged={() => {}} />
      )}
    </div>
  );
}

function summary(items: { matched?: "text" | "description" | "looks" | "filters" }[], q: string): string {
  const words = items.filter((i) => i.matched === "text" || i.matched === "description").length;
  const looks = items.filter((i) => i.matched === "looks").length;
  if (!words && !looks) return `${items.length} ${items.length === 1 ? "photo" : "photos"}, newest first`;
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (words && looks) return `${n(words, "photo", "photos")} with “${q}” in ${words === 1 ? "it" : "them"}, then ${n(looks, "that looks", "that look")} like it`;
  if (words) return `${n(words, "photo", "photos")} with “${q}” in ${words === 1 ? "it" : "them"}`;
  return `${n(looks, "photo that looks", "photos that look")} like “${q}”, closest first`;
}

/** How the question was read — who, where, when — and, when nothing
 *  matched exactly, what was let go; names it doesn't know are said. */
function Understood({ data }: { data?: PhotoSearchResult }) {
  if (!data) return null;
  const u = data.understood;
  const chips: string[] = [
    ...(u.people ?? []),
    ...(u.pets ?? []),
    ...(u.place ? [String(u.place)] : []),
    ...(u.date_from ? [`${String(u.date_from)} – ${String(u.date_to ?? "")}`] : []),
    ...(u.media === "video" ? ["videos"] : []),
    ...(u.favorites ? ["favourites"] : []),
    ...(u.text ? [`“${String(u.text)}” written in it`] : []),
  ];
  return (
    <div className="mb-3 space-y-1.5 text-xs">
      {chips.length > 0 && (
        <p className="flex flex-wrap items-center gap-1.5" aria-label="Understood as">
          {chips.map((c) => (
            <span key={c} className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[var(--accent-text)]">{c}</span>
          ))}
        </p>
      )}
      {data.relaxed.length > 0 && (
        <p role="status" className="text-[var(--text)]">Nothing matched exactly, so the search was widened: {data.relaxed.join(" · ")}.</p>
      )}
      {data.unresolved.map((u) => (
        <p key={u} className="text-amber-600 dark:text-amber-400">Couldn't find {u}.</p>
      ))}
    </div>
  );
}
