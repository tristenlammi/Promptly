import { useEffect, useMemo, useState } from "react";

import type { ItemHandle } from "@/items/useItem";
import { Chip, Field, ItemButton, Segmented, Sheet, Stepper, TextInput } from "@/items/ui";

import { Badge, Callout, DeleteButton, ScalePicker, WhenInput, blankReading, insertReading, round } from "./common";
import {
  GLUCOSE_CONTEXTS,
  bpCategory,
  dailySeries,
  displayDecimals,
  displayStep,
  fmtHours,
  fmtMetric,
  fromDisplay,
  glucoseBand,
  metricDef,
  momentAt,
  spo2Band,
  toDisplay,
  unitLabel,
} from "./metrics";
import type { GlucoseContext, HealthData, Reading } from "./types";
import { nowISO, todayISO } from "./zone";

/** Where a stepper starts before anything is logged (canonical units). */
const STARTS: Record<string, number> = {
  weight: 70, body_fat: 25, waist: 85, hip: 100, chest: 100, arm: 32, thigh: 55, resting_hr: 65,
  glucose: 5.5, steps: 6000, temperature: 36.8, spo2: 98,
};

/**
 * Log (or edit) one reading. One sheet for every metric, shaped to it:
 * steppers for numbers, sys/dia/pulse for blood pressure, bed/wake for
 * sleep, faces for mood/energy, quick-add amounts for water.
 */
export function LogSheet({
  item,
  metric,
  editing,
  onClose,
}: {
  item: ItemHandle<HealthData>;
  metric: string | null;
  editing?: Reading | null;
  onClose: () => void;
}) {
  const data = item.data;
  const s = data.settings;
  const def = metric ? metricDef(data, metric) : null;
  const rows = useMemo(() => data.readings.filter((r) => r.metric === metric), [data.readings, metric]);
  const last = rows[rows.length - 1];

  const [at, setAt] = useState(nowISO());
  const [value, setValue] = useState<number>(0);
  const [sys, setSys] = useState(120);
  const [dia, setDia] = useState(80);
  const [pulse, setPulse] = useState<number | null>(null);
  const [arm, setArm] = useState<"left" | "right" | "">("");
  const [position, setPosition] = useState<"sitting" | "standing" | "lying" | "">("sitting");
  const [context, setContext] = useState<GlucoseContext | "">("");
  const [bed, setBed] = useState("23:00");
  const [wake, setWake] = useState("07:00");
  const [wakeDay, setWakeDay] = useState(todayISO());
  const [quality, setQuality] = useState<number | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!metric || !def) return;
    const src = editing ?? null;
    setAt(src?.at ?? nowISO());
    setNote(src?.note ?? "");
    if (def.kind === "bp") {
      const ref = src ?? last;
      setSys(ref?.sys ?? 120);
      setDia(ref?.dia ?? 80);
      setPulse(src ? src.pulse : (last?.pulse ?? null));
      setArm(src?.arm ?? last?.arm ?? "");
      setPosition(src?.position ?? last?.position ?? "sitting");
    } else if (def.kind === "sleep") {
      const ref = src ?? last;
      setBed(ref?.bed ? ref.bed.slice(11, 16) : "23:00");
      setWake(src ? src.at.slice(11, 16) : (ref?.at.slice(11, 16) ?? "07:00"));
      setWakeDay(src ? src.at.slice(0, 10) : todayISO());
      setQuality(src?.quality ?? null);
    } else if (def.kind === "scale") {
      setValue(src?.value ?? 0);
    } else {
      const v = src?.value ?? (def.kind === "water" ? null : last?.value) ?? (def.kind === "water" ? 250 : (STARTS[def.id] ?? null));
      setValue(v === null ? 0 : round(toDisplay(v, def.dim, s), displayDecimals(def, s)));
      setContext(src?.context ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metric, editing?.id]);

  if (!metric || !def) return null;
  const unit = unitLabel(def, s);
  const cat = def.kind === "bp" ? bpCategory(sys, dia) : null;

  const sleepHours = (() => {
    const w = new Date(momentAt(wakeDay, wake)).getTime();
    let b = new Date(momentAt(wakeDay, bed)).getTime();
    if (b >= w) b -= 86_400_000;
    return (w - b) / 3_600_000;
  })();
  const bedISO = (() => {
    const w = momentAt(wakeDay, wake);
    const sameDay = momentAt(wakeDay, bed);
    if (new Date(sameDay).getTime() < new Date(w).getTime()) return sameDay;
    const prev = new Date(`${wakeDay}T12:00:00`);
    prev.setDate(prev.getDate() - 1);
    const pd = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}-${String(prev.getDate()).padStart(2, "0")}`;
    return momentAt(pd, bed);
  })();

  const valid =
    def.kind === "bp"
      ? sys > dia
      : def.kind === "sleep"
        ? sleepHours > 0 && sleepHours <= 24
        : def.kind === "scale"
          ? value >= 1 && value <= 5
          : Number.isFinite(value) && fromDisplay(value, def.dim, s) >= def.lo && fromDisplay(value, def.dim, s) <= def.hi;

  const build = (): Omit<Reading, "id"> => {
    const r = blankReading(metric, at);
    r.note = note.trim();
    if (def.kind === "bp") Object.assign(r, { sys, dia, pulse, arm: arm || null, position: position || null });
    else if (def.kind === "sleep") Object.assign(r, { at: momentAt(wakeDay, wake), bed: bedISO, value: round(sleepHours, 2), quality });
    else if (def.kind === "scale") r.value = value;
    else {
      r.value = round(fromDisplay(value, def.dim, s), 4);
      if (metric === "glucose") r.context = context || null;
    }
    return r;
  };

  const save = (override?: Partial<Reading>) => {
    const r = { ...build(), ...override };
    item.update((d) => {
      if (editing) {
        const i = d.readings.findIndex((x) => x.id === editing.id);
        if (i >= 0) d.readings.splice(i, 1);
        insertReading(d, { ...r, id: editing.id });
      } else insertReading(d, r);
    });
    onClose();
  };

  const todayWater = def.kind === "water" ? (dailySeries(rows, "water", "sum", todayISO(), todayISO())[0]?.v ?? 0) : 0;
  const quick = s.water_unit === "oz" ? [8, 12, 16, 24] : [150, 250, 500, 750];

  return (
    <Sheet
      open
      onClose={onClose}
      title={`${editing ? "Edit" : "Log"} ${def.label.toLowerCase()}`}
      footer={
        <>
          {editing && (
            <DeleteButton
              onDelete={() => {
                item.update((d) => {
                  d.readings = d.readings.filter((x) => x.id !== editing.id);
                });
                onClose();
              }}
            />
          )}
          <ItemButton variant="primary" block disabled={!valid || !item.canEdit} onClick={() => save()}>
            {editing ? "Save" : "Log it"}
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {def.kind === "bp" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Stepper label="Systolic" value={sys} onChange={setSys} min={40} max={320} />
              <Stepper label="Diastolic" value={dia} onChange={setDia} min={20} max={220} />
            </div>
            <Stepper label="Pulse (optional)" value={pulse ?? 0} onChange={(v) => setPulse(v || null)} min={0} max={260} unit="bpm" />
            <div className="flex items-center gap-2" aria-live="polite">
              {cat && <Badge color={cat.color}>{cat.label}</Badge>}
              {sys <= dia && <span className="text-xs text-[var(--danger)]">Systolic should be the higher number.</span>}
            </div>
            {cat?.id === "crisis" && (
              <Callout tone="danger" title="This is in the hypertensive-crisis range">
                {cat.advice}
              </Callout>
            )}
            <Field label="Arm">
              <Segmented
                value={arm || "none"}
                onChange={(v) => setArm(v === "none" ? "" : (v as "left" | "right"))}
                options={[
                  { value: "none", label: "—" },
                  { value: "left", label: "Left" },
                  { value: "right", label: "Right" },
                ]}
              />
            </Field>
            <Field label="Position">
              <Segmented
                value={position || "sitting"}
                onChange={(v) => setPosition(v as "sitting")}
                options={[
                  { value: "sitting", label: "Sitting" },
                  { value: "standing", label: "Standing" },
                  { value: "lying", label: "Lying" },
                ]}
              />
            </Field>
          </>
        )}

        {def.kind === "sleep" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Went to bed">
                <TextInput type="time" value={bed} onChange={(e) => setBed(e.target.value || "23:00")} />
              </Field>
              <Field label="Woke up">
                <TextInput type="time" value={wake} onChange={(e) => setWake(e.target.value || "07:00")} />
              </Field>
            </div>
            <Field label="Woke on">
              <TextInput type="date" value={wakeDay} max={todayISO()} onChange={(e) => e.target.value && setWakeDay(e.target.value)} />
            </Field>
            <p className="text-center text-2xl font-semibold tabular-nums text-[var(--text)]" aria-live="polite">
              {sleepHours > 0 && sleepHours <= 24 ? fmtHours(sleepHours) : "Check the times"}
            </p>
            <Field label="How did you sleep?">
              <ScalePicker label="Sleep quality" value={quality} onChange={setQuality} words={["Awful", "Poor", "Okay", "Good", "Great"]} />
            </Field>
          </>
        )}

        {def.kind === "scale" && (
          <ScalePicker
            label={def.label}
            value={value || null}
            onChange={(v) => {
              setValue(v);
              if (!editing && item.canEdit) save({ value: v });
            }}
          />
        )}

        {def.kind === "water" && (
          <>
            <p className="text-center text-sm text-[var(--text-muted)]">
              Today so far: <span className="font-semibold tabular-nums text-[var(--text)]">{fmtMetric(def, todayWater, s)}</span>
            </p>
            {!editing && (
              <div className="grid grid-cols-4 gap-2">
                {quick.map((q) => (
                  <ItemButton key={q} size="lg" onClick={() => save({ value: round(fromDisplay(q, "water", s), 2) })} disabled={!item.canEdit}>
                    +{q}
                  </ItemButton>
                ))}
              </div>
            )}
            <Stepper label={`Amount (${unit})`} value={value} onChange={setValue} step={displayStep(def, s)} min={0} max={s.water_unit === "oz" ? 300 : 10000} />
          </>
        )}

        {def.kind === "number" && (
          <>
            <Stepper
              label={`${def.label}${unit ? ` (${unit})` : ""}`}
              value={value}
              onChange={setValue}
              step={displayStep(def, s)}
              min={def.custom ? -1e6 : Math.floor(toDisplay(def.lo, def.dim, s))}
              max={def.custom ? 1e7 : Math.ceil(toDisplay(def.hi, def.dim, s))}
              decimals={displayDecimals(def, s)}
            />
            {last && !editing && (
              <p className="text-xs text-[var(--text-muted)]">
                Last: <span className="tabular-nums">{fmtMetric(def, last.value, s)}</span> · {last.at.slice(0, 10)}
              </p>
            )}
            {metric === "spo2" && Number.isFinite(value) && value > 0 && (
              <div aria-live="polite">
                {(() => {
                  const b = spo2Band(value);
                  return (
                    <>
                      <Badge color={b.color}>{b.label}</Badge>
                      {b.advice && <p className="mt-1 text-xs text-[var(--text-muted)]">{b.advice}</p>}
                    </>
                  );
                })()}
              </div>
            )}
            {metric === "glucose" && (
              <>
                <Field label="When was it taken?">
                  <div className="flex flex-wrap gap-2">
                    {GLUCOSE_CONTEXTS.map((c) => (
                      <Chip key={c.value} active={context === c.value} onClick={() => setContext(context === c.value ? "" : (c.value as GlucoseContext))}>
                        {c.label}
                      </Chip>
                    ))}
                  </div>
                </Field>
                {Number.isFinite(value) && value > 0 && (
                  <div aria-live="polite">
                    {(() => {
                      const b = glucoseBand(fromDisplay(value, "glucose", s), context || null, s.glucose_unit);
                      return (
                        <>
                          <Badge color={b.color}>{b.label}</Badge>
                          {b.advice && <p className="mt-1 text-xs text-[var(--text-muted)]">{b.advice}</p>}
                        </>
                      );
                    })()}
                  </div>
                )}
              </>
            )}
          </>
        )}

        {def.kind !== "sleep" && def.kind !== "scale" && <WhenInput value={at} onChange={setAt} />}
        {def.kind === "scale" && editing && <WhenInput value={at} onChange={setAt} />}
        <Field label="Note (optional)">
          <TextInput value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder={def.kind === "bp" ? "After coffee, stressed…" : "Anything worth remembering"} />
        </Field>
      </div>
    </Sheet>
  );
}
