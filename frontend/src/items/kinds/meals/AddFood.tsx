import {
  ArrowLeft,
  Check,
  Globe,
  History,
  Loader2,
  Pencil,
  Plus,
  ScanBarcode,
  Search,
  Sparkles,
  Star,
  UtensilsCrossed,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ItemHandle } from "@/items/useItem";
import {
  Chip,
  EmptyState,
  Field,
  IconButton,
  ItemButton,
  List,
  ListRow,
  ScrollRow,
  Segmented,
  Select,
  Sheet,
  Stepper,
  TextArea,
  TextInput,
  fmtDay,
  fmtNum,
  uid,
} from "@/items/ui";
import { toast } from "@/store/toastStore";

import { lookupBarcode, searchOnline, useFoodPool } from "./api";
import { EstBadge, NumberInput } from "./components";
import { FoodEditor } from "./FoodEditor";
import {
  HOUSEHOLD_LABEL,
  MACRO_COLOR,
  dayOf,
  defaultPortionText,
  densityOf,
  ensureDay,
  errorText,
  fmtEnergy,
  foodLabel,
  kcalFromMacros,
  makeEntry,
  meals,
  portionOf,
  portionText,
  recentBarcodes,
  recents,
  scaleTotals,
  searchFoods,
  servingOf,
  targetsFor,
  toKcal,
  total,
  visibleSlots,
} from "./lib";
import { Scanner } from "./Scanner";
import type { Entry, Food, FoundFood, MealsData, Portion, SavedMeal, Unit } from "./types";

type Tab = "search" | "scan" | "quick" | "describe";
type Browse = "recent" | "favourites" | "mine" | "meals";
export type Picked = { food: Food; origin: "library" | "builtin" | "online" | "barcode"; found?: FoundFood; initial?: { amount: number; unit: Unit; serving_id: string | null } };

export function AddFood({
  open,
  onClose,
  item,
  day,
  slot: initialSlot,
  ask,
  initialTab = "search",
}: {
  open: boolean;
  onClose: () => void;
  item: ItemHandle<MealsData>;
  day: string;
  slot: string;
  ask: (prompt: string) => void;
  initialTab?: Tab;
}) {
  const data = meals(item.data);
  const s = data.settings;
  const { pool, resolve, favs, loading } = useFoodPool(data);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [slot, setSlot] = useState(initialSlot);
  const [q, setQ] = useState("");
  const [browse, setBrowse] = useState<Browse>("recent");
  const [picked, setPicked] = useState<Picked | null>(null);
  const [meal, setMeal] = useState<SavedMeal | null>(null);
  const [online, setOnline] = useState<{ q: string; foods: FoundFood[] } | null>(null);
  const [onlineBusy, setOnlineBusy] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [notFound, setNotFound] = useState<string | null>(null);
  const [editor, setEditor] = useState<Partial<Food> | null>(null);
  const [added, setAdded] = useState(0);
  // One-tap "+" rows flash a tick so a fast logger sees it landed (MFP does
  // the same) without leaving the list.
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const flashTimers = useRef<number[]>([]);
  const flashRow = useCallback((key: string) => {
    setFlash((f) => new Set(f).add(key));
    flashTimers.current.push(
      window.setTimeout(() => setFlash((f) => {
        const n = new Set(f);
        n.delete(key);
        return n;
      }), 1400),
    );
  }, []);
  useEffect(() => () => flashTimers.current.forEach((t) => window.clearTimeout(t)), []);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setSlot(initialSlot);
      setQ("");
      setPicked(null);
      setMeal(null);
      setOnline(null);
      setNotFound(null);
      setAdded(0);
    }
  }, [open, initialSlot, initialTab]);

  // The sheet focuses its first control (the mode switch); searching is what
  // you open it for, so put the cursor in the search box instead.
  useEffect(() => {
    if (!open || tab !== "search" || picked || meal) return;
    const t = window.setTimeout(() => searchRef.current?.focus(), 90);
    return () => window.clearTimeout(t);
  }, [open, tab, picked, meal]);

  const slotName = s.meal_slots.find((x) => x.id === slot)?.name ?? "Snacks";
  const recent = useMemo(() => (open ? recents(data, resolve) : []), [open, data, resolve]);
  const results = useMemo(() => searchFoods(pool, q, favs), [pool, q, favs]);
  const remaining = useMemo(() => {
    const t = targetsFor(data.targets, day);
    return t.kcal - total(dayOf(data, day).entries).kcal;
  }, [data, day]);

  const logPortion = (p: Portion, source: Entry["source"], toSlot = slot) => {
    const entry = makeEntry(p, toSlot, source, day); // id + time made once, outside the replayable change
    item.update((d) => {
      ensureDay(d, day).entries.push(entry);
    });
    setAdded((n) => n + 1);
    toast.success(`Added ${p.name} to ${s.meal_slots.find((x) => x.id === toSlot)?.name ?? "your diary"}`);
  };

  /** An online food → a library food (reusing one with the same barcode / name). */
  const adopt = (f: FoundFood): Food => {
    const same = data.foods.find(
      (x) => (f.barcode && x.barcode === f.barcode) || (x.name.toLowerCase() === f.name.toLowerCase() && x.brand.toLowerCase() === (f.brand || "").toLowerCase()),
    );
    if (same) return same;
    return { ...f, id: uid("f"), source: "off", notes: "From Open Food Facts", created: new Date().toISOString() };
  };

  const pickFood = (food: Food, initial?: Picked["initial"]) => setPicked({ food, origin: food.id.startsWith("b:") ? "builtin" : "library", initial });

  const doOnline = async () => {
    const query = q.trim();
    if (query.length < 2) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      toast.error("You're offline — Open Food Facts needs a connection. Your foods and the built-in list still work.");
      return;
    }
    setOnlineBusy(true);
    try {
      setOnline({ q: query, foods: await searchOnline(query) });
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setOnlineBusy(false);
    }
  };

  const onCode = async (code: string) => {
    setNotFound(null);
    const mine = data.foods.find((f) => f.barcode === code);
    if (mine) {
      setPicked({ food: mine, origin: "library" });
      return;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setNotFound(code);
      toast.error("You're offline — this barcode isn't in your foods yet.");
      return;
    }
    setScanBusy(true);
    try {
      const f = await lookupBarcode(code);
      if (f) setPicked({ food: adopt(f), origin: "barcode", found: f });
      else setNotFound(code);
    } catch (e) {
      toast.error(errorText(e));
      setNotFound(code);
    } finally {
      setScanBusy(false);
    }
  };

  const title = picked ? `Add to ${slotName}` : meal ? meal.name : `Add food · ${fmtDay(day)}`;

  return (
    <>
      <Sheet
        open={open && !editor}
        onClose={onClose}
        title={title}
        size="lg"
        footer={
          !picked && !meal && added > 0 ? (
            <ItemButton variant="primary" block onClick={onClose}>
              Done · {added} added
            </ItemButton>
          ) : undefined
        }
      >
        {picked ? (
          <PortionPicker
            key={picked.food.id}
            item={item}
            picked={picked}
            slot={slot}
            onSlot={setSlot}
            remaining={remaining}
            onBack={() => setPicked(null)}
            onEdit={() => setEditor(picked.food)}
            onAdd={(p) => {
              const food = picked.food;
              if ((picked.origin === "online" || picked.origin === "barcode") && !data.foods.some((f) => f.id === food.id)) {
                item.update((d) => {
                  if (!d.foods.some((f) => f.id === food.id)) d.foods.push(food);
                });
              }
              logPortion(p, picked.origin === "barcode" ? "barcode" : picked.origin === "online" ? "online" : "food");
              setPicked(null);
              setQ("");
            }}
          />
        ) : meal ? (
          <MealPicker
            meal={meal}
            item={item}
            slot={slot}
            onSlot={setSlot}
            onBack={() => setMeal(null)}
            onLog={(servings) => {
              const entries = meal.items.map((it) => {
                const p: Portion = servings === 1 ? it : { ...it, amount: Math.round(it.amount * servings * 100) / 100, grams: it.grams ? Math.round(it.grams * servings * 10) / 10 : null, n: scaleTotals(it.n, servings) };
                return makeEntry(p, slot, "meal", day);
              });
              item.update((d) => {
                ensureDay(d, day).entries.push(...entries);
              });
              setAdded((n) => n + meal.items.length);
              toast.success(`Logged ${meal.name}`);
              setMeal(null);
            }}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <ScrollRow className="md:flex-wrap">
              {visibleSlots(s).map((x) => (
                <Chip key={x.id} active={slot === x.id} onClick={() => setSlot(x.id)}>
                  {x.name}
                </Chip>
              ))}
            </ScrollRow>
            <Segmented
              value={tab}
              onChange={setTab}
              className="w-full"
              options={[
                { value: "search", label: <span className="inline-flex items-center gap-1.5"><Search className="h-3.5 w-3.5" />Search</span> },
                { value: "scan", label: <span className="inline-flex items-center gap-1.5"><ScanBarcode className="h-3.5 w-3.5" />Scan</span> },
                { value: "quick", label: <span className="inline-flex items-center gap-1.5"><Zap className="h-3.5 w-3.5" />Quick</span> },
                { value: "describe", label: <span className="inline-flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5" />Describe</span> },
              ]}
            />
            {tab === "search" && (
              <div className="flex flex-col gap-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
                  <TextInput
                    ref={searchRef}
                    type="search"
                    enterKeyHint="search"
                    aria-label="Search foods"
                    placeholder="Search foods, e.g. greek yogurt"
                    value={q}
                    onChange={(e) => {
                      setQ(e.target.value);
                      setOnline(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" || !q.trim()) return;
                      // Enter opens the best match (or goes online when nothing matched).
                      if (results.length) pickFood(results[0]);
                      else void doOnline();
                    }}
                    className="pl-9"
                  />
                </div>
                {q.trim() ? (
                  <>
                    {results.length > 0 ? (
                      <List>
                        {results.map((f) => (
                          <FoodRow
                            key={f.id}
                            food={f}
                            fav={favs.has(f.id)}
                            done={flash.has(f.id)}
                            onPick={() => pickFood(f)}
                            onQuick={() => {
                              logPortion(portionOf(f, servingOf(f, null) ? 1 : 100, servingOf(f, null) ? "serving" : (f.liquid ? "ml" : "g"), null), "food");
                              flashRow(f.id);
                            }}
                            settings={s}
                          />
                        ))}
                      </List>
                    ) : (
                      !loading && <p className="px-1 text-sm text-[var(--text-muted)]">Nothing in your foods or the built-in list.</p>
                    )}
                    {online?.q === q.trim() ? (
                      online.foods.length ? (
                        <section className="flex flex-col gap-2">
                          <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Open Food Facts</h3>
                          <List>
                            {online.foods.map((f, i) => (
                              <ListRow
                                key={`${f.barcode ?? f.name}-${i}`}
                                onClick={() => setPicked({ food: adopt(f), origin: "online", found: f })}
                                leading={<Globe className="h-4 w-4 text-[var(--text-muted)]" />}
                                title={f.name}
                                subtitle={[f.brand, f.servings[0]?.label].filter(Boolean).join(" · ")}
                                trailing={<span className="tabular-nums">{fmtNum(f.per100.kcal)} kcal/100</span>}
                              />
                            ))}
                          </List>
                        </section>
                      ) : (
                        <p className="px-1 text-sm text-[var(--text-muted)]">Open Food Facts has nothing for “{online.q}”.</p>
                      )
                    ) : (
                      <ItemButton icon={onlineBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />} disabled={onlineBusy || q.trim().length < 2} onClick={() => void doOnline()}>
                        Search Open Food Facts for “{q.trim()}”
                      </ItemButton>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <ItemButton size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setEditor({ name: q.trim() })}>
                        Create “{q.trim()}”
                      </ItemButton>
                      <ItemButton
                        size="sm"
                        variant="ghost"
                        icon={<Sparkles className="h-3.5 w-3.5" />}
                        onClick={() => {
                          ask(`Log to my ${slotName.toLowerCase()} on ${day}: ${q.trim()}. Estimate the nutrition if you can't find it.`);
                          onClose();
                        }}
                      >
                        Ask AI to estimate it
                      </ItemButton>
                    </div>
                  </>
                ) : (
                  <BrowseLists
                    browse={browse}
                    setBrowse={setBrowse}
                    data={data}
                    recent={recent}
                    resolve={resolve}
                    onPick={pickFood}
                    onRelog={(p, key) => {
                      logPortion({ ...p }, "food");
                      if (key) flashRow(key);
                    }}
                    flash={flash}
                    onMeal={setMeal}
                    onNewFood={() => setEditor({})}
                  />
                )}
              </div>
            )}
            {tab === "scan" && (
              <div className="flex flex-col gap-3">
                {open && tab === "scan" && <Scanner onCode={(c) => void onCode(c)} busy={scanBusy} recent={recentBarcodes(item.data)} onRecent={(f) => setPicked({ food: f, origin: "library" })} settings={s} />}
                {notFound && (
                  <EmptyState
                    icon={ScanBarcode}
                    title={`${notFound} isn't in Open Food Facts yet`}
                    text="Add it once from the label and it'll scan instantly next time."
                    action={
                      <ItemButton variant="primary" onClick={() => setEditor({ barcode: notFound })}>
                        Add this food
                      </ItemButton>
                    }
                  />
                )}
                <p className="px-1 text-xs text-[var(--text-muted)]">Product data from Open Food Facts (openfoodfacts.org), looked up by your server.</p>
              </div>
            )}
            {tab === "quick" && <QuickAdd settings={s} onAdd={(p) => logPortion(p, "quick")} />}
            {tab === "describe" && (
              <Describe
                slotName={slotName}
                onSend={(text) => {
                  ask(`Log this to my ${slotName.toLowerCase()} on ${day}: "${text}". Use my foods or the built-in list where they match; otherwise estimate and mark the estimates.`);
                  onClose();
                }}
              />
            )}
          </div>
        )}
      </Sheet>
      <FoodEditor
        open={!!editor}
        onClose={() => setEditor(null)}
        item={item}
        food={editor}
        onSaved={(f) => {
          setNotFound(null);
          setPicked({ food: f, origin: "library" });
        }}
      />
    </>
  );
}

function QuickPlus({ label, done, onClick }: { label: string; done?: boolean; onClick: () => void }) {
  return (
    <IconButton
      label={done ? "Added" : label}
      icon={done ? Check : Plus}
      onClick={onClick}
      className={done ? "mr-1 bg-[color-mix(in_srgb,var(--item-accent)_16%,transparent)] text-[var(--item-accent)]" : "mr-1 text-[var(--item-accent)]"}
    />
  );
}

function FoodRow({ food, fav, done, onPick, onQuick, settings }: { food: Food; fav: boolean; done?: boolean; onPick: () => void; onQuick: () => void; settings: MealsData["settings"] }) {
  return (
    <div className="flex items-center">
      <ListRow
        className="flex-1"
        onClick={onPick}
        title={
          <span className="flex items-center gap-1.5">
            {fav && <Star className="h-3.5 w-3.5 shrink-0 fill-current text-[var(--item-accent)]" aria-label="Favourite" />}
            <span className="truncate">{foodLabel(food)}</span>
          </span>
        }
        subtitle={defaultPortionText(food, settings)}
      />
      <QuickPlus label={`Quick add ${food.name}`} done={done} onClick={onQuick} />
    </div>
  );
}

function BrowseLists({
  browse,
  setBrowse,
  data,
  recent,
  resolve,
  onPick,
  onRelog,
  onMeal,
  onNewFood,
  flash,
}: {
  browse: Browse;
  setBrowse: (b: Browse) => void;
  data: MealsData;
  recent: ReturnType<typeof recents>;
  resolve: (ref: string | null) => Food | null;
  onPick: (f: Food, initial?: Picked["initial"]) => void;
  onRelog: (p: Portion, key?: string) => void;
  onMeal: (m: SavedMeal) => void;
  onNewFood: () => void;
  flash: Set<string>;
}) {
  const s = data.settings;
  const favFoods = data.favourites.map((id) => resolve(id)).filter((f): f is Food => !!f);
  return (
    <div className="flex flex-col gap-3">
      <ScrollRow className="md:flex-wrap">
        <Chip active={browse === "recent"} onClick={() => setBrowse("recent")} icon={<History className="h-3.5 w-3.5" />}>
          Recent
        </Chip>
        <Chip active={browse === "favourites"} onClick={() => setBrowse("favourites")} icon={<Star className="h-3.5 w-3.5" />}>
          Favourites
        </Chip>
        <Chip active={browse === "mine"} onClick={() => setBrowse("mine")}>
          My foods
        </Chip>
        <Chip active={browse === "meals"} onClick={() => setBrowse("meals")} icon={<UtensilsCrossed className="h-3.5 w-3.5" />}>
          Saved meals
        </Chip>
      </ScrollRow>
      {browse === "recent" &&
        (recent.length ? (
          <List>
            {recent.map((r) => (
              <div key={r.key} className="flex items-center">
                <ListRow
                  className="flex-1"
                  onClick={() =>
                    r.food
                      ? onPick(r.food, { amount: r.portion.amount, unit: r.portion.unit === "kcal" ? "serving" : r.portion.unit, serving_id: r.portion.serving_id })
                      : onRelog(r.portion, r.key)
                  }
                  title={
                    <span className="flex items-center gap-1.5">
                      <span className="truncate">{foodLabel(r.portion)}</span>
                      {r.portion.estimate && <EstBadge />}
                    </span>
                  }
                  subtitle={`${portionText(r.portion)} · ${fmtEnergy(r.portion.n.kcal, s, true)}${r.times > 1 ? ` · ${r.times}×` : ""}`}
                />
                <QuickPlus label={`Log ${r.portion.name} again`} done={flash.has(r.key)} onClick={() => onRelog(r.portion, r.key)} />
              </div>
            ))}
          </List>
        ) : (
          <EmptyState icon={History} title="Nothing logged yet" text="Search above, scan a barcode, or describe your meal and the assistant will log it." />
        ))}
      {browse === "favourites" &&
        (favFoods.length ? (
          <List>
            {favFoods.map((f) => (
              <ListRow key={f.id} onClick={() => onPick(f)} leading={<Star className="h-4 w-4 fill-current text-[var(--item-accent)]" />} title={foodLabel(f)} subtitle={defaultPortionText(f, s)} />
            ))}
          </List>
        ) : (
          <EmptyState icon={Star} title="No favourites yet" text="Star a food when you add it to find it here." />
        ))}
      {browse === "mine" && (
        <>
          {data.foods.length ? (
            <List className="max-h-[50dvh] overflow-y-auto">
              {[...data.foods].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 300).map((f) => (
                <ListRow key={f.id} onClick={() => onPick(f)} title={foodLabel(f)} subtitle={defaultPortionText(f, s)} />
              ))}
            </List>
          ) : (
            <p className="px-1 text-sm text-[var(--text-muted)]">Foods you create, scan or find online are kept here.</p>
          )}
          <ItemButton icon={<Plus className="h-4 w-4" />} onClick={onNewFood}>
            New food
          </ItemButton>
        </>
      )}
      {browse === "meals" &&
        (data.meals.length ? (
          <List>
            {data.meals.map((m) => (
              <ListRow
                key={m.id}
                onClick={() => onMeal(m)}
                leading={<UtensilsCrossed className="h-4 w-4 text-[var(--text-muted)]" />}
                title={m.name}
                subtitle={`${m.items.length} items · ${fmtEnergy(total(m.items).kcal, s, true)}`}
              />
            ))}
          </List>
        ) : (
          <EmptyState icon={UtensilsCrossed} title="No saved meals" text="In the diary, open a meal's ⋯ menu and choose “Save as meal” to reuse a combo in one tap." />
        ))}
    </div>
  );
}

function unitOptions(food: Food) {
  const opts: { value: string; label: string }[] = food.servings.map((x) => ({ value: `s:${x.id}`, label: `${x.label} (${fmtNum(x.grams)} ${food.liquid ? "ml" : "g"})` }));
  opts.push({ value: food.liquid ? "ml" : "g", label: food.liquid ? "ml" : "grams" });
  opts.push({ value: food.liquid ? "g" : "ml", label: food.liquid ? "grams" : "ml" });
  opts.push({ value: "oz", label: "oz (weight)" });
  // Cups and spoons only where a volume means something: drinks, and foods
  // with a known density (oils, honey, milk…).
  if (densityOf(food) !== null) {
    for (const u of ["cup", "tbsp", "tsp", "floz"] as const) opts.push({ value: u, label: HOUSEHOLD_LABEL[u] });
  }
  return opts;
}

export function PortionPicker({
  item,
  picked,
  slot,
  onSlot,
  remaining,
  onBack,
  onAdd,
  onEdit,
  initial,
  submitLabel = "Add",
}: {
  item: ItemHandle<MealsData>;
  picked: Picked;
  slot: string;
  onSlot: (s: string) => void;
  remaining: number;
  onBack?: () => void;
  onAdd: (p: Portion) => void;
  onEdit?: () => void;
  initial?: { amount: number; unit: Unit; serving_id: string | null };
  submitLabel?: string;
}) {
  const food = picked.food;
  initial = initial ?? picked.initial;
  const s = meals(item.data).settings;
  const first = servingOf(food, initial?.serving_id ?? null);
  const [amount, setAmount] = useState<number>(initial?.amount ?? (first ? 1 : 100));
  const [unitKey, setUnitKey] = useState<string>(() => {
    if (initial) return initial.unit === "serving" && initial.serving_id ? `s:${initial.serving_id}` : initial.unit === "serving" && first ? `s:${first.id}` : initial.unit;
    return first ? `s:${first.id}` : food.liquid ? "ml" : "g";
  });
  const unit: Unit = unitKey.startsWith("s:") ? "serving" : (unitKey as Unit);
  const servingId = unitKey.startsWith("s:") ? unitKey.slice(2) : null;
  const p = useMemo(() => portionOf(food, amount || 0, unit, servingId), [food, amount, unit, servingId]);
  const isFav = meals(item.data).favourites.includes(food.id);
  const known = food.id.startsWith("b:") || meals(item.data).foods.some((f) => f.id === food.id);
  const share = remaining > 0 ? Math.min(1, p.n.kcal / remaining) : 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2">
        {onBack && <IconButton label="Back" icon={ArrowLeft} onClick={onBack} />}
        <div className="min-w-0 flex-1 pt-1">
          <p className="text-base font-semibold leading-snug text-[var(--text)]">{food.name}</p>
          <p className="text-xs text-[var(--text-muted)]">
            {[food.brand, picked.origin === "builtin" ? "Built-in · USDA reference" : picked.origin === "online" || picked.origin === "barcode" ? "Open Food Facts" : "My foods"]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        {known && (
          <IconButton
            label={isFav ? "Remove from favourites" : "Add to favourites"}
            icon={Star}
            active={isFav}
            className={isFav ? "[&_svg]:fill-current" : ""}
            onClick={() => {
              const on = !isFav;
              item.update((d) => {
                if (on && !d.favourites.includes(food.id)) d.favourites.push(food.id);
                if (!on) d.favourites = d.favourites.filter((f) => f !== food.id);
              });
            }}
          />
        )}
        {onEdit && !food.id.startsWith("b:") && known && <IconButton label="Edit food" icon={Pencil} onClick={onEdit} />}
      </div>

      <div className="grid grid-cols-[1fr_1.4fr] gap-2">
        <Field label="Amount">
          <NumberInput ariaLabel="Amount" value={amount} onChange={(v) => setAmount(Math.max(0, v ?? 0))} />
        </Field>
        <Field label="Unit">
          <Select value={unitKey} onChange={(e) => setUnitKey(e.target.value)} aria-label="Unit">
            {unitOptions(food).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {(unit === "serving" || unit === "g" || unit === "ml") && (
        <ScrollRow>
          {(unit === "serving" ? [0.5, 1, 1.5, 2, 3] : [50, 100, 150, 200, 250, 300]).map((m) => (
            <Chip key={m} active={amount === m} onClick={() => setAmount(m)} className="h-9 min-w-[44px] justify-center text-sm">
              {m === 0.5 ? "½" : m === 1.5 ? "1½" : unit === "serving" ? `${m}×` : `${m} ${unit}`}
            </Chip>
          ))}
        </ScrollRow>
      )}

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4" aria-live="polite">
        <div className="flex items-baseline justify-between">
          <span className="text-3xl font-semibold tabular-nums tracking-tight text-[var(--text)]">{fmtEnergy(p.n.kcal, s)}</span>
          <span className="text-sm text-[var(--text-muted)]">
            {s.energy_unit}
            {p.grams ? ` · ${fmtNum(p.grams)} ${food.liquid ? "ml" : "g"}` : ""}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          {(
            [
              ["Protein", p.n.protein, MACRO_COLOR.protein],
              ["Carbs", p.n.carbs, MACRO_COLOR.carbs],
              ["Fat", p.n.fat, MACRO_COLOR.fat],
            ] as const
          ).map(([label, v, c]) => (
            <div key={label} className="rounded-xl bg-[var(--surface-2)] py-2">
              <div className="text-base font-semibold tabular-nums text-[var(--text)]">{fmtNum(v, 1)} g</div>
              <div className="flex items-center justify-center gap-1 text-[11px] text-[var(--text-muted)]">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
                {label}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex justify-between text-xs text-[var(--text-muted)] tabular-nums">
          <span>Fibre {fmtNum(p.n.fibre, 1)} g</span>
          <span>Sugar {fmtNum(p.n.sugar, 1)} g</span>
          <span>Sodium {fmtNum(p.n.sodium)} mg</span>
        </div>
        {remaining > 0 && (
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            Uses {Math.round(share * 100)}% of the {fmtEnergy(remaining, s, true)} you have left today.
          </p>
        )}
      </div>

      <div className="flex items-end gap-2">
        <Field label="Meal" className="flex-1">
          <Select value={slot} onChange={(e) => onSlot(e.target.value)} aria-label="Meal">
            {visibleSlots(s).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
        <ItemButton variant="primary" size="lg" disabled={!amount || !item.canEdit} onClick={() => onAdd(p)}>
          {submitLabel}
        </ItemButton>
      </div>
    </div>
  );
}

function MealPicker({
  meal,
  item,
  slot,
  onSlot,
  onBack,
  onLog,
}: {
  meal: SavedMeal;
  item: ItemHandle<MealsData>;
  slot: string;
  onSlot: (s: string) => void;
  onBack: () => void;
  onLog: (servings: number) => void;
}) {
  const s = meals(item.data).settings;
  const [servings, setServings] = useState(1);
  const t = scaleTotals(total(meal.items), servings);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <IconButton label="Back" icon={ArrowLeft} onClick={onBack} />
        <p className="text-sm text-[var(--text-muted)]">
          {meal.items.length} items · {fmtEnergy(t.kcal, s, true)} · P {fmtNum(t.protein)} · C {fmtNum(t.carbs)} · F {fmtNum(t.fat)}
        </p>
      </div>
      <List>
        {meal.items.map((it, i) => (
          <ListRow key={i} title={it.name} subtitle={portionText(it)} trailing={<span className="tabular-nums">{fmtEnergy(it.n.kcal * servings, s)}</span>} />
        ))}
      </List>
      <Stepper label="Servings" value={servings} onChange={setServings} step={0.5} min={0.5} max={20} />
      <div className="flex items-end gap-2">
        <Field label="Meal" className="flex-1">
          <Select value={slot} onChange={(e) => onSlot(e.target.value)} aria-label="Meal">
            {visibleSlots(s).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
        <ItemButton variant="primary" size="lg" onClick={() => onLog(servings)}>
          Log meal
        </ItemButton>
      </div>
    </div>
  );
}

function QuickAdd({ settings, onAdd }: { settings: MealsData["settings"]; onAdd: (p: Portion) => void }) {
  const [name, setName] = useState("");
  const [energy, setEnergy] = useState<number | null>(null);
  const [p, setP] = useState<number | null>(null);
  const [c, setC] = useState<number | null>(null);
  const [f, setF] = useState<number | null>(null);
  const fromMacros = kcalFromMacros(p ?? 0, c ?? 0, f ?? 0);
  const kcal = energy !== null ? toKcal(energy, settings) : fromMacros;
  const add = () => {
    onAdd({
      name: name.trim() || "Quick add",
      brand: "",
      food_ref: null,
      amount: 1,
      unit: "serving",
      serving_id: null,
      serving_label: "quick add",
      grams: null,
      n: { kcal: Math.round(kcal * 10) / 10, protein: p ?? 0, carbs: c ?? 0, fat: f ?? 0, fibre: 0, sugar: 0, sat_fat: 0, sodium: 0, micros: {} },
      estimate: false,
    });
    setName("");
    setEnergy(null);
    setP(null);
    setC(null);
    setF(null);
  };
  return (
    <div className="flex flex-col gap-3">
      <Field label="What (optional)">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Snack at the café" />
      </Field>
      <Field label={`Energy (${settings.energy_unit})`} hint={energy === null && fromMacros > 0 ? `From macros: ${fmtEnergy(fromMacros, settings, true)}` : undefined}>
        <NumberInput ariaLabel="Energy" allowEmpty value={energy} onChange={setEnergy} suffix={settings.energy_unit} />
      </Field>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Protein">
          <NumberInput ariaLabel="Protein" allowEmpty value={p} onChange={setP} suffix="g" />
        </Field>
        <Field label="Carbs">
          <NumberInput ariaLabel="Carbs" allowEmpty value={c} onChange={setC} suffix="g" />
        </Field>
        <Field label="Fat">
          <NumberInput ariaLabel="Fat" allowEmpty value={f} onChange={setF} suffix="g" />
        </Field>
      </div>
      <ItemButton variant="primary" block disabled={!(kcal > 0)} onClick={add}>
        Add {kcal > 0 ? fmtEnergy(kcal, settings, true) : ""}
      </ItemButton>
    </div>
  );
}

const EXAMPLES = ["2 eggs, toast with butter and a flat white", "Chicken burrito bowl from Chipotle", "A handful of almonds and an apple", "Spaghetti bolognese, a big plate"];

function Describe({ slotName, onSend }: { slotName: string; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="flex flex-col gap-3">
      <Field label={`Describe your ${slotName.toLowerCase()}`} hint="The assistant matches your foods where it can and estimates the rest — estimates are marked “est.”">
        <TextArea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="2 eggs, toast with butter and a flat white" />
      </Field>
      <div className="flex flex-wrap gap-2">
        {EXAMPLES.map((ex) => (
          <Chip key={ex} onClick={() => setText(ex)}>
            {ex}
          </Chip>
        ))}
      </div>
      <ItemButton variant="primary" block disabled={!text.trim()} icon={<Sparkles className="h-4 w-4" />} onClick={() => onSend(text.trim())}>
        Log it with AI
      </ItemButton>
    </div>
  );
}

