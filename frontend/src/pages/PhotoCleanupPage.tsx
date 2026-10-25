import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Maximize2, Sparkles, Trash2 } from "lucide-react";

import { filesApi } from "@/api/files";
import { photosApi, type CleanupReason, type PhotoItem, type SizedPhoto } from "@/api/photos";
import { humanSize } from "@/components/files/helpers";
import { PhotoTile } from "@/components/photos/PhotoTile";
import { PhotoViewer } from "@/components/photos/PhotoViewer";
import { Button } from "@/components/shared/Button";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/** Cleanup (PH-7): what you may not want — duplicates (the one to keep
 *  marked, the rest picked), blurry shots, screenshots, large videos — moved
 *  to the trash when you say so (recoverable), or kept and not asked again. */

const TABS: { id: CleanupReason; label: string; empty: string }[] = [
  { id: "duplicate", label: "Duplicates", empty: "No duplicates — every photo is one of a kind." },
  { id: "blurry", label: "Blurry", empty: "Nothing blurry found." },
  { id: "screenshot", label: "Screenshots", empty: "No screenshots in your photos." },
  { id: "large_video", label: "Large videos", empty: "No videos over 100 MB." },
];

export function PhotoCleanupPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["photo-cleanup"], queryFn: photosApi.cleanup });
  const [tab, setTab] = useState<CleanupReason>("duplicate");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<{ items: PhotoItem[]; id: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Duplicates start with every extra copy picked; the rest with nothing.
  useEffect(() => {
    if (!data) return;
    setSelected(tab === "duplicate" ? new Set(data.duplicate.groups.flatMap((g) => g.others.map((o) => o.id))) : new Set());
  }, [data, tab]);

  const all: SizedPhoto[] = useMemo(() => {
    if (!data) return [];
    return tab === "duplicate" ? data.duplicate.groups.flatMap((g) => g.others) : data[tab].items;
  }, [data, tab]);
  const chosen = all.filter((p) => selected.has(p.id));
  const bytes = chosen.reduce((n, p) => n + p.size, 0);
  const toggle = (p: PhotoItem) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(p.id)) next.delete(p.id);
      else next.add(p.id);
      return next;
    });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["photo-cleanup"] });
    void qc.invalidateQueries({ queryKey: ["photos"] });
  };

  const trash = async () => {
    const ids = chosen.map((p) => p.id);
    setBusy(true);
    try {
      await filesApi.bulkTrash({ file_ids: ids, folder_ids: [] });
      refresh();
      toast.success(`${ids.length} moved to the trash — ${humanSize(bytes)} freed when it's emptied.`, {
        action: {
          label: "Undo",
          onClick: () => void Promise.all(ids.map((id) => filesApi.restoreFile(id))).then(refresh),
        },
      });
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't move them to the trash."));
    } finally {
      setBusy(false);
    }
  };
  const keep = async (ids: string[]) => {
    setBusy(true);
    try {
      await photosApi.keep(ids, tab);
      refresh();
      toast.success(ids.length === 1 ? "Kept — it won't be suggested again." : `Kept ${ids.length} — they won't be suggested again.`);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't save that."));
    } finally {
      setBusy(false);
    }
  };

  const tile = (p: SizedPhoto, pool: PhotoItem[], kept = false) => (
    <div key={p.id} className="relative">
      <PhotoTile photo={p} width={132} height={132} selected={!kept && selected.has(p.id)} selecting={!kept} onToggle={kept ? () => {} : toggle}
        onOpen={() => setViewing({ items: pool, id: p.id })} />
      <button type="button" aria-label="View" onClick={() => setViewing({ items: pool, id: p.id })}
        className="absolute right-1 top-1 rounded bg-black/50 p-1 text-white opacity-80 hover:opacity-100">
        <Maximize2 className="h-3 w-3" />
      </button>
      <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
        {kept ? <span className="font-medium text-[var(--accent-text)]">Keep · </span> : null}
        {humanSize(p.size)}
      </p>
    </div>
  );

  const current = TABS.find((t) => t.id === tab)!;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
        <h1 className="mr-2 text-base font-semibold text-[var(--text)]">Clean up</h1>
        <nav aria-label="Cleanup" className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button key={t.id} type="button" aria-current={tab === t.id ? "page" : undefined} onClick={() => setTab(t.id)}
              className={cn("rounded-full px-3 py-1 text-xs transition",
                tab === t.id ? "bg-[var(--accent-soft)] font-medium text-[var(--accent-text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]")}>
              {t.label}{data ? ` · ${data[t.id].count}` : ""}
            </button>
          ))}
        </nav>
      </header>
      {chosen.length > 0 && (
        <div role="toolbar" aria-label="Chosen" className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm">
          <span className="flex-1">
            {chosen.length} chosen · {humanSize(bytes)}
          </span>
          <Button size="sm" variant="ghost" leftIcon={<Check className="h-3.5 w-3.5" />} disabled={busy} onClick={() => void keep(chosen.map((p) => p.id))}>
            Keep
          </Button>
          <Button size="sm" variant="danger" leftIcon={<Trash2 className="h-3.5 w-3.5" />} loading={busy} onClick={() => void trash()}>
            Move to trash
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <HiddenCopies />
        {isLoading ? (
          <p className="text-sm text-[var(--text-muted)]">Looking through your photos…</p>
        ) : error ? (
          <p role="alert" className="text-sm text-[var(--text-muted)]">{apiErrorMessage(error, "Couldn't look through your photos.")}</p>
        ) : !data || data[tab].count === 0 ? (
          <div className="flex flex-col items-center gap-2 p-10 text-center">
            <Sparkles className="h-10 w-10 text-[var(--text-muted)]" />
            <p className="text-sm font-medium text-[var(--text)]">{current.empty}</p>
          </div>
        ) : (
          <>
            <p className="mb-3 text-xs text-[var(--text-muted)]">
              {tab === "duplicate"
                ? `${data.duplicate.count} extra ${data.duplicate.count === 1 ? "copy" : "copies"} in ${data.duplicate.groups.length} ${data.duplicate.groups.length === 1 ? "group" : "groups"} · ${humanSize(data.duplicate.bytes)}. The best of each is kept; the rest are picked.`
                : `${data[tab].count} · ${humanSize(data[tab].bytes)}. Pick the ones you don't want.`}{" "}
              The trash keeps them until it's emptied.{" "}
              <button type="button" className="font-medium text-[var(--accent-text)] hover:underline" onClick={() => setSelected(new Set(all.map((p) => p.id)))}>
                Pick all
              </button>{" · "}
              <button type="button" className="font-medium text-[var(--accent-text)] hover:underline" onClick={() => setSelected(new Set())}>
                Pick none
              </button>
            </p>
            {tab === "duplicate" ? (
              <ul aria-label="Duplicate groups" className="space-y-4">
                {data.duplicate.groups.map((g) => {
                  const pool = [g.keep, ...g.others];
                  return (
                    <li key={g.keep.id} className="rounded-lg border border-[var(--border)] p-2">
                      <div className="flex flex-wrap gap-2">
                        {tile(g.keep, pool, true)}
                        {g.others.map((o) => tile(o, pool))}
                      </div>
                      <button type="button" className="mt-1 text-xs text-[var(--text-muted)] underline-offset-2 hover:underline"
                        onClick={() => void keep(g.others.map((o) => o.id))}>
                        Keep all of these
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div aria-label={current.label} className="flex flex-wrap gap-2">
                {data[tab].items.map((p) => tile(p, data[tab].items))}
              </div>
            )}
          </>
        )}
      </div>
      {viewing && (
        <PhotoViewer items={viewing.items} startId={viewing.id} loadMore={async () => []} onClose={() => setViewing(null)} onChanged={refresh} />
      )}
    </div>
  );
}


/** Photos hidden as copies of ones you already have — usually your phone
 *  syncing photos a Google Takeout already brought in. Each next to the
 *  one it matched; "Not a copy" puts it back in Photos for good. */
function HiddenCopies() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["photos", "copies"], queryFn: photosApi.copies });
  const [open, setOpen] = useState(false);
  if (!data || data.count === 0) return null;
  const restore = async (id: string) => {
    try {
      await photosApi.notCopies([id]);
      toast.success("It's back in Photos.");
      void qc.invalidateQueries({ queryKey: ["photos"] });
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't put it back."));
    }
  };
  return (
    <section aria-label="Hidden copies" className="mb-4 rounded-card border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-sm text-[var(--text)]">
          <span className="font-medium">{data.count.toLocaleString()} {data.count === 1 ? "photo" : "photos"} hidden as copies</span>
          <span className="block text-xs text-[var(--text-muted)]">
            Ones you already had, sent again — usually your phone syncing photos a Takeout brought in. They're kept, so your
            phone doesn't send them again, but not shown twice.
          </span>
        </p>
        <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Hide" : "Show"}
        </Button>
      </div>
      {open && (
        <ul className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3" aria-label="Copies and their originals">
          {data.items.map(({ copy, original }) => (
            <li key={copy.id} className="flex items-center gap-2 rounded-md border border-[var(--border)] p-2">
              {[copy, original].map((p, i) => (
                <figure key={p.id} className="flex flex-col items-center gap-0.5">
                  <span className="block h-16 w-16 overflow-hidden rounded bg-[var(--hover)]">
                    {p.thumb && <img src={p.thumb} alt="" loading="lazy" className="h-full w-full object-cover" />}
                  </span>
                  <figcaption className="text-[10px] text-[var(--text-muted)]">{i === 0 ? "copy" : "you had"}</figcaption>
                </figure>
              ))}
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void restore(copy.id)}>
                Not a copy
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
