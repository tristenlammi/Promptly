import { CalendarClock, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { ItemHandle } from "@/items/useItem";
import { Field, IconButton, ItemButton, Segmented, Select, Sheet, TextInput, Toggle, fmtDay } from "@/items/ui";
import { cn } from "@/utils/cn";

import { DeleteButton, NumberInput } from "./common";
import { WEEKDAYS, changePlan, isCurrent, newMedication, planChanges, planOn, resumeMed, scheduleText, stopMed } from "./meds";
import type { HealthData, Medication, MedForm, Schedule } from "./types";
import { nowISO, todayISO } from "./zone";

type H = ItemHandle<HealthData>;

const FORMS: MedForm[] = ["tablet", "capsule", "liquid", "injection", "inhaler", "drops", "patch", "cream", "powder", "spray", "other"];

interface PlanDraft {
  schedule: Schedule;
  dose: string;
  per_dose: number;
}

interface StepDraft {
  from: string;
  dose: string;
  per_dose: number | null;
}

function cleanSchedule(s: Schedule): Schedule {
  const times = [...new Set(s.times)].sort();
  const slot_doses = Object.fromEntries(
    Object.entries(s.slot_doses ?? {}).filter(([t, v]) => times.includes(t) && (v.dose.trim() || v.per_dose)).map(([t, v]) => [t, { dose: v.dose.trim(), per_dose: v.per_dose }]),
  );
  return { ...s, times, weekdays: [...new Set(s.weekdays)].sort(), slot_doses, anchor: s.type === "interval" ? (s.anchor ?? null) : (s.anchor ?? null) };
}

const planJSON = (p: PlanDraft) => JSON.stringify({ ...p, schedule: cleanSchedule(p.schedule), dose: p.dose.trim() });

/**
 * Add / edit a medicine. Schedule and dose changes on an existing medicine
 * apply from a day (default today) through the plan history, so earlier
 * days keep the plan they had and logged doses never turn into "missed".
 * Every other field is assigned on its own inside the mutator (never a
 * whole-object overwrite captured when the sheet opened).
 */
export function MedSheet({ item, editing, onClose }: { item: H; editing?: Medication | null; onClose: () => void }) {
  const today = todayISO();
  const base = useMemo(() => (editing ? structuredClone(editing) : newMedication()), [editing]);
  const basePlan = useMemo<PlanDraft>(() => {
    const p = planOn(base, today);
    return { schedule: structuredClone(p.schedule), dose: p.dose, per_dose: p.per_dose };
  }, [base, today]);
  const [m, setM] = useState<Medication>(base);
  const [plan, setPlan] = useState<PlanDraft>(basePlan);
  const [effective, setEffective] = useState(editing ? (base.start && base.start > today ? base.start : today) : today);
  const [steps, setSteps] = useState<StepDraft[]>([]);
  const [refill, setRefill] = useState<number | null>(null);
  const [active, setActive] = useState(editing ? isCurrent(editing) : true);
  const set = (patch: Partial<Medication>) => setM((cur) => ({ ...cur, ...patch }));
  const setSch = (patch: Partial<Schedule>) => setPlan((cur) => ({ ...cur, schedule: { ...cur.schedule, ...patch } }));
  const sch = plan.schedule;
  const planChanged = planJSON(plan) !== planJSON(basePlan);
  const laterSteps = editing ? planChanges(base).filter((c) => c.from > effective && c.until !== null) : [];
  const duplicate = !editing && item.data.medications.some((x) => x.active && x.name.trim().toLowerCase() === m.name.trim().toLowerCase());
  const intervalAnchor = sch.anchor || m.start;
  const stepsValid = steps.every((s) => s.from > (editing ? effective : today) && (s.dose.trim() || s.per_dose));
  const valid =
    !!m.name.trim() &&
    !duplicate &&
    (sch.type === "as_needed" || sch.times.length > 0) &&
    (sch.type !== "days" || sch.weekdays.length > 0) &&
    (sch.type !== "interval" || !!intervalAnchor) &&
    !(m.start && m.end && m.end < m.start) &&
    !(editing && planChanged && m.start && effective < m.start) &&
    stepsValid;

  const save = () => {
    const name = m.name.trim();
    const cleanPlan: PlanDraft = { schedule: cleanSchedule({ ...sch, anchor: sch.type === "interval" ? (sch.anchor || m.start) : sch.anchor }), dose: plan.dose.trim(), per_dose: plan.per_dose || 1 };
    const now = nowISO();
    const orderedSteps = [...steps].sort((a, b) => (a.from < b.from ? -1 : 1));
    if (!editing) {
      const med: Medication = { ...m, name, ...cleanPlan, remaining: m.remaining === null ? null : Math.max(0, m.remaining) };
      for (const st of orderedSteps) {
        const p = planOn(med, st.from);
        changePlan(med, st.from, { schedule: p.schedule, dose: st.dose.trim() || p.dose, per_dose: st.per_dose || p.per_dose });
      }
      item.update((d) => {
        if (!d.medications.some((x) => x.id === med.id)) d.medications.push(med);
      });
      onClose();
      return;
    }
    // Only what the person changed, applied to the current state.
    const fields: (keyof Medication)[] = ["kind", "form", "with_food", "purpose", "prescriber", "instructions", "start", "end", "max_per_day", "min_hours_between"];
    const changed = fields.filter((f) => JSON.stringify(m[f] ?? null) !== JSON.stringify(base[f] ?? null));
    const remainingChanged = m.remaining !== base.remaining;
    const activeChanged = active !== isCurrent(base);
    item.update((d) => {
      const cur = d.medications.find((x) => x.id === base.id);
      if (!cur) return;
      if (name !== base.name) cur.name = name;
      for (const f of changed) (cur as unknown as Record<string, unknown>)[f] = m[f] ?? null;
      if (remainingChanged) cur.remaining = m.remaining === null ? null : Math.max(0, m.remaining);
      if (refill && refill > 0) cur.remaining = Math.round(((cur.remaining ?? 0) + refill) * 100) / 100;
      if (planChanged) changePlan(cur, effective, cleanPlan);
      for (const st of orderedSteps) {
        const p = planOn(cur, st.from);
        changePlan(cur, st.from, { schedule: p.schedule, dose: st.dose.trim() || p.dose, per_dose: st.per_dose || p.per_dose });
      }
      if (activeChanged) {
        if (active && !cur.active) resumeMed(cur, now.slice(0, 10), d.doses);
        else if (!active && cur.active) stopMed(cur, now);
      }
    });
    onClose();
  };

  const slotDose = (t: string) => sch.slot_doses?.[t] ?? { dose: "", per_dose: null };
  const setSlotDose = (t: string, patch: Partial<{ dose: string; per_dose: number | null }>) =>
    setSch({ slot_doses: { ...(sch.slot_doses ?? {}), [t]: { ...slotDose(t), ...patch } } });
  const [perTime, setPerTime] = useState(Object.keys(basePlan.schedule.slot_doses ?? {}).length > 0);

  return (
    <Sheet
      open
      onClose={onClose}
      size="lg"
      title={editing ? `Edit ${editing.name}` : "Add a medication"}
      footer={
        <>
          {editing && (
            <DeleteButton
              label="Delete"
              onDelete={() => {
                item.update((d) => {
                  d.medications = d.medications.filter((x) => x.id !== editing.id);
                  d.doses = d.doses.filter((x) => x.med_id !== editing.id);
                });
                onClose();
              }}
            />
          )}
          <ItemButton variant="primary" block disabled={!valid} onClick={save}>
            {editing ? "Save" : "Add"}
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Segmented
          value={m.kind}
          onChange={(v) => set({ kind: v })}
          options={[
            { value: "medication", label: "Medication" },
            { value: "supplement", label: "Supplement" },
          ]}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr]">
          <Field label="Name" hint={duplicate ? "Already on your list" : undefined}>
            <TextInput autoFocus={!editing} value={m.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} placeholder="Metformin" />
          </Field>
          <Field label="Dose">
            <TextInput value={plan.dose} maxLength={60} onChange={(e) => setPlan((p) => ({ ...p, dose: e.target.value }))} placeholder="500 mg" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Form">
            <Select value={m.form} onChange={(e) => set({ form: e.target.value as MedForm })}>
              {FORMS.map((f) => (
                <option key={f} value={f}>
                  {f[0].toUpperCase() + f.slice(1)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Per dose (units)">
            <NumberInput value={plan.per_dose} onChange={(v) => setPlan((p) => ({ ...p, per_dose: v && v > 0 ? v : 1 }))} ariaLabel="Units per dose" />
          </Field>
        </div>

        <Field label="Schedule">
          <Segmented
            value={sch.type}
            onChange={(v) => setSch({ type: v, anchor: v === "interval" ? (sch.anchor ?? m.start ?? today) : sch.anchor })}
            size="sm"
            options={[
              { value: "daily", label: "Daily" },
              { value: "days", label: "Some days" },
              { value: "interval", label: "Every N days" },
              { value: "as_needed", label: "As needed" },
            ]}
          />
        </Field>
        {sch.type === "days" && (
          <div className="grid grid-cols-7 gap-1" role="group" aria-label="Weekdays">
            {WEEKDAYS.map((w, i) => {
              const on = sch.weekdays.includes(i);
              return (
                <button
                  key={w}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setSch({ weekdays: on ? sch.weekdays.filter((x) => x !== i) : [...sch.weekdays, i] })}
                  className={cn(
                    "h-11 rounded-lg text-xs font-semibold transition",
                    on ? "bg-[var(--item-accent)] text-white" : "bg-[var(--surface-2)] text-[var(--text-muted)]",
                  )}
                >
                  {w}
                </button>
              );
            })}
          </div>
        )}
        {sch.type === "interval" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Every how many days?">
              <NumberInput value={sch.every_days} onChange={(v) => setSch({ every_days: Math.max(1, Math.min(90, Math.round(v ?? 1))) })} ariaLabel="Every N days" />
            </Field>
            <Field label="Counting from" hint={!intervalAnchor ? "Pick the first day it's due" : undefined}>
              <TextInput type="date" value={sch.anchor ?? m.start ?? ""} onChange={(e) => setSch({ anchor: e.target.value || null })} />
            </Field>
          </div>
        )}
        {sch.type !== "as_needed" && (
          <Field label="Times">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {sch.times.map((t, i) => (
                  <div key={i} className="flex items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-2">
                    <input
                      type="time"
                      aria-label={`Time ${i + 1}`}
                      value={t}
                      onChange={(e) => {
                        const nt = e.target.value || t;
                        const sd = { ...(sch.slot_doses ?? {}) };
                        if (sd[t]) {
                          sd[nt] = sd[t];
                          delete sd[t];
                        }
                        setSch({ times: sch.times.map((x, j) => (j === i ? nt : x)), slot_doses: sd });
                      }}
                      className="h-10 bg-transparent text-sm tabular-nums text-[var(--text)] outline-none"
                    />
                    <IconButton label="Remove time" icon={X} onClick={() => setSch({ times: sch.times.filter((_, j) => j !== i) })} />
                  </div>
                ))}
                {sch.times.length < 12 && (
                  <ItemButton
                    size="sm"
                    icon={<Plus className="h-3.5 w-3.5" />}
                    onClick={() => setSch({ times: [...sch.times, sch.times.length ? (sch.times.includes("20:00") ? "13:00" : "20:00") : "08:00"] })}
                  >
                    Time
                  </ItemButton>
                )}
              </div>
              {sch.times.length > 1 && (
                <div className="flex items-center justify-between rounded-xl border border-[var(--border)] px-3 py-2">
                  <span className="text-sm text-[var(--text)]">Different amount at some times</span>
                  <Toggle
                    checked={perTime}
                    onChange={(v) => {
                      setPerTime(v);
                      if (!v) setSch({ slot_doses: {} });
                    }}
                    label="Different amount at some times"
                  />
                </div>
              )}
              {perTime &&
                sch.times.map((t) => (
                  <div key={t} className="grid grid-cols-[3.5rem_minmax(0,2fr)_minmax(0,1fr)] items-center gap-2">
                    <span className="text-sm font-semibold tabular-nums text-[var(--text)]">{t}</span>
                    <TextInput aria-label={`Dose at ${t}`} value={slotDose(t).dose} maxLength={60} placeholder={plan.dose || "Dose"} onChange={(e) => setSlotDose(t, { dose: e.target.value })} />
                    <NumberInput ariaLabel={`Units at ${t}`} value={slotDose(t).per_dose} placeholder={`${plan.per_dose} units`} onChange={(v) => setSlotDose(t, { per_dose: v && v > 0 ? v : null })} />
                  </div>
                ))}
            </div>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={sch.type === "as_needed" ? "Most doses a day" : "Most doses a day (optional)"}>
            <NumberInput value={m.max_per_day ?? null} placeholder="No limit" ariaLabel="Most doses a day" onChange={(v) => set({ max_per_day: v && v >= 1 ? Math.min(48, Math.round(v)) : null })} />
          </Field>
          <Field label="Hours between doses">
            <NumberInput value={m.min_hours_between ?? null} placeholder="No minimum" ariaLabel="Minimum hours between doses" onChange={(v) => set({ min_hours_between: v && v > 0 ? Math.min(72, v) : null })} />
          </Field>
        </div>

        {editing && planChanged && (
          <Field label="Change applies from" hint="Earlier days keep the schedule and dose they had, so past doses stay as logged.">
            <TextInput type="date" value={effective} min={m.start ?? undefined} onChange={(e) => e.target.value && setEffective(e.target.value)} />
            {laterSteps.length > 0 && <p className="mt-1 text-xs text-[var(--warning)]">This replaces the planned change{laterSteps.length > 1 ? "s" : ""} from {laterSteps.map((c) => fmtDay(c.from)).join(", ")}.</p>}
          </Field>
        )}

        {sch.type !== "as_needed" && (
          <Field label="Dose changes on a date (taper or step-up, as your prescriber told you)">
            <div className="flex flex-col gap-2">
              {editing &&
                planChanges(base)
                  .filter((c) => c.until === null || c.until >= today)
                  .map((c) => (
                    <p key={c.from} className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                      <CalendarClock className="h-3.5 w-3.5" />
                      <span className="tabular-nums">{c.from && c.from > today ? `From ${fmtDay(c.from)}` : "Now"}</span>
                      <span className="text-[var(--text)]">{c.plan.stopped ? "Paused" : `${c.plan.dose || "—"} · ${scheduleText({ ...base, schedule: c.plan.schedule, schedule_history: [] })}`}</span>
                      {c.until && <span>until {fmtDay(c.until)}</span>}
                    </p>
                  ))}
              {steps.map((st, i) => (
                <div key={i} className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto] items-center gap-2">
                  <TextInput type="date" aria-label="From" value={st.from} min={today} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
                  <TextInput aria-label="New dose" value={st.dose} maxLength={60} placeholder="20 mg" onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, dose: e.target.value } : x)))} />
                  <NumberInput ariaLabel="Units per dose" value={st.per_dose} placeholder="units" onChange={(v) => setSteps(steps.map((x, j) => (j === i ? { ...x, per_dose: v && v > 0 ? v : null } : x)))} />
                  <IconButton label="Remove this change" icon={X} onClick={() => setSteps(steps.filter((_, j) => j !== i))} />
                </div>
              ))}
              {!stepsValid && <p className="text-xs text-[var(--warning)]">Each change needs a later day and a new dose.</p>}
              {steps.length < 10 && (
                <ItemButton size="sm" className="self-start" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setSteps([...steps, { from: "", dose: "", per_dose: null }])}>
                  Add a dose change
                </ItemButton>
              )}
            </div>
          </Field>
        )}

        <Field label="Food">
          <Select value={m.with_food} onChange={(e) => set({ with_food: e.target.value as Medication["with_food"] })}>
            <option value="any">No instruction</option>
            <option value="with">With food</option>
            <option value="before">Before food</option>
            <option value="after">After food</option>
            <option value="empty">On an empty stomach</option>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start">
            <TextInput type="date" value={m.start ?? ""} onChange={(e) => set({ start: e.target.value || null })} />
          </Field>
          <Field label="End (optional)">
            <TextInput type="date" value={m.end ?? ""} onChange={(e) => set({ end: e.target.value || null })} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="On hand (units)" hint="For refill warnings">
            <NumberInput value={m.remaining} onChange={(v) => set({ remaining: v === null ? null : Math.max(0, v) })} placeholder="Not tracked" ariaLabel="Units on hand" />
          </Field>
          {editing && (
            <Field label="Picked up a refill?" hint="Adds to what's on hand">
              <NumberInput value={refill} onChange={setRefill} placeholder="+ units" ariaLabel="Refill units" />
            </Field>
          )}
        </div>
        <Field label="What it's for">
          <TextInput value={m.purpose} maxLength={200} onChange={(e) => set({ purpose: e.target.value })} placeholder="Blood pressure" />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Prescriber">
            <TextInput value={m.prescriber} maxLength={120} onChange={(e) => set({ prescriber: e.target.value })} />
          </Field>
          <Field label="Instructions">
            <TextInput value={m.instructions} maxLength={500} onChange={(e) => set({ instructions: e.target.value })} placeholder="As on the label" />
          </Field>
        </div>
        {editing && (
          <div className="flex flex-col gap-1 rounded-xl border border-[var(--border)] px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-[var(--text)]">Currently taking</span>
              <Toggle checked={active} onChange={setActive} label="Currently taking" />
            </div>
            <p className="text-xs text-[var(--text-muted)]">Stopping ends future doses only — its history and adherence stay.</p>
          </div>
        )}
      </div>
    </Sheet>
  );
}
