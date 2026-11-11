import { Check, ListRestart, Luggage, Minus, Plus, Sparkles, Star, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { TWO_COL, useTripWidth } from "./layout";
import type { ItemViewProps } from "@/items/types";
import { Chip, EmptyState, Fab, Field, IconButton, ItemButton, Page, ProgressRing, ScrollRow, Select, Sheet, TextInput, Toggle, uid } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { packingProgress } from "./logic";
import { assignChanged } from "./ops";
import { PACK_TEMPLATES } from "./packTemplates";
import type { PackingItem, Trip } from "./types";

const TEMPLATES: { id: string; label: string; emoji: string; hint: string }[] = [
  { id: "essentials", label: "Essentials", emoji: "🧳", hint: "Documents, money, tech, basics" },
  { id: "city", label: "City break", emoji: "🏙️", hint: "Walking, evenings out" },
  { id: "beach", label: "Beach", emoji: "🏖️", hint: "Sun, swim, snorkel" },
  { id: "ski", label: "Ski / snow", emoji: "🎿", hint: "Layers, goggles, gloves" },
  { id: "winter", label: "Cold weather", emoji: "🧣", hint: "Coat, thermals" },
  { id: "hiking", label: "Hiking", emoji: "🥾", hint: "Boots, rain shell, daypack" },
  { id: "camping", label: "Camping", emoji: "⛺", hint: "Tent, sleeping gear, stove" },
  { id: "business", label: "Business", emoji: "💼", hint: "Suits, laptop, cards" },
  { id: "baby", label: "Baby & toddler", emoji: "🍼", hint: "Nappies, feeding, sleep" },
];

const CATEGORY_ORDER = ["Documents", "Money", "Tech", "Health", "Toiletries", "Clothes", "Gear", "Kids", "Work", "Food", "Other"];

export function PackingTab({ item, isPhone, ask }: ItemViewProps<Trip>) {
  const t = item.data;
  const width = useTripWidth();
  const narrow = isPhone || width < TWO_COL;
  const [who, setWho] = useState<string>("all"); // all | shared | traveller id
  const [hideDone, setHideDone] = useState(false);
  const [templates, setTemplates] = useState(false);
  const [adding, setAdding] = useState<{ category: string } | null>(null);
  const [editing, setEditing] = useState<PackingItem | null>(null);
  const names = Object.fromEntries(t.travellers.map((x) => [x.id, x.name]));

  const visible = useMemo(
    () => t.packing.filter((i) => (who === "all" ? true : who === "shared" ? !i.traveller_id : i.traveller_id === who) && (!hideDone || !i.checked)),
    [t.packing, who, hideDone],
  );
  const groups = useMemo(() => {
    const m = new Map<string, PackingItem[]>();
    for (const i of visible) m.set(i.category || "Other", [...(m.get(i.category || "Other") ?? []), i]);
    const rank = (c: string) => (CATEGORY_ORDER.indexOf(c) >= 0 ? CATEGORY_ORDER.indexOf(c) : 50);
    return [...m.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
  }, [visible]);
  const prog = packingProgress(t, who === "all" ? undefined : who === "shared" ? null : who);
  const essentialsLeft = t.packing.filter((i) => i.essential && !i.checked).length;

  const toggle = (id: string) => {
    // Decided from what's on screen, so a replay can't flip it back.
    const target = !t.packing.find((x) => x.id === id)?.checked;
    item.update((d) => {
      const i = d.packing.find((x) => x.id === id);
      if (i) i.checked = target;
    });
  };

  // Added right here (works offline); the same lists as the assistant's.
  const applyTemplate = (id: string) => {
    setTemplates(false);
    const people = t.travellers.map((x) => x.id);
    const rows = (PACK_TEMPLATES[id] ?? []).flatMap(([name, category, per, qty, essential]) =>
      (per && people.length ? people : [null]).map((tid) => ({ id: uid("p-"), name, category, traveller_id: tid, qty, checked: false, essential, notes: "" })),
    );
    const have = new Set(t.packing.map((i) => `${i.name.toLowerCase()}|${i.traveller_id ?? ""}`));
    const fresh = rows.filter((r) => !have.has(`${r.name.toLowerCase()}|${r.traveller_id ?? ""}`));
    item.update((d) => {
      const now = new Set(d.packing.map((i) => `${i.name.toLowerCase()}|${i.traveller_id ?? ""}`));
      for (const r of fresh) {
        const k = `${r.name.toLowerCase()}|${r.traveller_id ?? ""}`;
        if (now.has(k) || d.packing.length >= 800) continue;
        now.add(k);
        d.packing.push(r);
      }
    });
    toast.success(fresh.length ? `Added ${fresh.length} item${fresh.length === 1 ? "" : "s"}` : "Everything on that list is already here");
  };

  return (
    <Page wide={!narrow}>
      <div className={cn("flex gap-4", narrow ? "flex-col" : "items-center justify-between")}>
        <div className="flex items-center gap-4">
          <ProgressRing value={prog.ratio} size={72} stroke={7}>
            <span className="text-sm">{Math.round(prog.ratio * 100)}%</span>
          </ProgressRing>
          <div>
            <p className="text-lg font-semibold text-[var(--text)]" aria-live="polite">
              {prog.total ? `${prog.done} of ${prog.total} packed` : "Nothing on the list yet"}
            </p>
            <p className="text-sm text-[var(--text-muted)]">
              {essentialsLeft ? `${essentialsLeft} essential${essentialsLeft === 1 ? "" : "s"} still to pack` : prog.total ? "All essentials packed" : "Start from a template or ask the assistant"}
            </p>
          </div>
        </div>
        {item.canEdit && (
          <div className={cn("flex gap-2 [&>*]:shrink-0", narrow ? "-mx-4 overflow-x-auto px-4 pb-1 [scrollbar-width:none]" : "flex-wrap")}>
            <ItemButton icon={<Luggage className="h-4 w-4" />} onClick={() => setTemplates(true)}>
              Templates
            </ItemButton>
            <ItemButton
              variant="ghost"
              icon={<Sparkles className="h-4 w-4" />}
              onClick={() => ask("Make a packing list for each traveller based on the trip length, the expected weather for our dates and destinations, and the activities planned. Mark the essentials.")}
            >
              Pack for the weather
            </ItemButton>
            {t.packing.some((i) => i.checked) && (
              <ItemButton
                variant="ghost"
                icon={<ListRestart className="h-4 w-4" />}
                onClick={() => {
                  const ids = new Set(t.packing.filter((i) => i.checked).map((i) => i.id));
                  item.update((d) => {
                    for (const i of d.packing) if (ids.has(i.id)) i.checked = false;
                  });
                }}
              >
                Repack for home
              </ItemButton>
            )}
          </div>
        )}
      </div>

      {t.packing.length > 0 && (
        <div className="flex flex-col gap-2">
          <ScrollRow>
            <Chip active={who === "all"} onClick={() => setWho("all")}>
              Everyone
            </Chip>
            <Chip active={who === "shared"} onClick={() => setWho("shared")}>
              Shared
            </Chip>
            {t.travellers.length > 1 &&
              t.travellers.map((x) => {
                const p = packingProgress(t, x.id);
                return (
                  <Chip key={x.id} active={who === x.id} onClick={() => setWho(x.id)}>
                    {x.name} {p.total ? <span className="tabular-nums text-[var(--text-muted)]">{p.done}/{p.total}</span> : null}
                  </Chip>
                );
              })}
          </ScrollRow>
          <label className="flex items-center gap-2 self-end text-xs text-[var(--text-muted)]">
            Hide packed
            <Toggle checked={hideDone} onChange={setHideDone} label="Hide packed items" />
          </label>
        </div>
      )}

      {t.packing.length === 0 ? (
        <EmptyState
          icon={Luggage}
          title="Pack smarter"
          text="Pick a template (beach, ski, business, baby…) or let the assistant build a list for the weather and your plans — per traveller."
          action={
            item.canEdit && (
              <div className="flex flex-wrap justify-center gap-2">
                <ItemButton variant="primary" onClick={() => setTemplates(true)}>
                  Choose a template
                </ItemButton>
                <ItemButton icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Make a packing list for each traveller based on the weather and activities on this trip.")}>
                  Ask the assistant
                </ItemButton>
              </div>
            )
          }
        />
      ) : (
        <div className={cn("grid gap-4", !isPhone && (width >= 1100 ? "grid-cols-3" : width >= 640 ? "grid-cols-2" : ""))}>
          {groups.map(([cat, list]) => {
            const done = list.filter((i) => i.checked).length;
            return (
              <section key={cat} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between px-1">
                  <h2 className="text-sm font-semibold text-[var(--text)]">{cat}</h2>
                  <span className="text-xs tabular-nums text-[var(--text-muted)]">
                    {done}/{list.length}
                  </span>
                </div>
                <div className="divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
                  {list.map((i) => (
                    <div key={i.id} className="flex min-h-[52px] items-center gap-1 pr-1">
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={i.checked}
                        disabled={!item.canEdit}
                        onClick={() => toggle(i.id)}
                        className="flex min-h-[52px] min-w-0 flex-1 items-center gap-3 px-3 text-left"
                      >
                        <span
                          className={cn(
                            "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border-2 transition",
                            i.checked ? "border-[var(--item-accent)] bg-[var(--item-accent-fill)] text-white" : "border-[var(--border)]",
                          )}
                        >
                          {i.checked && <Check className="h-4 w-4" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={cn("flex items-center gap-1.5 text-sm text-[var(--text)]", i.checked && "text-[var(--text-muted)] line-through")}>
                            <span className="truncate">{i.name}</span>
                            {i.essential && <Star aria-label="Essential" className="h-3.5 w-3.5 shrink-0 fill-[var(--warning)] text-[var(--warning)]" />}
                          </span>
                          {(who === "all" || i.notes) && (
                            <span className="block truncate text-xs text-[var(--text-muted)]">
                              {[who === "all" && t.travellers.length > 1 ? (i.traveller_id ? names[i.traveller_id] : "Shared") : "", i.notes].filter(Boolean).join(" · ")}
                            </span>
                          )}
                        </span>
                        {i.qty > 1 && <span className="shrink-0 rounded-md bg-[var(--surface-2)] px-1.5 text-xs font-semibold tabular-nums text-[var(--text)]">×{i.qty}</span>}
                      </button>
                      {item.canEdit && (
                        <IconButton label={`Edit ${i.name}`} icon={MoreDots} onClick={() => setEditing(i)} />
                      )}
                    </div>
                  ))}
                  {item.canEdit && (
                    <QuickAdd
                      category={cat}
                      who={who}
                      onAdd={(name) => {
                        const it = newItem(name, cat, who);
                        item.update((d) => {
                          if (d.packing.length < 800 && !d.packing.some((x) => x.id === it.id)) d.packing.push(it);
                        });
                      }}
                    />
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
      {item.canEdit && t.packing.length > 0 && !isPhone && (
        <ItemButton variant="ghost" className="self-start" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding({ category: "Other" })}>
          New category or item
        </ItemButton>
      )}
      {isPhone && item.canEdit && <Fab label="Item" icon={Plus} onClick={() => setAdding({ category: groups[0]?.[0] ?? "Clothes" })} />}

      <Sheet open={templates} onClose={() => setTemplates(false)} title="Add a packing template" size="lg">
        <p className="mb-3 text-sm text-[var(--text-muted)]">Per-person items are added for each traveller; things you share once. Items already on the list are skipped.</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {TEMPLATES.map((x) => (
            <button
              key={x.id}
              type="button"
              onClick={() => applyTemplate(x.id)}
              className="flex min-h-[64px] items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-3 text-left transition hover:border-[var(--item-accent)]"
            >
              <span className="text-2xl" aria-hidden>
                {x.emoji}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-[var(--text)]">{x.label}</span>
                <span className="block truncate text-xs text-[var(--text-muted)]">{x.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </Sheet>
      <ItemEditor
        trip={t}
        open={!!editing || !!adding}
        initial={editing ?? newItem("", adding?.category ?? "Other", who)}
        isNew={!editing}
        onClose={() => {
          setEditing(null);
          setAdding(null);
        }}
        onSave={(p) => {
          const before = editing;
          item.update((d) => {
            const cur = d.packing.find((x) => x.id === p.id);
            if (cur && before) assignChanged(cur, before, p);
            else if (!cur && !before && d.packing.length < 800) d.packing.push(p);
          });
          setEditing(null);
          setAdding(null);
        }}
        onDelete={
          editing
            ? () => {
                const id = editing.id;
                item.update((d) => {
                  d.packing = d.packing.filter((x) => x.id !== id);
                });
                setEditing(null);
              }
            : undefined
        }
      />
    </Page>
  );
}

function MoreDots({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

function newItem(name: string, category: string, who: string): PackingItem {
  return {
    id: uid("p-"),
    name: name.trim(),
    category,
    traveller_id: who === "all" || who === "shared" ? null : who,
    qty: 1,
    checked: false,
    essential: false,
    notes: "",
  };
}

function QuickAdd({ category, who, onAdd }: { category: string; who: string; onAdd: (name: string) => void }) {
  const [v, setV] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  return (
    <form
      className="flex items-center gap-2 px-3 py-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!v.trim()) return;
        onAdd(v.trim().slice(0, 80));
        setV("");
        ref.current?.focus();
      }}
    >
      <Plus className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
      <input
        ref={ref}
        value={v}
        onChange={(e) => setV(e.target.value)}
        aria-label={`Add to ${category}`}
        placeholder={`Add to ${category}${who !== "all" && who !== "shared" ? "" : ""}…`}
        className="h-10 min-w-0 flex-1 bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
      />
    </form>
  );
}

function ItemEditor({ trip, open, initial, isNew, onClose, onSave, onDelete }: {
  trip: Trip;
  open: boolean;
  initial: PackingItem;
  isNew: boolean;
  onClose: () => void;
  onSave: (p: PackingItem) => void;
  onDelete?: () => void;
}) {
  const [p, setP] = useState(initial);
  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setP(initial);
  }
  const cats = [...new Set([...CATEGORY_ORDER, ...trip.packing.map((i) => i.category)])];
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={isNew ? "Add to the list" : "Packing item"}
      footer={
        <>
          {onDelete && (
            <ItemButton variant="ghost" className="text-[var(--danger)]" icon={<Trash2 className="h-4 w-4" />} onClick={onDelete}>
              Delete
            </ItemButton>
          )}
          <ItemButton variant="primary" block disabled={!p.name.trim()} onClick={() => onSave({ ...p, name: p.name.trim().slice(0, 80), category: (p.category || "Other").slice(0, 40) })}>
            Save
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Item">
          <TextInput autoFocus value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} placeholder="Swimsuit" />
        </Field>
        <Field label="Category">
          <TextInput list="trip-pack-cats" value={p.category} onChange={(e) => setP({ ...p, category: e.target.value })} />
          <datalist id="trip-pack-cats">
            {cats.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
        {trip.travellers.length > 1 && (
          <Field label="Whose">
            <Select value={p.traveller_id ?? ""} onChange={(e) => setP({ ...p, traveller_id: e.target.value || null })}>
              <option value="">Shared</option>
              {trip.travellers.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-[var(--text)]">How many</span>
          <div className="flex items-center gap-2">
            <IconButton label="Fewer" icon={Minus} onClick={() => setP({ ...p, qty: Math.max(1, p.qty - 1) })} />
            <span className="w-8 text-center text-base font-semibold tabular-nums text-[var(--text)]">{p.qty}</span>
            <IconButton label="More" icon={Plus} onClick={() => setP({ ...p, qty: Math.min(99, p.qty + 1) })} />
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-[var(--text)]">Essential</span>
          <Toggle checked={p.essential} onChange={(v) => setP({ ...p, essential: v })} label="Essential" />
        </div>
        <Field label="Note">
          <TextInput value={p.notes} onChange={(e) => setP({ ...p, notes: e.target.value.slice(0, 200) })} placeholder="In the carry-on" />
        </Field>
      </div>
    </Sheet>
  );
}
