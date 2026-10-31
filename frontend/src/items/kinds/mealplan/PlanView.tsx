import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { BookOpen, CalendarDays, Check, ChefHat, ChevronDown, ChevronLeft, ChevronRight, Loader2, Plus, Repeat2, Search, ShoppingCart, Sparkles, TriangleAlert, UtensilsCrossed, X } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import { Card, ItemButton, Page, TextInput, addDays, todayISO, uid } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { CookMode } from "./CookMode";
import { allergenHits, allergenSummary, confirmAllergens, fmtDayNum, fmtMinutes, fmtMonthDay, fmtRange, fmtWeekday, matchesQuery, recipeNav, recipeTime, startOfWeek, useSortedRecipes, weekDays } from "./helpers";
import { Callout, RecipeThumb } from "./parts";
import { AssignSheet, MealSheet, addEntry } from "./PlanSheets";
import { SLOT_LABEL, SLOTS, type MealPlanData, type PlanEntry, type Recipe, type Slot } from "./types";
import { useWidth } from "./useWidth";

const longDay = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const fmtLongWeekday = (day: string) => longDay.format(new Date(day + "T12:00"));

export function PlanView({ item, isPhone, ask, goTo }: ItemViewProps<MealPlanData>) {
  const data = item.data;
  const prefs = data.preferences;
  const today = todayISO();
  const [start, setStart] = useState(() => startOfWeek(today, prefs.week_start));
  const days = weekDays(start);
  const end = days[6];
  const slots: Slot[] = SLOTS.filter((s) => prefs.slots.includes(s) || data.plan.some((e) => e.slot === s && e.date >= start && e.date <= end));
  const [assign, setAssign] = useState<{ date: string; slot: Slot } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null); // tap-to-assign
  const [dragging, setDragging] = useState<{ kind: "recipe" | "entry"; id: string } | null>(null);
  const [cook, setCook] = useState<PlanEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const [rootRef, rootW] = useWidth<HTMLDivElement>();
  const [sidebarPref, setSidebarPref] = useState<boolean | null>(null);

  const recipes = useMemo(() => new Map(data.recipes.map((r) => [r.id, r])), [data.recipes]);
  const week = useMemo(() => data.plan.filter((e) => e.date >= start && e.date <= end), [data.plan, start, end]);
  const at = (d: string, s: Slot) => week.filter((e) => e.date === d && e.slot === s);
  const wanted = days.length * prefs.slots.length;
  const filled = days.reduce((n, d) => n + prefs.slots.filter((s) => at(d, s).length).length, 0);
  const leftovers = week.filter((e) => e.leftovers_of).length;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
  );
  // Keyboard: no drag sensor (it would swallow Enter/Space) — tap a recipe,
  // then a slot's + button, does the same.

  // Drag/drop, tap-to-place and the pickers all ask first when the recipe
  // has something on the allergy list.
  const place = (date: string, slot: Slot, recipe: Recipe) => {
    if (!confirmAllergens(recipe, prefs.allergies)) return;
    const id = uid("m");
    item.update((d) => {
      addEntry(d, { id, date, slot, recipe_id: recipe.id, title: recipe.title, servings: null, leftovers_of: null, note: "", cooked: false });
    });
  };

  // This week's meals that contain an allergen — shown at the top.
  const flagged = useMemo(() => {
    if (!prefs.allergies.length) return [] as { entry: PlanEntry; text: string }[];
    const out: { entry: PlanEntry; text: string }[] = [];
    for (const e of week) {
      const r = recipes.get(e.recipe_id ?? "");
      const text = r ? allergenSummary(r, prefs.allergies) : "";
      if (text) out.push({ entry: e, text });
    }
    return out;
  }, [week, recipes, prefs.allergies]);
  const allergyBanner = flagged.length > 0 && (
    <Callout tone="danger" icon={<TriangleAlert className="h-4 w-4" />}>
      <b>Allergy warning this week:</b>{" "}
      {flagged.slice(0, 4).map((f, n) => (
        <span key={f.entry.id}>
          {n > 0 && "; "}
          <button type="button" className="font-medium underline" onClick={() => setOpen(f.entry.id)}>
            {fmtWeekday(f.entry.date)} {f.entry.title}
          </button>{" "}
          ({f.text})
        </span>
      ))}
      {flagged.length > 4 && ` and ${flagged.length - 4} more`}.
      {item.canEdit && (
        <>
          {" "}
          <button type="button" className="font-medium underline" onClick={() => ask(`Some meals planned for ${start} to ${end} contain things on my allergy list (${prefs.allergies.join(", ")}). Swap them for safe recipes or adapt them.`)}>
            Fix with AI
          </button>
        </>
      )}
    </Callout>
  );

  const onDragStart = (e: DragStartEvent) => {
    const [kind, id] = String(e.active.id).split(":");
    setDragging({ kind: kind as "recipe" | "entry", id });
  };
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    if (!e.over) return;
    const [kind, id] = String(e.active.id).split(":");
    const [, date, slot] = String(e.over.id).split(":");
    if (kind === "recipe") {
      const r = recipes.get(id);
      if (r) place(date, slot as Slot, r);
    } else {
      item.update((d) => {
        const x = d.plan.find((p) => p.id === id);
        if (!x) return;
        x.date = date;
        x.slot = slot as Slot;
        for (const r of d.plan) if (r.leftovers_of === x.id && r.date <= date) r.leftovers_of = null;
        d.plan.sort((a, b) => (a.date === b.date ? SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot) : a.date < b.date ? -1 : 1));
      });
    }
  };

  const groceries = async () => {
    if (navigator.onLine === false) {
      toast.error("You're offline — the list is built on the server. You can still add items by hand under Groceries.");
      return;
    }
    setBusy(true);
    try {
      const res = await item.runAction("generate_grocery_list", { start, end });
      toast.success(res.summary);
      goTo("groceries");
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(detail ?? "Couldn't build the list.");
    } finally {
      setBusy(false);
    }
  };

  const tapCell = (date: string, slot: Slot) => {
    if (!item.canEdit) return;
    const r = picked ? recipes.get(picked) : null;
    if (r) {
      place(date, slot, r);
      return;
    }
    setAssign({ date, slot });
  };

  const totalFor = (d: string, s: Slot) =>
    at(d, s).reduce((n, e) => {
      const r = recipes.get(e.recipe_id ?? "");
      return n + (e.leftovers_of || !r ? 0 : recipeTime(r) ?? 0);
    }, 0);
  const limitFor = (d: string, s: Slot) => (s === "dinner" ? ([0, 6].includes(new Date(d + "T12:00").getDay()) ? prefs.weekend_minutes : prefs.weeknight_minutes) : null);
  const isCurrent = start <= today && today <= end;
  const weekLabel = isCurrent ? "This week" : start > today ? (addDays(startOfWeek(today, prefs.week_start), 7) === start ? "Next week" : "Upcoming") : "Past week";
  // Desktop: the recipe rail and the week board both key off the space the
  // tab really has (the AI panel can take a third of the screen).
  const sidebar = sidebarPref ?? rootW >= 1300;
  const boardW = rootW - (sidebar ? 272 : 0);
  const board = boardW >= 900 || rootW === 0 ? "grid" : "agenda";
  const weekNav = (
    <div className="flex min-w-0 items-center gap-1">
      <button type="button" aria-label="Previous week" onClick={() => setStart(addDays(start, -7))} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] md:h-10 md:w-10">
        <ChevronLeft className="h-5 w-5" />
      </button>
      <div className={cn("min-w-[8.5rem] text-center", isPhone && "flex-1")}>
        <p className="text-base font-semibold tabular-nums text-[var(--text)]">{fmtRange(start, end)}</p>
        {isCurrent ? (
          <p className="text-xs tabular-nums text-[var(--text-muted)]" aria-live="polite">
            {weekLabel} · {filled}/{wanted} planned
          </p>
        ) : (
          <button type="button" onClick={() => setStart(startOfWeek(today, prefs.week_start))} className="text-xs font-medium text-[var(--item-accent)] hover:underline">
            {weekLabel} · back to this week
          </button>
        )}
      </div>
      <button type="button" aria-label="Next week" onClick={() => setStart(addDays(start, 7))} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] md:h-10 md:w-10">
        <ChevronRight className="h-5 w-5" />
      </button>
    </div>
  );
  const aiBtn = item.canEdit && (
    <ItemButton size={isPhone ? "md" : "sm"} variant={isPhone ? "secondary" : "ghost"} block={isPhone} icon={<Sparkles className="h-4 w-4 text-[var(--item-accent)]" />} onClick={() => ask(planPrompt(start, end, prefs.slots, week.length > 0))}>
      {week.length ? "Fill with AI" : "Plan with AI"}
    </ItemButton>
  );
  const listBtn = item.canEdit && (
    <ItemButton size={isPhone ? "md" : "sm"} variant="primary" block={isPhone} disabled={busy || !week.some((e) => e.recipe_id)} onClick={() => void groceries()} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />}>
      Grocery list
    </ItemButton>
  );
  const header = isPhone ? (
    <div className="flex flex-col gap-3">
      {weekNav}
      {item.canEdit && (
        <div className="grid grid-cols-2 gap-2">
          {aiBtn}
          {listBtn}
        </div>
      )}
    </div>
  ) : (
    <div className="flex flex-wrap items-center gap-2">
      {weekNav}
      <span className="flex-1" />
      {leftovers > 0 && <p className="text-sm tabular-nums text-[var(--text-muted)]">{leftovers} leftover meal{leftovers === 1 ? "" : "s"}</p>}
      {aiBtn}
      {listBtn}
      <button
        type="button"
        aria-label={sidebar ? "Hide recipes" : "Show recipes"}
        aria-pressed={sidebar}
        title={sidebar ? "Hide recipes" : "Show recipes"}
        onClick={() => setSidebarPref(!sidebar)}
        className={cn("flex h-9 w-9 items-center justify-center rounded-xl border transition hover:bg-[var(--hover)]", sidebar ? "border-[var(--item-accent)] text-[var(--item-accent)]" : "border-[var(--border)] text-[var(--text-muted)]")}
      >
        <BookOpen className="h-4 w-4" />
      </button>
    </div>
  );

  const emptyWeek = week.length === 0 && (
    <Card className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] text-[var(--item-accent)]">
        <CalendarDays className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-[var(--text)]">Nothing planned for this week yet</p>
        <p className="text-sm text-[var(--text-muted)]">
          {isPhone ? "Tap a day to add a meal" : "Drag recipes onto the days, or tap a slot"} — or let the assistant plan a balanced week around your preferences{data.pantry.length ? " and pantry" : ""}.
        </p>
      </div>
      {item.canEdit && (
        <ItemButton variant="primary" icon={<Sparkles className="h-4 w-4" />} onClick={() => ask(planPrompt(start, end, prefs.slots, false))}>
          Plan my week
        </ItemButton>
      )}
    </Card>
  );

  const overlays = (
    <>
      {assign && <AssignSheet item={item} target={assign} onClose={() => setAssign(null)} />}
      {open && (
        <MealSheet
          item={item}
          entryId={open}
          onClose={() => setOpen(null)}
          onOpenRecipe={(id) => {
            setOpen(null);
            recipeNav.open(id);
            goTo("recipes");
          }}
          onCook={(e) => {
            setOpen(null);
            setCook(e);
          }}
        />
      )}
      {cook && recipes.get(cook.recipe_id ?? "") && (
        <CookMode
          recipe={recipes.get(cook.recipe_id ?? "")!}
          factor={((cook.servings ?? prefs.household_size) + data.plan.filter((x) => x.leftovers_of === cook.id).reduce((n, x) => n + (x.servings ?? prefs.household_size), 0)) / recipes.get(cook.recipe_id ?? "")!.servings}
          units={prefs.units}
          keepAwake={prefs.keep_awake}
          onClose={() => setCook(null)}
          onFinish={
            item.canEdit
              ? (rating) => {
                  const id = cook.id;
                  item.update((d) => {
                    const e = d.plan.find((x) => x.id === id);
                    const r = d.recipes.find((x) => x.id === e?.recipe_id);
                    if (!e || !r) return;
                    if (!e.cooked) {
                      e.cooked = true;
                      r.times_cooked = (r.times_cooked || 0) + 1;
                      if (!r.last_cooked || r.last_cooked < e.date) r.last_cooked = e.date;
                    }
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

  if (isPhone) {
    // Today first: earlier days of this week fold away (Mealime-style).
    const past = isCurrent ? days.filter((d) => d < today) : [];
    const coming = isCurrent ? days.filter((d) => d >= today) : days;
    const pastMeals = week.filter((e) => e.date < today);
    const dayCard = (d: string) => (
      <DayCard
        key={d}
        day={d}
        isToday={d === today}
        slots={slots}
        at={at}
        recipes={recipes}
        allergies={prefs.allergies}
        canEdit={item.canEdit}
        onOpen={setOpen}
        onAdd={tapCell}
        onCook={setCook}
      />
    );
    return (
      <Page className="gap-4">
        {header}
        {allergyBanner}
        {emptyWeek}
        {past.length > 0 && (
          <button
            type="button"
            onClick={() => setShowPast((v) => !v)}
            aria-expanded={showPast}
            className="flex min-h-[44px] items-center gap-2 rounded-xl px-1 text-sm text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            <ChevronDown className={cn("h-4 w-4 transition", showPast && "rotate-180")} />
            <span className="font-medium">Earlier this week</span>
            <span className="tabular-nums">
              · {pastMeals.length ? `${pastMeals.filter((e) => e.cooked).length} of ${pastMeals.length} cooked` : "nothing planned"}
            </span>
          </button>
        )}
        {showPast && past.map(dayCard)}
        {coming.map(dayCard)}
        {overlays}
      </Page>
    );
  }

  const pickedRecipe = picked ? recipes.get(picked) : null;
  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div ref={rootRef} className="flex h-full min-h-0">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <Page wide className="!max-w-none">
            {header}
            {pickedRecipe && (
              <div className="flex items-center gap-2 rounded-xl border border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_10%,transparent)] px-3 py-2 text-sm text-[var(--text)]" role="status">
                Tap a slot to place <b>{pickedRecipe.title}</b>.
                <span className="flex-1" />
                <button type="button" aria-label="Stop placing" onClick={() => setPicked(null)} className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--hover)]">
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}
            {allergyBanner}
            {emptyWeek}
            {board === "grid" ? (
              <div className="grid gap-2" style={{ gridTemplateColumns: `5.5rem repeat(7, minmax(0, 1fr))` }}>
                <div />
                {days.map((d) => (
                  <div key={d} className={cn("rounded-xl px-2 py-1.5 text-center", d === today && "bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)]")}>
                    <p className={cn("text-xs font-medium", d === today ? "text-[var(--item-accent)]" : "text-[var(--text-muted)]")}>{fmtWeekday(d)}</p>
                    <p className={cn("text-lg font-semibold tabular-nums", d === today ? "text-[var(--item-accent)]" : "text-[var(--text)]")}>{fmtDayNum(d)}</p>
                  </div>
                ))}
                {slots.map((s) => (
                  <SlotRow
                    key={s}
                    slot={s}
                    days={days}
                    today={today}
                    at={at}
                    recipes={recipes}
                    allergies={prefs.allergies}
                    canEdit={item.canEdit}
                    placing={!!pickedRecipe}
                    onTap={tapCell}
                    onOpen={setOpen}
                    totalFor={(d) => totalFor(d, s)}
                    limitFor={(d) => limitFor(d, s)}
                  />
                ))}
              </div>
            ) : (
              // Narrow desktop (AI panel open): days down, meals across.
              <div className="grid gap-2" style={{ gridTemplateColumns: `4.5rem repeat(${slots.length}, minmax(0, 1fr))` }}>
                <div />
                {slots.map((s) => (
                  <p key={s} className="px-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                    {SLOT_LABEL[s]}
                  </p>
                ))}
                {days.map((d) => (
                  <Fragment key={d}>
                    <div className={cn("flex flex-col items-center justify-center rounded-xl py-1.5", d === today && "bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)]")}>
                      <p className={cn("text-xs font-medium", d === today ? "text-[var(--item-accent)]" : "text-[var(--text-muted)]")}>{fmtWeekday(d)}</p>
                      <p className={cn("text-lg font-semibold tabular-nums", d === today ? "text-[var(--item-accent)]" : "text-[var(--text)]")}>{fmtDayNum(d)}</p>
                    </div>
                    {slots.map((s) => (
                      <BoardCell
                        key={s}
                        date={d}
                        slot={s}
                        today={d === today}
                        entries={at(d, s)}
                        recipes={recipes}
                        allergies={prefs.allergies}
                        canEdit={item.canEdit}
                        placing={!!pickedRecipe}
                        onTap={tapCell}
                        onOpen={setOpen}
                        total={totalFor(d, s)}
                        limit={limitFor(d, s)}
                        compact
                      />
                    ))}
                  </Fragment>
                ))}
              </div>
            )}
          </Page>
        </div>
        {sidebar && <RecipeSidebar data={data} picked={picked} onPick={(id) => setPicked(picked === id ? null : id)} canEdit={item.canEdit} />}
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging && (
          <div className="rounded-xl border border-[var(--item-accent)] bg-[var(--surface)] px-3 py-2 text-sm font-medium text-[var(--text)] shadow-[var(--shadow-lg)]">
            {dragging.kind === "recipe" ? recipes.get(dragging.id)?.title : data.plan.find((e) => e.id === dragging.id)?.title}
          </div>
        )}
      </DragOverlay>
      {overlays}
    </DndContext>
  );
}

function planPrompt(start: string, end: string, slots: Slot[], partial: boolean): string {
  const what = slots.length === 1 ? `${slots[0]}s` : slots.join(", ");
  return partial
    ? `Fill the empty ${what} slots from ${start} to ${end}, working around what's already planned (reuse ingredients, plan leftovers where it helps).`
    : `Plan my ${what} for ${start} to ${end}: balanced, varied, within my time limits and budget, using what's in my pantry, with a cook-once-eat-twice night if it fits.`;
}

function MealChip({
  entry,
  recipe,
  onClick,
  allergies,
  draggable,
}: {
  entry: PlanEntry;
  recipe?: Recipe;
  onClick: () => void;
  allergies: string[];
  draggable?: boolean;
}) {
  const drag = useDraggable({ id: `entry:${entry.id}`, disabled: !draggable });
  const warn = recipe ? allergenHits(recipe, allergies).length > 0 : false;
  return (
    <button
      ref={drag.setNodeRef}
      {...(draggable ? drag.listeners : {})}
      {...(draggable ? drag.attributes : {})}
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-[40px] w-full min-w-0 items-start gap-1.5 rounded-lg border px-2 py-1.5 text-left text-sm transition hover:border-[var(--item-accent)] [&>svg]:mt-0.5",
        entry.leftovers_of ? "border-dashed border-[var(--border)] bg-[var(--surface-2)]" : "border-[var(--border)] bg-[var(--surface)]",
        entry.cooked && "opacity-60",
        drag.isDragging && "opacity-30",
      )}
      title={entry.title}
    >
      {entry.leftovers_of ? <Repeat2 className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-label="Leftovers" /> : null}
      {entry.cooked ? <Check className="h-3.5 w-3.5 shrink-0 text-[var(--success)]" aria-label="Cooked" /> : null}
      {warn ? <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-[var(--danger)]" aria-label="Contains an allergen" /> : null}
      <span className={cn("line-clamp-2 min-w-0 flex-1 break-words text-[13px] font-medium leading-snug text-[var(--text)]", !recipe && !entry.leftovers_of && "italic text-[var(--text-muted)]")}>{entry.title || recipe?.title || "Meal"}</span>
    </button>
  );
}

function SlotRow({
  slot,
  days,
  today,
  at,
  recipes,
  allergies,
  canEdit,
  placing,
  onTap,
  onOpen,
  totalFor,
  limitFor,
}: {
  slot: Slot;
  days: string[];
  today: string;
  at: (d: string, s: Slot) => PlanEntry[];
  recipes: Map<string, Recipe>;
  allergies: string[];
  canEdit: boolean;
  placing: boolean;
  onTap: (d: string, s: Slot) => void;
  onOpen: (id: string) => void;
  totalFor: (d: string) => number;
  limitFor: (d: string) => number | null;
}) {
  return (
    <>
      <div className="flex items-start pt-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{SLOT_LABEL[slot]}</div>
      {days.map((d) => (
        <BoardCell
          key={d}
          date={d}
          slot={slot}
          today={d === today}
          entries={at(d, slot)}
          recipes={recipes}
          allergies={allergies}
          canEdit={canEdit}
          placing={placing}
          onTap={onTap}
          onOpen={onOpen}
          total={totalFor(d)}
          limit={limitFor(d)}
        />
      ))}
    </>
  );
}

function BoardCell({
  date,
  slot,
  today,
  entries,
  recipes,
  allergies,
  canEdit,
  placing,
  onTap,
  onOpen,
  total,
  limit,
  compact,
}: {
  date: string;
  slot: Slot;
  today: boolean;
  entries: PlanEntry[];
  recipes: Map<string, Recipe>;
  allergies: string[];
  canEdit: boolean;
  placing: boolean;
  onTap: (d: string, s: Slot) => void;
  onOpen: (id: string) => void;
  total: number;
  limit: number | null;
  compact?: boolean;
}) {
  const drop = useDroppable({ id: `cell:${date}:${slot}` });
  const empty = entries.length === 0;
  return (
    <div
      ref={drop.setNodeRef}
      className={cn(
        "group/cell flex flex-col gap-1.5 rounded-xl border p-1.5 transition",
        compact ? "min-h-[64px]" : "min-h-[104px]",
        today ? "border-[color-mix(in_srgb,var(--item-accent)_45%,var(--border))] bg-[color-mix(in_srgb,var(--item-accent)_5%,transparent)]" : "border-[var(--border)] bg-[var(--surface)]",
        drop.isOver && "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)]",
        placing && "border-dashed",
      )}
    >
      {entries.map((e) => (
        <MealChip key={e.id} entry={e} recipe={recipes.get(e.recipe_id ?? "")} onClick={() => onOpen(e.id)} allergies={allergies} draggable={canEdit} />
      ))}
      {empty ? (
        canEdit && (
          <button
            type="button"
            onClick={() => onTap(date, slot)}
            aria-label={`Add ${SLOT_LABEL[slot].toLowerCase()} on ${date}`}
            className={cn(
              "flex min-h-[2rem] w-full flex-1 items-center justify-center rounded-lg text-[var(--text-muted)] opacity-60 transition hover:bg-[var(--hover)] hover:text-[var(--text)] hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
              placing && "border border-dashed border-[var(--item-accent)] text-[var(--item-accent)] opacity-100",
            )}
          >
            <Plus className="h-4 w-4" />
          </button>
        )
      ) : (
        <div className="mt-auto flex min-h-[24px] items-center gap-1 pl-1">
          <p className={cn("min-w-0 flex-1 truncate text-[11px] tabular-nums", limit && total > limit ? "text-[var(--warning)]" : "text-[var(--text-muted)]")}>
            {total > 0 ? fmtMinutes(total) : ""}
            {limit && total > limit ? ` · over ${limit}` : ""}
          </p>
          {canEdit && (
            <button
              type="button"
              onClick={() => onTap(date, slot)}
              aria-label={`Add ${SLOT_LABEL[slot].toLowerCase()} on ${date}`}
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] opacity-0 transition hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] group-hover/cell:opacity-100",
                placing && "text-[var(--item-accent)] opacity-100",
              )}
            >
              <Plus className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Phone: one day — planned meals as rows, empty meals as small add chips. */
function DayCard({
  day,
  isToday,
  slots,
  at,
  recipes,
  allergies,
  canEdit,
  onOpen,
  onAdd,
  onCook,
}: {
  day: string;
  isToday: boolean;
  slots: Slot[];
  at: (d: string, s: Slot) => PlanEntry[];
  recipes: Map<string, Recipe>;
  allergies: string[];
  canEdit: boolean;
  onOpen: (id: string) => void;
  onAdd: (d: string, s: Slot) => void;
  onCook: (e: PlanEntry) => void;
}) {
  const meals = slots.flatMap((s) => at(day, s));
  const emptySlots = slots.filter((s) => at(day, s).length === 0);
  return (
    <section
      aria-label={`${fmtLongWeekday(day)} ${fmtDayNum(day)}`}
      className={cn(
        "overflow-hidden rounded-2xl border bg-[var(--surface)] shadow-[var(--shadow-sm)]",
        isToday ? "border-[color-mix(in_srgb,var(--item-accent)_60%,var(--border))]" : "border-[var(--border)]",
      )}
    >
      <div className="flex items-baseline gap-2 px-4 pb-1 pt-3">
        <h3 className={cn("text-[15px] font-semibold", isToday ? "text-[var(--item-accent)]" : "text-[var(--text)]")}>{isToday ? "Today" : fmtLongWeekday(day)}</h3>
        <span className="text-sm tabular-nums text-[var(--text-muted)]">{fmtMonthDay(day)}</span>
      </div>
      {meals.length > 0 && (
        <ul className="flex flex-col px-2">
          {meals.map((e) => {
            const r = recipes.get(e.recipe_id ?? "");
            return <MealRow key={e.id} entry={e} recipe={r} allergies={allergies} onOpen={() => onOpen(e.id)} onCook={isToday && r && !e.cooked && !e.leftovers_of ? () => onCook(e) : undefined} />;
          })}
        </ul>
      )}
      {canEdit && emptySlots.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-4 pb-3 pt-1.5">
          {emptySlots.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onAdd(day, s)}
              aria-label={`Add ${SLOT_LABEL[s].toLowerCase()} on ${fmtWeekday(day)}`}
              className="flex h-10 items-center gap-1.5 rounded-xl border border-dashed border-[var(--border)] px-3 text-sm text-[var(--text-muted)] transition hover:border-[var(--item-accent)] hover:text-[var(--text)] active:bg-[var(--hover)]"
            >
              <Plus className="h-4 w-4" />
              {SLOT_LABEL[s]}
            </button>
          ))}
        </div>
      ) : (
        <div className="h-2" />
      )}
    </section>
  );
}

function MealRow({ entry, recipe, allergies, onOpen, onCook }: { entry: PlanEntry; recipe?: Recipe; allergies: string[]; onOpen: () => void; onCook?: () => void }) {
  const warn = recipe ? allergenHits(recipe, allergies).length > 0 : false;
  const time = recipe && !entry.leftovers_of ? fmtMinutes(recipeTime(recipe)) : "";
  const meta = [SLOT_LABEL[entry.slot], entry.leftovers_of ? "Leftovers" : time, entry.cooked ? "Cooked" : ""].filter(Boolean).join(" · ");
  return (
    <li className="flex items-center gap-1">
      <button type="button" onClick={onOpen} className="flex min-h-[60px] min-w-0 flex-1 items-center gap-3 rounded-xl px-2 py-2 text-left transition active:bg-[var(--hover)]">
        {entry.leftovers_of ? (
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-dashed border-[var(--border)] text-[var(--text-muted)]">
            <Repeat2 className="h-5 w-5" />
          </span>
        ) : recipe ? (
          <RecipeThumb recipe={recipe} size={44} />
        ) : (
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-2)] text-[var(--text-muted)]">
            <UtensilsCrossed className="h-5 w-5" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-[15px] font-medium", entry.cooked ? "text-[var(--text-muted)]" : "text-[var(--text)]", !recipe && !entry.leftovers_of && "italic")}>
            {entry.title || recipe?.title || "Meal"}
          </span>
          <span className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
            {entry.cooked && <Check className="h-3.5 w-3.5 text-[var(--success)]" aria-hidden />}
            {warn && <TriangleAlert className="h-3.5 w-3.5 text-[var(--danger)]" aria-label="Contains an allergen" />}
            <span className="truncate">{meta}</span>
          </span>
        </span>
        {!onCook && <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)] opacity-60" aria-hidden />}
      </button>
      {onCook && (
        <button
          type="button"
          onClick={onCook}
          aria-label={`Cook ${entry.title || recipe?.title || "this meal"}`}
          className="mr-1 inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-[var(--item-accent)] px-3.5 text-sm font-semibold text-white shadow-[var(--shadow-sm)] active:brightness-90"
        >
          <ChefHat className="h-4 w-4" /> Cook
        </button>
      )}
    </li>
  );
}

function RecipeSidebar({ data, picked, onPick, canEdit }: { data: MealPlanData; picked: string | null; onPick: (id: string) => void; canEdit: boolean }) {
  const [q, setQ] = useState("");
  const sorted = useSortedRecipes(data.recipes);
  const list = useMemo(() => sorted.filter((r) => matchesQuery(r, q)).slice(0, 150), [sorted, q]);
  return (
    <aside className="flex w-[272px] shrink-0 flex-col gap-2 border-l border-[var(--border)] p-3" aria-label="Recipes">
      <p className="px-1 text-sm font-semibold text-[var(--text)]">Recipes</p>
      <p className="px-1 text-xs text-[var(--text-muted)]">{canEdit ? "Drag onto a day, or tap one then tap a slot." : "View only."}</p>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
        <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="pl-9" aria-label="Search recipes" />
      </div>
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {list.map((r) => (
          <SidebarRecipe key={r.id} recipe={r} active={picked === r.id} onPick={() => onPick(r.id)} disabled={!canEdit} warn={allergenHits(r, data.preferences.allergies).length > 0} />
        ))}
        {data.recipes.length === 0 && <p className="px-1 py-4 text-sm text-[var(--text-muted)]">No recipes yet — add some in the Recipes tab.</p>}
      </div>
    </aside>
  );
}

function SidebarRecipe({ recipe, active, onPick, disabled, warn }: { recipe: Recipe; active: boolean; onPick: () => void; disabled: boolean; warn: boolean }) {
  const drag = useDraggable({ id: `recipe:${recipe.id}`, disabled });
  return (
    <button
      ref={drag.setNodeRef}
      {...drag.listeners}
      {...drag.attributes}
      type="button"
      onClick={onPick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition hover:bg-[var(--hover)]",
        active && "bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] ring-1 ring-[var(--item-accent)]",
        drag.isDragging && "opacity-40",
      )}
    >
      <RecipeThumb recipe={recipe} size={36} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-[var(--text)]">{recipe.title}</p>
        <p className="truncate text-[11px] text-[var(--text-muted)]">{[fmtMinutes(recipeTime(recipe)), recipe.cuisine].filter(Boolean).join(" · ")}</p>
      </div>
      {warn && <TriangleAlert className="h-4 w-4 shrink-0 text-[var(--danger)]" aria-label="Contains an allergen" />}
    </button>
  );
}
