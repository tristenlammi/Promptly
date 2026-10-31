import { useEffect, useState } from "react";

import { ItemButton, Segmented, Sheet, Stepper } from "@/items/ui";

import { LB, barFor, fmtW, fromUnit, platesPerSide, toUnit } from "./science";
import type { Settings } from "./types";

const PLATE_COLORS: Record<string, string> = {
  "25": "#D9506A", "20": "#3B7DD8", "15": "#D9902F", "10": "#4E9F5B", "5": "#8A8F98", "2.5": "#5B5F66", "1.25": "#9AA0A6",
  "45": "#3B7DD8", "35": "#D9902F", "lb25": "#4E9F5B", "lb10": "#8A8F98", "lb5": "#5B5F66", "lb2.5": "#9AA0A6",
};

function plateColor(kg: number, s: Settings): string {
  const v = toUnit(kg, s) ?? 0;
  const key = s.units === "lb" ? (v === 45 || v === 35 ? String(v) : `lb${v}`) : String(v);
  return PLATE_COLORS[key] ?? "var(--text-muted)";
}

/** One side of the bar, drawn. */
export function BarDiagram({ perSide, s }: { perSide: number[]; s: Settings }) {
  const max = Math.max(...s.plates.map((p) => p.kg), 1);
  return (
    <div className="flex h-28 items-center" role="img" aria-label={`Each side: ${perSide.map((p) => fmtW(p, s)).join(", ") || "no plates"}`}>
      <div className="h-3 w-10 rounded-l bg-[var(--text-muted)] opacity-60" />
      <div className="h-8 w-2 rounded-sm bg-[var(--text-muted)]" />
      {perSide.map((p, i) => {
        const h = 36 + (p / max) * 70;
        return (
          <div
            key={i}
            className="mx-[1px] flex items-center justify-center rounded-[4px] text-[9px] font-bold text-white"
            style={{ height: h, width: p / max > 0.5 ? 18 : 12, background: plateColor(p, s) }}
            title={fmtW(p, s)}
          />
        );
      })}
      <div className="h-3 flex-1 rounded-r bg-[var(--text-muted)] opacity-40" />
    </div>
  );
}

export function PlateCalc({ open, onClose, s, initialKg, bar: barKind = "barbell", onUse }: { open: boolean; onClose: () => void; s: Settings; initialKg?: number | null; bar?: string; onUse?: (kg: number) => void }) {
  const [kind, setKind] = useState(barKind);
  const [val, setVal] = useState<number>(toUnit(initialKg ?? barFor(barKind, s) + 40, s) ?? 60);
  useEffect(() => {
    if (open) {
      setVal(toUnit(initialKg ?? barFor(barKind, s) + 40, s) ?? 60);
      setKind(barKind);
    }
  }, [open, initialKg, barKind, s]);
  const bar = barFor(kind, s);
  const kg = fromUnit(val, s);
  const res = platesPerSide(kg, s, bar);
  const step = s.units === "lb" ? 5 : 2.5;
  const counts = new Map<number, number>();
  for (const p of res.perSide) counts.set(p, (counts.get(p) ?? 0) + 1);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Plate calculator"
      footer={
        onUse ? (
          <ItemButton variant="primary" block onClick={() => { onUse(res.loaded); onClose(); }}>
            Use {fmtW(res.loaded, s)}
          </ItemButton>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: "barbell", label: `Bar ${fmtW(s.bar_kg, s)}` },
            { value: "ez_bar", label: `EZ ${fmtW(s.ez_bar_kg, s)}` },
            { value: "trap_bar", label: `Trap ${fmtW(s.trap_bar_kg, s)}` },
          ]}
          size="sm"
        />
        <Stepper label={`Total (${s.units})`} value={val} onChange={setVal} step={step} min={0} max={s.units === "lb" ? 1500 : 700} unit={s.units} />
        <BarDiagram perSide={res.perSide} s={s} />
        <div className="rounded-2xl bg-[var(--surface-2)] p-3 text-sm">
          <div className="mb-1 font-semibold text-[var(--text)]">Each side</div>
          {res.perSide.length ? (
            <ul className="flex flex-wrap gap-2">
              {[...counts.entries()].map(([p, n]) => (
                <li key={p} className="flex items-center gap-1.5 rounded-lg bg-[var(--surface)] px-2 py-1 tabular-nums">
                  <span className="h-3 w-3 rounded-sm" style={{ background: plateColor(p, s) }} />
                  {n} × {fmtW(p, s)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[var(--text-muted)]">Just the bar.</p>
          )}
          {res.remainder > 0.01 && (
            <p className="mt-2 text-xs text-[var(--warning)]">
              Can't make it exactly with your plates — that loads {fmtW(res.loaded, s)} ({fmtW(res.remainder, s)} short).
            </p>
          )}
          {kg < bar - 0.01 && <p className="mt-2 text-xs text-[var(--warning)]">That's lighter than the bar.</p>}
        </div>
        <p className="text-[11px] text-[var(--text-muted)]">
          Plates from your profile ({s.plates.map((p) => fmtW(p.kg, s, false)).join(" / ")} {s.units}). {s.units === "lb" ? `1 lb = ${LB.toFixed(3)} kg.` : ""}
        </p>
      </div>
    </Sheet>
  );
}
