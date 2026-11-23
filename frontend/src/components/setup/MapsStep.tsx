import { useEffect, useMemo, useState } from "react";
import { Map as MapIcon } from "lucide-react";

import { Button } from "@/components/shared/Button";
import {
  buildTimeWords,
  chooseRegion,
  listRegions,
  regionState,
  type MapRegion,
  type MapRegionState,
} from "@/setup/mapsRegions";
import { apiErrorMessage } from "@/utils/apiError";

/** Can this server offer a choice of map? False when the regions API isn't
 *  there (the step is then left out). */
export async function mapsStepAvailable(): Promise<boolean> {
  try {
    return (await listRegions()) !== null;
  } catch {
    return false;
  }
}

/**
 * Which country Maps downloads. Shows the size and time before anything
 * starts, and "Not now" leaves Maps empty until one is chosen later.
 * If the regions API isn't on this server the step passes straight through.
 */
export function MapsStep({ onDone, doneLabel = "Continue" }: { onDone: () => void; doneLabel?: string }) {
  const [regions, setRegions] = useState<MapRegion[] | null | undefined>(undefined);
  const [state, setState] = useState<MapRegionState | null>(null);
  const [pick, setPick] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([listRegions(), regionState()])
      .then(([r, s]) => {
        if (!alive) return;
        setRegions(r);
        setState(s);
      })
      .catch(() => alive && setRegions(null));
    return () => {
      alive = false;
    };
  }, []);

  // Not on this server: nothing to ask.
  useEffect(() => {
    if (regions === null) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regions]);

  const groups = useMemo(() => {
    const by = new Map<string, MapRegion[]>();
    for (const r of regions ?? []) by.set(r.group ?? "", [...(by.get(r.group ?? "") ?? []), r]);
    return Array.from(by.entries());
  }, [regions]);
  const chosen = (regions ?? []).find((r) => r.id === pick) ?? null;
  const have = (regions ?? []).filter((r) => state?.chosen.includes(r.id));

  const start = async () => {
    if (!chosen) return;
    setError(null);
    setBusy(true);
    try {
      setState(await chooseRegion(chosen.id));
      setConfirming(false);
      setPick("");
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't start the download."));
    } finally {
      setBusy(false);
    }
  };

  if (regions === undefined || regions === null) {
    return <div className="py-6 text-center text-xs text-[var(--text-muted)]">Checking Maps…</div>;
  }

  return (
    <div className="space-y-3" data-testid="maps-step">
      <div className="flex items-start gap-2.5 rounded-card border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-xs leading-relaxed text-[var(--text-muted)]">
        <MapIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-text)]" aria-hidden />
        <div>
          Maps keeps the whole map on this server, so searches and directions stay private. Choose the country to
          download. You can add more later in Admin.
        </div>
      </div>

      {have.length > 0 && (
        <div className="rounded-card border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-xs text-[var(--text-muted)]" data-testid="maps-step-chosen">
          <span className="font-medium text-[var(--text)]">{have.map((r) => r.name).join(", ")}</span>{" "}
          {state?.state === "ready"
            ? "is ready."
            : state?.state === "failed"
              ? "stopped part-way and will be tried again."
              : `is downloading in the background${state?.step ? ` (now: ${state.step})` : ""}. Everything else works meanwhile.`}
        </div>
      )}

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Country</span>
        <select
          value={pick}
          onChange={(e) => {
            setPick(e.target.value);
            setConfirming(false);
          }}
          disabled={busy}
          aria-label="Country"
          className="w-full rounded-card border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
        >
          <option value="">Choose a country…</option>
          {groups.map(([group, rows]) =>
            group ? (
              <optgroup key={group} label={group}>
                {rows.map((r) => (
                  <option key={r.id} value={r.id} disabled={state?.chosen.includes(r.id)}>{r.name}</option>
                ))}
              </optgroup>
            ) : (
              rows.map((r) => (
                <option key={r.id} value={r.id} disabled={state?.chosen.includes(r.id)}>{r.name}</option>
              ))
            ),
          )}
        </select>
      </label>

      {chosen && (
        <div className="rounded-card border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-xs leading-relaxed text-[var(--text-muted)]" data-testid="maps-step-estimate">
          <span className="font-medium text-[var(--text)]">{chosen.name}</span> takes {buildTimeWords(chosen.build_minutes)} to
          download and put together, and needs about {chosen.build_gb} GB of free disk while it does (about {chosen.disk_gb} GB
          afterwards). It happens in the background.
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {chosen && !confirming && (
        <Button type="button" variant="primary" className="w-full" onClick={() => setConfirming(true)}>
          Download {chosen.name}
        </Button>
      )}
      {chosen && confirming && (
        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="flex-1" onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="primary" className="flex-1" onClick={() => void start()} loading={busy}>
            Yes, start the download
          </Button>
        </div>
      )}

      {have.length > 0 ? (
        <Button type="button" variant={chosen ? "secondary" : "primary"} className="w-full" onClick={onDone} disabled={busy}>
          {doneLabel}
        </Button>
      ) : (
        <button
          type="button"
          onClick={onDone}
          disabled={busy}
          className="w-full text-center text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          Not now (Maps stays empty until you choose one)
        </button>
      )}
    </div>
  );
}
