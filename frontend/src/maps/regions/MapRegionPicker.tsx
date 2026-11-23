import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Search } from "lucide-react";

import { cn } from "@/utils/cn";

import { mapRegionsApi, sizeText, timeText, useMapRegionCatalog, type MapRegion, type MapRegionEstimate } from "./api";

export interface MapRegionPickerProps {
  /** The ids ticked in this picker. */
  value: string[];
  onChange: (ids: string[]) => void;
  /** Maps the server already has: shown ticked and greyed, and counted in the
   *  estimate (all the maps are built together). */
  installed?: string[];
  /** One map only: picking another replaces it. Default: several. */
  single?: boolean;
  /** Told the estimate for what's ticked (plus ``installed``), or null. */
  onEstimate?: (estimate: MapRegionEstimate | null) => void;
  /** Height of the list. Default "18rem". */
  listHeight?: string;
  className?: string;
}

function rowDetail(r: MapRegion): string {
  if (r.download_mb == null) return "";
  const parts = [`${sizeText(r.download_mb * 1_000_000)} download`];
  if (r.disk_mb != null) parts.push(`${sizeText(r.disk_mb * 1_000_000)} on disk`);
  if (r.minutes != null) parts.push(timeText(r.minutes));
  return parts.join(" · ");
}

/**
 * Pick which countries' maps this server keeps: a search box over the list of
 * countries (and parts of big ones), each with a rough size and time, and a
 * summary of what the ticked maps need. Admins only (the list is an admin
 * API). It only chooses: the caller saves with ``mapRegionsApi.choose`` or
 * ``mapRegionsApi.add``.
 */
export function MapRegionPicker({ value, onChange, installed = [], single = false, onEstimate, listHeight = "18rem", className }: MapRegionPickerProps) {
  const { data: catalog, isLoading, isError } = useMapRegionCatalog();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [estimate, setEstimate] = useState<MapRegionEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);

  const regions = useMemo(() => catalog?.regions ?? [], [catalog]);
  const children = useMemo(() => {
    const by = new Map<string, MapRegion[]>();
    for (const r of regions) if (r.parent) by.set(r.parent, [...(by.get(r.parent) ?? []), r]);
    return by;
  }, [regions]);
  const ids = useMemo(() => new Set(regions.map((r) => r.id)), [regions]);

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = useMemo(() => {
    if (words.length) {
      return regions
        .filter((r) => {
          const text = `${r.name} ${r.parent_name ?? ""} ${r.continent}`.toLowerCase();
          return words.every((w) => text.includes(w));
        })
        .slice(0, 80);
    }
    // No search: countries, with their parts tucked under them.
    const out: MapRegion[] = [];
    for (const r of regions) {
      if (r.parent && ids.has(r.parent)) continue;
      out.push(r);
      const stack = open.has(r.id) ? [...(children.get(r.id) ?? [])] : [];
      while (stack.length) {
        const child = stack.shift()!;
        out.push(child);
        if (open.has(child.id)) stack.unshift(...(children.get(child.id) ?? []));
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regions, children, ids, open, query]);

  const all = useMemo(() => [...new Set([...installed, ...value])], [installed, value]);
  const key = all.join(",");
  useEffect(() => {
    if (!value.length) {
      setEstimate(null);
      onEstimate?.(null);
      return;
    }
    const stop = new AbortController();
    setEstimating(true);
    const timer = window.setTimeout(() => {
      mapRegionsApi
        .estimate(all, stop.signal)
        .then((e) => {
          setEstimate(e);
          onEstimate?.(e);
        })
        .catch(() => {
          if (!stop.signal.aborted) {
            setEstimate(null);
            onEstimate?.(null);
          }
        })
        .finally(() => {
          if (!stop.signal.aborted) setEstimating(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      stop.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, value.length]);

  const toggle = (id: string) => {
    if (installed.includes(id)) return;
    if (single) return onChange(value.includes(id) ? [] : [id]);
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };

  let lastGroup = "";
  return (
    <div className={cn("space-y-3", className)} data-testid="map-region-picker">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search for a country or region"
          aria-label="Search for a country or region"
          data-testid="map-region-search"
          className="h-10 w-full rounded-input border border-[var(--border)] bg-[var(--bg)] pl-9 pr-3 text-sm text-[var(--text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        />
      </div>

      <div
        role="listbox"
        aria-label="Maps you can choose"
        aria-multiselectable={!single}
        className="overflow-y-auto rounded-input border border-[var(--border)]"
        style={{ height: listHeight }}
      >
        {isLoading && <p className="p-3 text-sm text-[var(--text-muted)]">Getting the list of maps…</p>}
        {isError && <p className="p-3 text-sm text-[var(--text-muted)]">Couldn&apos;t get the list of maps. Check this server can reach the internet, then try again.</p>}
        {!isLoading && !isError && shown.length === 0 && <p className="p-3 text-sm text-[var(--text-muted)]">No map by that name.</p>}
        {shown.map((r) => {
          const group = words.length ? "" : r.continent;
          const header = group && group !== lastGroup && !(r.parent && ids.has(r.parent));
          if (header) lastGroup = group;
          const have = installed.includes(r.id);
          const on = have || value.includes(r.id);
          const parts = children.get(r.id);
          const depth = words.length || !r.parent || !ids.has(r.parent) ? 0 : 1;
          return (
            <div key={r.id}>
              {header && <p className="sticky top-0 z-[1] border-b border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{group}</p>}
              <div className={cn("flex items-stretch border-b border-[var(--border)] last:border-b-0", on && !have && "bg-[var(--hover)]")}>
                <button
                  type="button"
                  role="option"
                  aria-selected={on}
                  disabled={have}
                  onClick={() => toggle(r.id)}
                  data-testid={`map-region-${r.id}`}
                  className={cn("flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left", depth && "pl-8", have ? "cursor-default opacity-60" : "hover:bg-[var(--hover)]")}
                >
                  <span
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center border border-[var(--border)]",
                      single ? "rounded-full" : "rounded",
                      on && "border-[var(--accent-strong)] bg-[var(--accent-strong)] text-white",
                    )}
                  >
                    {on && <Check className="h-3.5 w-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-[var(--text)]">
                      {r.name}
                      {words.length > 0 && r.parent_name && <span className="text-[var(--text-muted)]"> · {r.parent_name}</span>}
                    </span>
                    <span className="block truncate text-xs text-[var(--text-muted)]">{have ? "Already on this server" : rowDetail(r) || "Size not known"}</span>
                  </span>
                </button>
                {!words.length && parts && parts.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      setOpen((was) => {
                        const next = new Set(was);
                        if (next.has(r.id)) next.delete(r.id);
                        else next.add(r.id);
                        return next;
                      })
                    }
                    aria-expanded={open.has(r.id)}
                    aria-label={`${open.has(r.id) ? "Hide" : "Show"} the parts of ${r.name}`}
                    title={`Just part of ${r.name}`}
                    className="flex shrink-0 items-center gap-1 px-3 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]"
                  >
                    {parts.length} parts
                    {open.has(r.id) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {catalog?.source === "builtin" && (
        <p className="text-xs text-[var(--text-muted)]">This is a short list, because the full one couldn&apos;t be downloaded just now. Try again in a while for every country.</p>
      )}

      {value.length > 0 && (
        <div className="rounded-input border border-[var(--border)] bg-[var(--bg)] p-3 text-sm" data-testid="map-region-estimate" aria-live="polite">
          {!estimate ? (
            <p className="text-[var(--text-muted)]">{estimating ? "Working out how big that is…" : "Couldn't work out the size just now."}</p>
          ) : (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-[var(--text-muted)]">Download</dt>
                <dd>about {sizeText(estimate.download_bytes)}</dd>
                <dt className="text-[var(--text-muted)]">Disk space</dt>
                <dd>
                  about {sizeText(estimate.disk_after_bytes)} when it&apos;s done, {sizeText(estimate.disk_needed_bytes)} free while it builds
                  {estimate.free_bytes != null && <span className="text-[var(--text-muted)]"> (this server has {sizeText(estimate.free_bytes)} free)</span>}
                </dd>
                <dt className="text-[var(--text-muted)]">Time</dt>
                <dd>{timeText(estimate.minutes)}, by itself in the background</dd>
              </dl>
              {installed.length > 0 && <p className="mt-2 text-xs text-[var(--text-muted)]">That&apos;s for all your maps together: they&apos;re rebuilt as one, and the ones you have keep working until the new set is ready.</p>}
              {!estimate.complete && <p className="mt-2 text-xs text-[var(--text-muted)]">Some sizes weren&apos;t known, so the real numbers will be bigger.</p>}
              {estimate.fits === false && (
                <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-400" role="alert" data-testid="map-region-too-big">
                  That won&apos;t fit: this server doesn&apos;t have enough free disk space. Pick a smaller map, or free up some space first.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
