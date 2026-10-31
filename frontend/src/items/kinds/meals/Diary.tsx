import {
  BookmarkPlus,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Copy,
  GlassWater,
  Minus,
  MoreHorizontal,
  Plus,
  Salad,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import type { ItemHandle } from "@/items/useItem";
import {
  Card,
  EmptyState,
  Fab,
  Field,
  IconButton,
  ItemButton,
  ListRow,
  Page,
  Select,
  Sheet,
  TextArea,
  TextInput,
  addDays,
  fmtDay,
  fmtNum,
  uid,
  weekStart,
} from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { AddFood, PortionPicker, type Picked } from "./AddFood";
import { useFoodPool } from "./api";
import { today as todayNow, useToday } from "./clock";
import { EstBadge, MacroSummary, NumberInput, NutrientTable, WaterGlasses, WeekStrip } from "./components";
import {
  MACRO_COLOR,
  dayOf,
  daySlots,
  energy,
  ensureDay,
  fmtEnergy,
  guessSlot,
  kcalFromMacros,
  meals,
  microsCoverage,
  onAddFoodRequest,
  portionText,
  scaleTotals,
  targetsFor,
  toKcal,
  total,
  visibleSlots,
  waterOut,
  weekdayOf,
} from "./lib";
import type { Entry, Food, MealsData, Portion } from "./types";

type AddState = { slot: string; tab?: "search" | "scan" | "quick" | "describe" } | null;

export function Diary({ item, isPhone, ask }: ItemViewProps<MealsData>) {
  const data = meals(item.data);
  const s = data.settings;
  const today = useToday();
  const [day, setDay] = useState(today);
  const [adding, setAdding] = useState<AddState>(null);
  const [editing, setEditing] = useState<Entry | null>(null);
  const [nutrients, setNutrients] = useState(false);
  const [copyTo, setCopyTo] = useState<string | null>(null);
  const [saveSlot, setSaveSlot] = useState<string | null>(null);

  // Day rollover: if you were looking at "today", follow it past midnight
  // (a phone left open overnight shouldn't log tomorrow's breakfast into
  // yesterday).
  const prevToday = useRef(today);
  useEffect(() => {
    if (prevToday.current !== today) {
      setDay((cur) => (cur === prevToday.current ? today : cur));
      prevToday.current = today;
    }
  }, [today]);

  const d = dayOf(item.data, day);
  const tgt = useMemo(() => targetsFor(data.targets, day), [data.targets, day]);
  const totals = useMemo(() => total(d.entries), [d.entries]);
  const coverage = useMemo(() => microsCoverage(d.entries), [d.entries]);
  const groups = useMemo(() => daySlots(s, d.entries), [d.entries, s]);
  const week = useMemo(() => {
    const start = weekStart(day);
    return Array.from({ length: 7 }, (_, i) => {
      const x = addDays(start, i);
      const dd = dayOf(item.data, x);
      return { d: x, kcal: total(dd.entries).kcal, target: targetsFor(data.targets, x).kcal, logged: dd.entries.length > 0, complete: dd.complete };
    });
  }, [day, item.data, data.targets]);

  const openAdd = useCallback((slot?: string, tab?: "search" | "scan" | "quick" | "describe") => setAdding({ slot: slot ?? guessSlot(s.meal_slots), tab }), [s.meal_slots]);

  // The header's "Add food" (index.tsx primaryAction) lands here.
  useEffect(
    () =>
      onAddFoodRequest(() => {
        setDay(todayNow());
        openAdd();
      }),
    [openAdd],
  );

  // Desktop shortcuts: A = add food, ←/→ = day, T = today.
  useEffect(() => {
    if (isPhone) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable=true], [role=dialog]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "a" && item.canEdit) {
        e.preventDefault();
        openAdd();
      } else if (e.key === "ArrowLeft") setDay((x) => addDays(x, -1));
      else if (e.key === "ArrowRight") setDay((x) => addDays(x, 1));
      else if (e.key === "t") setDay(todayNow());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPhone, item.canEdit, openAdd]);

  const water = (delta: number) =>
    item.update((dd) => {
      const x = ensureDay(dd, day);
      x.water_ml = Math.max(0, Math.min(20000, x.water_ml + delta));
    });

  const left = tgt.kcal - totals.kcal;
  const proteinLeft = Math.max(0, tgt.protein - totals.protein);
  const coaching = d.entries.length > 0 && day === today && left > 150;
  const askIdeas = () => ask("What could I eat for the rest of today to hit my targets? Give me 3 options that fit my diet.");
  const targetNote = `${d.entries.some((e) => e.estimate) ? "Includes estimates · " : ""}${
    data.targets.weekday?.[weekdayOf(day)] ? "Weekday targets" : `Targets: ${data.targets.mode === "auto" ? "calculated" : "custom"}`
  }`;

  // Phone: one compact card — ring + macros, then the coach line and the
  // nutrients sheet in the footer (was three tall cards before the log).
  const summary = isPhone ? (
    <Card className="flex flex-col gap-3">
      <MacroSummary n={totals} tgt={tgt} settings={s} compact />
      <div className="flex items-center gap-2 border-t border-[var(--border)] pt-2.5">
        {coaching ? (
          <>
            <Sparkles className="h-4 w-4 shrink-0 text-[var(--item-accent)]" aria-hidden />
            <p className="min-w-0 flex-1 text-xs text-[var(--text)]">
              <span className="font-semibold tabular-nums">{fmtNum(proteinLeft)} g</span> protein to go
            </p>
            <ItemButton size="sm" variant="ghost" onClick={askIdeas}>
              Ideas
            </ItemButton>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-muted)]">{targetNote}</span>
        )}
        <ItemButton size="sm" variant="ghost" onClick={() => setNutrients(true)}>
          Nutrients
        </ItemButton>
      </div>
    </Card>
  ) : (
    <Card>
      <MacroSummary n={totals} tgt={tgt} settings={s} />
      <p className="mt-3 border-t border-[var(--border)] pt-3 text-xs text-[var(--text-muted)]">{targetNote}</p>
    </Card>
  );

  const coach =
    !isPhone && coaching ? (
      <Card className="flex items-center gap-3">
        <Sparkles className="h-5 w-5 shrink-0 text-[var(--item-accent)]" />
        <p className="min-w-0 flex-1 text-sm text-[var(--text)]">
          {fmtEnergy(left, s, true)} and {fmtNum(proteinLeft)} g protein to go.
        </p>
        <ItemButton size="sm" onClick={askIdeas}>
          Ideas
        </ItemButton>
      </Card>
    ) : null;

  const mealCards = (
    <div className="flex flex-col gap-3">
      {groups.map(({ slot: sl, entries, archived }) => (
        <MealCard
          key={sl.id}
          name={sl.name}
          archived={archived}
          entries={entries}
          settings={s}
          canEdit={item.canEdit}
          onAdd={() => openAdd(archived ? undefined : sl.id)}
          onEdit={setEditing}
          onCopy={() => setCopyTo(sl.id)}
          onSave={() => setSaveSlot(sl.id)}
          onClear={() =>
            item.update((dd) => {
              const x = ensureDay(dd, day);
              x.entries = x.entries.filter((e) => e.slot !== sl.id);
            })
          }
          onDescribe={() => openAdd(sl.id, "describe")}
        />
      ))}
    </div>
  );

  const waterCard = (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <GlassWater className="h-5 w-5 shrink-0 text-[#3B9CD8]" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[var(--text)]">Water</p>
          <p className="text-xs tabular-nums text-[var(--text-muted)]" aria-live="polite">
            {waterOut(d.water_ml, s)} of {waterOut(tgt.water_ml, s)}
          </p>
        </div>
        {item.canEdit && (
          <>
            <IconButton label={`Remove ${s.water_step_ml} ml water`} icon={Minus} onClick={() => water(-s.water_step_ml)} disabled={d.water_ml <= 0} />
            <ItemButton variant="primary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => water(s.water_step_ml)} aria-label={`Add ${s.water_step_ml} ml water`}>
              {waterOut(s.water_step_ml, s)}
            </ItemButton>
          </>
        )}
      </div>
      <WaterGlasses ml={d.water_ml} target={tgt.water_ml || 2000} step={s.water_step_ml} />
    </Card>
  );

  const footer = <DayFooter item={item} day={day} />;

  return (
    <Page wide={!isPhone}>
      <div className="flex flex-col gap-1">
        <DateNav day={day} setDay={setDay} complete={d.complete} />
        <WeekStrip day={day} today={today} onPick={setDay} days={week} />
      </div>
      {d.entries.length === 0 && day === today && data.days && Object.keys(data.days).length === 0 && (
        <EmptyState
          icon={Salad}
          title="Your food diary starts here"
          text="Search or scan a food, or just describe what you ate — “2 eggs and toast” — and the assistant logs it with estimates."
          action={
            item.canEdit && (
              <div className="flex flex-wrap justify-center gap-2">
                <ItemButton variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => openAdd()}>
                  Add food
                </ItemButton>
                <ItemButton icon={<Sparkles className="h-4 w-4" />} onClick={() => openAdd(undefined, "describe")}>
                  Describe a meal
                </ItemButton>
              </div>
            )
          }
        />
      )}
      {isPhone ? (
        <>
          {summary}
          {coach}
          {mealCards}
          {waterCard}
          {footer}
          {item.canEdit && <div className="h-16" aria-hidden />}
        </>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
          <div className="flex min-w-0 flex-col gap-4">
            {mealCards}
            {footer}
          </div>
          <aside className="flex flex-col gap-4 lg:sticky lg:top-4 lg:self-start">
            {summary}
            {coach}
            {waterCard}
            <Card>
              <h3 className="mb-1 text-sm font-semibold text-[var(--text)]">Nutrients</h3>
              <NutrientTable n={totals} tgt={tgt} settings={s} showMicros={s.show_micros} coverage={coverage} />
            </Card>
            {item.canEdit && (
              <p className="px-1 text-[11px] text-[var(--text-muted)]">
                Shortcuts: <kbd>A</kbd> add food · <kbd>←</kbd>/<kbd>→</kbd> change day · <kbd>T</kbd> today
              </p>
            )}
          </aside>
        </div>
      )}

      {isPhone && item.canEdit && <Fab label="Add food" icon={Plus} onClick={() => openAdd()} />}

      <AddFood open={!!adding} onClose={() => setAdding(null)} item={item} day={day} slot={adding?.slot ?? "snacks"} initialTab={adding?.tab ?? "search"} ask={ask} />
      <EntrySheet entry={editing} onClose={() => setEditing(null)} item={item} day={day} />
      <Sheet open={nutrients} onClose={() => setNutrients(false)} title={`Nutrients · ${fmtDay(day)}`}>
        <NutrientTable n={totals} tgt={tgt} settings={s} showMicros={s.show_micros} coverage={coverage} />
      </Sheet>
      <CopySheet item={item} toDay={day} toSlot={copyTo} onClose={() => setCopyTo(null)} />
      <SaveMealSheet item={item} day={day} slot={saveSlot} onClose={() => setSaveSlot(null)} />
    </Page>
  );
}

function DateNav({ day, setDay, complete }: { day: string; setDay: (d: string) => void; complete: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const today = useToday();
  return (
    <div className="flex items-center gap-1">
      <IconButton label="Previous day" icon={ChevronLeft} onClick={() => setDay(addDays(day, -1))} />
      <button
        type="button"
        className="relative flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl px-2 text-base font-semibold text-[var(--text)] hover:bg-[var(--hover)]"
        onClick={() => input.current?.showPicker?.()}
        aria-label="Pick a day"
      >
        <CalendarDays className="h-4 w-4 text-[var(--text-muted)]" />
        {fmtDay(day, { long: true })}
        {complete && <CircleCheck className="h-4 w-4 text-[var(--success)]" aria-label="Day complete" />}
        <input
          ref={input}
          type="date"
          tabIndex={-1}
          aria-hidden
          value={day}
          onChange={(e) => e.target.value && setDay(e.target.value)}
          className="pointer-events-none absolute inset-0 opacity-0"
        />
      </button>
      {day !== today && (
        <ItemButton size="sm" variant="ghost" onClick={() => setDay(today)}>
          Today
        </ItemButton>
      )}
      <IconButton label="Next day" icon={ChevronRight} onClick={() => setDay(addDays(day, 1))} />
    </div>
  );
}

function MealCard({
  name,
  archived,
  entries,
  settings,
  canEdit,
  onAdd,
  onEdit,
  onCopy,
  onSave,
  onClear,
  onDescribe,
}: {
  name: string;
  archived?: boolean;
  entries: Entry[];
  settings: MealsData["settings"];
  canEdit: boolean;
  onAdd: () => void;
  onEdit: (e: Entry) => void;
  onCopy: () => void;
  onSave: () => void;
  onClear: () => void;
  onDescribe: () => void;
}) {
  const t = total(entries);
  const [menu, setMenu] = useState(false);
  return (
    <Card padded={false} as="section">
      <div className="flex items-center gap-2 px-4 pb-1 pt-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-[var(--text)]">
            {name}
            {archived && <span className="ml-1.5 text-xs font-normal text-[var(--text-muted)]">· removed meal</span>}
          </h2>
          {entries.length > 0 && (
            <p className="text-xs tabular-nums text-[var(--text-muted)]">
              <span className="font-medium text-[var(--text)]">{fmtEnergy(t.kcal, settings, true)}</span> · P {fmtNum(t.protein)} · C {fmtNum(t.carbs)} · F {fmtNum(t.fat)}
            </p>
          )}
        </div>
        {canEdit && !archived && <IconButton label={`${name} options`} icon={MoreHorizontal} onClick={() => setMenu(true)} />}
      </div>
      {entries.length > 0 && (
        <ul className="divide-y divide-[var(--border)]">
          {entries.map((e) => (
            <li key={e.id}>
              <ListRow
                onClick={() => onEdit(e)}
                title={
                  <span className="flex items-center gap-1.5">
                    <span className="truncate">{e.name}</span>
                    {e.estimate && <EstBadge />}
                  </span>
                }
                subtitle={
                  <span className="tabular-nums">
                    {[e.brand, portionText(e)].filter(Boolean).join(" · ")}
                    <span className="ml-1.5 opacity-80">
                      P {fmtNum(e.n.protein)} · C {fmtNum(e.n.carbs)} · F {fmtNum(e.n.fat)}
                    </span>
                  </span>
                }
                trailing={<span className="tabular-nums text-[var(--text)]">{fmtEnergy(e.n.kcal, settings)}</span>}
              />
            </li>
          ))}
        </ul>
      )}
      {canEdit && !archived && (
        <div className="flex gap-1 px-2 pb-2 pt-1">
          <button
            type="button"
            onClick={onAdd}
            className="flex min-h-[44px] flex-1 items-center gap-2 rounded-xl px-2 text-sm font-medium text-[var(--item-accent)] hover:bg-[var(--hover)]"
          >
            <Plus className="h-4 w-4" /> Add food
          </button>
          {entries.length === 0 && (
            <button
              type="button"
              onClick={onDescribe}
              className="flex min-h-[44px] items-center gap-1.5 rounded-xl px-3 text-sm text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            >
              <Sparkles className="h-4 w-4" /> Describe
            </button>
          )}
        </div>
      )}
      <Sheet open={menu} onClose={() => setMenu(false)} title={name} size="sm">
        <div className="flex flex-col py-1">
          <MenuItem icon={Copy} label="Copy from another day" onClick={() => (setMenu(false), onCopy())} />
          <MenuItem icon={BookmarkPlus} label="Save as a meal" disabled={!entries.length} onClick={() => (setMenu(false), onSave())} />
          <MenuItem icon={Sparkles} label="Describe it to the assistant" onClick={() => (setMenu(false), onDescribe())} />
          <MenuItem icon={Trash2} label={`Clear ${name.toLowerCase()}`} danger disabled={!entries.length} onClick={() => (setMenu(false), onClear())} />
        </div>
      </Sheet>
    </Card>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger, disabled }: { icon: typeof Copy; label: string; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-[48px] items-center gap-3 rounded-xl px-3 text-left text-sm hover:bg-[var(--hover)] disabled:opacity-40",
        danger ? "text-[var(--danger)]" : "text-[var(--text)]",
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function DayFooter({ item, day }: { item: ItemHandle<MealsData>; day: string }) {
  const d = dayOf(item.data, day);
  const [note, setNote] = useState(d.note);
  useEffect(() => setNote(d.note), [d.note, day]);
  const commit = () => {
    if (note !== d.note) item.update((dd) => void (ensureDay(dd, day).note = note.slice(0, 2000)));
  };
  return (
    <Card className="flex flex-col gap-3">
      <Field label="Notes for the day">
        <TextArea
          value={note}
          disabled={!item.canEdit}
          onChange={(e) => setNote(e.target.value)}
          onBlur={commit}
          placeholder="Ate out, felt hungry in the afternoon, big training day…"
          className="min-h-[64px]"
        />
      </Field>
      {item.canEdit && (
        <ItemButton
          variant={d.complete ? "secondary" : "primary"}
          icon={<CircleCheck className="h-4 w-4" />}
          onClick={() => {
            commit();
            const target = !d.complete;
            item.update((dd) => {
              ensureDay(dd, day).complete = target;
            });
            if (target) toast.success("Day complete — it now counts toward your expenditure estimate.");
          }}
        >
          {d.complete ? "Day complete · reopen" : "Complete day"}
        </ItemButton>
      )}
    </Card>
  );
}

function EntrySheet({ entry, onClose, item, day }: { entry: Entry | null; onClose: () => void; item: ItemHandle<MealsData>; day: string }) {
  const { resolve } = useFoodPool(meals(item.data));
  const food = entry ? resolve(entry.food_ref) : null;
  const [slot, setSlot] = useState(entry?.slot ?? "");
  useEffect(() => setSlot(entry?.slot ?? ""), [entry]);
  if (!entry) return null;
  const s = meals(item.data).settings;
  const remaining = targetsFor(meals(item.data).targets, day).kcal - total(dayOf(item.data, day).entries.filter((e) => e.id !== entry.id)).kcal;
  const replace = (p: Portion | null, patch: Partial<Entry> = {}) => {
    item.update((dd) => {
      const x = ensureDay(dd, day);
      const i = x.entries.findIndex((e) => e.id === entry.id);
      if (i < 0) return;
      Object.assign(x.entries[i], p ?? {}, patch, { slot });
    });
    onClose();
  };
  const remove = () => {
    item.update((dd) => {
      const x = ensureDay(dd, day);
      x.entries = x.entries.filter((e) => e.id !== entry.id);
    });
    toast.success(`Removed ${entry.name}`);
    onClose();
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={food ? "Edit entry" : entry.name}
      size="lg"
      footer={
        item.canEdit ? (
          <ItemButton variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={remove} className="text-[var(--danger)]">
            Remove from diary
          </ItemButton>
        ) : undefined
      }
    >
      {food && item.canEdit ? (
        <PortionPicker
          key={entry.id}
          item={item}
          picked={{ food, origin: food.id.startsWith("b:") ? "builtin" : "library" } as Picked}
          slot={slot}
          onSlot={setSlot}
          remaining={remaining}
          initial={{ amount: entry.amount, unit: entry.unit === "kcal" ? "serving" : entry.unit, serving_id: entry.serving_id }}
          submitLabel="Save"
          onAdd={(p) => replace(p, { estimate: false })}
        />
      ) : (
        <FreeEntryEditor entry={entry} item={item} slot={slot} onSlot={setSlot} onSave={(patch) => replace(null, patch)} />
      )}
      {entry.source !== "food" && (
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          {entry.source === "ai" ? "Logged by the assistant" : entry.source === "copy" ? "Copied from another day" : entry.source === "meal" ? "From a saved meal" : entry.source === "mealplan" ? "From your meal plan" : entry.source === "quick" ? "Quick add" : "From Open Food Facts"}
          {entry.estimate ? " — nutrition is an estimate." : "."}
        </p>
      )}
      {!item.canEdit && (
        <div className="mt-2">
          <NutrientTable n={entry.n} settings={s} />
        </div>
      )}
    </Sheet>
  );
}

function FreeEntryEditor({
  entry,
  item,
  slot,
  onSlot,
  onSave,
}: {
  entry: Entry;
  item: ItemHandle<MealsData>;
  slot: string;
  onSlot: (s: string) => void;
  onSave: (patch: Partial<Entry>) => void;
}) {
  const s = meals(item.data).settings;
  const [name, setName] = useState(entry.name);
  const [mult, setMult] = useState(1);
  const [kcal, setKcal] = useState<number>(entry.n.kcal); // always kcal; shown in the person's unit
  const [p, setP] = useState(entry.n.protein);
  const [c, setC] = useState(entry.n.carbs);
  const [f, setF] = useState(entry.n.fat);
  const [saveFood, setSaveFood] = useState(false);
  const scaled = mult !== 1;
  const n = scaled ? scaleTotals({ ...entry.n, kcal, protein: p, carbs: c, fat: f }, mult) : { ...entry.n, kcal, protein: p, carbs: c, fat: f };
  const atwater = kcalFromMacros(p, c, f);
  return (
    <div className="flex flex-col gap-3">
      <Field label="Name">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} disabled={!item.canEdit} />
      </Field>
      <p className="text-xs text-[var(--text-muted)]">{portionText(entry)}{entry.grams ? ` · ${fmtNum(entry.grams)} g` : ""}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Field label={`Energy (${s.energy_unit})`}>
          <NumberInput ariaLabel="Energy" value={Math.round(energy(kcal, s))} onChange={(v) => setKcal(Math.max(0, toKcal(v ?? 0, s)))} />
        </Field>
        <Field label="Protein (g)">
          <NumberInput ariaLabel="Protein" value={p} onChange={(v) => setP(Math.max(0, v ?? 0))} />
        </Field>
        <Field label="Carbs (g)">
          <NumberInput ariaLabel="Carbs" value={c} onChange={(v) => setC(Math.max(0, v ?? 0))} />
        </Field>
        <Field label="Fat (g)">
          <NumberInput ariaLabel="Fat" value={f} onChange={(v) => setF(Math.max(0, v ?? 0))} />
        </Field>
      </div>
      {Math.abs(atwater - kcal) > Math.max(40, kcal * 0.25) && <p className="text-xs text-[var(--warning)]">The macros add up to about {fmtEnergy(atwater, s, true)}.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-[var(--text-muted)]">Portion</span>
        {[0.5, 1, 1.5, 2].map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mult === m}
            onClick={() => setMult(m)}
            className={cn(
              "h-9 min-w-[44px] rounded-full border px-3 text-sm",
              mult === m ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)]" : "border-[var(--border)]",
            )}
          >
            {m === 0.5 ? "½×" : m === 1.5 ? "1½×" : `${m}×`}
          </button>
        ))}
      </div>
      <div className="rounded-xl bg-[var(--surface-2)] px-3 py-2 text-sm tabular-nums text-[var(--text)]">
        {fmtEnergy(n.kcal, s, true)} · <span style={{ color: MACRO_COLOR.protein }}>P</span> {fmtNum(n.protein)} g · <span style={{ color: MACRO_COLOR.carbs }}>C</span> {fmtNum(n.carbs)} g ·{" "}
        <span style={{ color: MACRO_COLOR.fat }}>F</span> {fmtNum(n.fat)} g
      </div>
      {entry.grams ? (
        <label className="flex items-center gap-2 text-sm text-[var(--text)]">
          <input type="checkbox" checked={saveFood} onChange={(e) => setSaveFood(e.target.checked)} className="h-4 w-4 accent-[var(--item-accent)]" />
          Also save to my foods
        </label>
      ) : null}
      <div className="flex items-end gap-2">
        <Field label="Meal" className="flex-1">
          <Select value={slot} onChange={(e) => onSlot(e.target.value)} aria-label="Meal">
            {s.meal_slots
              .filter((x) => !x.hidden || x.id === entry.slot)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                  {x.hidden ? " (removed)" : ""}
                </option>
              ))}
          </Select>
        </Field>
        <ItemButton
          variant="primary"
          size="lg"
          disabled={!item.canEdit}
          onClick={() => {
            const changedNumbers = Math.abs(kcal - entry.n.kcal) > 0.5 || p !== entry.n.protein || c !== entry.n.carbs || f !== entry.n.fat;
            const patch: Partial<Entry> = {
              name: name.trim() || entry.name,
              n,
              amount: scaled ? Math.round(entry.amount * mult * 100) / 100 : entry.amount,
              grams: entry.grams && scaled ? Math.round(entry.grams * mult * 10) / 10 : entry.grams,
              estimate: changedNumbers ? false : entry.estimate,
            };
            if (saveFood && entry.grams) {
              const grams = (patch.grams as number) || entry.grams;
              const food: Food = {
                id: uid("f"),
                name: patch.name as string,
                brand: entry.brand,
                barcode: null,
                servings: entry.serving_label && entry.unit === "serving" ? [{ id: "s1", label: entry.serving_label, grams: Math.round((grams / (patch.amount as number || 1)) * 10) / 10 }] : [],
                default_serving: entry.serving_label && entry.unit === "serving" ? "s1" : null,
                per100: scaleTotals(n, 100 / grams),
                liquid: entry.unit === "ml",
                source: entry.estimate ? "ai" : "custom",
                notes: entry.estimate ? "Estimated nutrition" : "",
                created: new Date().toISOString(),
              };
              item.update((dd) => {
                if (!dd.foods.some((x) => x.id === food.id)) dd.foods.push(food);
              });
              patch.food_ref = food.id;
            }
            onSave(patch);
          }}
        >
          Save
        </ItemButton>
      </div>
    </div>
  );
}

function CopySheet({ item, toDay, toSlot, onClose }: { item: ItemHandle<MealsData>; toDay: string; toSlot: string | null; onClose: () => void }) {
  const s = meals(item.data).settings;
  const [from, setFrom] = useState(addDays(toDay, -1));
  const [pick, setPick] = useState<string | null>(null);
  useEffect(() => {
    if (toSlot) {
      setFrom(addDays(toDay, -1));
      setPick(toSlot);
    }
  }, [toSlot, toDay]);
  if (!toSlot) return null;
  const src = dayOf(item.data, from);
  const slotsWith = daySlots(s, src.entries).map((g) => ({ ...g.slot, entries: g.entries }));
  const chosen = pick === "__all" ? src.entries : slotsWith.find((x) => x.id === pick)?.entries ?? [];
  const toName = s.meal_slots.find((x) => x.id === toSlot)?.name ?? "";
  const shown = new Set(visibleSlots(s).map((x) => x.id));
  return (
    <Sheet
      open
      onClose={onClose}
      title={`Copy into ${toName}`}
      footer={
        <ItemButton
          variant="primary"
          block
          disabled={!chosen.length}
          onClick={() => {
            const copies: Entry[] = chosen.map((e) => ({
              ...(JSON.parse(JSON.stringify(e)) as Entry),
              id: uid("e"),
              slot: pick === "__all" && shown.has(e.slot) ? e.slot : toSlot,
              source: "copy",
              time: null,
            }));
            item.update((dd) => {
              ensureDay(dd, toDay).entries.push(...copies);
            });
            toast.success(`Copied ${chosen.length} item${chosen.length === 1 ? "" : "s"}`);
            onClose();
          }}
        >
          Copy {chosen.length ? `${chosen.length} item${chosen.length === 1 ? "" : "s"} · ${fmtEnergy(total(chosen).kcal, s, true)}` : ""}
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {[-1, -2, -7].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setFrom(addDays(toDay, n))}
              className={cn(
                "h-9 rounded-full border px-3 text-sm",
                from === addDays(toDay, n) ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)]" : "border-[var(--border)]",
              )}
            >
              {n === -1 ? "Day before" : n === -7 ? "A week before" : "2 days before"}
            </button>
          ))}
          <TextInput type="date" aria-label="Copy from day" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} className="h-9 w-auto" />
        </div>
        {src.entries.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">Nothing logged on {fmtDay(from)}.</p>
        ) : (
          <div className="flex flex-col gap-2" role="radiogroup" aria-label="What to copy">
            {slotsWith
              .filter((x) => x.entries.length)
              .map((x) => (
                <CopyOption key={x.id} on={pick === x.id} onClick={() => setPick(x.id)} title={x.name} sub={x.entries.map((e) => e.name).join(", ")} kcal={fmtEnergy(total(x.entries).kcal, s, true)} />
              ))}
            <CopyOption on={pick === "__all"} onClick={() => setPick("__all")} title="The whole day (into the same meals)" sub={`${src.entries.length} items`} kcal={fmtEnergy(total(src.entries).kcal, s, true)} />
          </div>
        )}
      </div>
    </Sheet>
  );
}

function CopyOption({ on, onClick, title, sub, kcal }: { on: boolean; onClick: () => void; title: string; sub: string; kcal: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cn(
        "flex min-h-[52px] items-center gap-3 rounded-xl border px-3 py-2 text-left",
        on ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_10%,transparent)]" : "border-[var(--border)] bg-[var(--surface)]",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[var(--text)]">{title}</p>
        <p className="truncate text-xs text-[var(--text-muted)]">{sub}</p>
      </div>
      <span className="text-sm tabular-nums text-[var(--text-muted)]">{kcal}</span>
    </button>
  );
}

function SaveMealSheet({ item, day, slot, onClose }: { item: ItemHandle<MealsData>; day: string; slot: string | null; onClose: () => void }) {
  const [name, setName] = useState("");
  const slotName = meals(item.data).settings.meal_slots.find((x) => x.id === slot)?.name ?? "";
  useEffect(() => {
    if (slot) setName(`My ${slotName.toLowerCase()}`);
  }, [slot, slotName]);
  if (!slot) return null;
  const es = dayOf(item.data, day).entries.filter((e) => e.slot === slot);
  return (
    <Sheet
      open
      onClose={onClose}
      title="Save as a meal"
      size="sm"
      footer={
        <ItemButton
          variant="primary"
          block
          disabled={!name.trim() || !es.length}
          onClick={() => {
            const meal = {
              id: uid("m"),
              name: name.trim().slice(0, 80),
              slot,
              created: new Date().toISOString(),
              items: es.map(({ name, brand, food_ref, amount, unit, serving_id, serving_label, grams, n, estimate }) => ({ name, brand, food_ref, amount, unit, serving_id, serving_label, grams, n, estimate })),
            };
            item.update((dd) => {
              dd.meals.push(meal);
            });
            toast.success(`Saved “${name.trim()}”`);
            onClose();
          }}
        >
          Save meal
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <p className="text-sm text-[var(--text-muted)]">
          {es.length} items · {fmtEnergy(total(es).kcal, meals(item.data).settings, true)}
        </p>
      </div>
    </Sheet>
  );
}

