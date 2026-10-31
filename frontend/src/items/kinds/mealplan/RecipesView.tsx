import { useVirtualizer } from "@tanstack/react-virtual";
import { BookOpen, ClipboardPaste, Heart, Link2, Plus, Search, Sparkles, Star, UtensilsCrossed } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import { Chip, EmptyState, Fab, ItemButton, Page, ScrollRow, Select, Sheet, TextInput, todayISO } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { CookMode } from "./CookMode";
import { allergenSummary, fmtMinutes, matchesQuery, recipeNav, recipeTime } from "./helpers";
import { RecipeThumb } from "./parts";
import { AddToPlanSheet } from "./PlanSheets";
import { RecipeDetail } from "./RecipeDetail";
import { ImportSheet, RecipeEditor } from "./RecipeEditor";
import type { MealPlanData, Recipe } from "./types";
import type { UnitSystem } from "./units";
import { useWidth } from "./useWidth";

type Sort = "recent" | "az" | "cooked" | "rating" | "quick";
const TIMES = [20, 30, 45, 60];

export function RecipesView({ item, isPhone, ask }: ItemViewProps<MealPlanData>) {
  const data = item.data;
  const [selected, setSelected] = useState<string | null>(() => recipeNav.take());
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [maxTime, setMaxTime] = useState<number | null>(null);
  const [favs, setFavs] = useState(false);
  const [sort, setSort] = useState<Sort>("recent");
  const [editing, setEditing] = useState<Recipe | "new" | null>(null);
  const [importing, setImporting] = useState<"link" | "text" | null>(null);
  const [adding, setAdding] = useState(false);
  const [cook, setCook] = useState<{ recipe: Recipe; factor: number; system: UnitSystem } | null>(null);
  const [planning, setPlanning] = useState<{ recipe: Recipe; servings: number } | null>(null);

  const tags = useMemo(() => {
    const count = new Map<string, number>();
    for (const r of data.recipes) for (const t of r.tags) count.set(t, (count.get(t) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t]) => t);
  }, [data.recipes]);

  const list = useMemo(() => {
    const out = data.recipes.filter(
      (r) => matchesQuery(r, q.trim()) && (!tag || r.tags.includes(tag)) && (!favs || r.favorite) && (!maxTime || (recipeTime(r) ?? 999) <= maxTime),
    );
    const by: Record<Sort, (a: Recipe, b: Recipe) => number> = {
      recent: (a, b) => (b.added || "").localeCompare(a.added || "") || a.title.localeCompare(b.title),
      az: (a, b) => a.title.localeCompare(b.title),
      cooked: (a, b) => (b.times_cooked || 0) - (a.times_cooked || 0),
      rating: (a, b) => (b.rating || 0) - (a.rating || 0),
      quick: (a, b) => (recipeTime(a) ?? 999) - (recipeTime(b) ?? 999),
    };
    return out.sort(by[sort]);
  }, [data.recipes, q, tag, favs, maxTime, sort]);

  const current = data.recipes.find((r) => r.id === selected) ?? null;
  // Desktop: list | recipe side by side when the tab has the room for it
  // (measured — the AI panel can take a third of a laptop screen).
  const [rootRef, rootW] = useWidth<HTMLDivElement>();
  const split = !isPhone && (rootW === 0 || rootW >= 760);
  const listW = rootW >= 1180 ? 380 : 300;
  // Split view: always show something on the right.
  useEffect(() => {
    if (split && rootW > 0 && !current && list[0]) setSelected(list[0].id);
  }, [split, rootW, current, list]);

  // Only the fields the person changed in the editor are written, so an
  // edit made meanwhile by someone else (a rating, times cooked) survives.
  const saveRecipe = (r: Recipe) => {
    const before = typeof editing === "object" && editing && editing.id === r.id ? editing : data.recipes.find((x) => x.id === r.id) ?? null;
    const changed = before
      ? (Object.keys(r) as (keyof Recipe)[]).filter((k) => JSON.stringify(r[k]) !== JSON.stringify(before[k]))
      : null;
    item.update((d) => {
      const cur = d.recipes.find((x) => x.id === r.id);
      if (!cur) {
        d.recipes.push(structuredClone(r));
      } else if (changed) {
        const target = cur as unknown as Record<string, unknown>;
        for (const k of changed) target[k] = structuredClone(r[k]);
      }
      if (!changed || changed.includes("title")) for (const e of d.plan) if (e.recipe_id === r.id) e.title = r.title;
    });
    setEditing(null);
    setImporting(null);
    setSelected(r.id);
    const warn = allergenSummary(r, data.preferences.allergies);
    if (warn) toast.warning(`Saved “${r.title}” — allergy warning: contains ${warn}.`);
    else toast.success(`Saved “${r.title}”`);
  };

  const addMenu = (
    <div className="flex flex-col gap-2">
      <ItemButton block icon={<Link2 className="h-4 w-4" />} onClick={() => { setAdding(false); setImporting("link"); }}>
        Import from a link
      </ItemButton>
      <ItemButton block icon={<ClipboardPaste className="h-4 w-4" />} onClick={() => { setAdding(false); setImporting("text"); }}>
        Paste recipe text
      </ItemButton>
      <ItemButton block icon={<Plus className="h-4 w-4" />} onClick={() => { setAdding(false); setEditing("new"); }}>
        Write one
      </ItemButton>
      <ItemButton block icon={<Sparkles className="h-4 w-4 text-[var(--item-accent)]" />} onClick={() => { setAdding(false); ask("Find me a quick, reliable weeknight recipe that fits my preferences and save it to my recipe box."); }}>
        Find one with AI
      </ItemButton>
      {data.recipes.length < 6 && (
        <ItemButton
          block
          variant="ghost"
          icon={<BookOpen className="h-4 w-4" />}
          onClick={() => {
            setAdding(false);
            item
              .runAction("add_starter_recipes")
              .then((r) => toast.success(r.summary))
              .catch((e) => toast.error((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? (navigator.onLine === false ? "You're offline — try again when you're connected." : "Couldn't add the starter recipes.")));
          }}
        >
          Add 6 starter recipes
        </ItemButton>
      )}
    </div>
  );

  const filters = (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
          <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or ingredient" className="pl-9" aria-label="Search recipes" />
        </div>
        <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort" className="!w-auto">
          <option value="recent">Newest</option>
          <option value="az">A–Z</option>
          <option value="cooked">Most cooked</option>
          <option value="rating">Top rated</option>
          <option value="quick">Quickest</option>
        </Select>
      </div>
      <ScrollRow>
        <Chip active={favs} onClick={() => setFavs((f) => !f)} icon={<Heart className="h-3.5 w-3.5" />}>
          Favourites
        </Chip>
        {TIMES.map((t) => (
          <Chip key={t} active={maxTime === t} onClick={() => setMaxTime(maxTime === t ? null : t)}>
            ≤ {t} min
          </Chip>
        ))}
        {tags.map((t) => (
          <Chip key={t} active={tag === t} onClick={() => setTag(tag === t ? null : t)}>
            #{t}
          </Chip>
        ))}
      </ScrollRow>
    </div>
  );

  const overlays = (
    <>
      <RecipeEditor open={editing !== null} recipe={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSave={saveRecipe} />
      <ImportSheet
        open={importing !== null}
        initialMode={importing ?? "link"}
        onClose={() => setImporting(null)}
        onSave={saveRecipe}
        onEdit={(r) => {
          setImporting(null);
          setEditing(r);
        }}
        onAsk={(p) => {
          setImporting(null);
          ask(p);
        }}
        allergies={data.preferences.allergies}
      />
      <Sheet open={adding} onClose={() => setAdding(false)} title="Add a recipe" size="sm">
        {addMenu}
      </Sheet>
      {planning && <AddToPlanSheet item={item} recipe={planning.recipe} servings={planning.servings} onClose={() => setPlanning(null)} />}
      {cook && (
        <CookMode
          recipe={cook.recipe}
          factor={cook.factor}
          system={cook.system}
          units={data.preferences.units}
          keepAwake={data.preferences.keep_awake}
          onClose={() => setCook(null)}
          onFinish={
            item.canEdit
              ? (rating) => {
                  const id = cook.recipe.id;
                  const today = todayISO();
                  item.update((d) => {
                    const r = d.recipes.find((x) => x.id === id);
                    if (!r) return;
                    const planned = d.plan.find((e) => e.recipe_id === id && !e.cooked && !e.leftovers_of && e.date <= today);
                    if (planned) planned.cooked = true;
                    r.times_cooked = (r.times_cooked || 0) + 1;
                    r.last_cooked = planned?.date ?? today;
                    if (rating) r.rating = rating;
                  });
                  setCook(null);
                  toast.success("Marked as cooked");
                }
              : undefined
          }
        />
      )}
    </>
  );

  const detail = current && (
    <RecipeDetail
      key={current.id}
      item={item}
      recipe={current}
      isPhone={isPhone}
      onBack={split ? undefined : () => setSelected(null)}
      onEdit={() => setEditing(current)}
      onCook={(servings, system) => setCook({ recipe: current, factor: servings / current.servings, system })}
      onPlan={(servings) => setPlanning({ recipe: current, servings })}
      ask={ask}
    />
  );

  if (data.recipes.length === 0) {
    return (
      <Page>
        <EmptyState
          icon={UtensilsCrossed}
          title="Your recipe box is empty"
          text="Import recipes from most recipe sites, paste them from a note, write your own — or let the assistant find some that fit your diet and time."
          action={
            item.canEdit ? (
              <div className="flex w-full max-w-xs flex-col gap-2">{addMenu}</div>
            ) : undefined
          }
        />
        {overlays}
      </Page>
    );
  }

  if (!split) {
    const body = (
      <Page className={isPhone ? "gap-4" : undefined}>
        {current ? (
          detail
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xl font-semibold text-[var(--text)]">
                Recipes <span className="text-base font-normal tabular-nums text-[var(--text-muted)]">{list.length === data.recipes.length ? data.recipes.length : `${list.length} of ${data.recipes.length}`}</span>
              </p>
              {!isPhone && item.canEdit && (
                <ItemButton size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
                  Add recipe
                </ItemButton>
              )}
            </div>
            {filters}
            <RecipeList recipes={list} selected={null} onSelect={setSelected} />
            {isPhone && item.canEdit && <Fab label="Add recipe" icon={Plus} onClick={() => setAdding(true)} />}
          </>
        )}
        {overlays}
      </Page>
    );
    return isPhone ? body : (
      <div ref={rootRef} className="h-full overflow-y-auto">
        {body}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="flex h-full min-h-0">
      <div className="flex shrink-0 flex-col gap-3 border-r border-[var(--border)] p-4" style={{ width: listW }}>
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-[var(--text)]">
            {list.length === data.recipes.length ? `${data.recipes.length} recipes` : `${list.length} of ${data.recipes.length}`}
          </p>
          {item.canEdit && (
            <ItemButton size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
              Add recipe
            </ItemButton>
          )}
        </div>
        {filters}
        <div className="min-h-0 flex-1">
          <RecipeList recipes={list} selected={selected} onSelect={setSelected} fill />
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-6 py-6">{detail ?? <EmptyState icon={Search} title="No recipe matches" text="Try another search or clear the filters." />}</div>
      </div>
      {overlays}
    </div>
  );
}

/** Desktop: virtualised in its own scroller (a recipe box can hold 1,500).
 *  Phone: the page scrolls; rows come in pages of 60. */
function RecipeList({ recipes, selected, onSelect, fill }: { recipes: Recipe[]; selected: string | null; onSelect: (id: string) => void; fill?: boolean }) {
  const parent = useRef<HTMLDivElement>(null);
  const [limit, setLimit] = useState(60);
  const virtual = !!fill && recipes.length > 60;
  const v = useVirtualizer({ count: recipes.length, getScrollElement: () => parent.current, estimateSize: () => 68, overscan: 8, enabled: virtual });
  if (recipes.length === 0) return <p className="py-8 text-center text-sm text-[var(--text-muted)]">No recipe matches.</p>;
  const row = (r: Recipe) => (
    <button
      type="button"
      onClick={() => onSelect(r.id)}
      aria-current={r.id === selected ? "true" : undefined}
      className={cn(
        "flex h-[68px] w-full items-center gap-3 rounded-xl px-2 text-left transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
        r.id === selected && "bg-[var(--hover)]",
      )}
    >
      <RecipeThumb recipe={r} size={48} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-[var(--text)]">{r.title}</p>
        <p className="flex items-center gap-1.5 truncate text-xs text-[var(--text-muted)]">
          {[fmtMinutes(recipeTime(r)), r.cuisine].filter(Boolean).join(" · ")}
          {r.rating > 0 && (
            <span className="inline-flex items-center gap-0.5">
              <Star className="h-3 w-3 fill-[var(--item-accent)] text-[var(--item-accent)]" />
              {r.rating}
            </span>
          )}
        </p>
      </div>
      {r.favorite && <Heart className="h-4 w-4 shrink-0 fill-[var(--danger)] text-[var(--danger)]" aria-label="Favourite" />}
    </button>
  );
  if (!virtual) {
    const shown = fill ? recipes : recipes.slice(0, limit);
    return (
      <div ref={parent} className={cn("flex flex-col", fill && "h-full overflow-y-auto")}>
        {shown.map((r) => (
          <div key={r.id}>{row(r)}</div>
        ))}
        {shown.length < recipes.length && (
          <ItemButton variant="ghost" className="mt-2" onClick={() => setLimit((n) => n + 60)}>
            Show more ({recipes.length - shown.length})
          </ItemButton>
        )}
      </div>
    );
  }
  return (
    <div ref={parent} className={cn(fill && "h-full overflow-y-auto")}>
      <div style={{ height: v.getTotalSize(), position: "relative" }}>
        {v.getVirtualItems().map((vi) => (
          <div key={recipes[vi.index].id} style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` }}>
            {row(recipes[vi.index])}
          </div>
        ))}
      </div>
    </div>
  );
}
