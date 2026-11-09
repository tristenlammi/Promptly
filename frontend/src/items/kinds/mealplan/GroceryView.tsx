import { Loader2, MoreHorizontal, Pencil, Plus, RefreshCw, Share2, ShoppingBasket, ShoppingCart, Sparkles, Store, Trash2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { usePopoverDismiss } from "@/hooks/usePopoverDismiss";
import type { ItemViewProps } from "@/items/types";
import type { ItemHandle } from "@/items/useItem";
import { Card, Chip, EmptyState, Field, ItemButton, Page, ProgressBar, Section, Select, Sheet, TextInput, addDays, fmtAgo, todayISO, uid } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { addGroceryLines } from "./foods";
import { fmtRange, startOfWeek, useWakeLock } from "./helpers";
import { CheckDot } from "./parts";
import { SendToList } from "./SendToList";
import { AISLES, type GroceryItem, type MealPlanData } from "./types";
import { UNIT_CHOICES, fmtAmounts, unitLabel } from "./units";

function errDetail(e: unknown, fallback: string): string {
  const d = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  return typeof d === "string" ? d : fallback;
}

/** Check off / un-check: the target state is what the person saw, flipped,
 *  and set explicitly — two people ticking the same item don't cancel out. */
function setChecked(item: ItemHandle<MealPlanData>, id: string, checked: boolean) {
  item.update((d) => {
    const x = d.grocery.items.find((i) => i.id === id);
    if (x) x.checked = checked;
  });
}

/** Remove items; plan-made ones are remembered so "Update from plan" for
 *  the same days doesn't bring them back. */
function removeItems(d: MealPlanData, pick: (i: GroceryItem) => boolean) {
  const keys = d.grocery.items.filter((i) => pick(i) && i.source === "plan" && i.key).map((i) => i.key);
  d.grocery.items = d.grocery.items.filter((i) => !pick(i));
  if (keys.length) d.grocery.removed = [...new Set([...(d.grocery.removed ?? []), ...keys])].slice(-400);
}

/** Add typed lines locally (works offline — no server round trip). Ids are
 *  made here, outside the mutator. */
export function addLines(item: ItemHandle<MealPlanData>, lines: string[]): void {
  const clean = lines.map((l) => l.trim()).filter(Boolean).slice(0, 100);
  if (!clean.length) return;
  if (item.data.grocery.items.length + clean.length > 600) {
    toast.error("The list is full (600 items) — clear checked items first.");
    return;
  }
  const ids = clean.map(() => uid("m"));
  item.update((d) => {
    addGroceryLines(d, clean, ids);
  });
}

function useGroups(data: MealPlanData) {
  return useMemo(() => {
    const order = data.preferences.aisle_order;
    const open = data.grocery.items.filter((i) => !i.checked);
    const done = data.grocery.items.filter((i) => i.checked);
    const groups: { aisle: string; items: GroceryItem[] }[] = [];
    for (const a of [...order, ...Object.keys(AISLES).filter((k) => !order.includes(k))]) {
      const items = open.filter((i) => (i.aisle || "other") === a).sort((x, y) => x.name.localeCompare(y.name));
      if (items.length) groups.push({ aisle: a, items });
    }
    const stray = open.filter((i) => !AISLES[i.aisle]);
    if (stray.length) groups.push({ aisle: "other", items: stray });
    return { groups, open, done };
  }, [data.grocery.items, data.preferences.aisle_order]);
}

export function GroceryView({ item, isPhone, ask, goTo }: ItemViewProps<MealPlanData>) {
  const data = item.data;
  const g = data.grocery;
  const { groups, open, done } = useGroups(data);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [regen, setRegen] = useState(false);
  const [store, setStore] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(menu, menuRef, () => setMenu(false));
  const can = item.canEdit;

  const toggle = (i: GroceryItem) => setChecked(item, i.id, !i.checked);

  const add = () => {
    const lines = text.split(/\n|;/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    addLines(item, lines);
    setText("");
  };

  const clearChecked = () => {
    const ids = new Set(done.map((i) => i.id));
    item.update((d) => removeItems(d, (i) => ids.has(i.id) && i.checked));
  };

  const plannedInRange = (a: string, b: string) => data.plan.some((e) => e.recipe_id && e.date >= a && e.date <= b);
  const ws = startOfWeek(todayISO(), data.preferences.week_start);

  const total = g.items.length;
  const menuEl = can && (
    <div className="relative" ref={menuRef}>
      <button type="button" aria-label="More list actions" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)} className="flex h-11 w-11 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] md:h-10 md:w-10">
        <MoreHorizontal className="h-5 w-5" />
      </button>
      {menu && (
        <div role="menu" className="absolute right-0 top-12 z-50 w-60 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] py-1 shadow-[var(--shadow-lg)]">
          <MenuBtn icon={Trash2} label="Clear checked items" disabled={!done.length} onClick={() => { setMenu(false); clearChecked(); }} />
          <MenuBtn icon={X} label="Clear the whole list" disabled={!g.items.length} onClick={() => { setMenu(false); if (window.confirm("Clear the whole grocery list?")) item.update((d) => { d.grocery = { items: [], start: null, end: null, generated_at: null, covered: [], removed: [] }; }); }} />
          <MenuBtn icon={Share2} label="Share with your household" onClick={() => { setMenu(false); toast.info("Use ⋯ → Share at the top to give your household edit access — everyone shops from the same list (each device syncs when it saves) and gets the reminders."); }} />
          <MenuBtn icon={Sparkles} label="Ask AI to tidy the list" onClick={() => { setMenu(false); ask("Tidy my grocery list: merge duplicates, fix aisles, and tell me anything I might be missing for this week's meals."); }} />
        </div>
      )}
    </div>
  );
  const regenBtn = can && (
    <ItemButton size={isPhone ? "md" : "sm"} block={isPhone} icon={<RefreshCw className="h-4 w-4" />} onClick={() => setRegen(true)}>
      {g.start ? "Update from plan" : "From plan"}
    </ItemButton>
  );
  const shopBtn = total > 0 && (
    <ItemButton size={isPhone ? "md" : "sm"} block={isPhone} variant="primary" icon={<Store className="h-4 w-4" />} onClick={() => setStore(true)}>
      {isPhone ? "Start shopping" : "Shop"}
    </ItemButton>
  );
  const header = (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xl font-semibold tabular-nums text-[var(--text)]" aria-live="polite">
            {open.length ? `${open.length} to buy` : total ? "All done" : "Grocery list"}
          </p>
          <p className="text-sm text-[var(--text-muted)]">
            {g.start && g.end ? `For ${fmtRange(g.start, g.end)}` : "Add items, or build it from your plan"}
            {g.generated_at ? ` · updated ${fmtAgo(g.generated_at)}` : ""}
          </p>
        </div>
        {!isPhone && regenBtn}
        {!isPhone && shopBtn}
        {menuEl}
      </div>
      {total > 0 && (
        <div className="flex items-center gap-3">
          <ProgressBar value={done.length / total} className="flex-1" />
          <span className="shrink-0 text-xs tabular-nums text-[var(--text-muted)]">
            {done.length} of {total} in the cart
          </span>
        </div>
      )}
      {/* "Send to list": your Shopping note by default (Notes N2.3), another note, or Tasks. */}
      {open.length > 0 && <SendToList item={item} fileId={item.fileId} />}
      {isPhone && (regenBtn || shopBtn) && (
        <div className={cn("grid gap-2", regenBtn && shopBtn ? "grid-cols-2" : "grid-cols-1")}>
          {regenBtn}
          {shopBtn}
        </div>
      )}
    </div>
  );

  const addBar = can && (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <TextInput value={text} onChange={(e) => setText(e.target.value)} placeholder="Add an item — “2 lb apples”, “paper towels”" aria-label="Add an item" enterKeyHint="done" />
      <ItemButton type="submit" variant="primary" disabled={!text.trim()} aria-label="Add item" icon={<Plus className="h-4 w-4" />}>
        {!isPhone && "Add"}
      </ItemButton>
    </form>
  );

  return (
    <Page wide={!isPhone}>
      {header}
      {addBar}
      {g.items.length === 0 ? (
        <EmptyState
          icon={ShoppingBasket}
          title="Your list is empty"
          text={plannedInRange(ws, addDays(ws, 6)) ? "Build it from this week's plan: ingredients are merged, summed and grouped by aisle, and what's in your pantry is skipped." : "Plan some meals and build the list from them — or just add items above."}
          action={
            can ? (
              plannedInRange(ws, addDays(ws, 6)) ? (
                <ItemButton variant="primary" icon={<ShoppingCart className="h-4 w-4" />} onClick={() => setRegen(true)}>
                  Build from this week's plan
                </ItemButton>
              ) : (
                <div className="flex flex-wrap justify-center gap-2">
                  <ItemButton onClick={() => goTo("plan")}>Open the plan</ItemButton>
                  <ItemButton variant="primary" icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Plan this week's dinners, then make my grocery list.")}>
                    Plan with AI
                  </ItemButton>
                </div>
              )
            ) : undefined
          }
        />
      ) : (
        <div className={cn(isPhone ? "flex flex-col gap-5" : "gap-4 [column-width:19rem]")}>
          {groups.map((grp) => (
            <Section key={grp.aisle} title={`${AISLES[grp.aisle] ?? "Other"}`} hint={undefined} action={<span className="text-xs tabular-nums text-[var(--text-muted)]">{grp.items.length}</span>} className={cn(!isPhone && "mb-4 break-inside-avoid")}>
              <div className="divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
                {grp.items.map((i) => (
                  <Row key={i.id} i={i} onToggle={can ? () => toggle(i) : undefined} onEdit={can ? () => setEditing(i.id) : undefined} />
                ))}
              </div>
            </Section>
          ))}
          {open.length === 0 && (
            <Card className="break-inside-avoid text-center text-sm text-[var(--text-muted)]">Everything's in the cart.</Card>
          )}
        </div>
      )}
      {done.length > 0 && (
        <Section
          title={`In the cart (${done.length})`}
          action={
            can && (
              <ItemButton size="sm" variant="ghost" onClick={clearChecked}>
                Clear
              </ItemButton>
            )
          }
        >
          <div className={cn("overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]", isPhone ? "divide-y divide-[var(--border)]" : "gap-x-2 [column-width:19rem] [&>*]:break-inside-avoid")}>
            {done.map((i) => (
              <Row key={i.id} i={i} onToggle={can ? () => toggle(i) : undefined} />
            ))}
          </div>
        </Section>
      )}
      {g.covered.length > 0 && (
        <Section title="Already in your pantry" hint="Skipped from the plan — tap one to add it anyway.">
          <div className="flex flex-wrap gap-1.5">
            {g.covered.map((c) => (
              <Chip
                key={c}
                onClick={
                  can
                    ? () => {
                        const id = uid("m");
                        item.update((d) => {
                          addGroceryLines(d, [c], [id]);
                          d.grocery.covered = d.grocery.covered.filter((x) => x !== c);
                        });
                      }
                    : undefined
                }
              >
                {c}
              </Chip>
            ))}
          </div>
        </Section>
      )}
      {editing && <EditItemSheet item={item} id={editing} onClose={() => setEditing(null)} />}
      {regen && <RegenSheet item={item} onClose={() => setRegen(false)} />}
      {store && <InStore item={item} onClose={() => setStore(false)} />}
    </Page>
  );
}

function MenuBtn({ icon: Icon, label, onClick, disabled }: { icon: typeof Trash2; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick} className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-40">
      <Icon className="h-4 w-4 text-[var(--text-muted)]" />
      {label}
    </button>
  );
}

function Row({ i, onToggle, onEdit, big }: { i: GroceryItem; onToggle?: () => void; onEdit?: () => void; big?: boolean }) {
  const amt = fmtAmounts(i.amounts);
  const sub = [i.recipes.length ? `for ${i.recipes.slice(0, 3).join(", ")}${i.recipes.length > 3 ? ` +${i.recipes.length - 3}` : ""}` : "", i.note].filter(Boolean).join(" · ");
  return (
    <div className={cn("flex items-center [contain-intrinsic-size:auto_56px] [content-visibility:auto]", big ? "min-h-[68px]" : "min-h-[52px]")}>
      <button
        type="button"
        onClick={onToggle}
        disabled={!onToggle}
        aria-pressed={i.checked}
        aria-label={`${i.checked ? "Uncheck" : "Check off"} ${i.name}`}
        className={cn("flex min-w-0 flex-1 items-center gap-3 text-left transition hover:bg-[var(--hover)] disabled:cursor-default", big ? "px-4 py-3" : "px-3 py-2")}
      >
        <CheckDot on={i.checked} big={big} />
        <div className="min-w-0 flex-1">
          <p className={cn("truncate font-medium", big ? "text-lg" : "text-[15px]", i.checked ? "text-[var(--text-muted)] line-through decoration-[var(--text-muted)]" : "text-[var(--text)]")}>{i.name}</p>
          {sub && <p className={cn("truncate text-[var(--text-muted)]", big ? "text-sm" : "text-xs")}>{sub}</p>}
        </div>
        {amt && <span className={cn("max-w-[40%] shrink-0 truncate text-right tabular-nums", big ? "text-base font-medium" : "text-sm", i.checked ? "text-[var(--text-muted)]" : big ? "text-[var(--text)]" : "text-[var(--text-muted)]")}>{amt}</span>}
      </button>
      {onEdit && (
        <button type="button" aria-label={`Edit ${i.name}`} onClick={onEdit} className="mr-0.5 flex h-11 w-10 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] opacity-60 transition hover:bg-[var(--hover)] hover:opacity-100 focus-visible:opacity-100">
          <Pencil className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function EditItemSheet({ item, id, onClose }: { item: ItemHandle<MealPlanData>; id: string; onClose: () => void }) {
  const i = item.data.grocery.items.find((x) => x.id === id);
  const [name, setName] = useState(i?.name ?? "");
  const [note, setNote] = useState(i?.note ?? "");
  const [aisle, setAisle] = useState(i?.aisle ?? "other");
  const first = i?.amounts.find((a) => a.qty !== null);
  const [qty, setQty] = useState(first ? String(+first.qty!.toFixed(2)) : "");
  const [unit, setUnit] = useState(first?.unit ?? "");
  if (!i) return null;
  const initial = { name: i.name, note: i.note, aisle: i.aisle, qty: first ? String(+first.qty!.toFixed(2)) : "", unit: first?.unit ?? "" };
  const multi = i.amounts.filter((a) => a.qty !== null).length > 1;
  const units = UNIT_CHOICES.includes(unit) ? UNIT_CHOICES : [...UNIT_CHOICES, unit];
  return (
    <Sheet
      open
      onClose={onClose}
      title="Edit item"
      footer={
        <>
          <ItemButton
            variant="ghost"
            className="text-[var(--danger)]"
            icon={<Trash2 className="h-4 w-4" />}
            onClick={() => {
              item.update((d) => removeItems(d, (x) => x.id === id));
              onClose();
            }}
          >
            Remove
          </ItemButton>
          <span className="flex-1" />
          <ItemButton
            variant="primary"
            disabled={!name.trim()}
            onClick={() => {
              const q = parseFloat(qty.replace(",", "."));
              item.update((d) => {
                const x = d.grocery.items.find((y) => y.id === id);
                if (!x) return;
                // Only what the person changed in the sheet.
                if (name.trim() !== initial.name) {
                  x.name = name.trim().slice(0, 200);
                  x.renamed = true;
                }
                if (note !== initial.note) x.note = note.slice(0, 300);
                if (qty !== initial.qty || unit !== initial.unit) {
                  x.amounts = Number.isFinite(q) && q > 0 ? [{ qty: Math.min(q, 1_000_000), unit }] : [];
                  x.qty_edited = true;
                }
                if (aisle !== initial.aisle) {
                  x.aisle = aisle;
                  // Remember the aisle for next time.
                  const key = (x.key || x.name.toLowerCase()).slice(0, 80);
                  d.aisle_overrides = [...d.aisle_overrides.filter((o) => o.key !== key), { key, aisle }].slice(-500);
                }
              });
              onClose();
            }}
          >
            Save
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Amount" hint={multi ? `Now ${fmtAmounts(i.amounts)} — saving replaces it with one amount.` : i.recipes.length ? `For ${i.recipes.join(", ")}` : undefined}>
          <div className="flex gap-2">
            <TextInput value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" placeholder="Any" aria-label="Amount" className="min-w-0 flex-1" />
            <Select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Unit" className="!w-32">
              {units.map((u) => (
                <option key={u} value={u}>
                  {u ? unitLabel(u, 2) : "count"}
                </option>
              ))}
            </Select>
          </div>
        </Field>
        <Field label="Aisle" hint="Moving it is remembered next time the list is built.">
          <Select value={aisle} onChange={(e) => setAisle(e.target.value)}>
            {Object.entries(AISLES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Note">
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="Brand, size, ‘ripe for Thursday’…" />
        </Field>
        {i.source === "plan" && <p className="text-xs text-[var(--text-muted)]">Your changes are kept when the list is updated from the plan.</p>}
      </div>
    </Sheet>
  );
}

function RegenSheet({ item, onClose }: { item: ItemHandle<MealPlanData>; onClose: () => void }) {
  const prefs = item.data.preferences;
  const thisWeek = startOfWeek(todayISO(), prefs.week_start);
  const [start, setStart] = useState(item.data.grocery.start ?? (addDays(thisWeek, 7) <= addDays(todayISO(), 2) ? addDays(thisWeek, 7) : thisWeek));
  const [end, setEnd] = useState(item.data.grocery.end ?? addDays(start, 6));
  const [optional, setOptional] = useState(false);
  const [restore, setRestore] = useState(false);
  const [busy, setBusy] = useState(false);
  const g = item.data.grocery;
  const removedHere = g.start === start && g.end === end ? (g.removed ?? []).length : 0;
  const presets = [
    { label: "This week", a: thisWeek, b: addDays(thisWeek, 6) },
    { label: "Next week", a: addDays(thisWeek, 7), b: addDays(thisWeek, 13) },
    { label: "Next 3 days", a: todayISO(), b: addDays(todayISO(), 2) },
  ];
  const run = async () => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      toast.error("You're offline — the list is built on the server. Items you add by hand still work.");
      return;
    }
    setBusy(true);
    try {
      const r = await item.runAction("generate_grocery_list", { start, end, include_optional: optional, restore_removed: restore });
      toast.success(r.summary);
      onClose();
    } catch (e) {
      toast.error(errDetail(e, "Couldn't build the list."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title="Build from the plan"
      footer={
        <ItemButton variant="primary" block disabled={busy || end < start} onClick={() => void run()} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}>
          Build list for {fmtRange(start, end)}
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <Chip key={p.label} active={p.a === start && p.b === end} onClick={() => { setStart(p.a); setEnd(p.b); }} className="h-10">
              {p.label}
            </Chip>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From">
            <TextInput type="date" value={start} onChange={(e) => e.target.value && setStart(e.target.value)} />
          </Field>
          <Field label="To">
            <TextInput type="date" value={end} onChange={(e) => e.target.value && setEnd(e.target.value)} />
          </Field>
        </div>
        <label className="flex min-h-[44px] items-center gap-3 text-sm text-[var(--text)]">
          <input type="checkbox" checked={optional} onChange={(e) => setOptional(e.target.checked)} className="h-5 w-5 accent-[var(--item-accent)]" />
          Include optional ingredients
        </label>
        {removedHere > 0 && (
          <label className="flex min-h-[44px] items-center gap-3 text-sm text-[var(--text)]">
            <input type="checkbox" checked={restore} onChange={(e) => setRestore(e.target.checked)} className="h-5 w-5 accent-[var(--item-accent)]" />
            Bring back the {removedHere} item{removedHere === 1 ? "" : "s"} you removed
          </label>
        )}
        <p className="text-xs text-[var(--text-muted)]">Items you added by hand stay; your renames, notes, amounts and checks are kept, and items you removed stay off. Pantry items are skipped.</p>
      </div>
    </Sheet>
  );
}

/** Full-screen shopping: big rows, checked items sink, screen kept awake. */
function InStore({ item, onClose }: { item: ItemHandle<MealPlanData>; onClose: () => void }) {
  const data = item.data;
  const { groups, open, done } = useGroups(data);
  useWakeLock(data.preferences.keep_awake);
  const total = data.grocery.items.length;
  const toggle = (i: GroceryItem) => setChecked(item, i.id, !i.checked);
  return createPortal(
    <div className="fixed inset-0 z-[75] flex flex-col bg-[var(--bg)] pt-safe" role="dialog" aria-modal="true" aria-label="Shopping mode">
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-lg font-semibold tabular-nums text-[var(--text)]" aria-live="polite">
            {open.length ? `${open.length} to go` : "All in the cart"}
            <span className="ml-2 text-sm font-normal text-[var(--text-muted)]">
              {done.length} of {total}
            </span>
          </p>
          <ProgressBar value={total ? done.length / total : 0} className="mt-1.5" />
        </div>
        <ItemButton variant="primary" onClick={onClose}>
          Done
        </ItemButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto pb-safe">
        <div className="mx-auto max-w-2xl">
          {groups.map((g) => (
            <section key={g.aisle}>
              <h2 className="sticky top-0 z-10 flex items-baseline gap-2 border-b border-[var(--border)] bg-[var(--bg)] px-4 pb-2 pt-4 text-sm font-semibold uppercase tracking-wide text-[var(--item-accent)]">
                {AISLES[g.aisle] ?? "Other"}
                <span className="text-xs font-medium normal-case tracking-normal text-[var(--text-muted)] tabular-nums">{g.items.length} left</span>
              </h2>
              <div className="divide-y divide-[var(--border)]">
                {g.items.map((i) => (
                  <Row key={i.id} i={i} big onToggle={item.canEdit ? () => toggle(i) : undefined} />
                ))}
              </div>
            </section>
          ))}
          {open.length === 0 && <p className="px-4 py-10 text-center text-lg font-medium text-[var(--text)]">All done — nice shop!</p>}
          {done.length > 0 && (
            <section className="mt-4 opacity-70">
              <h2 className="px-4 pb-1 pt-4 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">In the cart</h2>
              <div className="divide-y divide-[var(--border)]">
                {done.map((i) => (
                  <Row key={i.id} i={i} big onToggle={item.canEdit ? () => toggle(i) : undefined} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
