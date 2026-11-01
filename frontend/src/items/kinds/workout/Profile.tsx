import { ArrowLeft, ArrowRight, Check, Dumbbell, Sparkles } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type { ItemViewProps } from "@/items/types";
import type { ItemHandle } from "@/items/useItem";
import { Card, Chip, Field, ItemButton, Page, ProgressBar, Segmented, Select, Stepper, TextArea, TextInput, Toggle } from "@/items/ui";
import { cn } from "@/utils/cn";

import { EQUIP_PRESETS, GOALS } from "./catalog";
import { LB, fmtW, fromUnit, toUnit } from "./science";
import { WEEKDAYS, useWorkoutCtx, type Ctx } from "./shared";
import type { Equip, Settings, Unit, WorkoutData } from "./types";

const KG_PLATES = [25, 20, 15, 10, 5, 2.5, 1.25];
const LB_PLATES = [45, 35, 25, 10, 5, 2.5];

/** Switch units, swapping the default kit for the new unit's standard. */
export function applyUnits(d: WorkoutData, units: Unit) {
  const st = d.settings;
  if (st.units === units) return;
  const was = st.units;
  const isDefault = st.plates.map((p) => Math.round((was === "lb" ? p.kg / LB : p.kg) * 100) / 100).join() === (was === "lb" ? LB_PLATES : KG_PLATES).join();
  st.units = units;
  if (isDefault) st.plates = (units === "lb" ? LB_PLATES.map((p) => +(p * LB).toFixed(4)) : KG_PLATES).map((kg) => ({ kg, pairs: 10 }));
  if (Math.abs(st.bar_kg - (was === "lb" ? 45 * LB : 20)) < 0.05) st.bar_kg = units === "lb" ? +(45 * LB).toFixed(4) : 20;
  if (Math.abs(st.machine_step_kg - (was === "lb" ? 10 * LB : 5)) < 0.05) st.machine_step_kg = units === "lb" ? +(10 * LB).toFixed(4) : 5;
  // The default − / + step follows too: 2.5 kg ↔ 5 lb.
  const step = st.weight_step_kg ?? 2.5;
  if (Math.abs(step - (was === "lb" ? 5 * LB : 2.5)) < 0.01) st.weight_step_kg = units === "lb" ? +(5 * LB).toFixed(4) : 2.5;
  if (Math.abs(st.dumbbell_step_kg - (was === "lb" ? 5 * LB : 2)) < 0.05) st.dumbbell_step_kg = units === "lb" ? +(5 * LB).toFixed(4) : 2;
  // Standard EZ (10 kg ↔ 25 lb) and trap bars (25 kg ↔ 55 lb) follow the switch; custom weights stay.
  for (const [key, kgStd, lbStd] of [["ez_bar_kg", 10, 25], ["trap_bar_kg", 25, 55]] as const) {
    const cur = st[key] ?? kgStd;
    if (Math.abs(cur - (was === "lb" ? lbStd * LB : kgStd)) < 0.05) st[key] = units === "lb" ? +(lbStd * LB).toFixed(4) : kgStd;
  }
}

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div className="min-w-0">
        <div className="text-sm text-[var(--text)]">{label}</div>
        {hint && <div className="text-xs text-[var(--text-muted)]">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function H({ children }: { children: ReactNode }) {
  return <h3 className="mt-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{children}</h3>;
}

function EquipmentEditor({ s, set, ctx }: { s: Settings; set: (fn: (st: Settings) => void) => void; ctx: Ctx }) {
  const preset = EQUIP_PRESETS.find((p) => p.equipment.join() === s.equipment.join())?.id ?? "custom";
  const all = Object.entries(ctx.lib.catalog.equipment).filter(([k]) => k !== "full_gym" && k !== "bodyweight");
  const hasDb = s.equipment.includes("full_gym") || s.equipment.includes("dumbbell");
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        {EQUIP_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={preset === p.id}
            onClick={() => set((st) => { st.equipment = [...p.equipment]; })}
            className={cn("rounded-xl border p-3 text-left transition", preset === p.id ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_10%,transparent)]" : "border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--hover)]")}
          >
            <div className="text-sm font-semibold text-[var(--text)]">{p.label}</div>
            <div className="text-[11px] text-[var(--text-muted)]">{p.hint}</div>
          </button>
        ))}
      </div>
      {!s.equipment.includes("full_gym") && (
        <div className="flex flex-wrap gap-1.5" aria-label="Equipment you have">
          {all.map(([k, label]) => {
            const on = s.equipment.includes(k as Equip);
            return (
              <Chip key={k} active={on} onClick={() => set((st) => { st.equipment = on ? st.equipment.filter((x) => x !== k) : st.equipment.includes(k as Equip) ? st.equipment : [...st.equipment, k as Equip]; })}>
                {label}
              </Chip>
            );
          })}
        </div>
      )}
      {hasDb && !s.equipment.includes("full_gym") && (
        <Field label={`Dumbbells you own (${s.units}, per hand)`} hint="Comma-separated, e.g. 5, 7.5, 10, 12.5 — or leave empty for a full rack.">
          <TextInput
            defaultValue={s.dumbbells_kg.map((x) => fmtW(x, s, false)).join(", ")}
            onBlur={(e) => {
              const vals = e.target.value.split(/[,\s]+/).map((x) => parseFloat(x.replace(",", "."))).filter((n) => Number.isFinite(n) && n > 0);
              set((st) => { st.dumbbells_kg = [...new Set(vals.map((v) => +fromUnit(v, s).toFixed(4)))].sort((a, b) => a - b); });
            }}
            placeholder="Full rack"
          />
        </Field>
      )}
    </div>
  );
}

/** Everything the coach and the logger tailor to. */
/** The Settings tab: your week first (what you train on which day), then
 *  you, equipment, logging and reminders. */
export function SettingsView({ item }: ItemViewProps<WorkoutData>) {
  const { ctx } = useWorkoutCtx(item);
  const s = item.data.settings;
  const set = (fn: (st: Settings) => void) => item.update((d) => fn(d.settings));
  const ro = !item.canEdit;
  const [plateText, setPlateText] = useState("");
  useEffect(() => {
    setPlateText(s.plates.map((p) => fmtW(p.kg, s, false)).join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.units]);
  const bw = toUnit(s.bodyweight_kg, s);
  return (
    <Page className="max-w-2xl">
      <h2 className="text-xl font-semibold text-[var(--text)]">Settings</h2>
      <fieldset disabled={ro} className="flex flex-col gap-3">
        <H>Your week</H>
        <DayPlanPicker s={s} set={set} />
        <div className="grid grid-cols-2 gap-3">
          {!s.training_days.length && <Stepper label="Days per week" value={s.days_per_week} min={1} max={7} onChange={(v) => set((st) => { st.days_per_week = v; })} />}
          <Stepper label="Session length (min)" value={s.session_minutes} step={5} min={15} max={240} onChange={(v) => set((st) => { st.session_minutes = v; })} />
        </div>
        <Row label="Week starts on">
          <Segmented value={s.week_start} onChange={(v) => set((st) => { st.week_start = v; })} options={[{ value: "mon", label: "Mon" }, { value: "sun", label: "Sun" }]} size="sm" />
        </Row>

        <H>You</H>
        <Row label="Units">
          <Segmented value={s.units} onChange={(u) => item.update((d) => applyUnits(d, u))} options={[{ value: "kg", label: "kg" }, { value: "lb", label: "lb" }]} size="sm" />
        </Row>
        <div className="grid grid-cols-2 gap-3">
          <Stepper label={`Bodyweight (${s.units})`} value={bw ?? (s.units === "lb" ? 165 : 75)} step={s.units === "lb" ? 1 : 0.5} min={0} max={900} onChange={(v) => set((st) => { st.bodyweight_kg = v ? Math.max(20, fromUnit(v, s)) : null; })} />
          <Field label="Sex (for starting loads)">
            <Select value={s.sex} onChange={(e) => { const v = e.target.value as Settings["sex"]; set((st) => { st.sex = v; }); }}>
              <option value="">Prefer not to say</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </Select>
          </Field>
        </div>
        <Field label="Experience">
          <Segmented value={s.experience} onChange={(v) => set((st) => { st.experience = v; })} options={[{ value: "beginner", label: "Beginner" }, { value: "intermediate", label: "Intermediate" }, { value: "advanced", label: "Advanced" }]} />
        </Field>
        <Field label="Main goal">
          <Select value={s.goal} onChange={(e) => { const v = e.target.value as Settings["goal"]; set((st) => { st.goal = v; }); }}>
            {GOALS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label} — {g.hint}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Injuries or limitations" hint="The coach avoids and substitutes around these.">
          <TextArea value={s.injuries} maxLength={1000} onChange={(e) => { const v = e.target.value.slice(0, 1000); set((st) => { st.injuries = v; }); }} placeholder="e.g. Left shoulder impingement — no overhead barbell work" />
        </Field>

        <H>Equipment</H>
        <EquipmentEditor s={s} set={set} ctx={ctx} />
        <div className="grid grid-cols-2 gap-3">
          <Stepper label={`Barbell (${s.units})`} value={toUnit(s.bar_kg, s) ?? 20} step={s.units === "lb" ? 5 : 2.5} min={0} max={130} onChange={(v) => set((st) => { st.bar_kg = fromUnit(v, s); })} />
          <Stepper label={`Machine step (${s.units})`} value={toUnit(s.machine_step_kg, s) ?? 5} step={s.units === "lb" ? 2.5 : 1.25} min={0.5} max={50} onChange={(v) => set((st) => { st.machine_step_kg = Math.max(0.1, fromUnit(v, s)); })} />
        </div>
        <Field label={`Plates (${s.units}, you have pairs of)`} hint="Used for rounding every suggested load and the plate calculator.">
          <TextInput
            value={plateText}
            onChange={(e) => setPlateText(e.target.value)}
            onBlur={() => {
              const vals = plateText.split(/[,\s]+/).map((x) => parseFloat(x)).filter((n) => Number.isFinite(n) && n > 0 && n <= 130);
              if (vals.length) set((st) => { st.plates = [...new Set(vals)].sort((a, b) => b - a).map((v) => ({ kg: +fromUnit(v, s).toFixed(4), pairs: 10 })); });
            }}
          />
        </Field>

        <H>Logging</H>
        <Stepper
          label={`Weight step for − / + (${s.units})`}
          value={Math.round(((s.weight_step_kg ?? 2.5) / (s.units === "lb" ? LB : 1)) * 100) / 100}
          step={s.units === "lb" ? 2.5 : 1.25}
          decimals={2}
          min={0.01}
          max={s.units === "lb" ? 110 : 50}
          onChange={(v) => { if (v > 0) set((st) => { st.weight_step_kg = +fromUnit(v, s).toFixed(4); }); }}
        />
        <Row label="Rest timer" hint="Counts down after each set you tick">
          <Toggle checked={s.rest_timer !== false} onChange={(v) => set((st) => { st.rest_timer = v; })} label="Rest timer" />
        </Row>
        {s.rest_timer !== false && (
        <div className="grid grid-cols-2 gap-3">
          <Stepper label="Rest — compounds (s)" value={s.rest_compound_s} step={15} min={15} max={900} onChange={(v) => set((st) => { st.rest_compound_s = v; })} />
          <Stepper label="Rest — isolation (s)" value={s.rest_isolation_s} step={15} min={15} max={900} onChange={(v) => set((st) => { st.rest_isolation_s = v; })} />
        </div>
        )}
        <Row label="1RM formula">
          <Segmented value={s.e1rm_formula} onChange={(v) => set((st) => { st.e1rm_formula = v; })} options={[{ value: "epley", label: "Epley" }, { value: "brzycki", label: "Brzycki" }]} size="sm" />
        </Row>
        <Row label="Warm-up sets" hint="Auto ramp before the first heavy lift">
          <Toggle checked={s.warmups} onChange={(v) => set((st) => { st.warmups = v; })} label="Warm-up sets" />
        </Row>
        {s.rest_timer !== false && (
          <>
            <Row label="Vibrate when rest ends" hint="Screen off? Tap the bell on the rest timer for a notification">
              <Toggle checked={s.vibrate} onChange={(v) => set((st) => { st.vibrate = v; })} label="Vibrate when rest ends" />
            </Row>
            <Row label="Beep when rest ends">
              <Toggle checked={s.sound} onChange={(v) => set((st) => { st.sound = v; })} label="Beep when rest ends" />
            </Row>
          </>
        )}

        <H>Reminders</H>
        <Row label="Remind me on training days">
          <Toggle checked={s.reminders} onChange={(v) => set((st) => { st.reminders = v; })} label="Workout reminders" />
        </Row>
        {s.reminders && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="At (sessions without a time)">
              <TextInput type="time" value={s.reminder_time} onChange={(e) => { const v = e.target.value; if (/^\d{2}:\d{2}$/.test(v)) set((st) => { st.reminder_time = v; }); }} />
            </Field>
            <Stepper label="Minutes before a timed session" value={s.remind_before_min} step={15} min={0} max={720} onChange={(v) => set((st) => { st.remind_before_min = v; })} />
          </div>
        )}
        <p className="pt-2 text-[11px] text-[var(--text-muted)]">
          Coaching here is general guidance, not medical advice. Stop any exercise that causes sharp pain, and get medical clearance first if you have a heart condition, are pregnant or are recovering from surgery.
        </p>
      </fieldset>
    </Page>
  );
}

/** What a training day can be for (the coach plans each day to match). */
const FOCUS = ["Full body", "Upper body", "Lower body", "Push", "Pull", "Legs", "Chest & back", "Shoulders & arms", "Glutes & hamstrings", "Core", "Cardio"];

/** One row per weekday: rest, the coach's choice, or what that day is for.
 *  Sets training days, day focus and days per week together. */
function DayPlanPicker({ s, set }: { s: Settings; set: (fn: (st: Settings) => void) => void }) {
  const focus = s.day_focus ?? {};
  const pick = (i: number, v: string) =>
    set((st) => {
      const days = st.training_days.filter((x) => x !== i);
      const next = { ...(st.day_focus ?? {}) };
      delete next[String(i)];
      if (v !== "rest") {
        days.push(i);
        if (v) next[String(i)] = v;
      }
      st.training_days = days.sort((x, y) => x - y);
      st.day_focus = next;
      if (days.length) st.days_per_week = days.length;
    });
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-[var(--text-muted)]">What do you want to do on each day? The coach plans your week to match.</span>
      {WEEKDAYS.map((d, i) => {
        const on = s.training_days.includes(i);
        return (
          <label key={d} className="grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-2">
            <span className={cn("text-sm font-medium", on ? "text-[var(--text)]" : "text-[var(--text-muted)]")}>{d}</span>
            <Select value={on ? focus[String(i)] ?? "" : "rest"} aria-label={`${d}: what to train`} onChange={(e) => pick(i, e.target.value)}>
              <option value="rest">Rest</option>
              <option value="">Train — let the coach decide</option>
              {FOCUS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
              {on && focus[String(i)] && !FOCUS.includes(focus[String(i)]) && <option value={focus[String(i)]}>{focus[String(i)]}</option>}
            </Select>
          </label>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------- onboarding */

export function Onboarding({ item, ask }: ItemViewProps<WorkoutData>) {
  const [step, setStep] = useState(0);
  const s = item.data.settings;
  const set = (fn: (st: Settings) => void) => item.update((d) => fn(d.settings));
  const steps = ["Goal", "You", "Schedule", "Equipment"];
  const finish = (plan: boolean) => {
    set((st) => { st.onboarded = true; });
    if (plan) window.setTimeout(() => ask("Plan my first training week — follow my day plan. Leave the weights out (you don't know what I can lift yet) and tell me how to pick a starting weight for each lift."), 100);
  };
  const bw = toUnit(s.bodyweight_kg, s);
  return (
    <Page className="max-w-xl">
      <div className="flex flex-col items-center gap-2 pt-2 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--item-accent)] text-white">
          <Dumbbell className="h-7 w-7" />
        </span>
        <h1 className="text-xl font-semibold text-[var(--text)]">Set up your training</h1>
        <p className="text-sm text-[var(--text-muted)]">Four quick questions so the coach can plan your training.</p>
      </div>
      <ProgressBar value={(step + 1) / steps.length} />
      <Card className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-[var(--text)]">
          {step + 1}. {steps[step]}
        </h2>
        {step === 0 && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {GOALS.map((g) => (
              <button
                key={g.value}
                type="button"
                aria-pressed={s.goal === g.value}
                onClick={() => set((st) => { st.goal = g.value; })}
                className={cn("min-h-[64px] rounded-xl border p-3 text-left transition", s.goal === g.value ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_10%,transparent)]" : "border-[var(--border)] hover:bg-[var(--hover)]")}
              >
                <div className="text-sm font-semibold text-[var(--text)]">{g.label}</div>
                <div className="text-xs text-[var(--text-muted)]">{g.hint}</div>
              </button>
            ))}
          </div>
        )}
        {step === 1 && (
          <div className="flex flex-col gap-4">
            <Row label="Units">
              <Segmented value={s.units} onChange={(u) => item.update((d) => applyUnits(d, u))} options={[{ value: "kg", label: "kg" }, { value: "lb", label: "lb" }]} size="sm" />
            </Row>
            <Field label="Training experience">
              <Segmented value={s.experience} onChange={(v) => set((st) => { st.experience = v; })} options={[{ value: "beginner", label: "< 1 year" }, { value: "intermediate", label: "1–3 years" }, { value: "advanced", label: "3+ years" }]} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Stepper label={`Bodyweight (${s.units})`} value={bw ?? (s.units === "lb" ? 165 : 75)} step={s.units === "lb" ? 1 : 0.5} min={0} max={900} onChange={(v) => set((st) => { st.bodyweight_kg = v ? Math.max(20, fromUnit(v, s)) : null; })} />
              <Field label="Sex (starting loads)">
                <Select value={s.sex} onChange={(e) => { const v = e.target.value as Settings["sex"]; set((st) => { st.sex = v; }); }}>
                  <option value="">Prefer not to say</option>
                  <option value="female">Female</option>
                  <option value="male">Male</option>
                </Select>
              </Field>
            </div>
            <Field label="Injuries or limitations (optional)">
              <TextInput value={s.injuries} onChange={(e) => { const v = e.target.value.slice(0, 1000); set((st) => { st.injuries = v; }); }} placeholder="e.g. lower back — go easy on deadlifts" />
            </Field>
          </div>
        )}
        {step === 2 && (
          <div className="flex flex-col gap-4">
            <DayPlanPicker s={s} set={set} />
            {!s.training_days.length && (
              <Stepper label="Or just: days per week" value={s.days_per_week} min={1} max={7} onChange={(v) => set((st) => { st.days_per_week = v; })} />
            )}
            <Stepper label="Minutes per session" value={s.session_minutes} step={5} min={15} max={240} onChange={(v) => set((st) => { st.session_minutes = v; })} />
          </div>
        )}
        {step === 3 && <OnboardingEquipment item={item} />}
      </Card>
      <div className="flex gap-2">
        {step > 0 ? (
          <ItemButton icon={<ArrowLeft className="h-4 w-4" />} onClick={() => setStep(step - 1)}>
            Back
          </ItemButton>
        ) : (
          <ItemButton variant="ghost" onClick={() => finish(false)}>
            Skip
          </ItemButton>
        )}
        {step < steps.length - 1 ? (
          <ItemButton variant="primary" block className="flex-1" onClick={() => setStep(step + 1)}>
            Next <ArrowRight className="h-4 w-4" />
          </ItemButton>
        ) : (
          <div className="flex flex-1 flex-col gap-2 sm:flex-row">
            <ItemButton block icon={<Check className="h-4 w-4" />} onClick={() => finish(false)}>
              Done
            </ItemButton>
            <ItemButton variant="primary" block icon={<Sparkles className="h-4 w-4" />} onClick={() => finish(true)}>
              Done — plan my week
            </ItemButton>
          </div>
        )}
      </div>
    </Page>
  );
}

function OnboardingEquipment({ item }: { item: ItemHandle<WorkoutData> }) {
  const s = item.data.settings;
  const preset = EQUIP_PRESETS.find((p) => p.equipment.join() === s.equipment.join())?.id ?? "custom";
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {EQUIP_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={preset === p.id}
            onClick={() => item.update((d) => { d.settings.equipment = [...p.equipment]; })}
            className={cn("min-h-[64px] rounded-xl border p-3 text-left transition", preset === p.id ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_10%,transparent)]" : "border-[var(--border)] hover:bg-[var(--hover)]")}
          >
            <div className="text-sm font-semibold text-[var(--text)]">{p.label}</div>
            <div className="text-xs text-[var(--text-muted)]">{p.hint}</div>
          </button>
        ))}
      </div>
      {(preset === "db" || preset === "home") && (
        <Stepper
          label={`Heaviest dumbbell (${s.units}, per hand)`}
          value={toUnit(s.dumbbell_max_kg, s) ?? (s.units === "lb" ? 50 : 24)}
          step={s.units === "lb" ? 5 : 2}
          min={2}
          max={s.units === "lb" ? 200 : 100}
          onChange={(v) => item.update((d) => { d.settings.dumbbell_max_kg = fromUnit(v, s); })}
        />
      )}
      <p className="text-xs text-[var(--text-muted)]">You can fine-tune plates, bar weight and exact dumbbells later in Profile.</p>
    </div>
  );
}
