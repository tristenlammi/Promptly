import { ArrowDown, ArrowUp, Bell, Package, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useState } from "react";

import type { ItemViewProps } from "@/items/types";
import type { ItemHandle } from "@/items/useItem";
import { Card, Chip, Field, ItemButton, Page, Section, Segmented, Select, Stepper, TextInput, Toggle, uid } from "@/items/ui";

import { ChipPicker } from "./parts";
import { AISLES, ALLERGIES, CUISINES, DIETS, EQUIPMENT, SLOT_LABEL, SLOTS, WEEKDAYS, type MealPlanData, type Preferences, type Slot } from "./types";
import { UNIT_CHOICES, fmtQty, unitLabel } from "./units";
import { useWidth } from "./useWidth";

const COMMON_STAPLES = ["salt", "black pepper", "olive oil", "vegetable oil", "rice", "pasta", "flour", "sugar", "garlic", "onions", "soy sauce", "stock cubes", "ground cumin", "paprika", "dried oregano", "butter", "eggs", "milk"];

export function usePrefs(item: ItemHandle<MealPlanData>) {
  return (patch: Partial<Preferences>) =>
    item.update((d) => {
      Object.assign(d.preferences, patch);
    });
}

type ListPref = "diets" | "allergies" | "dislikes" | "cuisines" | "equipment";

/** A chip list changed on screen → apply just the additions and removals,
 *  so someone else's edit to the same list (an allergy added on another
 *  phone) isn't overwritten by this screen's copy. */
function useListPref(item: ItemHandle<MealPlanData>) {
  return (key: ListPref, next: string[]) => {
    const shown = item.data.preferences[key];
    const low = (x: string) => x.trim().toLowerCase();
    const added = next.filter((x) => !shown.some((y) => low(y) === low(x)));
    const removed = shown.filter((x) => !next.some((y) => low(y) === low(x))).map(low);
    item.update((d) => {
      const cur = d.preferences[key].filter((x) => !removed.includes(low(x)));
      for (const a of added) if (!cur.some((y) => low(y) === low(a))) cur.push(a);
      d.preferences[key] = cur;
    });
  };
}

export function KitchenView({ item, isPhone, ask }: ItemViewProps<MealPlanData>) {
  const data = item.data;
  const p = data.preferences;
  const set = usePrefs(item);
  const setList = useListPref(item);
  const can = item.canEdit;
  const toggleSlot = (s: Slot, on: boolean) =>
    item.update((d) => {
      const cur = d.preferences.slots;
      if (on && cur.includes(s) && cur.length > 1) d.preferences.slots = cur.filter((x) => x !== s);
      else if (!on && !cur.includes(s)) d.preferences.slots = SLOTS.filter((x) => x === s || cur.includes(x));
    });
  const [ref, width] = useWidth<HTMLDivElement>();
  return (
    <Page wide={!isPhone}>
      <div ref={ref} className={isPhone || width < 860 ? "flex flex-col gap-5" : "grid grid-cols-2 items-start gap-6"}>
        <div className="flex flex-col gap-5">
          <Pantry item={item} />
          <Section title="Household & diet">
            <Card className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-[var(--text)]">People to cook for</p>
                  <p className="text-xs text-[var(--text-muted)]">Default servings for planned meals</p>
                </div>
                <Stepper value={p.household_size} min={1} max={20} onChange={(v) => can && set({ household_size: v || 1 })} className="w-36" />
              </div>
              <Field label="Diets">
                <ChipPicker value={p.diets} onChange={(v) => setList("diets", v)} options={DIETS} disabled={!can} placeholder="Another diet…" />
              </Field>
              <Field label="Allergies & intolerances" hint="Strict: the assistant never plans a recipe containing these, and recipes with them are flagged.">
                <ChipPicker value={p.allergies} onChange={(v) => setList("allergies", v)} options={ALLERGIES} tone="danger" disabled={!can} placeholder="Another allergy…" />
              </Field>
              <Field label="Dislikes">
                <ChipPicker value={p.dislikes} onChange={(v) => setList("dislikes", v)} options={[]} disabled={!can} placeholder="Coriander, olives…" />
              </Field>
              <Field label="Cuisines you love">
                <ChipPicker value={p.cuisines} onChange={(v) => setList("cuisines", v)} options={CUISINES} disabled={!can} placeholder="Another cuisine…" />
              </Field>
            </Card>
          </Section>
        </div>
        <div className="flex flex-col gap-5">
          <Section title="Planning">
            <Card className="flex flex-col gap-4">
              <Field label="Meals to plan">
                <div className="flex flex-wrap gap-2">
                  {SLOTS.map((s) => {
                    const on = p.slots.includes(s);
                    return (
                      <Chip
                        key={s}
                        active={on}
                        className="h-10"
                        onClick={can ? () => toggleSlot(s, on) : undefined}
                      >
                        {SLOT_LABEL[s]}
                      </Chip>
                    );
                  })}
                </div>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Stepper label="Weeknight dinners (min)" value={p.weeknight_minutes ?? 0} min={0} max={600} step={5} onChange={(v) => set({ weeknight_minutes: v >= 5 ? v : null })} />
                <Stepper label="Weekends (min)" value={p.weekend_minutes ?? 0} min={0} max={900} step={15} onChange={(v) => set({ weekend_minutes: v >= 5 ? v : null })} />
              </div>
              <Field label="Budget">
                <Segmented value={p.budget} onChange={(v) => can && set({ budget: v })} options={[{ value: "low", label: "Tight" }, { value: "medium", label: "Normal" }, { value: "high", label: "Generous" }]} />
              </Field>
              <Field label="Cooking skill">
                <Segmented value={p.skill} onChange={(v) => can && set({ skill: v })} options={[{ value: "beginner", label: "Beginner" }, { value: "intermediate", label: "Confident" }, { value: "advanced", label: "Advanced" }]} />
              </Field>
              <Field label="Kitchen equipment">
                <ChipPicker value={p.equipment} onChange={(v) => setList("equipment", v)} options={EQUIPMENT} disabled={!can} placeholder="Other equipment…" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Week starts on">
                  <Select value={p.week_start} disabled={!can} onChange={(e) => set({ week_start: Number(e.target.value) })}>
                    {WEEKDAYS.map((w, i) => (
                      <option key={w} value={i}>
                        {w}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Units">
                  <Segmented value={p.units} onChange={(v) => can && set({ units: v })} options={[{ value: "metric", label: "Metric" }, { value: "imperial", label: "US" }]} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Calories / day (per person)" hint="Optional — or set targets in Meals & Macros">
                  <TextInput inputMode="numeric" disabled={!can} value={p.calories_per_day ?? ""} onChange={(e) => { const n = parseInt(e.target.value, 10); set({ calories_per_day: n >= 800 && n <= 6000 ? n : null }); }} placeholder="2000" />
                </Field>
                <Field label="Protein g / day">
                  <TextInput inputMode="numeric" disabled={!can} value={p.protein_g_per_day ?? ""} onChange={(e) => { const n = parseInt(e.target.value, 10); set({ protein_g_per_day: n >= 10 && n <= 400 ? n : null }); }} placeholder="100" />
                </Field>
              </div>
              <ItemButton variant="ghost" size="sm" className="self-start" icon={<Sparkles className="h-4 w-4 text-[var(--item-accent)]" />} onClick={() => ask("Review my preferences and suggest anything that would make my meal plans better (time limits, slots, budget, targets).")}>
                Review with AI
              </ItemButton>
            </Card>
          </Section>
          <Section title="Reminders" hint="Sent as Promptly notifications.">
            <Card className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-[var(--text)]"><Bell className="h-4 w-4 text-[var(--item-accent)]" /> Tomorrow's prep</p>
                  <p className="text-xs text-[var(--text-muted)]">The evening before a recipe that needs thawing, marinating or soaking</p>
                </div>
                <Toggle checked={p.prep_reminders} onChange={(v) => can && set({ prep_reminders: v })} label="Prep reminders" />
              </div>
              {p.prep_reminders && (
                <Field label="At">
                  <TextInput type="time" disabled={!can} value={p.prep_reminder_time} onChange={(e) => /^\d\d:\d\d$/.test(e.target.value) && set({ prep_reminder_time: e.target.value })} className="w-36" />
                </Field>
              )}
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--text)]">Shopping day</p>
                  <p className="text-xs text-[var(--text-muted)]">A nudge with what's on the list</p>
                </div>
                <Toggle checked={p.shopping_reminder} onChange={(v) => can && set({ shopping_reminder: v })} label="Shopping reminder" />
              </div>
              {p.shopping_reminder && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Day">
                    <Select value={p.shopping_day} disabled={!can} onChange={(e) => set({ shopping_day: Number(e.target.value) })}>
                      {WEEKDAYS.map((w, i) => (
                        <option key={w} value={i}>
                          {w}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="At">
                    <TextInput type="time" disabled={!can} value={p.shopping_time} onChange={(e) => /^\d\d:\d\d$/.test(e.target.value) && set({ shopping_time: e.target.value })} />
                  </Field>
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--text)]">Keep the screen on</p>
                  <p className="text-xs text-[var(--text-muted)]">While cooking and shopping</p>
                </div>
                <Toggle checked={p.keep_awake} onChange={(v) => can && set({ keep_awake: v })} label="Keep the screen on" />
              </div>
            </Card>
          </Section>
          <AisleOrder item={item} />
        </div>
      </div>
    </Page>
  );
}

function Pantry({ item }: { item: ItemHandle<MealPlanData> }) {
  const data = item.data;
  const can = item.canEdit;
  const [name, setName] = useState("");
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState("");
  const has = (n: string) => data.pantry.some((x) => x.name.toLowerCase() === n.toLowerCase());
  const add = (n: string, q: number | null = null, u = "") => {
    const id = uid("p");
    item.update((d) => {
      const clean = n.trim().slice(0, 120);
      if (!clean || d.pantry.length >= 400) return;
      const existing = d.pantry.find((x) => x.name.toLowerCase() === clean.toLowerCase());
      if (existing) Object.assign(existing, { qty: q, unit: u, staple: q === null });
      else d.pantry.push({ id, name: clean, qty: q, unit: u, staple: q === null });
    });
  };
  const staples = data.pantry.filter((x) => x.staple || x.qty === null);
  const stocked = data.pantry.filter((x) => !(x.staple || x.qty === null));
  return (
    <Section title="Pantry" hint="Skipped when the grocery list is built. Amounts are subtracted.">
      <Card className="flex flex-col gap-3">
        {can && (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const q = parseFloat(qty.replace(",", "."));
              add(name, Number.isFinite(q) && q > 0 ? q : null, Number.isFinite(q) && q > 0 ? unit : "");
              setName("");
              setQty("");
            }}
          >
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Add to pantry — rice, tinned tomatoes…" aria-label="Pantry item" className="min-w-0 basis-full" />
            <TextInput value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Amount (optional)" aria-label="Amount (optional)" inputMode="decimal" className="w-24 min-w-0 flex-1" />
            <Select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Unit" className="!w-28 shrink-0">
              {UNIT_CHOICES.map((u) => (
                <option key={u} value={u}>
                  {u ? unitLabel(u, 2) : "count"}
                </option>
              ))}
            </Select>
            <ItemButton type="submit" variant="primary" disabled={!name.trim()} icon={<Plus className="h-4 w-4" />} aria-label="Add to pantry" />
          </form>
        )}
        {data.pantry.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
            <Package className="h-4 w-4" /> Add what you always keep in stock — it's left off the grocery list.
          </p>
        ) : (
          <>
            {staples.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {staples.map((x) => (
                  <Chip
                    key={x.id}
                    active
                    onClick={can ? () => item.update((d) => { d.pantry = d.pantry.filter((y) => y.id !== x.id); }) : undefined}
                    icon={can ? <X className="h-3 w-3" /> : undefined}
                    className="h-9 md:h-8"
                  >
                    <span className="sr-only">Remove </span>
                    {x.name}
                  </Chip>
                ))}
              </div>
            )}
            {stocked.length > 0 && (
              <ul className="divide-y divide-[var(--border)]">
                {stocked.map((x) => (
                  <li key={x.id} className="flex min-h-[44px] items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{x.name}</span>
                    <span className="text-sm tabular-nums text-[var(--text-muted)]">{fmtQty(x.qty, x.unit)}</span>
                    {can && (
                      <button type="button" aria-label={`Remove ${x.name}`} onClick={() => item.update((d) => { d.pantry = d.pantry.filter((y) => y.id !== x.id); })} className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)]">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {can && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-[var(--text-muted)]">Quick add</p>
            <div className="flex flex-wrap gap-1.5">
              {COMMON_STAPLES.filter((s) => !has(s)).slice(0, 12).map((s) => (
                <Chip key={s} onClick={() => add(s)} icon={<Plus className="h-3 w-3" />}>
                  {s}
                </Chip>
              ))}
            </div>
          </div>
        )}
      </Card>
    </Section>
  );
}

function AisleOrder({ item }: { item: ItemHandle<MealPlanData> }) {
  const order = item.data.preferences.aisle_order;
  const can = item.canEdit;
  const [open, setOpen] = useState(false);
  // By aisle name, against the current order (not the index on screen).
  const move = (aisle: string, d: number) =>
    item.update((x) => {
      const o = [...x.preferences.aisle_order];
      const i = o.indexOf(aisle);
      const j = i + d;
      if (i < 0 || j < 0 || j >= o.length) return;
      [o[i], o[j]] = [o[j], o[i]];
      x.preferences.aisle_order = o;
    });
  return (
    <Section title="Store layout" hint="Order the aisles the way you walk your store.">
      <Card padded={false} className="overflow-hidden">
        {!open ? (
          <button type="button" onClick={() => setOpen(true)} className="flex min-h-[52px] w-full items-center px-4 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)]">
            <span className="min-w-0 flex-1 truncate text-[var(--text-muted)]">{order.slice(0, 6).map((a) => AISLES[a]).join(" → ")}…</span>
            <span className="ml-2 font-medium text-[var(--item-accent)]">Reorder</span>
          </button>
        ) : (
          <ol className="divide-y divide-[var(--border)]">
            {order.map((a, i) => (
              <li key={a} className="flex min-h-[48px] items-center gap-2 px-3">
                <span className="w-5 text-xs tabular-nums text-[var(--text-muted)]">{i + 1}</span>
                <span className="min-w-0 flex-1 text-sm text-[var(--text)]">{AISLES[a]}</span>
                {can && (
                  <>
                    <button type="button" aria-label={`Move ${AISLES[a]} up`} disabled={i === 0} onClick={() => move(a, -1)} className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] disabled:opacity-30">
                      <ArrowUp className="h-4 w-4" />
                    </button>
                    <button type="button" aria-label={`Move ${AISLES[a]} down`} disabled={i === order.length - 1} onClick={() => move(a, 1)} className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] disabled:opacity-30">
                      <ArrowDown className="h-4 w-4" />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </Section>
  );
}
