import { cn } from "@/utils/cn";

import { landmark, type Landmark } from "./science";
import type { MuscleInfo } from "./types";

const TONE: Record<Landmark, { label: string; cls: string }> = {
  none: { label: "—", cls: "text-[var(--text-muted)]" },
  below_mev: { label: "Below MEV", cls: "text-[var(--warning)]" },
  productive: { label: "Productive", cls: "text-[var(--text)]" },
  in_mav: { label: "In MAV", cls: "text-[var(--success)]" },
  above_mav: { label: "Above MAV", cls: "text-[var(--warning)]" },
  near_mrv: { label: "Near MRV", cls: "text-[var(--warning)]" },
  above_mrv: { label: "Above MRV", cls: "text-[var(--danger)]" },
};

/** Weekly hard sets per muscle against the RP volume landmarks: the band
 *  shows MEV → MAV → MRV, the bar this week's sets. */
export function VolumeBars({ sets, muscles, compact, only }: { sets: Record<string, number>; muscles: Record<string, MuscleInfo>; compact?: boolean; only?: "trained" | "all" }) {
  const rows = Object.entries(muscles).filter(([m]) => only !== "trained" || (sets[m] ?? 0) > 0);
  if (!rows.length) return <p className="py-4 text-center text-sm text-[var(--text-muted)]">No sets yet this week.</p>;
  return (
    <div className="flex flex-col gap-2" role="list" aria-label="Weekly sets per muscle">
      {rows.map(([m, info]) => {
        const v = Math.round((sets[m] ?? 0) * 10) / 10;
        const max = Math.max(info.mrv + 4, v + 1);
        const pct = (x: number) => `${Math.min(100, (x / max) * 100)}%`;
        const status = landmark(info, v);
        return (
          <div key={m} role="listitem" className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-center gap-2" aria-label={`${info.label}: ${v} sets — ${TONE[status].label}. MEV ${info.mev}, MAV ${info.mav[0]}–${info.mav[1]}, MRV ${info.mrv}.`}>
            <span className="truncate text-xs text-[var(--text)]">{info.label}</span>
            <div className="relative h-3 overflow-hidden rounded-full bg-[var(--surface-2)]">
              {/* MEV→MAV low, MAV, MAV→MRV */}
              <div className="absolute inset-y-0 bg-[color-mix(in_srgb,var(--success)_14%,transparent)]" style={{ left: pct(info.mev), width: `calc(${pct(info.mav[0])} - ${pct(info.mev)})` }} />
              <div className="absolute inset-y-0 bg-[color-mix(in_srgb,var(--success)_30%,transparent)]" style={{ left: pct(info.mav[0]), width: `calc(${pct(info.mav[1])} - ${pct(info.mav[0])})` }} />
              <div className="absolute inset-y-0 bg-[color-mix(in_srgb,var(--warning)_22%,transparent)]" style={{ left: pct(info.mav[1]), width: `calc(${pct(info.mrv)} - ${pct(info.mav[1])})` }} />
              <div className="absolute inset-y-0 w-[2px] bg-[var(--danger)] opacity-70" style={{ left: pct(info.mrv) }} />
              <div className={cn("absolute inset-y-[3px] left-0 rounded-full", status === "above_mrv" ? "bg-[var(--danger)]" : "bg-[var(--item-accent)]")} style={{ width: pct(v) }} />
            </div>
            <span className={cn("w-[4.5rem] text-right text-xs tabular-nums", TONE[status].cls)}>
              {v}
              {!compact && <span className="text-[var(--text-muted)]"> / {info.mav[0]}–{info.mav[1]}</span>}
            </span>
          </div>
        );
      })}
      <p className="pt-1 text-[11px] text-[var(--text-muted)]">
        Hard sets per week (warm-ups excluded, secondary muscles count ½). Shaded: MEV → MAV → MRV — Israetel/RP guidelines; individuals vary.
      </p>
    </div>
  );
}
