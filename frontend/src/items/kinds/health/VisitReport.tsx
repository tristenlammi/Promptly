import { Download, Printer, Sparkles } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { ItemHandle } from "@/items/useItem";
import { Chip, Field, ItemButton, Select, Sheet, TextInput, Toggle, addDays, daysBetween, fmtDay } from "@/items/ui";

import { adherenceBetween, doseRowsBetween } from "./reportData";
import { ageYears, allMetrics, bpCategory, dailySeries, fmtMetric, indexReadings, metricDef, unitLabel, toDisplay, glucoseShown, type MetricDef } from "./metrics";
import { isActiveOn, scheduleText, slotDose } from "./meds";
import type { Appointment, HealthData, Reading } from "./types";
import { todayISO } from "./zone";

/*
 * "Prepare for my next visit": a clean, printable one-page report of a date
 * range (window.print with print CSS scoped to this view — only the report
 * prints) and a CSV of the raw readings, doses, symptoms and labs for the
 * same range. Everything is computed on the device, so it works offline.
 */

type Section = "all" | "readings" | "doses" | "symptoms" | "labs";

const PRINT_CSS = `
.hp-print-root { display: none; }
@media print {
  @page { margin: 14mm; }
  body > *:not(.hp-print-root) { display: none !important; }
  html, body { background: #fff !important; overflow: visible !important; height: auto !important; }
  .hp-print-root { display: block !important; color: #111; background: #fff; font: 11pt/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .hp-print-root h1 { font-size: 16pt; margin: 0 0 2mm; }
  .hp-print-root h2 { font-size: 12pt; margin: 5mm 0 1.5mm; border-bottom: 1px solid #999; padding-bottom: 1mm; break-after: avoid; }
  .hp-print-root table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  .hp-print-root th, .hp-print-root td { text-align: left; padding: 1mm 1.5mm; border-bottom: 1px solid #ddd; vertical-align: top; }
  .hp-print-root tr { break-inside: avoid; }
  .hp-print-root .hp-muted { color: #555; }
  .hp-print-root .hp-flag { font-weight: 700; }
}
`;

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  // Spreadsheet formula injection: a cell starting with = + - @ is text.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function download(name: string, text: string) {
  const blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readingValue(r: Reading, def: MetricDef | null, data: HealthData): { value: string; unit: string; detail: string } {
  const s = data.settings;
  if (r.metric === "bp") {
    const bits = [r.pulse ? `pulse ${r.pulse}` : "", r.arm ? `${r.arm} arm` : "", r.position ?? ""].filter(Boolean);
    return { value: `${r.sys}/${r.dia}`, unit: "mmHg", detail: [bpCategory(r.sys, r.dia)?.label ?? "", ...bits].filter(Boolean).join("; ") };
  }
  if (!def || r.value === null) return { value: r.quality ? `quality ${r.quality}/5` : "", unit: "", detail: "" };
  if (r.metric === "sleep") return { value: String(Math.round(r.value * 100) / 100), unit: "h", detail: [r.bed ? `bed ${r.bed.slice(11, 16)}` : "", r.quality ? `quality ${r.quality}/5` : ""].filter(Boolean).join("; ") };
  const unit = unitLabel(def, s);
  const v = def.dim === "glucose" ? glucoseShown(r.value, s.glucose_unit) : Math.round(toDisplay(r.value, def.dim, s) * 100) / 100;
  return { value: String(v), unit: unit === "/5" ? "/5" : unit, detail: r.context ? r.context.replace("_", " ") : "" };
}

export function buildCsv(data: HealthData, from: string, to: string, section: Section, notes: boolean): string {
  const rows: unknown[][] = [["section", "date", "time", "item", "value", "unit", "details", ...(notes ? ["note"] : [])]];
  const inRange = (day: string) => day >= from && day <= to;
  if (section === "all" || section === "readings")
    for (const r of data.readings) {
      if (!inRange(r.at.slice(0, 10))) continue;
      const def = metricDef(data, r.metric);
      const v = readingValue(r, def, data);
      rows.push(["reading", r.at.slice(0, 10), r.at.slice(11, 16), def?.label ?? r.metric, v.value, v.unit, v.detail, ...(notes ? [r.note] : [])]);
    }
  if (section === "all" || section === "doses")
    for (const d of doseRowsBetween(data, from, to))
      rows.push(["dose", d.day, d.slot ?? "", d.med, d.status, d.dose, d.takenAt ? `taken ${d.takenAt}` : d.slot === null ? "as needed" : "", ...(notes ? [d.note] : [])]);
  if (section === "all" || section === "symptoms")
    for (const x of data.symptoms) {
      if (!inRange(x.at.slice(0, 10))) continue;
      rows.push(["symptom", x.at.slice(0, 10), x.at.slice(11, 16), x.name, x.severity, "/10", x.tags.join("; "), ...(notes ? [x.note] : [])]);
    }
  if (section === "all" || section === "labs")
    for (const l of data.labs) {
      if (!inRange(l.day)) continue;
      const ref = l.ref_low !== null || l.ref_high !== null ? `ref ${l.ref_low ?? ""}–${l.ref_high ?? ""}` : "";
      rows.push(["lab", l.day, "", l.test, l.value ?? l.value_text, l.unit, [ref, l.flag && l.flag !== "normal" ? l.flag.toUpperCase() : "", l.panel].filter(Boolean).join("; "), ...(notes ? [l.note] : [])]);
    }
  const head = rows[0];
  const body = rows.slice(1).sort((a, b) => (`${a[1]}${a[2]}` < `${b[1]}${b[2]}` ? -1 : 1));
  return [head, ...body].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

interface ReportModel {
  from: string;
  to: string;
  about: { label: string; value: string }[];
  meds: { name: string; dose: string; schedule: string; since: string; adherence: string; purpose: string; active: boolean }[];
  metrics: { label: string; n: number; avg: string; range: string; latest: string; note: string }[];
  symptoms: { name: string; times: number; avg: string; worst: number; last: string; tags: string }[];
  labs: { day: string; test: string; value: string; ref: string; flag: string }[];
  questions: string[];
  appt: Appointment | null;
}

function buildReport(data: HealthData, from: string, to: string): ReportModel {
  const s = data.settings;
  const p = data.profile;
  const today = todayISO();
  const about: ReportModel["about"] = [];
  const age = ageYears(p.birth_date, today);
  if (age !== null) about.push({ label: "Age", value: String(age) });
  if (p.sex !== "unspecified") about.push({ label: "Sex", value: p.sex });
  if (p.height_cm) about.push({ label: "Height", value: s.length_unit === "in" ? `${Math.round(p.height_cm / 2.54)} in` : `${p.height_cm} cm` });
  if (p.blood_type) about.push({ label: "Blood type", value: p.blood_type });
  about.push({ label: "Conditions", value: p.conditions.join(", ") || "None recorded" });
  about.push({ label: "Allergies", value: p.allergies.join(", ") || "None recorded" });

  const adh = adherenceBetween(data, from, to);
  const meds = data.medications
    .filter((m) => isActiveOn(m, to) || (m.end !== null && m.end >= from))
    .map((m) => {
      const day = m.end && m.end < to ? m.end : to;
      const a = adh.get(m.id);
      return {
        name: m.name,
        dose: slotDose(m, day, null),
        schedule: scheduleText(m, day),
        since: m.start ?? "",
        adherence: a && a.due ? `${Math.round((100 * a.ok) / a.due)}% (${a.ok}/${a.due})` : "—",
        purpose: m.purpose,
        active: m.active && (!m.end || m.end >= today),
      };
    });

  const idx = indexReadings(data.readings);
  const metrics: ReportModel["metrics"] = [];
  for (const def of allMetrics(data)) {
    const rows = idx[def.id];
    if (!rows?.length) continue;
    if (def.kind === "bp") {
      const inR = rows.filter((r) => r.at.slice(0, 10) >= from && r.at.slice(0, 10) <= to && r.sys !== null && r.dia !== null);
      if (!inR.length) continue;
      const sys = Math.round(inR.reduce((a, r) => a + (r.sys ?? 0), 0) / inR.length);
      const dia = Math.round(inR.reduce((a, r) => a + (r.dia ?? 0), 0) / inR.length);
      const last = inR[inR.length - 1];
      const highs = inR.filter((r) => bpCategory(r.sys, r.dia)?.id === "crisis").length;
      metrics.push({
        label: "Blood pressure",
        n: inR.length,
        avg: `${sys}/${dia} mmHg`,
        range: `${Math.min(...inR.map((r) => r.sys ?? 0))}–${Math.max(...inR.map((r) => r.sys ?? 0))} systolic`,
        latest: `${last.sys}/${last.dia} (${fmtDay(last.at.slice(0, 10))})`,
        note: [`Average: ${bpCategory(sys, dia)?.label ?? ""} (AHA)`, highs ? `${highs} reading${highs > 1 ? "s" : ""} in the crisis range` : ""].filter(Boolean).join(" · "),
      });
      continue;
    }
    const series = dailySeries(rows, def.id, def.agg, from, to);
    if (!series.length) continue;
    const vals = series.map((x) => x.v);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const last = series[series.length - 1];
    let note = "";
    if (def.id === "glucose") {
      const byCtx = new Map<string, number[]>();
      for (const r of rows) {
        if (r.value === null || r.at.slice(0, 10) < from || r.at.slice(0, 10) > to) continue;
        const k = r.context ?? "unspecified";
        const arr = byCtx.get(k) ?? [];
        arr.push(r.value);
        byCtx.set(k, arr);
      }
      note = [...byCtx.entries()].map(([k, v]) => `${k.replace("_", " ")} avg ${fmtMetric(def, v.reduce((a, b) => a + b, 0) / v.length, s)} (${v.length})`).join(" · ");
    }
    metrics.push({
      label: def.label,
      n: series.length,
      avg: fmtMetric(def, avg, s),
      range: `${fmtMetric(def, Math.min(...vals), s)} – ${fmtMetric(def, Math.max(...vals), s)}`,
      latest: `${fmtMetric(def, last.v, s)} (${fmtDay(last.day)})`,
      note,
    });
  }

  type Agg = { name: string; sev: number[]; last: string; tags: Map<string, number> };
  const agg = new Map<string, Agg>();
  for (const x of data.symptoms) {
    const day = x.at.slice(0, 10);
    if (day < from || day > to) continue;
    const k = x.name.trim().toLowerCase();
    const row: Agg = agg.get(k) ?? { name: x.name, sev: [], last: day, tags: new Map<string, number>() };
    row.sev.push(x.severity);
    if (day > row.last) row.last = day;
    for (const t of x.tags) row.tags.set(t, (row.tags.get(t) ?? 0) + 1);
    agg.set(k, row);
  }
  const symptoms = [...agg.values()]
    .map((r) => ({
      name: r.name,
      times: r.sev.length,
      avg: (r.sev.reduce((a, b) => a + b, 0) / r.sev.length).toFixed(1),
      worst: Math.max(...r.sev),
      last: r.last,
      tags: [...r.tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t).join(", "),
    }))
    .sort((a, b) => b.times - a.times)
    .slice(0, 20);

  const flagRank = (f: string) => (f === "critical" ? 0 : f && f !== "normal" ? 1 : 2);
  const labs = data.labs
    .filter((l) => l.day >= from && l.day <= to)
    .map((l) => ({
      day: l.day,
      test: l.test,
      value: `${l.value ?? l.value_text} ${l.unit}`.trim(),
      ref: l.ref_low !== null || l.ref_high !== null ? `${l.ref_low ?? ""}–${l.ref_high ?? ""}` : "",
      flag: l.flag && l.flag !== "normal" ? l.flag.toUpperCase() : "",
    }))
    .sort((a, b) => flagRank(a.flag.toLowerCase()) - flagRank(b.flag.toLowerCase()) || (a.day < b.day ? 1 : -1));

  const appt = data.appointments.find((a) => !a.done && a.at.slice(0, 10) >= today) ?? null;
  return { from, to, about, meds, metrics, symptoms, labs, questions: appt?.questions ?? [], appt };
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} className="border-b border-[var(--border)] px-2 py-1.5 text-xs font-semibold text-[var(--text-muted)]">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className="border-b border-[var(--border)] px-2 py-1.5 align-top tabular-nums text-[var(--text)]">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function H2({ children }: { children: ReactNode }) {
  return <h2 className="mt-5 border-b border-[var(--border)] pb-1 text-base font-semibold text-[var(--text)]">{children}</h2>;
}

function Report({ model, title }: { model: ReportModel; title: string }) {
  return (
    <article aria-label="Visit report" className="flex flex-col">
      <h1 className="text-xl font-semibold text-[var(--text)]">{title}</h1>
      <p className="hp-muted text-sm text-[var(--text-muted)]">
        {fmtDay(model.from, { long: true })} – {fmtDay(model.to, { long: true })} · {daysBetween(model.from, model.to) + 1} days · self-recorded in Promptly, printed {todayISO()}
      </p>
      {model.appt && (
        <p className="mt-1 text-sm text-[var(--text)]">
          For: {model.appt.title || "Appointment"} on {model.appt.at.slice(0, 10)} {model.appt.at.slice(11, 16)}
          {model.appt.who ? ` with ${model.appt.who}` : ""}
        </p>
      )}

      <H2>About</H2>
      <Table head={["", ""]} rows={model.about.map((a) => [a.label, a.value])} />

      <H2>Medicines</H2>
      {model.meds.length ? (
        <Table
          head={["Medicine", "Dose", "Schedule", "Since", "Taken as scheduled", "For"]}
          rows={model.meds.map((m) => [m.active ? m.name : `${m.name} (stopped)`, m.dose, m.schedule, m.since, m.adherence, m.purpose])}
        />
      ) : (
        <p className="text-sm text-[var(--text-muted)]">None recorded.</p>
      )}

      <H2>Readings</H2>
      {model.metrics.length ? (
        <Table head={["Measure", "Days", "Average", "Range", "Latest", "Notes"]} rows={model.metrics.map((m) => [m.label, m.n, m.avg, m.range, m.latest, m.note])} />
      ) : (
        <p className="text-sm text-[var(--text-muted)]">Nothing logged in this range.</p>
      )}

      <H2>Symptoms</H2>
      {model.symptoms.length ? (
        <Table head={["Symptom", "Times", "Avg /10", "Worst", "Last", "Often with"]} rows={model.symptoms.map((x) => [x.name, x.times, x.avg, x.worst, x.last, x.tags])} />
      ) : (
        <p className="text-sm text-[var(--text-muted)]">None logged.</p>
      )}

      <H2>Lab results</H2>
      {model.labs.length ? (
        <Table head={["Date", "Test", "Result", "Reference", "Flag"]} rows={model.labs.map((l) => [l.day, l.test, l.value, l.ref, <span className="hp-flag font-semibold">{l.flag}</span>])} />
      ) : (
        <p className="text-sm text-[var(--text-muted)]">None in this range.</p>
      )}

      {model.questions.length > 0 && (
        <>
          <H2>Questions to ask</H2>
          <ol className="list-decimal pl-5 text-sm text-[var(--text)]">
            {model.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ol>
        </>
      )}
      <p className="hp-muted mt-5 text-xs text-[var(--text-muted)]">
        Recorded by the patient at home. Categories use published reference ranges (AHA blood pressure, ADA glucose) for orientation only — not a diagnosis.
      </p>
    </article>
  );
}

const PRESETS = [30, 90, 180, 365];

export function VisitReport({ item, onClose, ask }: { item: ItemHandle<HealthData>; onClose: () => void; ask?: (prompt: string) => void }) {
  const data = item.data;
  const today = todayISO();
  const [from, setFrom] = useState(addDays(today, -89));
  const [to, setTo] = useState(today);
  const [section, setSection] = useState<Section>("all");
  const [notes, setNotes] = useState(false);
  const valid = from <= to;
  const model = useMemo(() => (valid ? buildReport(data, from, to) : null), [data, from, to, valid]);
  const title = "Health summary";

  return (
    <>
      <style>{PRINT_CSS}</style>
      {model && createPortal(<div className="hp-print-root"><Report model={model} title={title} /></div>, document.body)}
      <Sheet
        open
        size="full"
        onClose={onClose}
        title="Prepare for my next visit"
        footer={
          <>
            <ItemButton
              icon={<Download className="h-4 w-4" />}
              disabled={!valid}
              onClick={() => download(`health-${section}-${from}-to-${to}.csv`, buildCsv(data, from, to, section, notes))}
            >
              CSV
            </ItemButton>
            <ItemButton variant="primary" block icon={<Printer className="h-4 w-4" />} disabled={!valid} onClick={() => window.print()}>
              Print or save as PDF
            </ItemButton>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((n) => (
              <Chip
                key={n}
                active={to === today && from === addDays(today, -(n - 1))}
                onClick={() => {
                  setTo(today);
                  setFrom(addDays(today, -(n - 1)));
                }}
              >
                {n === 365 ? "1 year" : `${n} days`}
              </Chip>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Field label="From">
              <TextInput type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
            </Field>
            <Field label="To" hint={!valid ? "Ends before it starts" : undefined}>
              <TextInput type="date" value={to} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} />
            </Field>
            <Field label="CSV contents">
              <Select value={section} onChange={(e) => setSection(e.target.value as Section)}>
                <option value="all">Everything</option>
                <option value="readings">Readings</option>
                <option value="doses">Doses</option>
                <option value="symptoms">Symptoms</option>
                <option value="labs">Labs</option>
              </Select>
            </Field>
            <div className="flex items-end">
              <div className="flex h-11 w-full items-center justify-between rounded-xl border border-[var(--border)] px-3 md:h-10">
                <span className="text-sm text-[var(--text)]">Include my notes</span>
                <Toggle checked={notes} onChange={setNotes} label="Include my notes in the CSV" />
              </div>
            </div>
          </div>
          {ask && (
            <ItemButton
              className="self-start"
              icon={<Sparkles className="h-4 w-4" />}
              onClick={() => {
                onClose();
                ask(`Prepare a one-page summary of ${from} to ${to} for my next visit (doctor_visit_summary), and suggest questions to add to it.`);
              }}
            >
              Ask the assistant for questions to bring
            </ItemButton>
          )}
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 md:p-6">{model ? <Report model={model} title={title} /> : null}</div>
        </div>
      </Sheet>
    </>
  );
}
