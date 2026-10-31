import { addDays } from "@/items/ui";

import { doseIndex, slotDose, slotsFor } from "./meds";
import type { HealthData } from "./types";

/* Dose numbers for a date range (the visit report and its CSV). */

export interface DoseRow {
  day: string;
  slot: string | null;
  med: string;
  dose: string;
  status: "taken" | "late" | "skipped" | "missed" | "not yet";
  takenAt: string;
  note: string;
}

/** Every scheduled slot in [from, to] with its state (missed included),
 *  plus each as-needed dose taken. */
export function doseRowsBetween(data: HealthData, from: string, to: string, now = Date.now()): DoseRow[] {
  const idx = doseIndex(data.doses);
  const out: DoseRow[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    for (const s of slotsFor(data, day, now, idx)) {
      out.push({
        day,
        slot: s.time,
        med: s.med.name,
        dose: s.dose,
        status: s.state === "due" || s.state === "upcoming" ? "not yet" : s.state,
        takenAt: s.record?.at && s.state !== "skipped" ? s.record.at.slice(11, 16) : "",
        note: s.record?.note ?? "",
      });
    }
  }
  const names = new Map(data.medications.map((m) => [m.id, m]));
  for (const d of data.doses) {
    if (d.slot !== null || d.day < from || d.day > to) continue;
    const m = names.get(d.med_id);
    out.push({
      day: d.day,
      slot: null,
      med: m?.name ?? d.med_id,
      dose: m ? slotDose(m, d.day, null) : "",
      status: d.status,
      takenAt: d.at ? d.at.slice(11, 16) : "",
      note: d.note,
    });
  }
  return out.sort((a, b) => (a.day + (a.slot ?? a.takenAt) < b.day + (b.slot ?? b.takenAt) ? -1 : 1));
}

/** Per medicine: counted scheduled doses (past their grace) and taken ones. */
export function adherenceBetween(data: HealthData, from: string, to: string, now = Date.now()): Map<string, { due: number; ok: number }> {
  const idx = doseIndex(data.doses);
  const out = new Map<string, { due: number; ok: number }>();
  for (let day = from; day <= to; day = addDays(day, 1)) {
    for (const s of slotsFor(data, day, now, idx)) {
      if (s.state === "due" || s.state === "upcoming") continue;
      const row = out.get(s.med.id) ?? { due: 0, ok: 0 };
      row.due += 1;
      if (s.state === "taken" || s.state === "late") row.ok += 1;
      out.set(s.med.id, row);
    }
  }
  return out;
}
