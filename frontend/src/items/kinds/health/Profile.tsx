import { ArrowDown, ArrowUp, Plus, UserRound } from "lucide-react";
import { useMemo, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import type { ItemHandle } from "@/items/useItem";
import {
  Card,
  Field,
  IconButton,
  ItemButton,
  List,
  ListRow,
  Section,
  Segmented,
  Select,
  Sheet,
  Stat,
  TextArea,
  TextInput,
  Toggle,
  uid,
} from "@/items/ui";
import { PersonInput } from "@/items/ui/PersonInput";

import { DeleteButton, ListInput, NumberInput, round } from "./common";
import {
  ageYears,
  allMetrics,
  bmiBand,
  bmiOf,
  dailySeries,
  ewma,
  fmtMetric,
  fromDisplay,
  metricDef,
  toDisplay,
  unitLabel,
  type MetricDef,
} from "./metrics";
import type { BloodType, CareProvider, CustomMetric, Goal, HealthData, Settings, Sex } from "./types";
import { todayISO } from "./zone";

type H = ItemHandle<HealthData>;

export function ProfileView({ item, ask }: ItemViewProps<HealthData>) {
  const data = item.data;
  const p = data.profile;
  const s = data.settings;
  const ro = !item.canEdit;
  const [goalFor, setGoalFor] = useState<Goal | "new" | null>(null);
  const [metricSheet, setMetricSheet] = useState<CustomMetric | "new" | null>(null);
  const [provider, setProvider] = useState<CareProvider | "new" | null>(null);

  const setP = (patch: Partial<HealthData["profile"]>) => item.update((d) => Object.assign(d.profile, patch));
  const setS = (patch: Partial<Settings>) => item.update((d) => Object.assign(d.settings, patch));

  const weightTrend = useMemo(() => {
    const ser = dailySeries(data.readings.filter((r) => r.metric === "weight"), "weight", "avg");
    const t = ewma(ser, s.smoothing);
    return t.length ? t[t.length - 1].v : null;
  }, [data.readings, s.smoothing]);
  const bmi = bmiOf(weightTrend, p.height_cm);
  const age = ageYears(p.birth_date);
  const heightDisp = p.height_cm === null ? null : round(s.length_unit === "in" ? p.height_cm / 2.54 : p.height_cm, 1);

  return (
    <>
      <Section title="About you" hint="Used for BMI, BMR and reference ranges. Stays in this file.">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Age" value={age ?? "–"} />
          <Stat label="BMI" value={bmi ? bmi.toFixed(1) : "–"} delta={bmi ? bmiBand(bmi).label : p.height_cm ? "Log a weight" : "Add height"} />
          <Stat label="Weight trend" value={weightTrend ? fmtMetric(metricDef(data, "weight")!, weightTrend, s) : "–"} />
        </div>
        {bmi && (
          <button type="button" onClick={() => ask("Explain my BMI and other body measures, with the caveats")} className="self-start px-1 text-xs text-[var(--item-accent)] hover:underline">
            What does this mean?
          </button>
        )}
        <Card className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={`Height (${s.length_unit})`}>
            <NumberInput
              value={heightDisp}
              onChange={(v) => !ro && setP({ height_cm: v === null ? null : Math.min(260, Math.max(40, round(s.length_unit === "in" ? v * 2.54 : v, 1))) })}
              ariaLabel="Height"
            />
          </Field>
          <Field label="Date of birth">
            <TextInput type="date" disabled={ro} value={p.birth_date ?? ""} max={todayISO()} onChange={(e) => setP({ birth_date: e.target.value || null })} />
          </Field>
          <Field label="Sex">
            <Select disabled={ro} value={p.sex} onChange={(e) => setP({ sex: e.target.value as Sex })}>
              <option value="unspecified">Prefer not to say</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
              <option value="intersex">Intersex</option>
            </Select>
          </Field>
          <Field label="Blood type">
            <Select disabled={ro} value={p.blood_type} onChange={(e) => setP({ blood_type: e.target.value as BloodType })}>
              <option value="">—</option>
              {["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"].map((b) => (
                <option key={b} value={b}>
                  {b === "unknown" ? "Unknown" : b}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Conditions" hint="Separate with commas">
            <ListInput value={p.conditions} onChange={(v) => !ro && setP({ conditions: v })} placeholder="Asthma, hypertension" />
          </Field>
          <Field label="Allergies" hint="Separate with commas">
            <ListInput value={p.allergies} onChange={(v) => !ro && setP({ allergies: v })} placeholder="Penicillin, peanuts" />
          </Field>
          <Field label="Emergency contact" className="sm:col-span-2" hint={ro ? undefined : "Type a name to pick from your Contacts"}>
            <PersonInput
              disabled={ro}
              value={p.emergency_contact}
              maxLength={300}
              onChange={(v) => setP({ emergency_contact: v })}
              // Kept as text ("Name · phone") — the contact just fills it in.
              onPick={(c) => setP({ emergency_contact: [c.name, c.phone].filter(Boolean).join(" · ").slice(0, 300) })}
              placeholder="Name · phone"
            />
          </Field>
          <Field label="Emergency notes" className="sm:col-span-2" hint="What a paramedic should know. Not shared with chats.">
            <TextArea disabled={ro} value={p.emergency_notes} maxLength={2000} onChange={(e) => setP({ emergency_notes: e.target.value })} />
          </Field>
        </Card>
      </Section>

      <Section
        title="Care team"
        action={
          !ro && (
            <ItemButton size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setProvider("new")}>
              Add
            </ItemButton>
          )
        }
      >
        {p.care_team.length ? (
          <List>
            {p.care_team.map((c) => (
              <ListRow
                key={c.id}
                onClick={ro ? undefined : () => setProvider(c)}
                leading={<UserRound className="h-4 w-4 text-[var(--item-accent)]" />}
                title={c.name}
                subtitle={[c.role, c.clinic].filter(Boolean).join(" · ")}
                trailing={c.phone ? <a href={`tel:${c.phone.replace(/\s/g, "")}`} onClick={(e) => e.stopPropagation()} className="text-xs text-[var(--item-accent)]">{c.phone}</a> : null}
              />
            ))}
          </List>
        ) : (
          <p className="px-1 text-sm text-[var(--text-muted)]">Your GP, specialists, dentist, pharmacy — one tap to call, and quick to pick for appointments.</p>
        )}
      </Section>

      <Section
        title="Goals"
        action={
          !ro && (
            <ItemButton size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setGoalFor("new")}>
              Goal
            </ItemButton>
          )
        }
      >
        {data.goals.length ? (
          <List>
            {data.goals.map((g) => {
              const m = metricDef(data, g.metric);
              if (!m) return null;
              const text =
                g.target !== null
                  ? `${fmtMetric(m, g.target, s)}${g.direction === "daily" ? " a day" : ""}${g.target_date ? ` by ${g.target_date}` : ""}`
                  : `${fmtMetric(m, g.low, s)} – ${fmtMetric(m, g.high, s)}`;
              return <ListRow key={g.metric} onClick={ro ? undefined : () => setGoalFor(g)} leading={<m.icon className="h-4 w-4 text-[var(--item-accent)]" />} title={m.label} trailing={<span className="tabular-nums">{text}</span>} />;
            })}
          </List>
        ) : (
          <p className="px-1 text-sm text-[var(--text-muted)]">No goals yet.</p>
        )}
      </Section>

      <Section
        title="Your own metrics"
        hint="Track anything: caffeine, peak flow, pain-free minutes…"
        action={
          !ro && (
            <ItemButton size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setMetricSheet("new")}>
              Metric
            </ItemButton>
          )
        }
      >
        {data.custom_metrics.length > 0 && (
          <List>
            {data.custom_metrics.map((c) => (
              <ListRow key={c.id} onClick={ro ? undefined : () => setMetricSheet(c)} title={c.name} subtitle={`${c.unit || "no unit"} · daily ${c.aggregate}`} />
            ))}
          </List>
        )}
      </Section>

      {!ro && <TilesEditor item={item} />}

      <Section title="Units">
        <Card className="flex flex-col gap-3">
          <UnitRow label="Weight" value={s.weight_unit} options={[{ value: "kg", label: "kg" }, { value: "lb", label: "lb" }]} onChange={(v) => setS({ weight_unit: v })} />
          <UnitRow label="Length" value={s.length_unit} options={[{ value: "cm", label: "cm" }, { value: "in", label: "in" }]} onChange={(v) => setS({ length_unit: v })} />
          <UnitRow label="Glucose" value={s.glucose_unit} options={[{ value: "mmol", label: "mmol/L" }, { value: "mgdl", label: "mg/dL" }]} onChange={(v) => setS({ glucose_unit: v })} />
          <UnitRow label="Temperature" value={s.temp_unit} options={[{ value: "c", label: "°C" }, { value: "f", label: "°F" }]} onChange={(v) => setS({ temp_unit: v })} />
          <UnitRow label="Water" value={s.water_unit} options={[{ value: "ml", label: "ml" }, { value: "oz", label: "oz" }]} onChange={(v) => setS({ water_unit: v })} />
        </Card>
      </Section>

      <Section title="Reminders & privacy">
        <Card className="flex flex-col divide-y divide-[var(--border)] py-1" padded={false}>
          <ToggleRow label="Dose reminders" hint="A nudge at each scheduled dose (not if you've already marked it)" checked={s.med_reminders} onChange={(v) => setS({ med_reminders: v })} disabled={ro} />
          <ToggleRow label="Refill warnings" hint={`When about ${s.refill_days} days' supply is left`} checked={s.refill_reminders} onChange={(v) => setS({ refill_reminders: v })} disabled={ro} />
          <ToggleRow label="Appointment reminders" hint="The evening before and 2 hours before" checked={s.appointment_reminders} onChange={(v) => setS({ appointment_reminders: v })} disabled={ro} />
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div>
              <p className="text-sm text-[var(--text)]">Daily weigh-in</p>
              <p className="text-xs text-[var(--text-muted)]">Skipped on days you've already weighed in</p>
            </div>
            <div className="flex items-center gap-2">
              {s.weigh_in_time && (
                <input
                  type="time"
                  aria-label="Weigh-in time"
                  value={s.weigh_in_time}
                  disabled={ro}
                  onChange={(e) => e.target.value && setS({ weigh_in_time: e.target.value })}
                  className="h-9 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 text-sm tabular-nums text-[var(--text)]"
                />
              )}
              <Toggle checked={!!s.weigh_in_time} onChange={(v) => !ro && setS({ weigh_in_time: v ? "07:00" : null })} label="Daily weigh-in reminder" />
            </div>
          </div>
          <ToggleRow label="Discreet notifications" hint="Hide medicine names on your lock screen" checked={s.discreet_reminders} onChange={(v) => setS({ discreet_reminders: v })} disabled={ro} />
          <ToggleRow label="Cycle tracking" hint="Period log, predictions and fertile-window estimates" checked={s.cycle_tracking} onChange={(v) => setS({ cycle_tracking: v })} disabled={ro} />
        </Card>
      </Section>

      {goalFor && <GoalSheet item={item} editing={goalFor === "new" ? null : goalFor} onClose={() => setGoalFor(null)} />}
      {metricSheet && <CustomMetricSheet item={item} editing={metricSheet === "new" ? null : metricSheet} onClose={() => setMetricSheet(null)} />}
      {provider && <ProviderSheet item={item} editing={provider === "new" ? null : provider} onClose={() => setProvider(null)} />}
    </>
  );
}

function UnitRow<V extends string>({ label, value, options, onChange }: { label: string; value: V; options: { value: V; label: string }[]; onChange: (v: V) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-[var(--text)]">{label}</span>
      <Segmented size="sm" value={value} onChange={onChange} options={options} />
    </div>
  );
}

function ToggleRow({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div>
        <p className="text-sm text-[var(--text)]">{label}</p>
        {hint && <p className="text-xs text-[var(--text-muted)]">{hint}</p>}
      </div>
      <Toggle checked={checked} onChange={(v) => !disabled && onChange(v)} label={label} />
    </div>
  );
}

function TilesEditor({ item }: { item: H }) {
  const data = item.data;
  const tiles = data.settings.today_tiles;
  const all = allMetrics(data);
  const on = tiles.map((id) => all.find((m) => m.id === id)).filter((m): m is MetricDef => !!m);
  const off = all.filter((m) => !tiles.includes(m.id));
  const move = (i: number, by: number) =>
    item.update((d) => {
      const t = d.settings.today_tiles;
      const j = i + by;
      if (j < 0 || j >= t.length) return;
      [t[i], t[j]] = [t[j], t[i]];
    });
  return (
    <Section title="Today tiles" hint="What you log most, in the order you want it">
      <List>
        {on.map((m, i) => (
          <ListRow
            key={m.id}
            leading={<m.icon className="h-4 w-4 text-[var(--item-accent)]" />}
            title={m.label}
            trailing={
              <>
                <IconButton label={`Move ${m.label} up`} icon={ArrowUp} disabled={i === 0} onClick={() => move(i, -1)} />
                <IconButton label={`Move ${m.label} down`} icon={ArrowDown} disabled={i === on.length - 1} onClick={() => move(i, 1)} />
                <Toggle checked onChange={() => item.update((d) => void (d.settings.today_tiles = d.settings.today_tiles.filter((x) => x !== m.id)))} label={`Show ${m.label}`} />
              </>
            }
          />
        ))}
        {off.map((m) => (
          <ListRow
            key={m.id}
            leading={<m.icon className="h-4 w-4 text-[var(--text-muted)]" />}
            title={<span className="text-[var(--text-muted)]">{m.label}</span>}
            trailing={
              <Toggle
                checked={false}
                onChange={() =>
                  item.update((d) => {
                    if (d.settings.today_tiles.length < 24) d.settings.today_tiles.push(m.id);
                  })
                }
                label={`Show ${m.label}`}
              />
            }
          />
        ))}
      </List>
    </Section>
  );
}

function GoalSheet({ item, editing, onClose }: { item: H; editing: Goal | null; onClose: () => void }) {
  const data = item.data;
  const s = data.settings;
  const choices = allMetrics(data).filter((m) => m.kind !== "bp");
  const [metric, setMetric] = useState(editing?.metric ?? "weight");
  const def = metricDef(data, metric) ?? choices[0];
  const daily = def.agg === "sum" || def.id === "steps";
  const [mode, setMode] = useState<"target" | "range">(editing && editing.target === null ? "range" : "target");
  const conv = (v: number | null) => (v === null ? null : round(toDisplay(v, def.dim, s), 2));
  const [target, setTarget] = useState<number | null>(conv(editing?.target ?? null));
  const [low, setLow] = useState<number | null>(conv(editing?.low ?? null));
  const [high, setHigh] = useState<number | null>(conv(editing?.high ?? null));
  const [date, setDate] = useState(editing?.target_date ?? "");
  const unit = unitLabel(def, s);
  const valid = mode === "target" ? target !== null : low !== null && high !== null && low <= high;

  const save = () => {
    const back = (v: number | null) => (v === null ? null : round(fromDisplay(v, def.dim, s), 3));
    const rows = data.readings.filter((r) => r.metric === def.id);
    const ser = dailySeries(rows, def.id, def.agg);
    const cur = ser.length ? (def.smooth ? (() => { const t = ewma(ser, s.smoothing); return t[t.length - 1].v; })() : ser[ser.length - 1].v) : null;
    const t = mode === "target" ? back(target) : null;
    const direction: Goal["direction"] = mode === "range" ? "range" : daily ? "daily" : cur !== null && t !== null ? (t < cur ? "down" : "up") : def.higherIsBetter === false ? "down" : "up";
    const g: Goal = {
      metric: def.id,
      target: t,
      low: mode === "range" ? back(low) : null,
      high: mode === "range" ? back(high) : null,
      direction,
      target_date: date || null,
      start_value: editing?.metric === def.id && editing.start_value !== null ? editing.start_value : cur,
      start_day: editing?.metric === def.id && editing.start_day ? editing.start_day : todayISO(),
    };
    item.update((d) => {
      d.goals = d.goals.filter((x) => x.metric !== g.metric && x.metric !== editing?.metric);
      d.goals.push(g);
    });
    onClose();
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={editing ? "Edit goal" : "New goal"}
      footer={
        <>
          {editing && (
            <DeleteButton
              onDelete={() => {
                item.update((d) => {
                  d.goals = d.goals.filter((x) => x.metric !== editing.metric);
                });
                onClose();
              }}
            />
          )}
          <ItemButton variant="primary" block disabled={!valid} onClick={save}>
            Save
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Metric">
          <Select value={metric} onChange={(e) => setMetric(e.target.value)}>
            {choices.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        {!daily && (
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: "target", label: "A target" },
              { value: "range", label: "A healthy range" },
            ]}
          />
        )}
        {mode === "target" || daily ? (
          <Field label={`${daily ? "Each day" : "Target"}${unit ? ` (${def.id === "sleep" ? "hours" : unit})` : ""}`}>
            <NumberInput value={target} onChange={setTarget} ariaLabel="Target" />
          </Field>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label={`Low (${unit})`}>
              <NumberInput value={low} onChange={setLow} ariaLabel="Low" />
            </Field>
            <Field label={`High (${unit})`}>
              <NumberInput value={high} onChange={setHigh} ariaLabel="High" />
            </Field>
          </div>
        )}
        {!daily && mode === "target" && (
          <Field label="By (optional)">
            <TextInput type="date" value={date} min={todayISO()} onChange={(e) => setDate(e.target.value)} />
          </Field>
        )}
      </div>
    </Sheet>
  );
}

function CustomMetricSheet({ item, editing, onClose }: { item: H; editing: CustomMetric | null; onClose: () => void }) {
  const [c, setC] = useState<CustomMetric>(editing ?? { id: "", name: "", unit: "", aggregate: "avg", decimals: 1, higher_is_better: null });
  const set = (patch: Partial<CustomMetric>) => setC((cur) => ({ ...cur, ...patch }));
  const clash = item.data.custom_metrics.some((x) => x.id !== c.id && x.name.trim().toLowerCase() === c.name.trim().toLowerCase());
  const save = () => {
    item.update((d) => {
      if (editing) {
        const i = d.custom_metrics.findIndex((x) => x.id === editing.id);
        if (i >= 0) d.custom_metrics[i] = { ...c, name: c.name.trim(), unit: c.unit.trim() };
        return;
      }
      const base = (c.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "metric") as string;
      let id = `x_${base}`;
      let n = 2;
      while (d.custom_metrics.some((x) => x.id === id)) id = `x_${base}${n++}`;
      d.custom_metrics.push({ ...c, id: id.slice(0, 40), name: c.name.trim(), unit: c.unit.trim() });
      if (d.settings.today_tiles.length < 24) d.settings.today_tiles.push(id.slice(0, 40));
    });
    onClose();
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={editing ? "Edit metric" : "New metric"}
      footer={
        <>
          {editing && (
            <DeleteButton
              label="Delete metric"
              onDelete={() => {
                item.update((d) => {
                  d.custom_metrics = d.custom_metrics.filter((x) => x.id !== editing.id);
                  d.readings = d.readings.filter((r) => r.metric !== editing.id);
                  d.goals = d.goals.filter((g) => g.metric !== editing.id);
                  d.settings.today_tiles = d.settings.today_tiles.filter((t) => t !== editing.id);
                });
                onClose();
              }}
            />
          )}
          <ItemButton variant="primary" block disabled={!c.name.trim() || clash} onClick={save}>
            Save
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" hint={clash ? "You already have a metric with that name" : undefined}>
          <TextInput autoFocus value={c.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} placeholder="Caffeine" />
        </Field>
        <Field label="Unit">
          <TextInput value={c.unit} maxLength={20} onChange={(e) => set({ unit: e.target.value })} placeholder="mg" />
        </Field>
        <Field label="A day's entries…">
          <Select value={c.aggregate} onChange={(e) => set({ aggregate: e.target.value as CustomMetric["aggregate"] })}>
            <option value="sum">Add up (caffeine, minutes)</option>
            <option value="avg">Average (peak flow, pain)</option>
            <option value="last">Latest counts</option>
            <option value="max">Highest counts</option>
            <option value="min">Lowest counts</option>
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Decimals">
            <Select value={String(c.decimals)} onChange={(e) => set({ decimals: Number(e.target.value) })}>
              {[0, 1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Better when">
            <Select value={c.higher_is_better === null ? "" : c.higher_is_better ? "up" : "down"} onChange={(e) => set({ higher_is_better: e.target.value === "" ? null : e.target.value === "up" })}>
              <option value="">Neither</option>
              <option value="up">Higher</option>
              <option value="down">Lower</option>
            </Select>
          </Field>
        </div>
      </div>
    </Sheet>
  );
}

function ProviderSheet({ item, editing, onClose }: { item: H; editing: CareProvider | null; onClose: () => void }) {
  const [c, setC] = useState<CareProvider>(editing ?? { id: uid("c"), name: "", role: "", clinic: "", phone: "", email: "", address: "", notes: "" });
  const set = (patch: Partial<CareProvider>) => setC((cur) => ({ ...cur, ...patch }));
  return (
    <Sheet
      open
      onClose={onClose}
      title={editing ? editing.name : "Add to care team"}
      footer={
        <>
          {editing && (
            <DeleteButton
              onDelete={() => {
                item.update((d) => {
                  d.profile.care_team = d.profile.care_team.filter((x) => x.id !== editing.id);
                });
                onClose();
              }}
            />
          )}
          <ItemButton
            variant="primary"
            block
            disabled={!c.name.trim()}
            onClick={() => {
              item.update((d) => {
                const i = d.profile.care_team.findIndex((x) => x.id === c.id);
                const row = { ...c, name: c.name.trim() };
                if (i >= 0) d.profile.care_team[i] = row;
                else d.profile.care_team.push(row);
              });
              onClose();
            }}
          >
            Save
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name" hint="Type to pick from your Contacts">
            <PersonInput
              autoFocus
              contactsOnly
              value={c.name}
              maxLength={120}
              onChange={(v) => set({ name: v })}
              // Fills the blanks from the contact card; what's stored stays plain text.
              onPick={(x) =>
                setC((cur) => ({
                  ...cur,
                  name: x.name.slice(0, 120),
                  phone: cur.phone || x.phone.slice(0, 60),
                  email: cur.email || x.email.slice(0, 160),
                  clinic: cur.clinic || x.company.slice(0, 160),
                  address: cur.address || x.address.slice(0, 300),
                }))
              }
              placeholder="Dr Lee"
            />
          </Field>
          <Field label="Role">
            <TextInput value={c.role} maxLength={80} onChange={(e) => set({ role: e.target.value })} placeholder="GP" />
          </Field>
        </div>
        <Field label="Clinic">
          <TextInput value={c.clinic} maxLength={160} onChange={(e) => set({ clinic: e.target.value })} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Phone">
            <TextInput type="tel" value={c.phone} maxLength={60} onChange={(e) => set({ phone: e.target.value })} />
          </Field>
          <Field label="Email">
            <TextInput type="email" value={c.email} maxLength={160} onChange={(e) => set({ email: e.target.value })} />
          </Field>
        </div>
        <Field label="Address">
          <TextInput value={c.address} maxLength={300} onChange={(e) => set({ address: e.target.value })} />
        </Field>
        <Field label="Notes">
          <TextArea value={c.notes} maxLength={1000} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
      </div>
    </Sheet>
  );
}
