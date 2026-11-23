import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, Map as MapIcon, Plus, Trash2 } from "lucide-react";

import { SettingsCard } from "@/components/admin/SettingsCard";
import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import { apiErrorMessage } from "@/utils/apiError";

import { MAP_REGIONS_STATE_KEY, mapRegionsApi, sizeText, stepText, useMapRegionsState, type MapRegionEstimate, type MapRegionRow, type MapRegionsState } from "./api";
import { MapRegionPicker } from "./MapRegionPicker";

const ROW_STATE: Record<MapRegionRow["state"], { label: string; tone: string }> = {
  installed: { label: "Ready", tone: "text-emerald-700 dark:text-emerald-400" },
  building: { label: "Being added", tone: "text-[var(--text-muted)]" },
  waiting: { label: "Waiting to start", tone: "text-[var(--text-muted)]" },
  removing: { label: "Being removed", tone: "text-[var(--text-muted)]" },
};

/** Admin → App settings: the maps this server keeps for P Maps. Add a
 *  country, watch it build, remove one. Hidden when P Maps is off. */
export function MapsRegionsCard() {
  const { data: state } = useMapRegionsState();
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [estimate, setEstimate] = useState<MapRegionEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!state || !state.available) return null;

  const took = (next: MapRegionsState) => {
    client.setQueryData(MAP_REGIONS_STATE_KEY, next);
    void client.invalidateQueries({ queryKey: ["maps-data-status"] });
    void client.invalidateQueries({ queryKey: ["maps-config"] });
  };
  const run = async (work: () => Promise<MapRegionsState | void>, failed: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await work();
      if (next) took(next);
      else void client.invalidateQueries({ queryKey: MAP_REGIONS_STATE_KEY });
      return true;
    } catch (err) {
      setError(apiErrorMessage(err, failed));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const kept = state.regions.filter((r) => r.state !== "removing");
  const add = async () => {
    if (await run(() => mapRegionsApi.add(picked), "Couldn't add that map.")) {
      setAdding(false);
      setPicked([]);
    }
  };
  const remove = async (row: MapRegionRow) => {
    const last = kept.length === 1;
    const ok = await confirm({
      title: `Remove ${row.name}?`,
      message: last
        ? "This is your only map. P Maps stops working for everyone until you choose another. People's saved places and timelines are kept."
        : `Your other maps are rebuilt without it, which takes a while. Everything keeps working meanwhile, and ${row.name} goes when the new set is ready. People's saved places are kept.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (ok) await run(() => mapRegionsApi.remove([row.id]), `Couldn't remove ${row.name}.`);
  };

  const env = state.managed === "env";
  const percent = state.progress != null ? Math.round(state.progress * 100) : null;

  return (
    <SettingsCard title="Maps on this server (P Maps)" icon={<MapIcon className="h-4 w-4" />}>
      <div className="space-y-4" data-testid="maps-regions-card">
        {kept.length === 0 && !state.regions.length ? (
          <p className="text-sm text-[var(--text)]" data-testid="maps-regions-none">
            <span className="font-medium">No map chosen yet.</span>{" "}
            <span className="text-[var(--text-muted)]">Nothing has been downloaded. Choose the country you live in and this server builds its map: the map itself, search and directions, all kept here.</span>
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border)] rounded-input border border-[var(--border)]" data-testid="maps-regions-list">
            {state.regions.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-3 py-2" data-testid={`maps-region-row-${r.id}`} data-state={r.state}>
                {r.state === "installed" ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" /> : <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--text-muted)]" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-[var(--text)]">{r.name}</span>
                  <span className={`block text-xs ${ROW_STATE[r.state].tone}`}>{state.failed && r.state !== "installed" ? "Stopped" : ROW_STATE[r.state].label}</span>
                </span>
                {!env && r.state !== "removing" && (
                  <Button size="sm" variant="ghost" onClick={() => void remove(r)} disabled={busy} aria-label={`Remove ${r.name}`} leftIcon={<Trash2 className="h-4 w-4" />}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {state.building && (
          <div data-testid="maps-regions-progress">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-[var(--text)]">
                {stepText(state.step)}
                {state.detail ? `: ${state.detail}` : ""}
              </span>
              {state.step_number != null && state.steps_total != null && (
                <span className="shrink-0 text-xs text-[var(--text-muted)]">
                  Step {state.step_number} of {state.steps_total}
                </span>
              )}
            </div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--hover)]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? 0} aria-label="Map build progress">
              <div className="h-full rounded-full bg-[var(--accent-strong)] transition-all" style={{ width: `${Math.max(4, percent ?? 4)}%` }} />
            </div>
            <p className="mt-1.5 text-xs text-[var(--text-muted)]">
              {state.ready ? "Your current maps keep working until this is ready." : "It carries on by itself: you can close this page."}
            </p>
          </div>
        )}

        {state.failed && (
          <div role="alert" className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-[var(--text)]">The map build stopped</p>
              <p className="text-xs text-[var(--text-muted)]">
                It stopped while {stepText(state.step).toLowerCase()}, often because a download was interrupted. {state.ready ? "Your current maps stay in use. " : ""}It&apos;s tried again by itself later, or you can try now.
              </p>
            </div>
            <Button size="sm" onClick={() => void run(() => mapRegionsApi.retry(), "Couldn't start it again.")} disabled={busy}>
              Try again
            </Button>
          </div>
        )}

        {state.disk && state.disk.free_bytes != null && (
          <p className="text-xs text-[var(--text-muted)]" data-testid="maps-regions-disk">
            {state.disk.maps_bytes > 0 ? `Your maps use ${sizeText(state.disk.maps_bytes)}. ` : ""}
            {sizeText(state.disk.free_bytes)} free on this server.
          </p>
        )}

        {env ? (
          <p className="text-xs text-[var(--text-muted)]" data-testid="maps-regions-env">
            This server&apos;s map is set in its .env file (MAPS_PBF_URL, MAPS_PHOTON_URL, MAPS_BBOX), so it can&apos;t be changed here. Take those lines out and restart to choose maps on this page.
          </p>
        ) : adding ? (
          <div className="space-y-3 rounded-input border border-[var(--border)] p-3">
            <MapRegionPicker value={picked} onChange={setPicked} installed={kept.map((r) => r.id)} onEstimate={setEstimate} />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  setAdding(false);
                  setPicked([]);
                  setError(null);
                }}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void add()} loading={busy} disabled={!picked.length || estimate?.fits === false} data-testid="maps-regions-confirm">
                {picked.length > 1 ? `Download ${picked.length} maps` : "Download this map"}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant={kept.length ? "secondary" : "primary"} onClick={() => setAdding(true)} leftIcon={<Plus className="h-4 w-4" />} data-testid="maps-regions-add">
            {kept.length ? "Add another map" : "Choose a map"}
          </Button>
        )}

        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400" data-testid="maps-regions-error">
            {error}
          </p>
        )}

        <p className="text-xs text-[var(--text-muted)]">
          Maps come from OpenStreetMap and are downloaded once, then refreshed about once a month. Searches, directions and where people are never leave this server.
        </p>
      </div>
    </SettingsCard>
  );
}
