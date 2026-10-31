import { ArrowDown, ArrowUp, Bell, Calculator, Plus, Salad, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import type { ItemHandle } from "@/items/useItem";
import {
  Card,
  Chip,
  Field,
  IconButton,
  ItemButton,
  Page,
  Section,
  Segmented,
  Select,
  Sheet,
  TextInput,
  Toggle,
  fmtNum,
  uid,
} from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { NumberInput } from "./components";
import {
  ACTIVITY_OPTIONS,
  DIET_TAGS,
  MACRO_COLOR,
  MAX_VISIBLE_SLOTS,
  meals,
  visibleSlots,
  STYLE_OPTIONS,
  WEEKDAYS,
  WEEKDAY_LABEL,
  errorText,
  fmtEnergy,
  kcalFromMacros,
  macroSplit,
  toKcal,
  energy,
  weightIn,
  weightOut,
} from "./lib";
import type { Activity, DietStyle, Goal, MealSlot, MealsData, Profile } from "./types";

type ProfileDraft = Pick<Profile, "sex" | "birth_year" | "height_cm" | "weight_kg" | "activity" | "goal" | "rate_pct" | "diet_style" | "goal_weight_kg">;

const RATES = {
  lose: [0.25, 0.5, 0.75, 1.0],
  gain: [0.1, 0.25, 0.5],
};

export function ProfileForm({ item, onDone, compact }: { item: ItemHandle<MealsData>; onDone?: () => void; compact?: boolean }) {
  const s = meals(item.data).settings;
  const p = meals(item.data).profile;
  const [d, setD] = useState<ProfileDraft>({
    sex: p.sex,
    birth_year: p.birth_year,
    height_cm: p.height_cm,
    weight_kg: p.weight_kg,
    activity: p.activity,
    goal: p.goal,
    rate_pct: p.rate_pct || 0.5,
    diet_style: p.diet_style,
    goal_weight_kg: p.goal_weight_kg,
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const ready = !!(d.birth_year && d.height_cm && d.weight_kg);
  const weeklyKg = d.weight_kg && d.goal !== "maintain" ? (d.weight_kg * d.rate_pct) / 100 : null;

  const run = async () => {
    setBusy(true);
    try {
      const r = await item.runAction("compute_targets", {
        sex: d.sex ?? undefined,
        birth_year: d.birth_year ?? undefined,
        height_cm: d.height_cm ?? undefined,
        weight_kg: d.weight_kg ?? undefined,
        activity: d.activity,
        goal: d.goal,
        rate_pct: d.goal === "maintain" ? 0 : d.rate_pct,
        diet_style: d.diet_style,
        goal_weight_kg: d.goal_weight_kg ?? undefined,
      });
      setResult(r.summary);
      toast.success("Targets updated");
      onDone?.();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className={cn("grid gap-3", compact ? "grid-cols-2" : "grid-cols-2 md:grid-cols-4")}>
        <Group label="Sex (for the BMR formula)" className={compact ? "col-span-2" : "col-span-2 md:col-span-1"}>
          <Segmented
            value={(d.sex ?? "unset") as "male" | "female" | "unset"}
            onChange={(v) => setD({ ...d, sex: v === "unset" ? null : v })}
            options={[
              { value: "female", label: "Female" },
              { value: "male", label: "Male" },
              { value: "unset", label: "Skip" },
            ]}
          />
        </Group>
        <Field label="Birth year">
          <NumberInput ariaLabel="Birth year" allowEmpty value={d.birth_year} onChange={(v) => setD({ ...d, birth_year: v ? Math.round(v) : null })} placeholder="e.g. 1990" />
        </Field>
        <Field label="Height" hint={d.height_cm ? `${Math.floor(d.height_cm / 30.48)}′${Math.round((d.height_cm / 2.54) % 12)}″` : undefined}>
          <NumberInput ariaLabel="Height in cm" allowEmpty value={d.height_cm} onChange={(v) => setD({ ...d, height_cm: v })} suffix="cm" placeholder="e.g. 170" />
        </Field>
        <Field label="Weight">
          <NumberInput
            ariaLabel={`Weight in ${s.weight_unit}`}
            allowEmpty
            value={d.weight_kg ? Math.round(weightOut(d.weight_kg, s) * 10) / 10 : null}
            onChange={(v) => setD({ ...d, weight_kg: v ? Math.round(weightIn(v, s) * 10) / 10 : null })}
            suffix={s.weight_unit}
          />
        </Field>
      </div>
      <Field label="Activity">
        <Select value={d.activity} onChange={(e) => setD({ ...d, activity: e.target.value as Activity })}>
          {ACTIVITY_OPTIONS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label} — {a.hint}
            </option>
          ))}
        </Select>
      </Field>
      <Group label="Goal">
        <Segmented
          className="w-full"
          value={d.goal}
          onChange={(v: Goal) => setD({ ...d, goal: v, rate_pct: v === "gain" ? 0.25 : v === "lose" ? 0.5 : d.rate_pct })}
          options={[
            { value: "lose", label: "Lose" },
            { value: "maintain", label: "Maintain" },
            { value: "gain", label: "Gain" },
          ]}
        />
      </Group>
      {d.goal !== "maintain" && (
        <Group label="Pace" hint={weeklyKg ? `≈ ${fmtNum(weightOut(weeklyKg, s), 2)} ${s.weight_unit} a week. ${d.goal === "lose" ? "0.5–1% a week is sustainable and protects muscle." : "Slow gains keep most of it lean."}` : "Enter your weight to see this per week."}>
          <div className="flex flex-wrap gap-2">
            {RATES[d.goal].map((r) => (
              <Chip key={r} active={d.rate_pct === r} onClick={() => setD({ ...d, rate_pct: r })}>
                {r}% / week
              </Chip>
            ))}
          </div>
        </Group>
      )}
      <Field label="Diet style">
        <Select value={d.diet_style} onChange={(e) => setD({ ...d, diet_style: e.target.value as DietStyle })}>
          {STYLE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      <ItemButton variant="primary" size="lg" icon={<Calculator className="h-4 w-4" />} disabled={!ready || busy || !item.canEdit} onClick={() => void run()}>
        {busy ? "Working it out…" : "Calculate my targets"}
      </ItemButton>
      {!ready && <p className="text-xs text-[var(--text-muted)]">Birth year, height and weight are needed for the Mifflin-St Jeor formula.</p>}
      {result && <p className="text-sm text-[var(--text)]" aria-live="polite">{result}</p>}
    </div>
  );
}

export function TargetsView({ item, isPhone, ask }: ItemViewProps<MealsData>) {
  const data = meals(item.data);
  const t = data.targets;
  const s = data.settings;
  const b = t.basis ?? {};
  const split = macroSplit(t);
  const macroKcal = kcalFromMacros(t.protein, t.carbs, t.fat);
  const off = t.kcal ? Math.abs(macroKcal - t.kcal) / t.kcal > 0.05 : false;
  const setT = (patch: Partial<MealsData["targets"]>, custom = true) => {
    const extra = custom ? { mode: "custom" as const, updated: new Date().toISOString() } : {};
    item.update((d) => {
      Object.assign(d.targets, patch, extra);
    });
  };
  const hasWeekday = Object.keys(t.weekday ?? {}).length > 0;
  const [weekdayOpen, setWeekdayOpen] = useState(hasWeekday);

  return (
    <Page wide={!isPhone}>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="flex flex-col gap-5">
          <Section
            title="Daily targets"
            hint={t.mode === "auto" ? "Calculated from your profile" : "Custom"}
            action={
              <ItemButton size="sm" icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Explain my calorie and macro targets and whether they suit my goal.")}>
                Explain
              </ItemButton>
            }
          >
            <Card className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label={`Energy (${s.energy_unit})`}>
                  <NumberInput ariaLabel="Energy target" value={Math.round(energy(t.kcal, s))} onChange={(v) => v && setT({ kcal: Math.round(toKcal(v, s)) })} />
                </Field>
                <Field label="Protein (g)">
                  <NumberInput ariaLabel="Protein target" value={t.protein} onChange={(v) => v !== null && setT({ protein: Math.max(0, Math.round(v)) })} />
                </Field>
                <Field label="Carbs (g)">
                  <NumberInput ariaLabel="Carbs target" value={t.carbs} onChange={(v) => v !== null && setT({ carbs: Math.max(0, Math.round(v)) })} />
                </Field>
                <Field label="Fat (g)">
                  <NumberInput ariaLabel="Fat target" value={t.fat} onChange={(v) => v !== null && setT({ fat: Math.max(0, Math.round(v)) })} />
                </Field>
              </div>
              <div className="flex h-3 w-full overflow-hidden rounded-full" aria-hidden>
                <span style={{ width: `${split.protein * 100}%`, background: MACRO_COLOR.protein }} />
                <span style={{ width: `${split.carbs * 100}%`, background: MACRO_COLOR.carbs }} />
                <span style={{ width: `${split.fat * 100}%`, background: MACRO_COLOR.fat }} />
              </div>
              <p className="text-xs tabular-nums text-[var(--text-muted)]">
                Protein {Math.round(split.protein * 100)}% · carbs {Math.round(split.carbs * 100)}% · fat {Math.round(split.fat * 100)}%
                {data.profile.weight_kg ? ` · ${fmtNum(t.protein / data.profile.weight_kg, 1)} g protein per kg` : ""}
              </p>
              {off && item.canEdit && (
                <div className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--text)]">
                  <span className="flex-1">The macros add up to {fmtEnergy(macroKcal, s, true)}, not {fmtEnergy(t.kcal, s, true)}.</span>
                  <ItemButton size="sm" onClick={() => setT({ carbs: Math.max(0, Math.round((t.kcal - t.protein * 4 - t.fat * 9) / 4)) })}>
                    Adjust carbs
                  </ItemButton>
                  <ItemButton size="sm" variant="ghost" onClick={() => setT({ kcal: Math.round(macroKcal) })}>
                    Use {fmtEnergy(macroKcal, s)}
                  </ItemButton>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Fibre (g)">
                  <NumberInput ariaLabel="Fibre target" value={t.fibre} onChange={(v) => v !== null && setT({ fibre: Math.max(0, v) }, false)} />
                </Field>
                <Field label="Water (ml)">
                  <NumberInput ariaLabel="Water target" value={t.water_ml} onChange={(v) => v !== null && setT({ water_ml: Math.max(0, Math.round(v)) }, false)} />
                </Field>
                <Field label="Sodium limit (mg)">
                  <NumberInput ariaLabel="Sodium limit" value={t.sodium} onChange={(v) => v !== null && setT({ sodium: Math.max(0, v) }, false)} />
                </Field>
                <Field label="Sugar limit (g, optional)">
                  <NumberInput ariaLabel="Sugar limit" allowEmpty value={t.sugar} onChange={(v) => setT({ sugar: v && v > 0 ? v : null }, false)} />
                </Field>
              </div>
              {b.tdee && (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-xl bg-[var(--surface-2)] px-3 py-2 text-xs">
                  {b.bmr && (
                    <>
                      <dt className="text-[var(--text-muted)]">BMR (Mifflin-St Jeor)</dt>
                      <dd className="text-right tabular-nums">{fmtEnergy(Number(b.bmr), s, true)}</dd>
                    </>
                  )}
                  <dt className="text-[var(--text-muted)]">Maintenance ({b.tdee_source === "adaptive" ? "adaptive" : `× ${b.multiplier}`})</dt>
                  <dd className="text-right tabular-nums">{fmtEnergy(Number(b.tdee), s, true)}</dd>
                  <dt className="text-[var(--text-muted)]">Goal adjustment</dt>
                  <dd className="text-right tabular-nums">{Number(b.delta) > 0 ? "+" : ""}{fmtEnergy(Number(b.delta), s, true)}</dd>
                  {b.notes && <dd className="col-span-2 pt-1 text-[var(--text-muted)]">{String(b.notes)}</dd>}
                </dl>
              )}
            </Card>
          </Section>

          <Section
            title="Different targets on some days"
            hint="e.g. more carbs on training days — keep the weekly average in mind"
            action={<Toggle checked={weekdayOpen} onChange={(v) => { setWeekdayOpen(v); if (!v) setT({ weekday: {} }); }} label="Per-weekday targets" />}
          >
            {weekdayOpen && (
              <Card className="flex flex-col gap-2">
                {WEEKDAYS.map((wd) => {
                  const o = t.weekday?.[wd] ?? {};
                  return (
                    <div key={wd} className="grid grid-cols-[48px_1fr_1fr] items-center gap-2">
                      <span className="text-sm font-medium text-[var(--text)]">{WEEKDAY_LABEL[wd]}</span>
                      <NumberInput
                        ariaLabel={`${WEEKDAY_LABEL[wd]} energy`}
                        allowEmpty
                        placeholder={fmtEnergy(t.kcal, s)}
                        suffix={s.energy_unit}
                        value={o.kcal ? Math.round(energy(o.kcal, s)) : null}
                        onChange={(v) =>
                          item.update((d) => {
                            const cur = { ...(d.targets.weekday[wd] ?? {}) };
                            cur.kcal = v ? Math.round(toKcal(v, s)) : null;
                            if (!cur.kcal && !cur.carbs && !cur.protein && !cur.fat) delete d.targets.weekday[wd];
                            else d.targets.weekday[wd] = cur;
                          })
                        }
                      />
                      <NumberInput
                        ariaLabel={`${WEEKDAY_LABEL[wd]} carbs`}
                        allowEmpty
                        placeholder={`${fmtNum(t.carbs)}`}
                        suffix="g C"
                        value={o.carbs ?? null}
                        onChange={(v) =>
                          item.update((d) => {
                            const cur = { ...(d.targets.weekday[wd] ?? {}) };
                            cur.carbs = v ? Math.round(v) : null;
                            if (!cur.kcal && !cur.carbs && !cur.protein && !cur.fat) delete d.targets.weekday[wd];
                            else d.targets.weekday[wd] = cur;
                          })
                        }
                      />
                    </div>
                  );
                })}
                <p className="text-xs text-[var(--text-muted)]">Blank uses the daily target.</p>
              </Card>
            )}
          </Section>
          {!isPhone && <MealsAndReminders item={item} />}
        </div>

        <div className="flex flex-col gap-5">
          <Section title="Your profile & goal" hint="Recalculate whenever your weight or routine changes">
            <Card>
              <ProfileForm item={item} compact />
            </Card>
          </Section>
          {isPhone && <MealsAndReminders item={item} />}
          <Preferences item={item} />
        </div>
      </div>
    </Page>
  );
}

function MealsAndReminders({ item }: { item: ItemHandle<MealsData> }) {
  const data = meals(item.data);
  const s = data.settings;
  const shown = visibleSlots(s);
  const [removing, setRemoving] = useState<MealSlot | null>(null);
  const update = (fn: (d: MealsData) => void) => item.update(fn);
  // Every change finds the meal by its id (never by position: the list may
  // have changed elsewhere since this screen drew it).
  const editSlot = (id: string, fn: (x: MealSlot) => void) =>
    update((d) => {
      const x = d.settings.meal_slots.find((m) => m.id === id);
      if (x) fn(x);
    });
  const used = useMemo(() => {
    const m = new Map<string, number>();
    for (const day of Object.values(data.days)) for (const e of day.entries) m.set(e.slot, (m.get(e.slot) ?? 0) + 1);
    for (const ml of data.meals) if (ml.slot) m.set(ml.slot, (m.get(ml.slot) ?? 0) + 1);
    return m;
  }, [data.days, data.meals]);
  const removeSlot = (id: string) => {
    const keep = (used.get(id) ?? 0) > 0;
    update((d) => {
      if (d.settings.meal_slots.filter((x) => !x.hidden).length <= 1) return;
      if (keep) {
        // History stays exactly where it is; the meal is only hidden (past
        // days still show it).
        const x = d.settings.meal_slots.find((m) => m.id === id);
        if (x) Object.assign(x, { hidden: true, remind_at: null });
      } else d.settings.meal_slots = d.settings.meal_slots.filter((x) => x.id !== id);
    });
  };
  const move = (id: string, by: number) =>
    update((d) => {
      const arr = d.settings.meal_slots;
      const vis = arr.filter((x) => !x.hidden);
      const i = vis.findIndex((x) => x.id === id);
      const other = vis[i + by];
      if (i < 0 || !other) return;
      const a = arr.findIndex((x) => x.id === id);
      const b = arr.findIndex((x) => x.id === other.id);
      [arr[a], arr[b]] = [arr[b], arr[a]];
    });
  const restore = (id: string) => editSlot(id, (x) => void (x.hidden = false));
  const addSlot = () => {
    const slot: MealSlot = { id: uid("slot"), name: "New meal", remind_at: null, hidden: false };
    update((d) => {
      if (d.settings.meal_slots.filter((x) => !x.hidden).length < MAX_VISIBLE_SLOTS) d.settings.meal_slots.push(slot);
    });
  };
  const hidden = s.meal_slots.filter((x) => x.hidden);
  return (
    <Section title="Meals & reminders" hint="Rename, reorder or add meals; get a nudge if you haven't logged one">
      <Card className="flex flex-col gap-3">
        {shown.map((sl, i) => (
          <div key={sl.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--border)] pb-3 last:border-0 last:pb-0">
            <SlotName value={sl.name} disabled={!item.canEdit} onCommit={(name) => editSlot(sl.id, (x) => void (x.name = name))} />
            <TextInput
              type="time"
              aria-label={`Reminder time for ${sl.name}`}
              disabled={!item.canEdit}
              value={sl.remind_at ?? ""}
              onChange={(e) => {
                const at = e.target.value || null;
                editSlot(sl.id, (x) => void (x.remind_at = at));
              }}
              className="w-[118px] shrink-0"
            />
            <div className="ml-auto flex shrink-0 items-center">
            <IconButton label={`Move ${sl.name} up`} icon={ArrowUp} disabled={i === 0 || !item.canEdit} onClick={() => move(sl.id, -1)} />
            <IconButton label={`Move ${sl.name} down`} icon={ArrowDown} disabled={i === shown.length - 1 || !item.canEdit} onClick={() => move(sl.id, 1)} />
            <IconButton label={`Remove ${sl.name}`} icon={Trash2} disabled={shown.length <= 1 || !item.canEdit} onClick={() => setRemoving(sl)} />
            </div>
          </div>
        ))}
        {item.canEdit && shown.length < MAX_VISIBLE_SLOTS && (
          <ItemButton size="sm" icon={<Plus className="h-4 w-4" />} className="self-start" onClick={addSlot}>
            Add a meal
          </ItemButton>
        )}
        {hidden.length > 0 && (
          <div className="flex flex-col gap-1 border-t border-[var(--border)] pt-3">
            <p className="text-xs text-[var(--text-muted)]">Removed meals (their past entries are kept and still show on those days):</p>
            <div className="flex flex-wrap gap-2">
              {hidden.map((x) => (
                <Chip key={x.id} onClick={item.canEdit && shown.length < MAX_VISIBLE_SLOTS ? () => restore(x.id) : undefined}>
                  {x.name}
                  {item.canEdit && shown.length < MAX_VISIBLE_SLOTS ? " · restore" : ""}
                </Chip>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] pt-3">
          <span className="flex items-center gap-2 text-sm text-[var(--text)]">
            <Bell className="h-4 w-4 text-[var(--text-muted)]" /> Meal-logging reminders
          </span>
          <Toggle checked={s.reminders} onChange={(v) => update((d) => void (d.settings.reminders = v))} label="Meal-logging reminders" />
        </div>
        {s.reminders && (
          <>
            {!shown.some((x) => x.remind_at) && <p className="text-xs text-[var(--text-muted)]">Set a time next to the meals you want a nudge for. Meals you've already logged are skipped.</p>}
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-[var(--text)]">Evening “finish your log” nudge</span>
              <TextInput
                type="time"
                aria-label="Evening nudge time"
                value={s.close_day_at ?? ""}
                onChange={(e) => {
                  const at = e.target.value || null;
                  update((d) => void (d.settings.close_day_at = at));
                }}
                className="w-[118px]"
              />
            </div>
          </>
        )}
      </Card>
      <Sheet
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={removing ? `Remove ${removing.name}?` : ""}
        size="sm"
        footer={
          <>
            <ItemButton variant="ghost" onClick={() => setRemoving(null)}>
              Cancel
            </ItemButton>
            <ItemButton
              variant="danger"
              block
              onClick={() => {
                if (removing) removeSlot(removing.id);
                setRemoving(null);
              }}
            >
              Remove meal
            </ItemButton>
          </>
        }
      >
        {removing && (
          <p className="text-sm text-[var(--text)]">
            {(used.get(removing.id) ?? 0) > 0
              ? `${removing.name} has ${used.get(removing.id)} logged item${used.get(removing.id) === 1 ? "" : "s"}. They stay exactly as logged and still show under “${removing.name}” on those days — it just won't appear on new days. You can restore it later.`
              : `${removing.name} has nothing logged, so it's simply removed.`}
          </p>
        )}
      </Sheet>
    </Section>
  );
}

function SlotName({ value, onCommit, disabled }: { value: string; onCommit: (v: string) => void; disabled?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <TextInput
      aria-label="Meal name"
      value={v}
      disabled={disabled}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const n = v.trim().slice(0, 40);
        if (n && n !== value) onCommit(n);
        else setV(value);
      }}
      className="min-w-[150px] flex-1"
    />
  );
}

function Preferences({ item }: { item: ItemHandle<MealsData> }) {
  const s = meals(item.data).settings;
  const p = meals(item.data).profile;
  const update = (fn: (d: MealsData) => void) => item.update(fn);
  const [allergies, setAllergies] = useState(p.allergies);
  const [dislikes, setDislikes] = useState(p.dislikes);
  useEffect(() => setAllergies(p.allergies), [p.allergies]);
  useEffect(() => setDislikes(p.dislikes), [p.dislikes]);
  const tags = useMemo(() => new Set(p.diet_tags), [p.diet_tags]);
  return (
    <>
      <Section title="Diet" hint="The assistant's suggestions respect these">
        <Card className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {DIET_TAGS.map((t) => (
              <Chip
                key={t}
                active={tags.has(t.toLowerCase())}
                onClick={() => {
                  if (!item.canEdit) return;
                  const k = t.toLowerCase();
                  const on = !tags.has(k); // decided from what you saw, not re-toggled on replay
                  update((d) => {
                    if (on && !d.profile.diet_tags.includes(k)) d.profile.diet_tags.push(k);
                    if (!on) d.profile.diet_tags = d.profile.diet_tags.filter((x) => x !== k);
                  });
                }}
              >
                {t}
              </Chip>
            ))}
          </div>
          <Field label="Allergies & intolerances">
            <TextInput value={allergies} disabled={!item.canEdit} onChange={(e) => setAllergies(e.target.value)} onBlur={() => allergies !== p.allergies && update((d) => void (d.profile.allergies = allergies.slice(0, 300)))} placeholder="Peanuts, lactose" />
          </Field>
          <Field label="Foods you don't like">
            <TextInput value={dislikes} disabled={!item.canEdit} onChange={(e) => setDislikes(e.target.value)} onBlur={() => dislikes !== p.dislikes && update((d) => void (d.profile.dislikes = dislikes.slice(0, 300)))} placeholder="Mushrooms, olives" />
          </Field>
        </Card>
      </Section>
      <Section title="Units & display">
        <Card className="flex flex-col gap-3">
          <Row label="Energy">
            <Segmented size="sm" value={s.energy_unit} onChange={(v) => update((d) => void (d.settings.energy_unit = v))} options={[{ value: "kcal", label: "kcal" }, { value: "kJ", label: "kJ" }]} />
          </Row>
          <Row label="Body weight">
            <Segmented size="sm" value={s.weight_unit} onChange={(v) => update((d) => void (d.settings.weight_unit = v))} options={[{ value: "kg", label: "kg" }, { value: "lb", label: "lb" }]} />
          </Row>
          <Row label="Water">
            <Segmented size="sm" value={s.water_unit} onChange={(v) => update((d) => void (d.settings.water_unit = v))} options={[{ value: "ml", label: "ml" }, { value: "floz", label: "fl oz" }]} />
          </Row>
          <Row label="Water button adds">
            <Select value={String(s.water_step_ml)} onChange={(e) => update((d) => void (d.settings.water_step_ml = Number(e.target.value)))} className="w-auto" aria-label="Water step">
              {[150, 200, 250, 330, 500, 750].map((n) => (
                <option key={n} value={n}>
                  {n} ml
                </option>
              ))}
            </Select>
          </Row>
          <Row label="Show vitamins & minerals">
            <Toggle checked={s.show_micros} onChange={(v) => update((d) => void (d.settings.show_micros = v))} label="Show vitamins and minerals" />
          </Row>
        </Card>
      </Section>
      <p className="flex items-start gap-2 px-1 text-xs text-[var(--text-muted)]">
        <Salad className="mt-px h-3.5 w-3.5 shrink-0" />
        General nutrition guidance, not medical advice. If you're pregnant, managing a health condition, or food feels stressful, a doctor or registered dietitian can tailor this safely.
      </p>
    </>
  );
}

function Group({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <div role="group" aria-label={label} className={cn("flex flex-col gap-1", className)}>
      <span className="text-xs font-medium text-[var(--text-muted)]">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-[var(--text-muted)]">{hint}</span>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-3">
      <span className="text-sm text-[var(--text)]">{label}</span>
      {children}
    </div>
  );
}

export function Onboarding({ item, ask }: ItemViewProps<MealsData>) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-5 px-4 py-6 md:py-10">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] text-[var(--item-accent)]">
          <Salad className="h-7 w-7" />
        </span>
        <h1 className="text-xl font-semibold text-[var(--text)]">Let's set your targets</h1>
        <p className="max-w-md text-sm text-[var(--text-muted)]">
          A few details give you calorie and macro targets (Mifflin-St Jeor × activity). As you log, an adaptive estimate learns your real maintenance calories.
        </p>
      </div>
      <Card>
        <ProfileForm item={item} compact />
      </Card>
      <div className="flex flex-wrap justify-center gap-2">
        <ItemButton variant="ghost" onClick={() => item.update((d) => void (d.profile.onboarded = true))}>
          Skip — I'll set targets myself
        </ItemButton>
        <ItemButton
          variant="ghost"
          icon={<Sparkles className="h-4 w-4" />}
          onClick={() => {
            item.update((d) => void (d.profile.onboarded = true));
            ask("Help me set up my calorie and macro targets — ask me what you need.");
          }}
        >
          Set up with the assistant
        </ItemButton>
      </div>
    </div>
  );
}
