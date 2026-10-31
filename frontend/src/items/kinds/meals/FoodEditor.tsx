import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ItemHandle } from "@/items/useItem";
import { Field, IconButton, ItemButton, Segmented, Sheet, TextInput, Toggle, nowISO, uid } from "@/items/ui";

import { NumberInput } from "./components";
import { MICROS, energy, fmtEnergy, kcalFromMacros, meals, toKcal, zero } from "./lib";
import type { Food, MealsData, Nutrients, Serving } from "./types";

/*
 * Create or edit a library food. Numbers can be typed per 100 g/ml (the
 * stored basis) or per serving, like a label; per-serving input is
 * converted on save. Editing a food never changes past diary entries.
 */

type Draft = {
  name: string;
  brand: string;
  barcode: string;
  liquid: boolean;
  basis: "100" | "serving";
  servings: Serving[];
  n: Nutrients;
  notes: string;
};

function toDraft(f: Partial<Food> | null): Draft {
  const servings = (f?.servings ?? []).map((s) => ({ ...s }));
  return {
    name: f?.name ?? "",
    brand: f?.brand ?? "",
    barcode: f?.barcode ?? "",
    liquid: !!f?.liquid,
    basis: "100",
    servings,
    n: f?.per100 ? { ...f.per100, micros: { ...(f.per100.micros || {}) } } : zero(),
    notes: f?.notes ?? "",
  };
}

const FIELDS: { k: keyof Omit<Nutrients, "micros">; label: string; unit: string; sub?: boolean }[] = [
  { k: "kcal", label: "Energy", unit: "kcal" },
  { k: "protein", label: "Protein", unit: "g" },
  { k: "carbs", label: "Carbohydrate", unit: "g" },
  { k: "sugar", label: "of which sugars", unit: "g", sub: true },
  { k: "fibre", label: "Fibre", unit: "g", sub: true },
  { k: "fat", label: "Fat", unit: "g" },
  { k: "sat_fat", label: "of which saturated", unit: "g", sub: true },
  { k: "sodium", label: "Sodium", unit: "mg" },
];

export function FoodEditor({
  open,
  onClose,
  item,
  food,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  item: ItemHandle<MealsData>;
  /** An existing library food (edit), or a partial one to start a new food from (copy / barcode). */
  food: Partial<Food> | null;
  onSaved?: (f: Food) => void;
}) {
  const st = meals(item.data).settings;
  const existing = !!food?.id && meals(item.data).foods.some((f) => f.id === food.id);
  const [d, setD] = useState<Draft>(() => toDraft(food));
  const [showMicros, setShowMicros] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => {
    if (open) {
      setD(toDraft(food));
      setConfirmDel(false);
      setShowMicros(Object.keys(food?.per100?.micros ?? {}).length > 0);
    }
  }, [open, food]);

  const basisServing = d.servings[0];
  const factor = d.basis === "serving" && basisServing ? basisServing.grams / 100 : 1;
  const shown = (v: number) => Math.round(v * factor * 10) / 10;
  // Energy is typed in the person's unit (kcal or kJ) and stored in kcal.
  const shownN = (k: keyof Omit<Nutrients, "micros">) => shown(k === "kcal" ? energy(d.n.kcal, st) : d.n[k]);
  const setN = (k: keyof Omit<Nutrients, "micros">, v: number | null) =>
    setD((x) => ({ ...x, n: { ...x.n, [k]: Math.max(0, (k === "kcal" ? toKcal(v ?? 0, st) : v ?? 0) / factor) } }));
  const setMicro = (k: string, v: number | null) =>
    setD((x) => {
      const micros = { ...x.n.micros };
      if (v === null || v <= 0) delete micros[k];
      else micros[k] = v / factor;
      return { ...x, n: { ...x.n, micros } };
    });

  const atwater = kcalFromMacros(d.n.protein, d.n.carbs, d.n.fat);
  const mismatch = d.n.kcal > 0 && Math.abs(atwater - d.n.kcal) > Math.max(30, d.n.kcal * 0.25);
  const valid = d.name.trim().length > 0 && (d.n.kcal > 0 || atwater > 0) && d.servings.every((s) => s.label.trim() && s.grams > 0);

  const unitWord = d.liquid ? "ml" : "g";
  const save = () => {
    const per100: Nutrients = { ...d.n, kcal: d.n.kcal || atwater };
    const cleanServings = d.servings.map((s) => ({ ...s, label: s.label.trim().slice(0, 60) }));
    const out: Food = {
      id: existing ? (food!.id as string) : uid("f"),
      name: d.name.trim().slice(0, 120),
      brand: d.brand.trim().slice(0, 80),
      barcode: d.barcode.replace(/\D/g, "") || null,
      servings: cleanServings,
      default_serving: cleanServings[0]?.id ?? null,
      per100,
      liquid: d.liquid,
      density: food?.density ?? null,
      source: existing ? ((food!.source as Food["source"]) ?? "custom") : food?.source === "off" ? "off" : food?.id?.startsWith("b:") ? "copy" : "custom",
      notes: d.notes.slice(0, 500),
      created: existing ? food!.created ?? null : nowISO(),
    };
    // Editing: assign only the fields that changed in the form (the food may
    // have been changed elsewhere meanwhile — keep those other edits).
    const before = food ?? {};
    const changed = (Object.keys(out) as (keyof Food)[]).filter((k) => k !== "id" && JSON.stringify(out[k] ?? null) !== JSON.stringify((before as Food)[k] ?? null));
    item.update((data) => {
      const cur = data.foods.find((f) => f.id === out.id);
      if (cur) {
        for (const k of changed) (cur as unknown as Record<string, unknown>)[k] = out[k];
      } else if (!existing) data.foods.push(out);
    });
    onSaved?.(out);
    onClose();
  };

  const remove = () => {
    const id = food?.id;
    if (!id) return;
    item.update((data) => {
      data.foods = data.foods.filter((f) => f.id !== id);
      data.favourites = data.favourites.filter((f) => f !== id);
    });
    onClose();
  };

  const microKeys = useMemo(() => Object.keys(MICROS), []);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={existing ? "Edit food" : "New food"}
      size="lg"
      footer={
        <>
          {existing &&
            (confirmDel ? (
              <ItemButton variant="danger" onClick={remove}>
                Delete for good
              </ItemButton>
            ) : (
              <ItemButton variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setConfirmDel(true)}>
                Delete
              </ItemButton>
            ))}
          <ItemButton variant="primary" block disabled={!valid} onClick={save}>
            {existing ? "Save food" : "Add to my foods"}
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name">
            <TextInput value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Overnight oats" autoFocus />
          </Field>
          <Field label="Brand (optional)">
            <TextInput value={d.brand} onChange={(e) => setD({ ...d, brand: e.target.value })} placeholder="Homemade" />
          </Field>
          <Field label="Barcode (optional)">
            <TextInput inputMode="numeric" value={d.barcode} onChange={(e) => setD({ ...d, barcode: e.target.value.replace(/[^\d]/g, "") })} />
          </Field>
          <div className="flex items-end justify-between gap-3 rounded-xl border border-[var(--border)] px-3 py-2">
            <span className="text-sm text-[var(--text)]">A drink (per 100 ml)</span>
            <Toggle checked={d.liquid} onChange={(v) => setD({ ...d, liquid: v })} label="Measured in ml" />
          </div>
        </div>

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--text)]">Serving sizes</h3>
            <ItemButton
              size="sm"
              icon={<Plus className="h-3.5 w-3.5" />}
              disabled={d.servings.length >= 12}
              onClick={() => setD({ ...d, servings: [...d.servings, { id: uid("s"), label: "", grams: 100 }] })}
            >
              Serving
            </ItemButton>
          </div>
          {d.servings.length === 0 && <p className="text-xs text-[var(--text-muted)]">Optional — add "1 bar = 45 g", "1 cup = 240 ml" to log in one tap.</p>}
          {d.servings.map((s, i) => (
            <div key={s.id} className="flex items-center gap-2">
              <TextInput
                aria-label="Serving name"
                placeholder="1 slice"
                value={s.label}
                onChange={(e) => setD({ ...d, servings: d.servings.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
              />
              <NumberInput
                ariaLabel={`Grams in ${s.label || "serving"}`}
                className="w-32 shrink-0"
                value={s.grams}
                suffix={unitWord}
                onChange={(v) => setD({ ...d, servings: d.servings.map((x, j) => (j === i ? { ...x, grams: Math.max(0, v ?? 0) } : x)) })}
              />
              <IconButton label="Remove serving" icon={Trash2} onClick={() => setD({ ...d, servings: d.servings.filter((_, j) => j !== i) })} />
            </div>
          ))}
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-[var(--text)]">Nutrition</h3>
            <Segmented
              size="sm"
              value={d.basis}
              onChange={(v) => setD({ ...d, basis: v })}
              options={[
                { value: "100", label: `Per 100 ${unitWord}` },
                ...(basisServing ? [{ value: "serving" as const, label: `Per ${basisServing.label || "serving"}` }] : []),
              ]}
            />
          </div>
          <div className="divide-y divide-[var(--border)] rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-3">
            {FIELDS.map((f) => (
              <label key={f.k} className="flex items-center gap-3 py-1.5">
                <span className={f.sub ? "flex-1 pl-3 text-sm text-[var(--text-muted)]" : "flex-1 text-sm font-medium text-[var(--text)]"}>{f.label}</span>
                <NumberInput ariaLabel={f.label} className="w-32" value={shownN(f.k)} suffix={f.k === "kcal" ? st.energy_unit : f.unit} onChange={(v) => setN(f.k, v)} />
              </label>
            ))}
          </div>
          {mismatch && (
            <p className="text-xs text-[var(--warning)]">
              Heads up: the macros add up to about {fmtEnergy(atwater * factor, st, true)}. Check the label (fibre and alcohol explain small gaps).
            </p>
          )}
          {!d.n.kcal && atwater > 0 && <p className="text-xs text-[var(--text-muted)]">Energy will be worked out from the macros ({fmtEnergy(atwater * factor, st, true)}).</p>}
          <button
            type="button"
            className="flex h-10 items-center gap-1 self-start text-sm font-medium text-[var(--item-accent)]"
            onClick={() => setShowMicros(!showMicros)}
            aria-expanded={showMicros}
          >
            <ChevronDown className={showMicros ? "h-4 w-4 rotate-180 transition" : "h-4 w-4 transition"} /> Vitamins, minerals & more
          </button>
          {showMicros && (
            <div className="grid grid-cols-1 gap-x-4 gap-y-1 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 sm:grid-cols-2">
              {microKeys.map((k) => (
                <label key={k} className="flex items-center gap-2 py-1">
                  <span className="flex-1 truncate text-sm text-[var(--text)]">{MICROS[k].label}</span>
                  <NumberInput
                    ariaLabel={MICROS[k].label}
                    className="w-28"
                    allowEmpty
                    value={d.n.micros[k] ? shown(d.n.micros[k]) : null}
                    suffix={MICROS[k].unit}
                    onChange={(v) => setMicro(k, v)}
                  />
                </label>
              ))}
            </div>
          )}
        </section>
        <Field label="Notes">
          <TextInput value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} placeholder="Recipe makes 4 servings…" />
        </Field>
      </div>
    </Sheet>
  );
}
