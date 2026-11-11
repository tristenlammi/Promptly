import { ArrowLeft, CalendarPlus, Check, ChefHat, Clock, Copy, ExternalLink, Pencil, Send, ShoppingCart, Sparkles, Trash2, TriangleAlert, Users } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@/utils/cn";

import { LinkedSection } from "@/components/links/LinkedSection";
import { SendToSheet } from "@/components/share/SendToSheet";
import type { ItemHandle } from "@/items/useItem";
import { Card, Chip, ItemButton, Section, Segmented, Stepper, fmtDay, safeHref, todayISO, uid } from "@/items/ui";
import { toast } from "@/store/toastStore";

import { addGroceryItem } from "./foods";
import { allergenReport } from "./foods";
import { fmtMinutes, recipeTime } from "./helpers";
import { Callout, FavButton, RecipeThumb, Stars } from "./parts";
import type { MealPlanData, Recipe } from "./types";
import { useWidth } from "./useWidth";
import { convertTemps, ingredientText, scaleIngredient, type UnitSystem } from "./units";

export function RecipeDetail({
  item,
  recipe,
  isPhone,
  onBack,
  onEdit,
  onCook,
  onPlan,
  ask,
}: {
  item: ItemHandle<MealPlanData>;
  recipe: Recipe;
  isPhone: boolean;
  onBack?: () => void;
  onEdit: () => void;
  onCook: (servings: number, system: UnitSystem) => void;
  onPlan: (servings: number) => void;
  ask: (prompt: string) => void;
}) {
  const prefs = item.data.preferences;
  const [servings, setServings] = useState(recipe.servings);
  const [system, setSystem] = useState<UnitSystem>("keep");
  const [sending, setSending] = useState(false);
  const factor = servings / recipe.servings;
  const ingredients = useMemo(() => recipe.ingredients.map((i) => scaleIngredient(i, factor, system)), [recipe.ingredients, factor, system]);
  const report = useMemo(() => allergenReport(recipe.ingredients, prefs.allergies), [recipe.ingredients, prefs.allergies]);
  const warn = Object.entries(report);
  const flaggedTexts = useMemo(() => new Set(Object.values(report).flat()), [report]);
  const can = item.canEdit;
  const n = recipe.nutrition;
  const time = recipeTime(recipe);
  const [ref, width] = useWidth<HTMLDivElement>();
  // Side-by-side hero and ingredients|method once the pane (not the
  // window) has room — the AI panel can leave it narrow on a laptop.
  const wide = !isPhone && width >= 680;
  const [have, setHave] = useState<Set<string>>(() => new Set());
  const src = safeHref(recipe.image_url);
  const hasImage = !!src && /^https?:/i.test(src);

  const patch = (fn: (r: Recipe) => void) =>
    item.update((d) => {
      const r = d.recipes.find((x) => x.id === recipe.id);
      if (r) fn(r);
    });

  // Local (works offline): each ingredient merges into the list by name.
  const toGroceries = () => {
    const items = ingredients.filter((i) => !i.optional && i.item.trim()).slice(0, 100);
    if (item.data.grocery.items.length + items.length > 600) {
      toast.error("The grocery list is full (600 items) — clear checked items first.");
      return;
    }
    const ids = items.map(() => uid("m"));
    item.update((d) => {
      items.forEach((i, n) => addGroceryItem(d, { name: i.item, qty: i.qty, unit: i.unit, aisle: i.aisle }, ids[n]));
    });
    toast.success(`Added ${items.length} ingredient${items.length === 1 ? "" : "s"} to the grocery list`);
  };

  const groups: { name: string; items: typeof ingredients }[] = [];
  for (const i of ingredients) {
    const last = groups[groups.length - 1];
    if (!last || last.name !== (i.group || "")) groups.push({ name: i.group || "", items: [i] });
    else last.items.push(i);
  }

  const timeCells = ([
    ["Prep", recipe.prep_min ? fmtMinutes(recipe.prep_min) : ""],
    ["Cook", recipe.cook_min ? fmtMinutes(recipe.cook_min) : ""],
    ["Total", time ? fmtMinutes(time) : ""],
    ["Serves", String(recipe.servings)],
  ] as const).filter(([, v]) => v);

  const titleBlock = (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {recipe.cuisine && <p className="text-xs font-semibold uppercase tracking-wide text-[var(--item-accent)]">{recipe.cuisine}</p>}
          <h2 className="text-2xl font-semibold leading-tight text-[var(--text)]">{recipe.title}</h2>
        </div>
        {can && <FavButton on={recipe.favorite} onClick={() => { const fav = !recipe.favorite; patch((r) => (r.favorite = fav)); }} />}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Stars value={recipe.rating} onChange={can ? (v) => patch((r) => (r.rating = v)) : undefined} size="sm" />
        {recipe.times_cooked > 0 && (
          <span className="text-sm text-[var(--text-muted)]">
            Cooked {recipe.times_cooked}×{recipe.last_cooked ? ` · last ${fmtDay(recipe.last_cooked)}` : ""}
          </span>
        )}
      </div>
      {timeCells.length > 0 && (
        <div className="grid divide-x divide-[var(--border)] rounded-2xl border border-[var(--border)] bg-[var(--surface)] py-2.5" style={{ gridTemplateColumns: `repeat(${timeCells.length}, minmax(0, 1fr))` }}>
          {timeCells.map(([label, v]) => (
            <div key={label} className="flex flex-col items-center px-1 text-center">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{label}</span>
              <span className="text-[15px] font-semibold tabular-nums text-[var(--text)]">{v}</span>
            </div>
          ))}
        </div>
      )}
      {recipe.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {recipe.tags.map((t) => (
            <Chip key={t}>#{t}</Chip>
          ))}
        </div>
      )}
    </div>
  );

  const actions = (
    <div className={wide ? "flex flex-wrap gap-2" : "flex flex-col gap-2"}>
      <ItemButton variant="primary" size={wide ? "md" : "lg"} block={!wide} icon={<ChefHat className="h-5 w-5" />} onClick={() => onCook(servings, system)}>
        Start cooking
      </ItemButton>
      {can && (
        <div className={wide ? "contents" : "grid grid-cols-2 gap-2"}>
          <ItemButton block={!wide} icon={<CalendarPlus className="h-4 w-4" />} onClick={() => onPlan(servings)}>
            Add to plan
          </ItemButton>
          <ItemButton block={!wide} icon={<ShoppingCart className="h-4 w-4" />} onClick={toGroceries}>
            {wide ? "Add to grocery list" : "To groceries"}
          </ItemButton>
        </div>
      )}
    </div>
  );

  return (
    <div ref={ref} className="flex flex-col gap-5">
      {onBack && (
        <button type="button" onClick={onBack} className="-ml-1 flex h-10 items-center gap-1 self-start rounded-xl px-2 text-sm font-medium text-[var(--text-muted)] hover:bg-[var(--hover)]">
          <ArrowLeft className="h-4 w-4" /> Recipes
        </button>
      )}
      {wide && hasImage ? (
        <div className="grid grid-cols-[minmax(0,5fr)_minmax(0,6fr)] items-start gap-6">
          <RecipeThumb recipe={recipe} size={640} className="!aspect-[4/3] !h-auto !w-full !rounded-2xl" />
          <div className="flex flex-col gap-4">
            {titleBlock}
            {actions}
          </div>
        </div>
      ) : (
        <>
          {hasImage && <RecipeThumb recipe={recipe} size={640} className="!h-56 !w-full !rounded-2xl" />}
          {titleBlock}
          {actions}
        </>
      )}

      {warn.length > 0 && (
        <Callout tone="danger" icon={<TriangleAlert className="h-4 w-4" />}>
          <b>Allergy warning:</b>{" "}
          {warn.map(([a, h], n) => (
            <span key={a}>
              {n > 0 && "; "}
              <b>{a}</b> in {h.join(", ")}
            </span>
          ))}
          . The assistant won't plan it until it's safe.{" "}
          <button type="button" className="font-medium underline" onClick={() => ask(`Adapt “${recipe.title}” so it's safe for my allergies (${prefs.allergies.join(", ")}) and save the changes.`)}>
            Adapt it with AI
          </button>
        </Callout>
      )}
      {recipe.prep_ahead && <Callout icon={<Clock className="h-4 w-4" />}>Prep ahead: {recipe.prep_ahead}</Callout>}

      <div className={wide ? "grid items-start gap-6 grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" : "flex flex-col gap-6"}>
        <Section title="Ingredients" hint={have.size ? `${have.size} of ${ingredients.length} ready — tap to tick off` : "Tap to tick off as you gather them"}>
          <Card className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />
                <Stepper value={servings} min={1} max={100} step={1} onChange={(v) => setServings(v || 1)} className="w-32" />
                <span className="text-sm text-[var(--text-muted)]">{factor !== 1 ? `×${+factor.toFixed(2)}` : "servings"}</span>
              </div>
              <Segmented
                size="sm"
                value={system}
                onChange={setSystem}
                options={[
                  { value: "keep", label: "As written" },
                  { value: "metric", label: "Metric" },
                  { value: "imperial", label: "US" },
                ]}
              />
            </div>
            {groups.map((g, gi) => (
              <div key={gi} className="flex flex-col">
                {g.name && <p className="pb-1 pt-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{g.name}</p>}
                <ul className="-mx-2 flex flex-col">
                  {g.items.map((i) => {
                    const on = have.has(i.id);
                    return (
                      <li key={i.id}>
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={on}
                          onClick={() => setHave((s) => { const n = new Set(s); if (on) n.delete(i.id); else n.add(i.id); return n; })}
                          className="flex min-h-[40px] w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-[var(--hover)]"
                        >
                          <span className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition", on ? "border-[var(--item-accent)] bg-[var(--item-accent-fill)] text-white" : "border-[var(--border)]")} aria-hidden>
                            {on && <Check className="h-3 w-3" strokeWidth={3} />}
                          </span>
                          <span className={cn("min-w-0 flex-1 text-[15px] leading-snug", on ? "text-[var(--text-muted)] line-through" : i.optional ? "text-[var(--text-muted)]" : "text-[var(--text)]")}>
                            {ingredientText(i)}
                          </span>
                          {flaggedTexts.has(i.item + (i.note ? `, ${i.note}` : "")) && (
                            <span className="inline-flex shrink-0 items-center gap-0.5 self-start rounded-md bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--danger)]">
                              <TriangleAlert className="h-3 w-3" aria-hidden /> Allergen
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {ingredients.length === 0 && <p className="text-sm text-[var(--text-muted)]">No ingredients yet.</p>}
          </Card>
        </Section>
        <Section title="Method" hint={recipe.steps.length ? `${recipe.steps.length} steps` : undefined}>
          <ol className="flex flex-col gap-4">
            {recipe.steps.map((s, k) => (
              <li key={k} className="flex gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--item-accent)_15%,transparent)] text-sm font-semibold tabular-nums text-[var(--item-accent)]">{k + 1}</span>
                <p className="pt-0.5 text-[15px] leading-relaxed text-[var(--text)]">{convertTemps(s, prefs.units)}</p>
              </li>
            ))}
            {recipe.steps.length === 0 && <p className="text-sm text-[var(--text-muted)]">No steps yet.</p>}
          </ol>
        </Section>
      </div>

      {n && Object.values(n).some((v) => v != null) && (
        <Section title="Nutrition per serving" hint="As saved with the recipe — often an estimate.">
          {(() => {
            const cells = ([["Calories", n.calories, "kcal"], ["Protein", n.protein_g, "g"], ["Carbs", n.carbs_g, "g"], ["Fat", n.fat_g, "g"], ["Fibre", n.fiber_g, "g"], ["Sodium", n.sodium_mg, "mg"]] as const).filter(([, v]) => v != null);
            return (
              <div className="grid gap-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-2 py-3" style={{ gridTemplateColumns: `repeat(${Math.min(cells.length, wide ? 6 : 4)}, minmax(0, 1fr))` }}>
                {cells.map(([label, v, unit]) => (
                  <div key={label} className="flex flex-col items-center text-center">
                    <span className="text-lg font-semibold tabular-nums text-[var(--text)]">
                      {Math.round(v as number)}
                      <span className="ml-0.5 text-xs font-normal text-[var(--text-muted)]">{unit}</span>
                    </span>
                    <span className="text-[11px] text-[var(--text-muted)]">{label}</span>
                  </div>
                ))}
              </div>
            );
          })()}
        </Section>
      )}

      {recipe.notes && (
        <Section title="Notes">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--text)]">{recipe.notes}</p>
        </Section>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-4">
        {safeHref(recipe.source_url) && /^https?:/i.test(safeHref(recipe.source_url)!) && (
          <a
            href={safeHref(recipe.source_url)}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="inline-flex h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-[var(--item-accent)] hover:bg-[var(--hover)]"
          >
            <ExternalLink className="h-4 w-4" /> {(() => {
              try {
                return new URL(recipe.source_url).hostname.replace(/^www\./, "");
              } catch {
                return "Source";
              }
            })()}
          </a>
        )}
        <span className="flex-1" />
        <ItemButton variant="ghost" size="sm" icon={<Sparkles className="h-4 w-4 text-[var(--item-accent)]" />} onClick={() => ask(`Estimate the nutrition per serving for “${recipe.title}” and save it.`)}>
          {n ? "Check nutrition" : "Estimate nutrition"}
        </ItemButton>
        <ItemButton variant="ghost" size="sm" icon={<Send className="h-4 w-4" />} onClick={() => setSending(true)}>
          Send to…
        </ItemButton>
        <SendToSheet open={sending} onClose={() => setSending(false)} target={{ kind: "recipe", id: recipe.id, file_id: item.fileId, title: recipe.title }} />
        {can && (
          <>
            <ItemButton variant="ghost" size="sm" icon={<Pencil className="h-4 w-4" />} onClick={onEdit}>
              Edit
            </ItemButton>
            <ItemButton
              variant="ghost"
              size="sm"
              icon={<Copy className="h-4 w-4" />}
              onClick={() => {
                const copy = { ...structuredClone(recipe), id: uid("r"), title: `${recipe.title} (copy)`.slice(0, 200), times_cooked: 0, last_cooked: null, added: todayISO() };
                item.update((d) => {
                  if (!d.recipes.some((x) => x.id === copy.id)) d.recipes.push(copy);
                });
                toast.success("Duplicated");
              }}
            >
              Duplicate
            </ItemButton>
            <ItemButton
              variant="ghost"
              size="sm"
              className="text-[var(--danger)]"
              icon={<Trash2 className="h-4 w-4" />}
              onClick={() => {
                if (!window.confirm(`Delete “${recipe.title}”? Planned meals keep its name.`)) return;
                item.update((d) => {
                  d.recipes = d.recipes.filter((x) => x.id !== recipe.id);
                  for (const e of d.plan) if (e.recipe_id === recipe.id) e.recipe_id = null;
                });
                onBack?.();
              }}
            >
              Delete
            </ItemButton>
          </>
        )}
      </div>
      <LinkedSection thing={{ kind: "recipe", id: `${item.fileId}:${recipe.id}` }} readOnly={!can} className="mt-4" />
    </div>
  );
}
