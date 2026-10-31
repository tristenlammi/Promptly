import { Archive as ArchiveIcon } from "lucide-react";
import { useState } from "react";

import { extractError } from "@/components/files/helpers";
import { itemsApi } from "@/items/api";
import type { ItemHandle } from "@/items/useItem";
import { Card, Field, ItemButton, TextInput, fmtDay, todayISO } from "@/items/ui";
import { toast } from "@/store/toastStore";

import { MAX_WORKOUTS } from "./science";
import type { WorkoutData } from "./types";

/** Warn this close to the workout cap. The shell's "N% full" banner only
 *  looks at bytes, and a compact file reaches the 2,500-workout cap first. */
const WARN_AT = MAX_WORKOUTS - 200;

export const nearlyFull = (d: WorkoutData) => d.workouts.length >= WARN_AT;

/** "This file is nearly full" + archive older workouts into a new file
 *  (the framework's archive: settings, routines, programs, custom exercises
 *  and the plan stay; the archive file reads on its own). */
export function ArchiveCard({ item }: { item: ItemHandle<WorkoutData> }) {
  const ws = item.data.workouts;
  const full = ws.length >= MAX_WORKOUTS;
  // Default: archive the older half, cut at a whole month.
  const mid = ws[Math.floor(ws.length / 2)]?.date ?? todayISO();
  const [before, setBefore] = useState(`${mid.slice(0, 7)}-01`);
  const [busy, setBusy] = useState(false);
  const moving = ws.filter((w) => w.date < before).length;

  const run = async () => {
    if (!moving) return;
    setBusy(true);
    try {
      const res = await itemsApi.archive<WorkoutData>(item.fileId, before);
      item.accept(res.data, res.revision);
      toast.success(`Moved ${moving.toLocaleString()} workouts to an archive file next to this one.`);
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="flex flex-col gap-3 border-[color-mix(in_srgb,var(--warning)_45%,var(--border))]" as="section">
      <div className="flex items-start gap-3">
        <ArchiveIcon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--warning)]" aria-hidden />
        <p className="min-w-0 flex-1 text-sm text-[var(--text)]">
          {full ? (
            <>
              <b>This file is full</b> ({MAX_WORKOUTS.toLocaleString()} workouts), so new workouts can't be saved. Archive older ones to make room — they move to a new Workout file and stay searchable.
            </>
          ) : (
            <>
              <b>Nearly full:</b> {ws.length.toLocaleString()} of {MAX_WORKOUTS.toLocaleString()} workouts. Archive older ones into a new file to keep logging here.
            </>
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Archive workouts before" className="min-w-[10rem] flex-1">
          <TextInput type="date" value={before} onChange={(e) => /^\d{4}-\d{2}-\d{2}$/.test(e.target.value) && setBefore(e.target.value)} />
        </Field>
        <ItemButton variant="primary" disabled={busy || !moving || !item.connected} onClick={() => void run()}>
          {busy ? "Archiving…" : `Archive ${moving.toLocaleString()}`}
        </ItemButton>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        {item.connected ? `Moves every workout before ${fmtDay(before)}.` : "Archiving needs a connection — your workouts are safe on this device meanwhile."}
      </p>
    </Card>
  );
}
