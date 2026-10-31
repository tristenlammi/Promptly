import { useVirtualizer } from "@tanstack/react-virtual";
import { Apple, CopyPlus, Pencil, Plus, Search, Sparkles, Star, Trash2, UtensilsCrossed } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import type { ItemHandle } from "@/items/useItem";
import {
  Card,
  Chip,
  EmptyState,
  Fab,
  Field,
  IconButton,
  ItemButton,
  List,
  ListRow,
  Page,
  ScrollRow,
  Segmented,
  Select,
  Sheet,
  TextInput,
  fmtNum,
} from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { useFoodPool } from "./api";
import { today as todayNow } from "./clock";
import { EstBadge, NutrientTable } from "./components";
import { FoodEditor } from "./FoodEditor";
import { defaultPortionText, ensureDay, fmtEnergy, foodLabel, guessSlot, makeEntry, meals, portionText, scaleTotals, searchFoods, total, visibleSlots } from "./lib";
import type { Food, MealsData, SavedMeal } from "./types";

type View = "mine" | "meals" | "builtin";

export function Foods({ item, isPhone, ask }: ItemViewProps<MealsData>) {
  const data = meals(item.data);
  const s = data.settings;
  const { builtins, categories, favs } = useFoodPool(data);
  const [view, setView] = useState<View>("mine");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string | null>(null);
  const [onlyFavs, setOnlyFavs] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [editor, setEditor] = useState<Partial<Food> | null>(null);
  const [meal, setMeal] = useState<SavedMeal | null>(null);

  const list = useMemo(() => {
    const base = view === "mine" ? data.foods : builtins.filter((f) => !cat || f.category === cat);
    let out = q.trim() ? searchFoods(base, q, favs, 3000) : [...base].sort((a, b) => a.name.localeCompare(b.name));
    if (onlyFavs) out = out.filter((f) => favs.has(f.id));
    return out;
  }, [view, data.foods, builtins, cat, q, favs, onlyFavs]);

  const sel = list.find((f) => f.id === selected) ?? (isPhone ? null : list[0] ?? null);

  const openFood = (f: Food) => {
    if (isPhone) {
      if (f.id.startsWith("b:")) setSelected(f.id);
      else setEditor(f);
    } else setSelected(f.id);
  };

  const savedMeals = data.meals;

  return (
    <Page wide={!isPhone}>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={view}
          onChange={(v) => {
            setView(v);
            setSelected(null);
          }}
          options={[
            { value: "mine", label: `My foods${data.foods.length ? ` · ${data.foods.length}` : ""}` },
            { value: "meals", label: `Meals${savedMeals.length ? ` · ${savedMeals.length}` : ""}` },
            { value: "builtin", label: "Built-in" },
          ]}
        />
        <div className="flex-1" />
        {!isPhone && item.canEdit && view === "mine" && (
          <ItemButton variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditor({})}>
            New food
          </ItemButton>
        )}
      </div>

      {view === "meals" ? (
        savedMeals.length ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {savedMeals.map((m) => {
              const t = total(m.items);
              return (
                <Card key={m.id} onClick={() => setMeal(m)} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <UtensilsCrossed className="h-4 w-4 text-[var(--item-accent)]" />
                    <p className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--text)]">{m.name}</p>
                    <span className="text-sm tabular-nums text-[var(--text)]">{fmtEnergy(t.kcal, s, true)}</span>
                  </div>
                  <p className="truncate text-xs text-[var(--text-muted)]">{m.items.map((i) => i.name).join(", ")}</p>
                  <p className="text-xs tabular-nums text-[var(--text-muted)]">
                    P {fmtNum(t.protein)} g · C {fmtNum(t.carbs)} g · F {fmtNum(t.fat)} g
                  </p>
                </Card>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={UtensilsCrossed}
            title="No saved meals yet"
            text="Save a breakfast you eat often from its ⋯ menu in the diary, then log it in one tap."
            action={<ItemButton icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Create a saved meal for my usual breakfast — ask me what it is.")}>Ask the assistant</ItemButton>}
          />
        )
      ) : (
        <div className={cn("grid gap-4", !isPhone && "grid-cols-[minmax(0,1fr)_minmax(300px,380px)]")}>
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
                <TextInput type="search" aria-label="Filter foods" placeholder={view === "mine" ? "Filter my foods" : "Filter built-in foods"} value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
              </div>
              <IconButton label={onlyFavs ? "Show all" : "Only favourites"} icon={Star} active={onlyFavs} onClick={() => setOnlyFavs(!onlyFavs)} />
            </div>
            {view === "builtin" && (
              <ScrollRow>
                <Chip active={!cat} onClick={() => setCat(null)}>
                  All
                </Chip>
                {categories.map((c) => (
                  <Chip key={c} active={cat === c} onClick={() => setCat(cat === c ? null : c)}>
                    {c}
                  </Chip>
                ))}
              </ScrollRow>
            )}
            {list.length ? (
              <FoodList foods={list} favs={favs} settings={s} selected={isPhone ? null : sel?.id ?? null} onOpen={openFood} />
            ) : view === "mine" && !q ? (
              <EmptyState
                icon={Apple}
                title="Your food library"
                text="Foods you create, scan or find on Open Food Facts land here — with your own serving sizes — so they're one tap away next time."
                action={
                  item.canEdit && (
                    <ItemButton variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditor({})}>
                      Create a food
                    </ItemButton>
                  )
                }
              />
            ) : (
              <p className="px-1 text-sm text-[var(--text-muted)]">No foods match.</p>
            )}
            {view === "builtin" && (
              <p className="px-1 text-xs text-[var(--text-muted)]">Generic foods per 100 g, rounded from USDA FoodData Central reference values. Copy one to adjust it.</p>
            )}
          </div>
          {!isPhone && (
            <div className="sticky top-4 self-start">
              {sel ? <FoodDetail key={sel.id} food={sel} item={item} fav={favs.has(sel.id)} onEdit={() => setEditor(sel.id.startsWith("b:") ? copyOf(sel) : sel)} /> : <Card className="text-sm text-[var(--text-muted)]">Pick a food to see its nutrition.</Card>}
            </div>
          )}
        </div>
      )}

      {isPhone && item.canEdit && view === "mine" && <Fab label="New food" icon={Plus} onClick={() => setEditor({})} />}
      {isPhone && sel && (
        <Sheet open onClose={() => setSelected(null)} title={sel.name}>
          <FoodDetail key={sel.id} food={sel} item={item} fav={favs.has(sel.id)} bare onEdit={() => (setSelected(null), setEditor(copyOf(sel)))} />
        </Sheet>
      )}
      <FoodEditor open={!!editor} onClose={() => setEditor(null)} item={item} food={editor} onSaved={(f) => setSelected(f.id)} />
      <MealSheet meal={meal} item={item} onClose={() => setMeal(null)} />
    </Page>
  );
}

function copyOf(f: Food): Partial<Food> {
  const { id: _id, category: _c, ...rest } = f;
  void _id;
  void _c;
  return { ...rest, source: "copy", name: f.name };
}

function FoodList({ foods, favs, settings, selected, onOpen }: { foods: Food[]; favs: Set<string>; settings: MealsData["settings"]; selected: string | null; onOpen: (f: Food) => void }) {
  const parent = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: foods.length, getScrollElement: () => parent.current, estimateSize: () => 57, overscan: 8 });
  return (
    <div ref={parent} className="max-h-[calc(100dvh-280px)] min-h-[200px] overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <div style={{ height: v.getTotalSize(), position: "relative" }}>
        {v.getVirtualItems().map((row) => {
          const f = foods[row.index];
          return (
            <div key={f.id} style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${row.start}px)` }} className="border-b border-[var(--border)]">
              <ListRow
                onClick={() => onOpen(f)}
                selected={selected === f.id}
                leading={favs.has(f.id) ? <Star className="h-4 w-4 fill-current text-[var(--item-accent)]" aria-label="Favourite" /> : <span className="w-4" />}
                title={
                  <span className="flex items-center gap-1.5">
                    <span className="truncate">{foodLabel(f)}</span>
                    {f.source === "ai" && <EstBadge />}
                  </span>
                }
                subtitle={[defaultPortionText(f, settings), f.servings.length ? `${fmtEnergy(f.per100.kcal, settings)} per 100 ${f.liquid ? "ml" : "g"}` : ""].filter(Boolean).join(" · ")}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FoodDetail({ food, item, fav, onEdit, bare }: { food: Food; item: ItemHandle<MealsData>; fav: boolean; onEdit: () => void; bare?: boolean }) {
  const s = meals(item.data).settings;
  const builtin = food.id.startsWith("b:");
  const [serving, setServing] = useState<string>(() => food.default_serving ?? food.servings[0]?.id ?? "100");
  const grams = serving === "100" ? 100 : food.servings.find((x) => x.id === serving)?.grams ?? 100;
  const n = scaleTotals(food.per100, grams / 100);
  const used = useMemo(() => {
    let times = 0;
    for (const d of Object.values(meals(item.data).days)) for (const e of d.entries) if (e.food_ref === food.id) times++;
    return times;
  }, [item.data, food.id]);
  const body = (
    <div className="flex flex-col gap-3">
      {!bare && (
        <div>
          <p className="text-base font-semibold text-[var(--text)]">{food.name}</p>
          <p className="text-xs text-[var(--text-muted)]">{[food.brand, builtin ? food.category : food.source === "off" ? "Open Food Facts" : "My food", food.barcode].filter(Boolean).join(" · ")}</p>
        </div>
      )}
      <Field label="Per">
        <Select value={serving} onChange={(e) => setServing(e.target.value)} aria-label="Serving">
          <option value="100">100 {food.liquid ? "ml" : "g"}</option>
          {food.servings.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label} ({fmtNum(x.grams)} {food.liquid ? "ml" : "g"})
            </option>
          ))}
        </Select>
      </Field>
      <NutrientTable n={n} settings={s} showMicros />
      {used > 0 && <p className="text-xs text-[var(--text-muted)]">Logged {used}× in your diary.</p>}
      {food.notes && <p className="text-xs text-[var(--text-muted)]">{food.notes}</p>}
      {item.canEdit && (
        <div className="flex flex-wrap gap-2">
          <ItemButton
            size="sm"
            icon={<Star className={cn("h-4 w-4", fav && "fill-current")} />}
            onClick={() => {
              const on = !fav;
              item.update((d) => {
                if (on && !d.favourites.includes(food.id)) d.favourites.push(food.id);
                if (!on) d.favourites = d.favourites.filter((x) => x !== food.id);
              });
            }}
          >
            {fav ? "Unstar" : "Favourite"}
          </ItemButton>
          <ItemButton size="sm" icon={builtin ? <CopyPlus className="h-4 w-4" /> : <Pencil className="h-4 w-4" />} onClick={onEdit}>
            {builtin ? "Copy to my foods" : "Edit"}
          </ItemButton>
          <ItemButton
            size="sm"
            variant="primary"
            icon={<Plus className="h-4 w-4" />}
            onClick={() => {
              const day = todayNow();
              const slot = guessSlot(s.meal_slots);
              const sv = food.servings.find((x) => x.id === serving);
              const p = {
                name: food.name,
                brand: food.brand,
                food_ref: food.id,
                amount: sv ? 1 : 100,
                unit: (sv ? "serving" : food.liquid ? "ml" : "g") as "serving" | "ml" | "g",
                serving_id: sv?.id ?? null,
                serving_label: sv?.label ?? "",
                grams,
                n,
                estimate: false,
              };
              const entry = makeEntry(p, slot, "food", day);
              item.update((d) => void ensureDay(d, day).entries.push(entry));
              toast.success(`Logged ${food.name} to ${s.meal_slots.find((x) => x.id === slot)?.name}`);
            }}
          >
            Log now
          </ItemButton>
        </div>
      )}
    </div>
  );
  return bare ? body : <Card>{body}</Card>;
}

function MealSheet({ meal, item, onClose }: { meal: SavedMeal | null; item: ItemHandle<MealsData>; onClose: () => void }) {
  const live = meal ? meals(item.data).meals.find((m) => m.id === meal.id) ?? null : null;
  const [confirm, setConfirm] = useState(false);
  if (!live) return null;
  const s = meals(item.data).settings;
  const t = total(live.items);
  const mutate = (fn: (m: SavedMeal) => void) =>
    item.update((d) => {
      const m = d.meals.find((x) => x.id === live.id);
      if (m) fn(m);
    });
  return (
    <Sheet
      open
      onClose={() => (setConfirm(false), onClose())}
      title="Saved meal"
      footer={
        item.canEdit ? (
          <>
            {confirm ? (
              <ItemButton
                variant="danger"
                onClick={() => {
                  item.update((d) => void (d.meals = d.meals.filter((m) => m.id !== live.id)));
                  setConfirm(false);
                  onClose();
                }}
              >
                Delete meal
              </ItemButton>
            ) : (
              <IconButton label="Delete meal" icon={Trash2} onClick={() => setConfirm(true)} />
            )}
            <ItemButton
              variant="primary"
              block
              onClick={() => {
                const day = todayNow();
                const slot = live.slot && visibleSlots(s).some((x) => x.id === live.slot) ? live.slot : guessSlot(s.meal_slots);
                const entries = live.items.map((it) => makeEntry(it, slot, "meal", day));
                item.update((d) => {
                  ensureDay(d, day).entries.push(...entries);
                });
                toast.success(`Logged ${live.name}`);
                onClose();
              }}
            >
              Log today · {fmtEnergy(t.kcal, s, true)}
            </ItemButton>
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput value={live.name} disabled={!item.canEdit} onChange={(e) => mutate((m) => void (m.name = e.target.value.slice(0, 80) || m.name))} />
        </Field>
        <Field label="Usually eaten at">
          <Select value={live.slot ?? ""} disabled={!item.canEdit} onChange={(e) => mutate((m) => void (m.slot = e.target.value || null))} aria-label="Usual meal">
            <option value="">Any time</option>
            {visibleSlots(s).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
        <List>
          {live.items.map((it, i) => (
            <ListRow
              key={i}
              title={
                <span className="flex items-center gap-1.5">
                  <span className="truncate">{it.name}</span>
                  {it.estimate && <EstBadge />}
                </span>
              }
              subtitle={`${portionText(it)} · ${fmtEnergy(it.n.kcal, s, true)}`}
              action={
                item.canEdit && live.items.length > 1 ? (
                  <IconButton
                    label={`Remove ${it.name}`}
                    icon={Trash2}
                    onClick={() =>
                      mutate((m) => {
                        // By position, but only if it's still the same item (the list may have changed since).
                        if (m.items[i]?.name === it.name) m.items.splice(i, 1);
                      })
                    }
                  />
                ) : undefined
              }
            />
          ))}
        </List>
        <p className="text-sm tabular-nums text-[var(--text-muted)]">
          Total {fmtEnergy(t.kcal, s, true)} · P {fmtNum(t.protein)} g · C {fmtNum(t.carbs)} g · F {fmtNum(t.fat)} g
        </p>
      </div>
    </Sheet>
  );
}
