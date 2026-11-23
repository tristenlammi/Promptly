import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Map as MapIcon } from "lucide-react";

import { Button } from "@/components/shared/Button";
import { MapRegionPicker, mapRegionsApi, stepText, useMapRegionsState, type MapRegionEstimate } from "@/maps/regions";
import { MAP_REGIONS_STATE_KEY } from "@/maps/regions/api";
import { apiErrorMessage } from "@/utils/apiError";

/**
 * Which countries' maps this server keeps. Nothing is downloaded until one
 * is chosen here (or later in Admin → App settings → Maps on this server):
 * the size, the disk space and the time are shown first, and a choice that
 * doesn't fit on the disk can't be started. "Not now" leaves Maps empty.
 *
 * The wizard leaves this step out when the server has no maps service or its
 * map is set in ``.env`` (``SetupOutside.maps.can_choose``); opened anyway,
 * it says so and moves on.
 */
export function MapsStep({ onDone, doneLabel = "Continue" }: { onDone: () => void; doneLabel?: string }) {
  const { data: state, isLoading, isError } = useMapRegionsState();
  const client = useQueryClient();
  const [picked, setPicked] = useState<string[]>([]);
  const [estimate, setEstimate] = useState<MapRegionEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isLoading) {
    return <div className="py-6 text-center text-xs text-[var(--text-muted)]">Checking Maps…</div>;
  }

  if (isError || !state || !state.available || state.managed === "env") {
    return (
      <div className="space-y-3" data-testid="maps-step">
        <p className="rounded-card border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-xs leading-relaxed text-[var(--text-muted)]" data-testid="maps-step-nothing">
          {state?.available && state.managed === "env"
            ? "Your map is set in .env (MAPS_PBF_URL, MAPS_PHOTON_URL, MAPS_BBOX), so there's nothing to choose here."
            : "Maps isn't running on this server, so there's no map to choose."}
        </p>
        <Button type="button" variant="primary" className="w-full" onClick={onDone}>
          {doneLabel}
        </Button>
      </div>
    );
  }

  const kept = state.regions.filter((r) => r.state !== "removing");
  const percent = state.progress != null ? Math.round(state.progress * 100) : null;

  const start = async () => {
    if (!picked.length) return;
    setError(null);
    setBusy(true);
    try {
      const next = kept.length ? await mapRegionsApi.add(picked) : await mapRegionsApi.choose(picked);
      client.setQueryData(MAP_REGIONS_STATE_KEY, next);
      void client.invalidateQueries({ queryKey: ["setup-checklist"] });
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't start the download."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="maps-step">
      <div className="flex items-start gap-2.5 rounded-card border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-xs leading-relaxed text-[var(--text-muted)]">
        <MapIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-text)]" aria-hidden />
        <div>
          Maps keeps the whole map on this server, so searches and directions stay private. Choose the country you live in,
          and any others you want. Nothing is downloaded until you say so, and you can add or remove countries later in
          Admin.
        </div>
      </div>

      {kept.length > 0 && (
        <div className="rounded-card border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--text-muted)]" data-testid="maps-step-chosen">
          <span className="font-medium text-[var(--text)]">{kept.map((r) => r.name).join(", ")}</span>{" "}
          {state.failed
            ? "stopped part-way and will be tried again."
            : state.building
              ? `${kept.length > 1 ? "are" : "is"} being put together in the background (${stepText(state.step).toLowerCase()}${percent ? `, about ${percent}% done` : ""}). Everything else works meanwhile.`
              : kept.every((r) => r.state === "installed")
                ? `${kept.length > 1 ? "are" : "is"} ready.`
                : "will start downloading in a moment."}
        </div>
      )}

      <MapRegionPicker value={picked} onChange={setPicked} installed={kept.map((r) => r.id)} pending={kept.filter((r) => r.state !== "installed").map((r) => r.id)} onEstimate={setEstimate} listHeight="14rem" />

      {error && (
        <div role="alert" className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {picked.length > 0 && (
        <Button
          type="button"
          variant="primary"
          className="w-full"
          onClick={() => void start()}
          loading={busy}
          disabled={estimate?.fits === false}
          data-testid="maps-step-download"
        >
          {picked.length > 1 ? `Download ${picked.length} maps and continue` : "Download this map and continue"}
        </Button>
      )}

      {kept.length > 0 ? (
        <Button type="button" variant={picked.length ? "secondary" : "primary"} className="w-full" onClick={onDone} disabled={busy} data-testid="maps-step-continue">
          {picked.length ? "Continue without adding" : doneLabel}
        </Button>
      ) : (
        <button
          type="button"
          onClick={onDone}
          disabled={busy}
          data-testid="maps-step-skip"
          className="w-full text-center text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          Not now (Maps stays empty until you choose one)
        </button>
      )}
    </div>
  );
}
