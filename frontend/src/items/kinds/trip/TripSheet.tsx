import { Plus, Trash2, UserRound } from "lucide-react";
import { useEffect, useState } from "react";

import { LinkedSection } from "@/components/links/LinkedSection";
import type { ItemHandle } from "@/items/useItem";
import { Field, IconButton, ItemButton, Segmented, Select, Sheet, TextArea, TextInput, todayISO, uid } from "@/items/ui";
import { cn } from "@/utils/cn";

import { meId, travellerRefs } from "./logic";
import { assignChanged, claimMe, rebaseHome, rebaseProblem, removeTraveller } from "./ops";
import type { Destination, Traveller, Trip, TripStatus } from "./types";
import { CurrencySelect, FieldRow, useUserId, ZoneInput } from "./ui";
import { validZone } from "./tz";

export const COVER_COLORS = ["#2C9CC8", "#3B7DD8", "#4E9F5B", "#2F8F83", "#D9902F", "#E2725B", "#C2557A", "#7B6CD9", "#8A6F5A"];
const EMOJIS = ["✈️", "🗾", "🏝️", "🏔️", "🗽", "🏰", "🌋", "🏜️", "🚆", "🚗", "⛵", "🎿", "🏖️", "🌏", "🍜", "🥐"];

export const STATUS_LABEL: Record<TripStatus, string> = { planning: "Planning", booked: "Booked", travelling: "Travelling", done: "Done" };

type Draft = Pick<Trip, "title" | "emoji" | "color" | "start" | "end" | "status" | "notes" | "destinations" | "travellers"> & {
  home: string;
  passport_months: number;
  clock: Trip["settings"]["clock"];
  /** Travellers taken off in this sheet → who takes over their expenses. */
  removed: Record<string, string | null>;
  /** Which traveller the signed-in person is. */
  me: string | null;
};

function draftOf(t: Trip, me: string | null): Draft {
  return {
    title: t.title,
    emoji: t.emoji,
    color: t.color,
    start: t.start,
    end: t.end,
    status: t.status,
    notes: t.notes,
    destinations: structuredClone(t.destinations),
    travellers: structuredClone(t.travellers),
    home: t.settings.home_currency,
    passport_months: t.settings.passport_months,
    clock: t.settings.clock,
    removed: {},
    me,
  };
}

const SCALARS = ["title", "emoji", "color", "start", "end", "status", "notes"] as const;

export function blankDestination(): Destination {
  return { id: uid("d-"), name: "", country: "", lat: null, lng: null, tz: "", start: null, end: null, notes: "" };
}

export function TripSheet({ item, open, onClose, fallbackTitle }: { item: ItemHandle<Trip>; open: boolean; onClose: () => void; fallbackTitle: string }) {
  const t = item.data;
  const userId = useUserId();
  const [opened, setOpened] = useState<Draft>(() => draftOf(t, meId(t, userId)));
  const [d, setD] = useState<Draft>(opened);
  const [removing, setRemoving] = useState<{ id: string; to: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    const o = draftOf(item.data, meId(item.data, userId));
    setOpened(o);
    setD(structuredClone(o));
    setRemoving(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const setDest = (i: number, patch: Partial<Destination>) => set("destinations", d.destinations.map((x, n) => (n === i ? { ...x, ...patch } : x)));
  const setTrav = (i: number, patch: Partial<Traveller>) => set("travellers", d.travellers.map((x, n) => (n === i ? { ...x, ...patch } : x)));
  const badDates = !!(d.start && d.end && d.end < d.start);
  const homeProblem = d.home !== opened.home ? rebaseProblem(t, d.home) : null;
  const names = d.travellers.map((x) => x.name.trim().toLowerCase()).filter(Boolean);
  const dupName = names.length !== new Set(names).size;
  const kept = d.travellers.filter((x) => x.name.trim());

  const askRemove = (x: Traveller) => {
    const isSaved = opened.travellers.some((o) => o.id === x.id);
    const r = isSaved ? travellerRefs(t, x.id) : { expenses: 0, settlements: 0 };
    if (r.expenses || r.settlements) {
      const other = d.travellers.find((o) => o.id !== x.id && o.name.trim());
      setRemoving({ id: x.id, to: other?.id ?? "" });
      return;
    }
    setD((z) => ({ ...z, travellers: z.travellers.filter((o) => o.id !== x.id), removed: isSaved ? { ...z.removed, [x.id]: null } : z.removed, me: z.me === x.id ? null : z.me }));
  };
  const confirmRemove = () => {
    if (!removing?.to) return;
    const { id, to } = removing;
    setD((z) => ({ ...z, travellers: z.travellers.filter((o) => o.id !== id), removed: { ...z.removed, [id]: to }, me: z.me === id ? null : z.me }));
    setRemoving(null);
  };

  const save = () => {
    const today = todayISO();
    const travellers = d.travellers.filter((z) => z.name.trim()).map((z) => ({ ...z, name: z.name.trim() }));
    const dests = d.destinations.filter((z) => z.name.trim()).map((z) => ({ ...z, name: z.name.trim(), tz: validZone(z.tz) ? z.tz : "" }));
    const openedDests = new Map(opened.destinations.map((z) => [z.id, z]));
    const openedTravs = new Map(opened.travellers.map((z) => [z.id, z]));
    item.update((x) => {
      // Only what changed in this sheet — a companion's edits meanwhile stay.
      const after = { ...d, title: d.title.trim(), emoji: d.emoji || "✈️", start: d.start || null, end: d.end || d.start || null };
      for (const k of SCALARS) if (after[k] !== opened[k]) (x as unknown as Record<string, unknown>)[k] = after[k];
      // Destinations, by id.
      const goneDests = opened.destinations.filter((o) => !dests.some((z) => z.id === o.id)).map((o) => o.id);
      x.destinations = x.destinations.filter((z) => !goneDests.includes(z.id));
      for (const z of dests) {
        const cur = x.destinations.find((c) => c.id === z.id);
        const before = openedDests.get(z.id);
        if (cur && before) assignChanged(cur, before, z);
        else if (!cur && !before && x.destinations.length < 40) x.destinations.push(z);
      }
      // Travellers, by id: new ones first (expenses may move to them), then removals.
      for (const z of travellers) {
        const cur = x.travellers.find((c) => c.id === z.id);
        const before = openedTravs.get(z.id);
        if (cur && before) assignChanged(cur, before, z);
        else if (!cur && !before && x.travellers.length < 20) x.travellers.push(z);
      }
      for (const [id, to] of Object.entries(d.removed)) {
        if (!x.travellers.some((c) => c.id === id)) continue;
        const target = to && x.travellers.some((c) => c.id === to) ? to : null;
        if (!target && (travellerRefs(x, id).expenses || travellerRefs(x, id).settlements)) continue; // never orphan money
        removeTraveller(x, id, target);
      }
      if (userId && d.me && d.me !== opened.me && x.travellers.some((c) => c.id === d.me)) claimMe(x, userId, d.me);
      if (d.home !== opened.home) rebaseHome(x, d.home, today);
      if (d.passport_months !== opened.passport_months) x.settings.passport_months = d.passport_months;
      if (d.clock !== opened.clock) x.settings.clock = d.clock;
      x.settings.onboarded = true;
    });
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Trip details"
      size="lg"
      footer={
        <ItemButton variant="primary" block disabled={badDates || !!homeProblem || dupName || !kept.length || !!removing} onClick={save}>
          Save
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" hint="Blank uses the file name">
          <TextInput value={d.title} placeholder={fallbackTitle} onChange={(e) => set("title", e.target.value)} />
        </Field>
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-[var(--text-muted)]">Cover</span>
          <div className="flex flex-wrap gap-1.5">
            {EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                aria-label={`Emoji ${e}`}
                aria-pressed={d.emoji === e}
                onClick={() => set("emoji", e)}
                className={cn("flex h-10 w-10 items-center justify-center rounded-xl text-xl", d.emoji === e ? "bg-[var(--hover-strong)] ring-2 ring-[var(--item-accent)]" : "hover:bg-[var(--hover)]")}
              >
                {e}
              </button>
            ))}
            <TextInput aria-label="Custom emoji" value={d.emoji} onChange={(e) => set("emoji", e.target.value.slice(0, 8))} className="w-16 text-center" />
          </div>
          <div className="flex flex-wrap gap-2">
            {COVER_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Colour ${c}`}
                aria-pressed={d.color === c}
                onClick={() => set("color", c)}
                className={cn("h-9 w-9 rounded-full", d.color === c && "ring-2 ring-[var(--text)] ring-offset-2 ring-offset-[var(--bg)]")}
                style={{ background: c }}
              />
            ))}
          </div>
        </div>
        <FieldRow>
          <Field label="First day">
            <TextInput type="date" value={d.start ?? ""} onChange={(e) => set("start", e.target.value || null)} />
          </Field>
          <Field label="Last day" hint={badDates ? "Ends before it starts" : undefined}>
            <TextInput type="date" value={d.end ?? ""} min={d.start ?? undefined} onChange={(e) => set("end", e.target.value || null)} />
          </Field>
        </FieldRow>
        <Field label="Status">
          <Segmented<TripStatus>
            value={d.status}
            onChange={(v) => set("status", v)}
            options={(Object.keys(STATUS_LABEL) as TripStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
            className="w-full"
            size="sm"
          />
        </Field>

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--text)]">Destinations</h3>
            <ItemButton size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => set("destinations", [...d.destinations, blankDestination()])}>
              Add
            </ItemButton>
          </div>
          {d.destinations.length === 0 && <p className="text-sm text-[var(--text-muted)]">Add the cities you'll stay in — their time zones make every time on the trip right.</p>}
          {d.destinations.map((x, i) => (
            <div key={x.id} className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] p-3">
              <div className="flex gap-2">
                <TextInput aria-label="City" placeholder="City (Kyoto)" value={x.name} onChange={(e) => setDest(i, { name: e.target.value })} />
                <TextInput aria-label="Country" placeholder="Country" value={x.country} onChange={(e) => setDest(i, { country: e.target.value })} />
                <IconButton label={`Remove ${x.name || "destination"}`} icon={Trash2} onClick={() => set("destinations", d.destinations.filter((_, n) => n !== i))} />
              </div>
              <ZoneInput label="Time zone" value={x.tz} onChange={(v) => setDest(i, { tz: v })} />
              {x.tz && !validZone(x.tz) && <p className="text-xs text-[var(--warning)]">Not a time zone this device knows — pick one from the list.</p>}
              <FieldRow>
                <TextInput type="date" aria-label="Arrive" value={x.start ?? ""} onChange={(e) => setDest(i, { start: e.target.value || null })} />
                <TextInput type="date" aria-label="Leave" value={x.end ?? ""} onChange={(e) => setDest(i, { end: e.target.value || null })} />
              </FieldRow>
            </div>
          ))}
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--text)]">Travellers</h3>
            <ItemButton
              size="sm"
              icon={<Plus className="h-4 w-4" />}
              disabled={d.travellers.length >= 20}
              onClick={() => set("travellers", [...d.travellers, { id: uid("t-"), name: "", is_me: false, user_id: "", age_group: "adult", passport_country: "" }])}
            >
              Add
            </ItemButton>
          </div>
          {d.travellers.map((x, i) => (
            <div key={x.id} className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <UserRound className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                <TextInput aria-label="Traveller name" placeholder="Name" value={x.name} onChange={(e) => setTrav(i, { name: e.target.value })} />
                <Select aria-label="Age" value={x.age_group} onChange={(e) => setTrav(i, { age_group: e.target.value as Traveller["age_group"] })} className="w-24">
                  <option value="adult">Adult</option>
                  <option value="child">Child</option>
                  <option value="infant">Infant</option>
                </Select>
                {userId && (
                  <button
                    type="button"
                    aria-pressed={d.me === x.id}
                    aria-label={`${x.name || "This traveller"} is me`}
                    onClick={() => set("me", x.id)}
                    className={cn(
                      "h-11 shrink-0 rounded-xl border px-2.5 text-xs font-semibold md:h-10",
                      d.me === x.id ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] text-[var(--text)]" : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)]",
                    )}
                  >
                    {d.me === x.id ? "You" : "Me?"}
                  </button>
                )}
                <IconButton label={`Remove ${x.name || "traveller"}`} icon={Trash2} disabled={kept.length <= 1 && !!x.name.trim()} onClick={() => askRemove(x)} />
              </div>
              {removing?.id === x.id && (
                <div className="flex flex-col gap-2 rounded-2xl border border-[color-mix(in_srgb,var(--warning)_45%,var(--border))] p-3" role="alert">
                  <p className="text-sm text-[var(--text)]">
                    {x.name} is on {travellerRefs(t, x.id).expenses} expense(s) and {travellerRefs(t, x.id).settlements} repayment(s). Who takes those over?
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Select aria-label="Move their expenses to" value={removing.to} onChange={(e) => setRemoving({ ...removing, to: e.target.value })} className="w-44">
                      {d.travellers
                        .filter((o) => o.id !== x.id && o.name.trim())
                        .map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                    </Select>
                    <ItemButton size="sm" variant="primary" disabled={!removing.to} onClick={confirmRemove}>
                      Remove {x.name}
                    </ItemButton>
                    <ItemButton size="sm" variant="ghost" onClick={() => setRemoving(null)}>
                      Keep
                    </ItemButton>
                  </div>
                  <p className="text-xs text-[var(--text-muted)]">Renaming keeps everything — just edit the name instead.</p>
                </div>
              )}
            </div>
          ))}
          {dupName && <p className="text-xs text-[var(--warning)]">Two travellers have the same name.</p>}
        </section>

        <FieldRow>
          <Field label="Home currency" hint={homeProblem ?? (d.home !== opened.home ? `Every amount is converted to ${d.home} at your rates.` : "Budgets and settle-up use it")}>
            <CurrencySelect trip={item.data} value={d.home} onChange={(v) => set("home", v)} />
          </Field>
          <Field label="Passport valid beyond return" hint="Months most countries ask for">
            <Select value={String(d.passport_months)} onChange={(e) => set("passport_months", Number(e.target.value))}>
              {[0, 3, 6].map((m) => (
                <option key={m} value={m}>
                  {m ? `${m} months` : "Don't check"}
                </option>
              ))}
            </Select>
          </Field>
        </FieldRow>
        <Field label="Clock">
          <Segmented
            value={d.clock}
            onChange={(v) => set("clock", v)}
            options={[
              { value: "auto", label: "Auto" },
              { value: "24h", label: "24-hour" },
              { value: "12h", label: "12-hour" },
            ]}
            size="sm"
          />
        </Field>
        <Field label="Notes">
          <TextArea value={d.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Anything worth remembering — the plan, who's booking what…" />
        </Field>
        <LinkedSection thing={{ kind: "trip", id: `${item.fileId}:${t.id}` }} readOnly={!item.canEdit} />
      </div>
    </Sheet>
  );
}

