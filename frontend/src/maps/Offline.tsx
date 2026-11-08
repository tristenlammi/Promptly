import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudDownload, Loader2, MapPinned, Pencil, Smartphone, Trash2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { Callout } from "@/components/shared/Callout";
import { confirm } from "@/components/shared/ConfirmDialog";
import { EmptyState } from "@/components/shared/EmptyState";
import { isAndroidDevice } from "@/lib/installPrompt";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { mapsApi, type OfflineArea, type OfflineEstimate, type OfflineOverview, type OfflinePhone, type Route, type Spot } from "./api";

/** P Maps offline areas on the web (maps-offline WP-M8). The areas are saved
 *  here and downloaded by the Promptly app on your Android phones: on Wi-Fi by
 *  themselves, or straight away when you save on the phone itself (the
 *  `promptlymaps://offline` hand-off, the same pair code as starting a trip). */

export const OFFLINE_KEY = ["maps-offline"] as const;

/** Your areas, and whether this server makes offline maps. */
export function useOffline(poll = false) {
  return useQuery({
    queryKey: OFFLINE_KEY,
    queryFn: mapsApi.offline,
    staleTime: 30_000,
    // While the panel's open, phones' progress shows without a reload.
    refetchInterval: poll ? 20_000 : false,
  });
}

/** "290 MB", "1.4 GB". */
export function formatSize(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

const STATES = /\s*(New South Wales|Victoria|Queensland|South Australia|Western Australia|Tasmania|Northern Territory|Australian Capital Territory|NSW|VIC|QLD|SA|WA|TAS|NT|ACT)?\s*(\d{4})?\s*$/;

/** A short name for an area: the town or suburb at its middle, else the place
 *  (the phone's Choose an area names areas the same way). */
export function areaName(found: { name: string; address?: string | null }): string | null {
  const town = found.address?.split(",").pop()?.replace(STATES, "").trim();
  if (town) return town;
  return found.name && found.name !== "Dropped pin" ? found.name : null;
}

const day = (iso: string) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });

/** What one phone has of an area, said plainly. */
export function phoneLine(phone: OfflinePhone, area: Pick<OfflineArea, "bytes">): string {
  switch (phone.state) {
    case "ready":
      return `Ready on ${phone.name} · ${day(phone.at)}`;
    case "downloading": {
      const part = area.bytes && phone.bytes > 0 ? Math.min(99, Math.floor((phone.bytes / area.bytes) * 100)) : null;
      return `Downloading on ${phone.name}${part !== null ? ` · ${part}%` : ""}`;
    }
    case "waiting":
      return `Waiting to download on ${phone.name}`;
    case "update":
      return `Update ready on ${phone.name}`;
    case "no_space":
      return `Not enough space on ${phone.name}`;
    default:
      return `Download stopped on ${phone.name} · it tries again by itself`;
  }
}

/** Opens the Promptly app's Offline areas on this Android phone, signed in,
 *  and with ``areaId`` starts that area's download. */
export async function openOnPhone(areaId?: string): Promise<void> {
  const code = await mapsApi.pairCode();
  const params = new URLSearchParams({ server: window.location.origin, code });
  if (areaId) params.set("area", areaId);
  window.location.href = `promptlymaps://offline?${params.toString()}`;
  // Still here shortly after: nothing took the link.
  window.setTimeout(() => {
    if (document.visibilityState === "visible") toast.info("Didn't open? Offline areas need the latest Promptly app for Android. The area is saved: your phone downloads it once it has that.");
  }, 2500);
}

/** After saving: straight to the phone's download on Android, else when it's next on Wi-Fi. */
async function handOff(area: OfflineArea): Promise<void> {
  const size = area.bytes ? ` (about ${formatSize(area.bytes)})` : "";
  if (isAndroidDevice()) {
    toast.success(`Saved ${area.name} for offline${size}`);
    try {
      await openOnPhone(area.id);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Saved, but couldn't open the Promptly app. Your phone downloads it on Wi-Fi when it has the latest Promptly app."));
    }
    return;
  }
  toast.success(`Saved ${area.name} for offline${size}. Your phone downloads it on Wi-Fi when it has the latest Promptly app.`, { duration: 6000 });
}

/** A route's corridor: the squares within 10 km of it. */
export async function saveRouteForOffline(route: Route, stops: Spot[], withAddresses = true): Promise<OfflineArea | null> {
  const ends = stops.filter((s) => s.name && s.name !== "Your location");
  const last = stops[stops.length - 1]?.name || "Destination";
  const name = (stops[0]?.name && stops[0].name !== "Your location" && ends.length >= 2 ? `${stops[0].name} to ${last}` : `To ${last}`).slice(0, 80);
  try {
    const area = await mapsApi.saveOffline({ name, kind: "route", shape: route.legs.map((l) => l.shape), with_addresses: withAddresses });
    await handOff(area);
    return area;
  } catch (e) {
    toast.error(apiErrorMessage(e, "Couldn't save this route for offline."));
    return null;
  }
}

type Box = [number, number, number, number];

export function OfflinePanel({ view, moves, onClose, onSquares, onShowArea }: {
  /** The part of the map you can see past the panels. */
  view: () => Box | null;
  /** Bumps whenever the map stops moving. */
  moves: number;
  onClose: () => void;
  /** The squares to shade on the map (null: none). */
  onSquares: (cells: string[] | null) => void;
  onShowArea: (area: OfflineArea) => void;
}) {
  const qc = useQueryClient();
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");
  const { data, error, isLoading, refetch } = useOffline(true);
  const android = isAndroidDevice();
  const nameId = useId();
  const houseId = useId();

  // ---- Save this view: the size of what's on screen, as the map moves. ----
  const [box, setBox] = useState<Box | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => setBox(view()), 300);
    return () => window.clearTimeout(t);
    // The map moved (or the panel opened): look again.
  }, [moves]); // eslint-disable-line react-hooks/exhaustive-deps
  const [withAddresses, setWithAddresses] = useState(true);
  const rounded = box?.map((v) => Math.round(v * 1000) / 1000) as Box | undefined;
  const { data: estimate, isFetching: estimating, error: estimateError } = useQuery<OfflineEstimate>({
    queryKey: ["maps-offline-estimate", rounded, withAddresses],
    queryFn: () => mapsApi.offlineEstimate(rounded!, withAddresses),
    enabled: !!rounded && !!data?.enabled,
    staleTime: 300_000,
    placeholderData: (previous) => previous,
    retry: false,
  });

  // The squares on the map: the one you're looking at, else what saving would keep.
  const [focus, setFocus] = useState<string | null>(null);
  const focused = data?.areas.find((a) => a.id === focus) ?? null;
  const shaded = focused?.cells ?? (estimate && !estimate.too_big ? estimate.cells : null);
  const shadedKey = shaded?.join(",") ?? "";
  useEffect(() => {
    onSquares(shaded);
    // By value: the same squares again aren't a change.
  }, [shadedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onSquares(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  // A name from the middle of the view, until you type your own.
  const [name, setName] = useState("");
  const typed = useRef(false);
  useEffect(() => {
    if (!box || typed.current) return;
    let live = true;
    const lat = (box[1] + box[3]) / 2;
    const lon = (box[0] + box[2]) / 2;
    const t = window.setTimeout(() => {
      mapsApi.reverse(lat, lon).then((found) => {
        if (live && !typed.current) setName(areaName(found) ?? "");
      }).catch(() => undefined);
    }, 400);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [box]);

  const [saving, setSaving] = useState(false);
  const saveView = async () => {
    const at = view();
    if (!at) return;
    const title = name.trim() || "My area";
    setSaving(true);
    try {
      const area = await mapsApi.saveOffline({
        name: title, kind: "view", with_addresses: withAddresses,
        box: { west: at[0], south: at[1], east: at[2], north: at[3] },
      });
      await qc.invalidateQueries({ queryKey: OFFLINE_KEY });
      typed.current = false;
      setName("");
      setBox(view());
      await handOff(area);
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't save this area."));
    } finally {
      setSaving(false);
    }
  };

  const refresh = () => qc.invalidateQueries({ queryKey: OFFLINE_KEY });

  const off = data && !data.enabled;
  const full = data ? data.areas.length >= data.max_areas : false;
  const tooBig = !!estimate?.too_big;
  const empty = !!estimate && estimate.squares === 0;
  const big = !!estimate?.bytes && estimate.bytes > 1_000_000_000;

  return (
    <div className="pb-4" data-testid="offline-panel">
      <div className="flex items-start gap-2 px-4 pt-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold text-[var(--text)]">Offline areas</h1>
          <p className="mt-0.5 text-sm text-[var(--text-muted)]">
            The map, search and directions on your Android phone when there&apos;s no signal.
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" title="Close" className="rounded-full p-1.5 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]">
          <X className="h-4 w-4" />
        </button>
      </div>

      {isLoading && <p className="flex items-center gap-2 px-4 pt-4 text-sm text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />Loading your areas…</p>}
      {error && (
        <div className="px-4 pt-3">
          <Callout tone="danger">
            {apiErrorMessage(error, "Couldn't load your offline areas.")}{" "}
            <button type="button" onClick={() => void refetch()} className="font-medium underline">Try again</button>
          </Callout>
        </div>
      )}

      {off && (
        <div className="px-4 pt-3">
          <Callout tone="warning">
            Offline maps are off on this server, so phones can&apos;t download areas.
            {isAdmin ? (
              <> They&apos;re turned on with <code>MAPS_OFFLINE=1</code> for the maps container; <Link to="/admin?tab=settings" className="font-medium underline">App settings</Link> shows their state.</>
            ) : " Ask your admin to turn them on."}
          </Callout>
        </div>
      )}
      {data && data.enabled && !data.ready && (
        <div className="px-4 pt-3">
          <Callout tone="info">
            {data.building
              ? "Your server is still building its maps. You can save areas now; sizes show, and phones download, once it's done."
              : "Your server makes offline maps at its next map update. You can save areas now; phones download them once they're made."}
          </Callout>
        </div>
      )}

      {data && data.enabled && (
        <section aria-labelledby={`${nameId}-h`} className="mx-4 mt-3 rounded-xl border border-[var(--border)] p-3">
          <h2 id={`${nameId}-h`} className="text-sm font-medium text-[var(--text)]">Save this view</h2>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            Move the map to frame the area. Your phone keeps the shaded squares.
          </p>
          <label htmlFor={nameId} className="mt-3 block text-xs font-medium text-[var(--text-muted)]">Name</label>
          <input
            id={nameId}
            value={name}
            maxLength={80}
            onChange={(e) => {
              typed.current = true;
              setName(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !saving && !tooBig && !empty && !full) void saveView();
            }}
            placeholder="Mudgee"
            className="mt-1 h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
          />
          <label htmlFor={houseId} className="mt-2 flex items-center gap-2 text-sm text-[var(--text)]">
            <input id={houseId} type="checkbox" checked={withAddresses} onChange={(e) => setWithAddresses(e.target.checked)} />
            House numbers
            {estimate?.addresses_bytes ? <span className="text-xs text-[var(--text-muted)]">(+{formatSize(estimate.addresses_bytes)})</span> : null}
          </label>
          <p className="ml-6 text-xs text-[var(--text-muted)]">Finds addresses like &quot;12 Smith St&quot; with no signal.</p>

          <p role="status" aria-live="polite" className="mt-3 min-h-5 text-sm" data-testid="offline-estimate">
            {estimateError ? (
              <span className="text-[var(--danger)]">{apiErrorMessage(estimateError, "Couldn't work out the size.")}</span>
            ) : !estimate ? (
              <span className="inline-flex items-center gap-2 text-[var(--text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />Working out the size…</span>
            ) : tooBig ? (
              <span className="text-[var(--danger)]">That&apos;s too big for one area ({estimate.squares} squares; the most is {estimate.max_squares}). Zoom in, or save it as two areas.</span>
            ) : empty ? (
              <span className="text-[var(--text-muted)]">There&apos;s no map here to keep. Move the map over land.</span>
            ) : estimate.bytes === null ? (
              <span className="text-[var(--text-muted)]">{estimate.squares} {estimate.squares === 1 ? "square" : "squares"} · the size shows once your server has made its offline maps.</span>
            ) : (
              <span className="text-[var(--text)]">
                About {formatSize(estimate.bytes)} <span className="text-[var(--text-muted)]">· {estimate.squares} {estimate.squares === 1 ? "square" : "squares"}</span>
                {estimating && <Loader2 className="ml-2 inline h-3.5 w-3.5 animate-spin text-[var(--text-muted)]" aria-hidden="true" />}
              </span>
            )}
          </p>
          {big && !tooBig && <p className="text-xs text-[var(--text-muted)]">That&apos;s a big area. Your phone downloads it on Wi-Fi.</p>}
          {full && <p className="mt-1 text-xs text-[var(--danger)]">You have {data.max_areas} areas, the most there can be. Delete one to save another.</p>}
          <button
            type="button"
            onClick={() => void saveView()}
            disabled={saving || !estimate || tooBig || empty || full}
            className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-4 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudDownload className="h-4 w-4" />}
            Save for offline
          </button>
        </section>
      )}

      {data && (
        <section aria-label="Your offline areas" className="pt-3">
          <div className="flex items-center justify-between px-4 pb-1">
            <h2 className="text-xs font-medium text-[var(--text-muted)]">Your areas{data.areas.length ? ` · ${data.areas.length} of ${data.max_areas}` : ""}</h2>
            {android && (
              <button type="button" onClick={() => void openOnPhone().catch((e) => toast.error(apiErrorMessage(e, "Couldn't open the Promptly app.")))} className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-text)]">
                <Smartphone className="h-3.5 w-3.5" />Open on this phone
              </button>
            )}
          </div>
          {data.areas.length === 0 ? (
            <div className="px-4">
              <EmptyState
                icon={<MapPinned className="h-5 w-5" />}
                title="No offline areas yet"
                description="Save an area to keep the map, search and directions on your phone for when there's no signal. You can also save a route's roads from its directions."
              />
            </div>
          ) : (
            <ul>
              {data.areas.map((a) => (
                <AreaRow
                  key={a.id}
                  area={a}
                  focused={focus === a.id}
                  onShow={() => {
                    setFocus(a.id);
                    onShowArea(a);
                  }}
                  onChanged={refresh}
                  onDeleted={() => {
                    if (focus === a.id) setFocus(null);
                    void refresh();
                  }}
                />
              ))}
            </ul>
          )}
          {focused && (
            <button type="button" onClick={() => setFocus(null)} className="mx-4 mt-1 text-xs font-medium text-[var(--accent-text)]">
              Back to this view&apos;s squares
            </button>
          )}
        </section>
      )}

      {data && (
        <p className="px-4 pt-4 text-xs text-[var(--text-muted)]">
          {android
            ? "Saving here opens the Promptly app to download it (offline areas need the latest Promptly app). Areas update themselves on Wi-Fi after the monthly map update."
            : "Areas download to your Android phones on Wi-Fi once they have the latest Promptly app, and update themselves after the monthly map update. Get the app from Apps → Install apps."}
          {" "}{data.attribution}
        </p>
      )}
    </div>
  );
}

function AreaRow({ area, focused, onShow, onChanged, onDeleted }: {
  area: OfflineArea;
  focused: boolean;
  onShow: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(area.name);
  const [busy, setBusy] = useState(false);
  const houseId = useId();
  const qc = useQueryClient();
  // The server's answer straight into the list, so a change shows at once.
  const put = (updated: OfflineArea) =>
    qc.setQueryData<OfflineOverview>(OFFLINE_KEY, (old) => (old ? { ...old, areas: old.areas.map((a) => (a.id === updated.id ? updated : a)) } : old));
  // Shown as ticked or not straight away, while it's saved.
  const [houses, setHouses] = useState(area.with_addresses);
  useEffect(() => setHouses(area.with_addresses), [area.with_addresses]);

  const rename = async () => {
    const next = draft.trim();
    if (!next || next === area.name) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    try {
      put(await mapsApi.editOffline(area.id, { name: next }));
      setRenaming(false);
      onChanged();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't rename it."));
    } finally {
      setBusy(false);
    }
  };

  const setHouseNumbers = async (on: boolean) => {
    setHouses(on);
    setBusy(true);
    try {
      put(await mapsApi.editOffline(area.id, { with_addresses: on }));
      onChanged();
    } catch (e) {
      setHouses(!on);
      toast.error(apiErrorMessage(e, "Couldn't change that."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${area.name}?`,
      message: area.devices.length
        ? "Your phones remove it next time they check in, and keep any squares another area still needs. You can save it again."
        : "You can save it again.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await mapsApi.deleteOffline(area.id);
      toast.success(`Deleted ${area.name}`);
      onDeleted();
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't delete it."));
    }
  };

  const kind = area.kind === "route" ? "Route" : area.kind === "around" ? "Around a place" : "Area";
  return (
    <li className={`border-t border-[var(--border)] px-4 py-2.5 first:border-t-0 ${focused ? "bg-[var(--hover)]" : ""}`} data-testid="offline-area">
      <div className="flex items-start gap-2">
        {renaming ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void rename();
            }}
          >
            <input
              autoFocus
              value={draft}
              maxLength={80}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setDraft(area.name);
                  setRenaming(false);
                }
              }}
              aria-label={`New name for ${area.name}`}
              className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
            <button type="submit" disabled={busy} className="rounded-lg bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50">Save</button>
            <button type="button" onClick={() => {
              setDraft(area.name);
              setRenaming(false);
            }} className="text-xs text-[var(--text-muted)] hover:text-[var(--text)]">Cancel</button>
          </form>
        ) : (
          <button type="button" onClick={onShow} className="min-w-0 flex-1 text-left" aria-label={`Show ${area.name} on the map`}>
            <span className="block truncate text-sm font-medium text-[var(--text)]">{area.name}</span>
            <span className="block text-xs text-[var(--text-muted)]">
              {kind} · {area.bytes !== null ? formatSize(area.bytes) : `${area.squares} ${area.squares === 1 ? "square" : "squares"}`}
            </span>
          </button>
        )}
        {!renaming && (
          <div className="flex shrink-0 items-center">
            <button type="button" onClick={() => {
              setDraft(area.name);
              setRenaming(true);
            }} aria-label={`Rename ${area.name}`} title="Rename" className="rounded-full p-1.5 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]">
              <Pencil className="h-4 w-4" />
            </button>
            {isAndroidDevice() && (
              <button type="button" onClick={() => void openOnPhone(area.id).catch((e) => toast.error(apiErrorMessage(e, "Couldn't open the Promptly app.")))} aria-label={`Download ${area.name} on this phone`} title="Download on this phone" className="rounded-full p-1.5 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]">
                <CloudDownload className="h-4 w-4" />
              </button>
            )}
            <button type="button" onClick={() => void remove()} aria-label={`Delete ${area.name}`} title="Delete" className="rounded-full p-1.5 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--danger)]">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
      <ul className="mt-1 space-y-0.5" aria-label={`${area.name} on your phones`}>
        {area.devices.length === 0 ? (
          <li className="text-xs text-[var(--text-muted)]">Not on a phone yet</li>
        ) : (
          area.devices.map((d) => (
            <li key={d.device_id} className="flex items-center gap-1.5 text-xs text-[var(--text)]">
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${d.state === "ready" ? "bg-[#2F9E6E]" : d.state === "failed" || d.state === "no_space" ? "bg-[var(--danger)]" : "bg-[var(--text-muted)]"}`}
              />
              {phoneLine(d, area)}
            </li>
          ))
        )}
      </ul>
      <label htmlFor={houseId} className="mt-1.5 flex items-center gap-2 text-xs text-[var(--text-muted)]">
        <input id={houseId} type="checkbox" checked={houses} disabled={busy} onChange={(e) => void setHouseNumbers(e.target.checked)} />
        House numbers{area.addresses_bytes ? ` (${formatSize(area.addresses_bytes)})` : ""}
      </label>
    </li>
  );
}
