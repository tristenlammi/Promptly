import { ChevronDown, Link2, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { extractError } from "@/components/files/helpers";
import { Field, ItemButton, Segmented, Sheet, Stepper, TextArea, TextInput, safeHref } from "@/items/ui";
import { toast } from "@/store/toastStore";

import { aisleFor, parseGroceryLine } from "./foods";
import { allergenSummary, emptyRecipe, mealplanApi, recipeFromDraft } from "./helpers";
import type { Ingredient, Nutrition, Recipe, RecipeDraft } from "./types";
import { ingredientsToLines } from "./units";

const NUTRIENTS: [keyof Nutrition, string, string][] = [
  ["calories", "Calories", "kcal"],
  ["protein_g", "Protein", "g"],
  ["carbs_g", "Carbs", "g"],
  ["fat_g", "Fat", "g"],
  ["fiber_g", "Fibre", "g"],
  ["sodium_mg", "Sodium", "mg"],
];

const num = (s: string, max = 20_000): number | null => {
  const n = parseFloat(s.replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n * 10) / 10, max) : null;
};
const NUTRIENT_MAX: Partial<Record<keyof Nutrition, number>> = { calories: 10_000, sodium_mg: 50_000, carbs_g: 2000 };

/**
 * Add or edit a recipe. Ingredients are edited as lines, the way a
 * cookbook prints them ("1 ½ cups flour, sifted"; "For the sauce:" starts a
 * group) — the server's parser turns them into structured amounts on save.
 */
export function RecipeEditor({
  open,
  recipe,
  onClose,
  onSave,
}: {
  open: boolean;
  recipe: Recipe | null;
  onClose: () => void;
  onSave: (r: Recipe) => void;
}) {
  const [r, setR] = useState<Recipe>(() => recipe ?? emptyRecipe());
  const [lines, setLines] = useState("");
  const [steps, setSteps] = useState("");
  const [tags, setTags] = useState("");
  const [more, setMore] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const base = recipe ?? emptyRecipe();
    setR(base);
    setLines(ingredientsToLines(base.ingredients));
    setSteps(base.steps.join("\n\n"));
    setTags(base.tags.join(", "));
    setMore(!!(base.nutrition || base.notes || base.source_url || base.prep_ahead));
  }, [open, recipe]);

  const set = <K extends keyof Recipe>(k: K, v: Recipe[K]) => setR((x) => ({ ...x, [k]: v }));
  const setN = (k: keyof Nutrition, v: number | null) =>
    setR((x) => {
      const n: Nutrition = x.nutrition ?? { calories: null, protein_g: null, carbs_g: null, fat_g: null, fiber_g: null, sugar_g: null, saturated_fat_g: null, sodium_mg: null };
      const next = { ...n, [k]: v };
      return { ...x, nutrition: Object.values(next).some((y) => y !== null) ? next : null };
    });

  const save = async () => {
    if (!r.title.trim()) {
      toast.error("Give the recipe a name.");
      return;
    }
    setSaving(true);
    const rawLines = lines.split("\n").map((l) => l.trim()).filter(Boolean);
    let ingredients: Ingredient[];
    const unchanged = lines === ingredientsToLines(recipe?.ingredients ?? []);
    try {
      ingredients = unchanged && recipe ? recipe.ingredients : (await mealplanApi.parseLines(rawLines)).map((i, n) => ({ ...i, id: `i${n + 1}` }));
    } catch {
      // Offline: a light local parse (amount, unit, name, note); "For the
      // sauce:" lines still start groups.
      let group = "";
      ingredients = [];
      for (const l of rawLines) {
        if (l.endsWith(":") && l.length <= 60) {
          group = l.slice(0, -1).trim().slice(0, 80);
          continue;
        }
        const p = parseGroceryLine(l);
        ingredients.push({ id: `i${ingredients.length + 1}`, qty: p.qty, qty_max: null, unit: p.unit, item: p.name.slice(0, 200), note: p.note.slice(0, 300), optional: /\boptional\b/i.test(l), group, aisle: aisleFor(p.name) });
      }
    }
    const stepList = steps
      .split("\n")
      .map((s) => s.replace(/^\s*(?:step\s*)?\d{1,2}[.):]\s*/i, "").trim())
      .filter(Boolean)
      .map((s) => s.slice(0, 3000));
    const total = r.total_min ?? ((r.prep_min ?? 0) + (r.cook_min ?? 0) || null);
    onSave({
      ...r,
      title: r.title.trim().slice(0, 200),
      ingredients: ingredients.slice(0, 150),
      steps: stepList.slice(0, 100),
      total_min: total,
      tags: tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 25),
    });
    setSaving(false);
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="full"
      title={recipe ? "Edit recipe" : "New recipe"}
      footer={
        <>
          <ItemButton block onClick={onClose}>
            Cancel
          </ItemButton>
          <ItemButton variant="primary" block disabled={saving} onClick={() => void save()} icon={saving ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>
            Save recipe
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <TextInput value={r.title} onChange={(e) => set("title", e.target.value)} placeholder="Chicken tikka masala" maxLength={200} />
        </Field>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stepper label="Servings" value={r.servings} min={1} max={100} onChange={(v) => set("servings", v || 1)} />
          <Field label="Prep (min)">
            <TextInput inputMode="numeric" value={r.prep_min ?? ""} onChange={(e) => set("prep_min", num(e.target.value) === null ? null : Math.round(num(e.target.value)!))} />
          </Field>
          <Field label="Cook (min)">
            <TextInput inputMode="numeric" value={r.cook_min ?? ""} onChange={(e) => set("cook_min", num(e.target.value) === null ? null : Math.round(num(e.target.value)!))} />
          </Field>
          <Field label="Total (min)" hint="Blank = prep + cook">
            <TextInput inputMode="numeric" value={r.total_min ?? ""} onChange={(e) => set("total_min", num(e.target.value) === null ? null : Math.round(num(e.target.value)!))} />
          </Field>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Ingredients" hint="One per line, e.g. “2 cloves garlic, minced”. A line ending in “:” starts a section.">
            <TextArea
              value={lines}
              onChange={(e) => setLines(e.target.value)}
              rows={12}
              className="min-h-[220px] font-[inherit]"
              placeholder={"500 g chicken thighs\n1 onion, finely chopped\n2 tbsp olive oil\n\nFor the sauce:\n3 tbsp soy sauce"}
            />
          </Field>
          <Field label="Steps" hint="One step per line.">
            <TextArea
              value={steps}
              onChange={(e) => setSteps(e.target.value)}
              rows={12}
              className="min-h-[220px]"
              placeholder={"Heat the oven to 200°C (400°F).\n\nToss the chicken with the oil and spices…"}
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tags" hint="Comma-separated: quick, vegetarian, batch">
            <TextInput value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
          <Field label="Cuisine">
            <TextInput value={r.cuisine} onChange={(e) => set("cuisine", e.target.value.slice(0, 60))} placeholder="Italian" />
          </Field>
        </div>
        <button type="button" onClick={() => setMore((m) => !m)} className="flex items-center gap-1.5 self-start text-sm font-medium text-[var(--item-accent)]" aria-expanded={more}>
          <ChevronDown className={`h-4 w-4 transition ${more ? "rotate-180" : ""}`} /> Notes, prep-ahead, nutrition & links
        </button>
        {more && (
          <div className="flex flex-col gap-4">
            <Field label="Prep ahead" hint="Something to do the day before (thaw, marinate, soak) — you'll get an evening reminder.">
              <TextInput value={r.prep_ahead} onChange={(e) => set("prep_ahead", e.target.value.slice(0, 300))} placeholder="Move the chicken to the fridge to thaw" />
            </Field>
            <Field label="Notes">
              <TextArea value={r.notes} onChange={(e) => set("notes", e.target.value.slice(0, 5000))} rows={3} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Source link">
                <TextInput type="url" value={r.source_url} onChange={(e) => set("source_url", e.target.value.slice(0, 1000))} placeholder="https://" />
              </Field>
              <Field label="Photo link">
                <TextInput type="url" value={r.image_url} onChange={(e) => set("image_url", e.target.value.slice(0, 2000))} placeholder="https://" />
              </Field>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-[var(--text-muted)]">Nutrition per serving</p>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {NUTRIENTS.map(([k, label, unit]) => (
                  <Field key={k} label={`${label} (${unit})`}>
                    <TextInput inputMode="decimal" value={r.nutrition?.[k] ?? ""} onChange={(e) => setN(k, num(e.target.value, NUTRIENT_MAX[k] ?? 1000))} />
                  </Field>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}

/** Import from a link or pasted text → a preview → save or edit first. */
export function ImportSheet({
  open,
  initialMode = "link",
  onClose,
  onSave,
  onEdit,
  onAsk,
  allergies = [],
}: {
  open: boolean;
  initialMode?: "link" | "text";
  onClose: () => void;
  onSave: (r: Recipe) => void;
  onEdit: (r: Recipe) => void;
  onAsk: (prompt: string) => void;
  allergies?: string[];
}) {
  const [mode, setMode] = useState<"link" | "text">(initialMode);
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<RecipeDraft | null>(null);

  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setDraft(null);
      setError(null);
      setUrl("");
      setText("");
    }
  }, [open, initialMode]);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await mealplanApi.importRecipe(mode === "link" ? { url: url.trim() } : { text });
      setDraft(d);
    } catch (e) {
      setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  const ready = mode === "link" ? url.trim().length > 4 : text.trim().length > 10;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="lg"
      title="Import a recipe"
      footer={
        draft ? (
          <>
            <ItemButton block onClick={() => onEdit(recipeFromDraft(draft))}>
              Edit first
            </ItemButton>
            <ItemButton variant="primary" block onClick={() => onSave(recipeFromDraft(draft))}>
              Save recipe
            </ItemButton>
          </>
        ) : (
          <ItemButton variant="primary" block disabled={!ready || busy} onClick={() => void go()} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>
            {busy ? "Reading…" : "Import"}
          </ItemButton>
        )
      }
    >
      {draft ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3">
            {safeHref(draft.image_url)?.match(/^https?:/i) && <img src={safeHref(draft.image_url)} alt="" referrerPolicy="no-referrer" className="h-20 w-20 shrink-0 rounded-xl object-cover" />}
            <div className="min-w-0">
              <p className="text-base font-semibold text-[var(--text)]">{draft.title}</p>
              <p className="text-sm text-[var(--text-muted)]">
                Serves {draft.servings} · {draft.ingredients.length} ingredients · {draft.steps.length} steps
                {draft.total_min ? ` · ${draft.total_min} min` : ""}
              </p>
              {draft.source_url && <p className="truncate text-xs text-[var(--text-muted)]">{draft.source_url}</p>}
            </div>
          </div>
          {allergenSummary(draft, allergies) && (
            <div role="alert" className="rounded-xl border border-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-3 py-2.5 text-sm text-[var(--text)]">
              <b>Allergy warning:</b> contains {allergenSummary(draft, allergies)}. You can still save it, but it won't be planned until it's adapted.
            </div>
          )}
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-[var(--text)]">
            {draft.ingredients.slice(0, 8).map((i, n) => (
              <li key={n}>{[i.qty !== null ? String(+i.qty.toFixed(2)) : "", i.unit, i.item].filter(Boolean).join(" ")}{i.note ? `, ${i.note}` : ""}</li>
            ))}
            {draft.ingredients.length > 8 && <li className="list-none text-[var(--text-muted)]">…and {draft.ingredients.length - 8} more</li>}
          </ul>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: "link", label: "From a link" },
              { value: "text", label: "Paste text" },
            ]}
          />
          {mode === "link" ? (
            <Field label="Recipe page" hint="Works with most recipe sites (they publish the recipe as structured data).">
              <TextInput
                type="url"
                inputMode="url"
                autoFocus
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && ready && void go()}
                placeholder="https://www.example.com/best-lasagna"
              />
            </Field>
          ) : (
            <Field label="Recipe text" hint="Paste from a note, an email or a page — title first, then ingredients and method.">
              <TextArea value={text} onChange={(e) => setText(e.target.value)} rows={10} placeholder={"Banana bread\nServes 8\n\nIngredients\n3 ripe bananas\n…\n\nMethod\n1. Heat the oven…"} />
            </Field>
          )}
          {error && (
            <div className="rounded-xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-3 py-2.5 text-sm text-[var(--text)]" role="alert">
              {error}
              {mode === "link" && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <ItemButton size="sm" onClick={() => setMode("text")}>
                    Paste text instead
                  </ItemButton>
                  <ItemButton size="sm" icon={<Link2 className="h-3.5 w-3.5" />} onClick={() => onAsk(`Save the recipe from this page to my recipe box: ${url.trim()}`)}>
                    Ask the assistant
                  </ItemButton>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
