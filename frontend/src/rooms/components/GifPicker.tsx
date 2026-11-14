/**
 * The composer's GIF picker.
 *
 * "Saved": the GIFs you've kept (your own files, on this server, plus any
 * you saved from the library). One tap sends.
 *
 * The library tab (GIPHY or KLIPY) is only there when an admin has turned
 * GIF search on. It searches straight from this device, as the libraries'
 * terms require; the note under the box says so. Results are shown exactly
 * as the library returns them, in its own tab, with its name on it.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, Loader2, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { roomsApi, type GifSearchConfig, type LibraryGif, type SavedGif } from "@/api/rooms";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { GifLibraryError, LIBRARY_NAMES, searchGifs, searchLabel, type GifPage } from "../gifs";

export const SAVED_GIFS_KEY = ["rooms", "saved-gifs"];

type Tab = "saved" | "library";

export function GifPicker({
  config,
  onPickSaved,
  onPickLibrary,
  className,
}: {
  /** GIF search, when it's on for this server. */
  config: GifSearchConfig | null;
  onPickSaved: (g: SavedGif) => void;
  onPickLibrary: (g: LibraryGif) => void;
  className?: string;
}) {
  const [tab, setTab] = useState<Tab>(config ? "library" : "saved");
  const name = config ? LIBRARY_NAMES[config.provider] : "";
  return (
    <div className={cn("flex h-[26rem] max-h-[70vh] flex-col", className)}>
      {config && (
        <div role="tablist" aria-label="GIFs" className="flex shrink-0 gap-1 border-b border-[var(--border)] px-2 pt-2">
          {(
            [
              ["library", name],
              ["saved", "Saved"],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                "-mb-px h-9 rounded-t-lg border-b-2 px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                tab === id ? "border-[var(--accent)] text-[var(--text)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {tab === "library" && config ? <LibraryTab config={config} onPick={onPickLibrary} /> : <SavedTab onPick={onPickSaved} searchOn={!!config} />}
    </div>
  );
}

const tile =
  "group/tile relative mb-1.5 block w-full break-inside-avoid overflow-hidden rounded-lg bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

function ratio(w?: number | null, h?: number | null): string {
  return w && h ? `${w} / ${h}` : "4 / 3";
}

// ------------------------------------------------------------------ saved

function SavedTab({ onPick, searchOn }: { onPick: (g: SavedGif) => void; searchOn: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: SAVED_GIFS_KEY, queryFn: roomsApi.savedGifs, refetchOnMount: "always" });
  const [managing, setManaging] = useState(false);
  const remove = async (g: SavedGif) => {
    qc.setQueryData<SavedGif[]>(SAVED_GIFS_KEY, (cur) => (cur ?? []).filter((x) => x.id !== g.id));
    try {
      await roomsApi.unsaveGif(g.id);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't remove that GIF."));
      void qc.invalidateQueries({ queryKey: SAVED_GIFS_KEY });
    }
  };
  // A library GIF you saved can only be sent while GIF search is on.
  const list = (q.data ?? []).filter((g) => g.source === "own" || searchOn);
  if (q.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center text-[var(--text-muted)]">
        <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading your GIFs" />
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-sm text-[var(--text-muted)]">
        Couldn't load your saved GIFs.
        <button type="button" onClick={() => void q.refetch()} className="font-medium text-[var(--accent-text)] underline">
          Try again
        </button>
      </div>
    );
  }
  if (list.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
        <Bookmark className="h-6 w-6 text-[var(--text-muted)]" aria-hidden />
        <p className="text-sm font-medium text-[var(--text)]">No saved GIFs yet</p>
        <p className="text-xs text-[var(--text-muted)]">
          Paste or attach a GIF to send it. To keep one for later, {searchOn ? "tap the bookmark on it here or in a conversation." : "tap the bookmark on it in a conversation."}
        </p>
      </div>
    );
  }
  return (
    <>
      <div className="flex shrink-0 items-center justify-between px-3 pb-1 pt-2">
        <span className="text-xs text-[var(--text-muted)]">{list.length === 1 ? "1 saved GIF" : `${list.length} saved GIFs`}</span>
        <button type="button" onClick={() => setManaging((v) => !v)} className="rounded-md px-1.5 py-1 text-xs font-medium text-[var(--accent-text)] hover:bg-[var(--hover)]">
          {managing ? "Done" : "Remove some"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        <div className="columns-2 gap-1.5 sm:columns-3">
          {list.map((g) => {
            const src = g.source === "own" ? g.url : (g.gif.preview_url ?? g.gif.url);
            const label = g.source === "own" ? g.filename || "GIF" : g.gif.title || "GIF";
            return (
              <div key={g.id} className={tile} style={{ aspectRatio: ratio(g.width, g.height) }}>
                <button type="button" onClick={() => (managing ? void remove(g) : onPick(g))} aria-label={managing ? `Remove ${label}` : `Send ${label}`} className="block h-full w-full">
                  <img src={src} alt={label} loading="lazy" draggable={false} referrerPolicy="no-referrer" className={cn("h-full w-full object-cover", managing && "opacity-50")} />
                </button>
                {managing && (
                  <span className="pointer-events-none absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-white">
                    <X className="h-3.5 w-3.5" />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ the library

function LibraryTab({ config, onPick }: { config: GifSearchConfig; onPick: (g: LibraryGif) => void }) {
  const qc = useQueryClient();
  const name = LIBRARY_NAMES[config.provider];
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState<GifPage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Set<string>>(() => new Set());
  const run = useRef(0);

  // Typing settles for a moment before the library is asked.
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(text.trim()), 350);
    return () => window.clearTimeout(t);
  }, [text]);

  const load = async (cursor: number, fresh: boolean, abort?: AbortSignal) => {
    const mine = ++run.current;
    setBusy(true);
    setError(null);
    try {
      const page = await searchGifs(config, query, cursor, abort);
      if (mine !== run.current) return;
      setPages((cur) => (fresh ? [page] : [...cur, page]));
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError" || mine !== run.current) return;
      setError(e instanceof GifLibraryError ? e.message : `Couldn't reach ${name}.`);
      if (fresh) setPages([]);
    } finally {
      if (mine === run.current) setBusy(false);
    }
  };

  useEffect(() => {
    const abort = new AbortController();
    void load(0, true, abort.signal);
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, config.provider, config.key, config.rating]);

  const keep = async (g: LibraryGif) => {
    setSaved((s) => new Set(s).add(g.id));
    try {
      await roomsApi.saveGif({ gif: g });
      void qc.invalidateQueries({ queryKey: SAVED_GIFS_KEY });
    } catch (err) {
      setSaved((s) => {
        const n = new Set(s);
        n.delete(g.id);
        return n;
      });
      toast.error(apiErrorMessage(err, "Couldn't save that GIF."));
    }
  };

  const gifs = pages.flatMap((p) => p.gifs);
  const next = pages.length ? pages[pages.length - 1].next : null;

  return (
    <>
      <div className="shrink-0 px-2 pt-2">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={searchLabel(config.provider)}
            aria-label={searchLabel(config.provider)}
            autoComplete="off"
            data-autofocus=""
            className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] pl-8 pr-3 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none md:h-9"
          />
        </label>
        <p className="px-1 pb-1 pt-1.5 text-[11px] leading-snug text-[var(--text-muted)]">
          {query ? "Results" : "Trending"} from {name}. Searches and GIFs go between this device and {name}, not through this server.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-[var(--text-muted)]">
            {error}
            <button type="button" onClick={() => void load(0, true)} className="font-medium text-[var(--accent-text)] underline">
              Try again
            </button>
          </div>
        ) : gifs.length === 0 && !busy ? (
          <p className="px-2 py-8 text-center text-sm text-[var(--text-muted)]">{query ? `Nothing on ${name} for "${query}". Try other words.` : `${name} has nothing to show right now.`}</p>
        ) : (
          <>
            {/* The library's own order, in its own grid: nothing added, dropped or moved. */}
            <div className="columns-2 gap-1.5 sm:columns-3">
              {gifs.map((g, i) => (
                <div key={`${g.id}-${i}`} className={tile} style={{ aspectRatio: ratio(g.width, g.height) }}>
                  <button type="button" onClick={() => onPick(g)} aria-label={`Send ${g.title || "GIF"}`} className="block h-full w-full">
                    <img src={g.preview_url ?? g.url} alt={g.title || "GIF"} loading="lazy" draggable={false} referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                  </button>
                  <button
                    type="button"
                    aria-label={saved.has(g.id) ? "Saved" : "Save to your GIFs"}
                    title={saved.has(g.id) ? "Saved" : "Save to your GIFs"}
                    disabled={saved.has(g.id)}
                    onClick={() => void keep(g)}
                    className={cn(
                      "absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white",
                      saved.has(g.id) ? "opacity-100" : "opacity-100 md:opacity-0 md:focus-visible:opacity-100 md:group-hover/tile:opacity-100",
                    )}
                  >
                    <Bookmark className={cn("h-3.5 w-3.5", saved.has(g.id) && "fill-current")} />
                  </button>
                </div>
              ))}
            </div>
            {busy && (
              <div className="flex justify-center py-3 text-[var(--text-muted)]">
                <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading GIFs" />
              </div>
            )}
            {!busy && next !== null && (
              <button type="button" onClick={() => void load(next, false)} className="mx-auto mt-1 block rounded-full border border-[var(--border)] px-4 py-1.5 text-xs font-medium text-[var(--text)] hover:bg-[var(--hover)]">
                Show more
              </button>
            )}
          </>
        )}
      </div>
      <div className="shrink-0 border-t border-[var(--border)] px-3 py-1.5 text-center text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        Powered by {name}
      </div>
    </>
  );
}
