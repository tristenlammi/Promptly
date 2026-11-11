import { BookOpen, ChefHat, Check, Repeat2, Search, Trash2, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";

import type { ItemHandle } from "@/items/useItem";
import { Chip, Field, ItemButton, Segmented, Select, Sheet, Stepper, TextInput, addDays, fmtDay, todayISO, uid } from "@/items/ui";
import { cn } from "@/utils/cn";

import { allergenHits, allergenSummary, confirmAllergens, fmtDayNum, fmtMinutes, fmtMonthDay, fmtWeekday, matchesQuery, recipeTime, sortPlan, useSortedRecipes } from "./helpers";
import { Callout, RecipeThumb } from "./parts";
import { SLOT_LABEL, SLOTS, type MealPlanData, type PlanEntry, type Recipe, type Slot } from "./types";

/** Put a meal in the plan: one recipe-like entry, sorted in. The id is made
 *  by the caller, outside the mutator (``uid("m")``) — a mutator can run
 *  more than once and must add the same entry each time. */
export function addEntry(d: MealPlanData, e: PlanEntry): string {
  const id = e.id;
  if (d.plan.some((x) => x.id === id)) return id;
  d.plan.push({ ...e });
  sortPlan(d.plan);
  if (d.plan.length > 2950) d.plan.splice(0, d.plan.length - 2900);
  return id;
}

/** Recipe picker with search — for the plan cells and "what's for…". */
function RecipePicker({ data, onPick }: { data: MealPlanData; onPick: (r: Recipe) => void }) {
  const [q, setQ] = useState("");
  const sorted = useSortedRecipes(data.recipes);
  const list = useMemo(() => sorted.filter((r) => matchesQuery(r, q)).slice(0, 80), [sorted, q]);
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
        <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search recipes or ingredients" className="pl-9" aria-label="Search recipes" />
      </div>
      {list.length === 0 ? (
        <p className="px-1 py-6 text-center text-sm text-[var(--text-muted)]">{data.recipes.length ? "No recipe matches." : "Your recipe box is empty — add free text below, or import recipes first."}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          {list.map((r) => {
            const warn = allergenHits(r, data.preferences.allergies);
            return (
              <li key={r.id}>
                <button type="button" onClick={() => onPick(r)} className="flex min-h-[56px] w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--hover)]">
                  <RecipeThumb recipe={r} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-[var(--text)]">{r.title}</p>
                    <p className="truncate text-xs text-[var(--text-muted)]">
                      {[fmtMinutes(recipeTime(r)), r.cuisine, r.times_cooked ? `cooked ${r.times_cooked}×` : ""].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  {warn.length > 0 && (
                    <span title={`Contains ${warn.join(", ")}`} className="flex shrink-0 items-center gap-1 rounded-lg bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] px-2 py-1 text-xs font-semibold text-[var(--danger)]">
                      <TriangleAlert className="h-4 w-4" /> Allergen
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const QUICK = ["Leftovers", "Eat out", "Takeaway", "Something simple"];

/** What's for {slot} on {date}: a recipe, free text, or leftovers. */
export function AssignSheet({
  item,
  target,
  onClose,
}: {
  item: ItemHandle<MealPlanData>;
  target: { date: string; slot: Slot } | null;
  onClose: () => void;
}) {
  const data = item.data;
  const [mode, setMode] = useState<"recipe" | "other">("recipe");
  const [servings, setServings] = useState<number>(data.preferences.household_size);
  const [text, setText] = useState("");
  if (!target) return null;
  const cooks = data.plan
    .filter((e) => e.recipe_id && !e.leftovers_of && e.date < target.date && e.date >= addDays(target.date, -4))
    .slice(-6)
    .reverse();
  const put = (e: Partial<PlanEntry>) => {
    const recipe = e.recipe_id ? data.recipes.find((r) => r.id === e.recipe_id) : undefined;
    if (recipe && !confirmAllergens(recipe, data.preferences.allergies)) return;
    const id = uid("m");
    item.update((d) => {
      addEntry(d, { id, date: target.date, slot: target.slot, recipe_id: null, title: "", servings: servings === d.preferences.household_size ? null : servings, leftovers_of: null, note: "", cooked: false, ...e });
    });
    setText("");
    onClose();
  };
  return (
    <Sheet open onClose={onClose} size="lg" title={`${SLOT_LABEL[target.slot]} · ${fmtDay(target.date)}`}>
      <div className="flex flex-col gap-3">
        <div className="flex items-end gap-3">
          <Segmented
            className="flex-1"
            value={mode}
            onChange={setMode}
            options={[
              { value: "recipe", label: "Recipe" },
              { value: "other", label: "Leftovers / other" },
            ]}
          />
          <Stepper label="Servings" value={servings} min={1} max={40} onChange={setServings} className="w-36" />
        </div>
        {mode === "recipe" ? (
          <RecipePicker data={data} onPick={(r) => put({ recipe_id: r.id, title: r.title })} />
        ) : (
          <div className="flex flex-col gap-3">
            {cooks.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs font-medium text-[var(--text-muted)]">Leftovers from (cook once, eat twice)</p>
                <div className="flex flex-wrap gap-2">
                  {cooks.map((c) => (
                    <Chip key={c.id} onClick={() => put({ leftovers_of: c.id, recipe_id: c.recipe_id, title: c.title })} icon={<Repeat2 className="h-3.5 w-3.5" />} className="h-10">
                      {c.title} · {fmtWeekday(c.date)}
                    </Chip>
                  ))}
                </div>
              </div>
            )}
            <Field label="Or write it in">
              <div className="flex gap-2">
                <TextInput value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && text.trim() && put({ title: text.trim().slice(0, 200) })} placeholder="Pizza night, BBQ at Sam's…" />
                <ItemButton variant="primary" disabled={!text.trim()} onClick={() => put({ title: text.trim().slice(0, 200) })}>
                  Add
                </ItemButton>
              </div>
            </Field>
            <div className="flex flex-wrap gap-2">
              {QUICK.map((q) => (
                <Chip key={q} onClick={() => put({ title: q })} className="h-10">
                  {q}
                </Chip>
              ))}
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}

/** One planned meal: servings, cooked, leftovers, move, remove. */
export function MealSheet({
  item,
  entryId,
  onClose,
  onOpenRecipe,
  onCook,
}: {
  item: ItemHandle<MealPlanData>;
  entryId: string | null;
  onClose: () => void;
  onOpenRecipe: (id: string) => void;
  onCook: (entry: PlanEntry) => void;
}) {
  const data = item.data;
  const e = data.plan.find((x) => x.id === entryId);
  const [moveDay, setMoveDay] = useState<string | null>(null);
  const [moveSlot, setMoveSlot] = useState<Slot>("dinner");
  if (!e) return null;
  const recipe = data.recipes.find((r) => r.id === e.recipe_id);
  const source = e.leftovers_of ? data.plan.find((x) => x.id === e.leftovers_of) : null;
  const riders = data.plan.filter((x) => x.leftovers_of === e.id);
  const edit = (fn: (x: PlanEntry, d: MealPlanData) => void) =>
    item.update((d) => {
      const x = d.plan.find((y) => y.id === e.id);
      if (x) fn(x, d);
    });
  // The target comes from what the person saw; if someone else already
  // set it, nothing changes (no double count, no cancelling out).
  const toggleCooked = () => {
    const target = !e.cooked;
    item.update((d) => {
      const x = d.plan.find((y) => y.id === e.id);
      if (!x || x.cooked === target) return;
      x.cooked = target;
      const r = d.recipes.find((y) => y.id === x.recipe_id);
      if (r && !x.leftovers_of) {
        r.times_cooked = Math.max(0, (r.times_cooked || 0) + (target ? 1 : -1));
        if (target && (!r.last_cooked || r.last_cooked < x.date)) r.last_cooked = x.date;
      }
    });
  };
  const warn = recipe ? allergenSummary(recipe, data.preferences.allergies) : "";
  const days = Array.from({ length: 7 }, (_, i) => addDays(e.date, i + 1));
  const can = item.canEdit;
  return (
    <Sheet open onClose={onClose} title={e.title || recipe?.title || "Meal"} size="md">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-[var(--text-muted)]">
          {SLOT_LABEL[e.slot]} · {fmtDay(e.date, { long: true })}
          {source && <> · leftovers of {fmtWeekday(source.date)}'s cook</>}
          {riders.length > 0 && <> · also feeds {riders.map((r) => fmtWeekday(r.date)).join(", ")}</>}
        </p>
        {warn && (
          <Callout tone="danger" icon={<TriangleAlert className="h-4 w-4" />}>
            <b>Allergy warning:</b> contains {warn}. Swap it, or adapt the recipe before cooking.
          </Callout>
        )}
        <div className="grid grid-cols-2 gap-2">
          {recipe && (
            <ItemButton icon={<BookOpen className="h-4 w-4" />} onClick={() => onOpenRecipe(recipe.id)}>
              Recipe
            </ItemButton>
          )}
          {recipe && !e.leftovers_of && (
            <ItemButton variant="primary" icon={<ChefHat className="h-4 w-4" />} onClick={() => onCook(e)}>
              Cook
            </ItemButton>
          )}
        </div>
        {can && (
          <>
            <div className="flex items-center justify-between gap-3">
              <Stepper label="Servings" value={e.servings ?? data.preferences.household_size} min={1} max={40} onChange={(v) => edit((x, d) => (x.servings = v === d.preferences.household_size ? null : v))} className="w-40" />
              <ItemButton variant={e.cooked ? "primary" : "secondary"} icon={<Check className="h-4 w-4" />} onClick={toggleCooked} aria-pressed={e.cooked}>
                {e.cooked ? "Cooked" : "Mark cooked"}
              </ItemButton>
            </div>
            {recipe && !e.leftovers_of && (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs font-medium text-[var(--text-muted)]">Cook once, eat twice — leftovers on</p>
                <div className="flex flex-wrap gap-2">
                  {days.slice(0, 3).flatMap((day) =>
                    (["lunch", "dinner"] as Slot[]).map((slot) => (
                      <Chip
                        key={day + slot}
                        icon={<Repeat2 className="h-3.5 w-3.5" />}
                        className="h-10"
                        onClick={() => {
                          const id = uid("m");
                          item.update((d) => {
                            addEntry(d, { id, date: day, slot, recipe_id: e.recipe_id, title: e.title || recipe.title, servings: null, leftovers_of: e.id, note: "", cooked: false });
                          });
                        }}
                      >
                        {fmtWeekday(day)} {slot}
                      </Chip>
                    )),
                  )}
                </div>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium text-[var(--text-muted)]">Move to</p>
              <div className="flex flex-wrap items-center gap-2">
                {[addDays(e.date, -1), ...days.slice(0, 6)].map((day) => (
                  <Chip
                    key={day}
                    active={moveDay === day}
                    onClick={() => {
                      setMoveDay(day);
                      setMoveSlot(e.slot);
                    }}
                    className="h-10"
                  >
                    {day === todayISO() ? "Today" : `${fmtWeekday(day)} ${fmtMonthDay(day)}`}
                  </Chip>
                ))}
              </div>
              {moveDay && (
                <div className="flex gap-2">
                  <Select aria-label="Slot" value={moveSlot} onChange={(ev) => setMoveSlot(ev.target.value as Slot)} className="flex-1">
                    {SLOTS.map((s) => (
                      <option key={s} value={s}>
                        {SLOT_LABEL[s]}
                      </option>
                    ))}
                  </Select>
                  <ItemButton
                    variant="primary"
                    onClick={() => {
                      edit((x, d) => {
                        x.date = moveDay;
                        x.slot = moveSlot;
                        // Leftovers can't come before their cook.
                        for (const r of d.plan) if (r.leftovers_of === x.id && r.date <= moveDay) r.leftovers_of = null;
                        sortPlan(d.plan);
                      });
                      setMoveDay(null);
                      onClose();
                    }}
                  >
                    Move
                  </ItemButton>
                </div>
              )}
            </div>
            <Field label="Note">
              <TextInput value={e.note} onChange={(ev) => edit((x) => (x.note = ev.target.value.slice(0, 300)))} placeholder="Double the sauce, Sam's birthday…" />
            </Field>
            <ItemButton
              variant="ghost"
              className="self-start text-[var(--danger)]"
              icon={<Trash2 className="h-4 w-4" />}
              onClick={() => {
                item.update((d) => {
                  d.plan = d.plan.filter((x) => x.id !== e.id);
                  for (const r of d.plan) if (r.leftovers_of === e.id) r.leftovers_of = null;
                });
                onClose();
              }}
            >
              Remove from plan
            </ItemButton>
          </>
        )}
      </div>
    </Sheet>
  );
}

/** "Add to plan" from a recipe: pick a day and slot. */
export function AddToPlanSheet({
  item,
  recipe,
  servings,
  onClose,
}: {
  item: ItemHandle<MealPlanData>;
  recipe: Recipe | null;
  servings?: number;
  onClose: () => void;
}) {
  const prefs = item.data.preferences;
  const [day, setDay] = useState(todayISO());
  const [slot, setSlot] = useState<Slot>(prefs.slots.includes("dinner") ? "dinner" : prefs.slots[0] ?? "dinner");
  const [n, setN] = useState(servings ?? prefs.household_size);
  if (!recipe) return null;
  const days = Array.from({ length: 14 }, (_, i) => addDays(todayISO(), i));
  const taken = (d: string) => item.data.plan.filter((e) => e.date === d && e.slot === slot);
  return (
    <Sheet
      open
      onClose={onClose}
      title={`Plan “${recipe.title}”`}
      footer={
        <ItemButton
          variant="primary"
          block
          onClick={() => {
            if (!confirmAllergens(recipe, prefs.allergies)) return;
            const id = uid("m");
            item.update((d) => {
              addEntry(d, { id, date: day, slot, recipe_id: recipe.id, title: recipe.title, servings: n === d.preferences.household_size ? null : n, leftovers_of: null, note: "", cooked: false });
            });
            onClose();
          }}
        >
          Add to {fmtDay(day)}
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-4">
        {allergenHits(recipe, prefs.allergies).length > 0 && (
          <Callout tone="danger" icon={<TriangleAlert className="h-4 w-4" />}>
            <b>Allergy warning:</b> contains {allergenSummary(recipe, prefs.allergies)}.
          </Callout>
        )}
        <Segmented value={slot} onChange={setSlot} options={SLOTS.map((s) => ({ value: s, label: SLOT_LABEL[s] }))} size="sm" />
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
          {days.map((d) => {
            const t = taken(d);
            return (
              <button
                key={d}
                type="button"
                onClick={() => setDay(d)}
                aria-pressed={d === day}
                className={cn(
                  "flex min-h-[60px] flex-col items-center justify-center rounded-xl border px-1 text-center transition",
                  d === day ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_12%,transparent)]" : "border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--hover)]",
                )}
              >
                <span className="text-[11px] text-[var(--text-muted)]">{fmtWeekday(d)}</span>
                <span className="text-base font-semibold tabular-nums text-[var(--text)]">{fmtDayNum(d)}</span>
                {t.length > 0 && <span className="h-1.5 w-1.5 rounded-full bg-[var(--item-accent-fill)]" title={t.map((x) => x.title).join(", ")} />}
              </button>
            );
          })}
        </div>
        {taken(day).length > 0 && <p className="text-xs text-[var(--text-muted)]">Already planned: {taken(day).map((x) => x.title).join(", ")} — this adds another.</p>}
        <Stepper label="Servings" value={n} min={1} max={40} onChange={setN} className="w-40" />
      </div>
    </Sheet>
  );
}
