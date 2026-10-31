import { BookOpen, CalendarDays, ChefHat, ShoppingCart, Sparkles } from "lucide-react";
import { useState } from "react";

import type { ItemModule, ItemViewProps } from "@/items/types";
import { Card, Field, ItemButton, Page, Segmented, Stepper } from "@/items/ui";
import { toast } from "@/store/toastStore";

import { GroceryView } from "./GroceryView";
import { KitchenView } from "./KitchenView";
import { ChipPicker } from "./parts";
import { PlanView } from "./PlanView";
import { RecipesView } from "./RecipesView";
import { ALLERGIES, DIETS, SLOT_LABEL, SLOTS, type MealPlanData, type Slot } from "./types";

/*
 * Meal Planner — recipe box, weekly plan, grocery list and pantry in one
 * file (replaces Mealime and Plan to Eat). Tabs: Plan (the
 * week, today first), Groceries, Recipes (box + detail + cook mode),
 * Kitchen (pantry and preferences).
 */

function Onboarding({ item, ask }: ItemViewProps<MealPlanData>) {
  const p = item.data.preferences;
  const [household, setHousehold] = useState(p.household_size);
  const [diets, setDiets] = useState<string[]>(p.diets);
  const [allergies, setAllergies] = useState<string[]>(p.allergies);
  const [slots, setSlots] = useState<Slot[]>(p.slots);
  const [units, setUnits] = useState(p.units);
  const [starters, setStarters] = useState(true);
  const [busy, setBusy] = useState(false);

  const finish = async (skip = false) => {
    setBusy(true);
    item.update((d) => {
      if (!skip) Object.assign(d.preferences, { household_size: household, diets, allergies, slots: slots.length ? slots : ["dinner"], units });
      d.preferences.onboarded = true;
    });
    if (!skip && starters) {
      try {
        await item.runAction("add_starter_recipes");
      } catch {
        toast.error("Couldn't add the starter recipes — you can add them from Recipes.");
      }
    }
    setBusy(false);
  };

  return (
    <Page>
      <div className="flex flex-col gap-1 pt-2">
        <h2 className="text-2xl font-semibold text-[var(--text)]">Let's set up your kitchen</h2>
        <p className="text-sm text-[var(--text-muted)]">A few answers and every plan, recipe and grocery list fits your household. Change them any time under Kitchen.</p>
      </div>
      <Card className="flex flex-col gap-5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-[var(--text)]">How many people do you cook for?</p>
          <Stepper value={household} min={1} max={20} onChange={(v) => setHousehold(v || 1)} className="w-36" />
        </div>
        <Field label="Which meals should we plan?">
          <div className="flex flex-wrap gap-2">
            {SLOTS.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={slots.includes(s)}
                onClick={() => setSlots((x) => (x.includes(s) ? x.filter((y) => y !== s) : SLOTS.filter((y) => y === s || x.includes(y))))}
                className={`h-11 rounded-xl border px-4 text-sm font-medium transition ${slots.includes(s) ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] text-[var(--text)]" : "border-[var(--border)] text-[var(--text-muted)]"}`}
              >
                {SLOT_LABEL[s]}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Any diet?">
          <ChipPicker value={diets} onChange={setDiets} options={DIETS} placeholder="Another diet…" />
        </Field>
        <Field label="Allergies or intolerances" hint="Taken strictly — never planned, always flagged.">
          <ChipPicker value={allergies} onChange={setAllergies} options={ALLERGIES} tone="danger" placeholder="Another allergy…" />
        </Field>
        <Field label="Units">
          <Segmented value={units} onChange={setUnits} options={[{ value: "metric", label: "Metric (g, ml)" }, { value: "imperial", label: "US (cups, oz)" }]} />
        </Field>
        <label className="flex min-h-[44px] items-center gap-3 text-sm text-[var(--text)]">
          <input type="checkbox" checked={starters} onChange={(e) => setStarters(e.target.checked)} className="h-5 w-5 accent-[var(--item-accent)]" />
          Start with 6 reliable recipes (fajitas, dal, salmon, stir-fry, overnight oats, chickpea salad)
        </label>
      </Card>
      <div className="flex flex-col gap-2 sm:flex-row">
        <ItemButton variant="primary" size="lg" block disabled={busy} onClick={() => void finish()}>
          Start planning
        </ItemButton>
        <ItemButton size="lg" block disabled={busy} onClick={() => void finish(true)}>
          Skip for now
        </ItemButton>
      </div>
      <button type="button" onClick={() => ask("Help me set up my meal planner: ask me a few quick questions about my household, diet and schedule, then set my preferences.")} className="inline-flex items-center gap-1.5 self-center text-sm font-medium text-[var(--item-accent)]">
        <Sparkles className="h-4 w-4" /> Or set it up by chatting with the assistant
      </button>
    </Page>
  );
}

const module: ItemModule<MealPlanData> = {
  kind: "mealplan",
  icon: CalendarDays,
  tabs: [
    { id: "plan", label: "Plan", icon: CalendarDays, View: PlanView },
    { id: "groceries", label: "Groceries", icon: ShoppingCart, View: GroceryView },
    { id: "recipes", label: "Recipes", icon: BookOpen, View: RecipesView },
    { id: "kitchen", label: "Kitchen", icon: ChefHat, View: KitchenView },
  ],
  primaryAction: (h, { ask }) =>
    h.canEdit
      ? {
          label: "Plan with AI",
          icon: <Sparkles className="h-4 w-4" />,
          onClick: () => ask("Plan my meals for the rest of this week around my preferences, allergies and pantry, then offer to make the grocery list.", { send: false }),
        }
      : null,
  needsOnboarding: (d) => !d.preferences?.onboarded && !(d.recipes?.length) && !(d.plan?.length),
  Onboarding,
};

export default module;
