import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";

import { Chip, Field, ItemButton, Select, Sheet, TextArea, TextInput, Toggle } from "@/items/ui";

import { money, mapsUrl, toHome, toMajor, toMinor } from "./logic";
import type { Idea, PlanItem, PlanStatus, PlanType, Priority, Trip } from "./types";
import { PLAN_LABEL, PLAN_TYPES } from "./types";
import { CurrencySelect, FieldRow, linkProblem, parseAmount, TYPE_ICON } from "./ui";

/** One form for an itinerary item or an idea. */
export interface PlanDraft {
  title: string;
  type: PlanType;
  time: string | null;
  duration_min: number | null;
  place: string;
  address: string;
  area: string;
  lat: number | null;
  lng: number | null;
  cost: string;
  currency: string;
  link: string;
  status: PlanStatus;
  notes: string;
  travel_after: string;
  priority: Priority;
  tags: string;
  hours: string;
  book_ahead: boolean;
  date: string;
}

export function draftFrom(t: Trip, src: Partial<PlanItem & Idea> | null, date: string): PlanDraft {
  const cur = src?.currency || t.settings.home_currency;
  return {
    title: src?.title ?? "",
    type: src?.type ?? "activity",
    time: src?.time ?? null,
    duration_min: src?.duration_min ?? null,
    place: src?.place ?? "",
    address: src?.address ?? "",
    area: src?.area ?? "",
    lat: src?.lat ?? null,
    lng: src?.lng ?? null,
    cost: src?.cost_minor !== null && src?.cost_minor !== undefined ? String(toMajor(src.cost_minor, cur)) : "",
    currency: cur,
    link: src?.link ?? "",
    status: src?.status ?? "planned",
    notes: src?.notes ?? "",
    travel_after: src?.travel_after ?? "",
    priority: src?.priority ?? "want",
    tags: (src?.tags ?? []).join(", "),
    hours: src?.hours ?? "",
    book_ahead: src?.book_ahead ?? false,
    date,
  };
}

export function applyDraft<T extends Partial<PlanItem & Idea>>(t: Trip, target: T, d: PlanDraft, mode: "item" | "idea"): T {
  const amount = parseAmount(d.cost);
  const base = {
    title: d.title.trim(),
    type: d.type,
    duration_min: d.duration_min,
    place: d.place.trim(),
    address: d.address.trim(),
    area: d.area.trim(),
    lat: d.lat,
    lng: d.lng,
    cost_minor: amount === null ? null : toMinor(amount, d.currency),
    currency: amount === null ? null : d.currency === t.settings.home_currency ? null : d.currency,
    link: d.link.trim(),
    notes: d.notes,
  };
  if (mode === "item") return Object.assign(target, base, { time: d.time || null, status: d.status, travel_after: d.travel_after.trim() });
  return Object.assign(target, base, {
    priority: d.priority,
    tags: d.tags.split(",").map((s) => s.trim().slice(0, 30)).filter(Boolean).slice(0, 12),
    hours: d.hours.trim(),
    book_ahead: d.book_ahead,
  });
}

const DURATIONS = [30, 60, 90, 120, 180, 240];

export function PlanItemSheet({
  open,
  onClose,
  trip,
  mode,
  initial,
  title,
  dates,
  onSave,
  onDelete,
  extra,
}: {
  open: boolean;
  onClose: () => void;
  trip: Trip;
  mode: "item" | "idea";
  initial: PlanDraft;
  title: string;
  dates?: string[];
  onSave: (d: PlanDraft) => void;
  onDelete?: () => void;
  extra?: React.ReactNode;
}) {
  const [d, setD] = useState(initial);
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (open) {
      setD(initial);
      setMore(!!(initial.address || initial.link || initial.lat !== null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = <K extends keyof PlanDraft>(k: K, v: PlanDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const maps = mapsUrl({ lat: d.lat, lng: d.lng, place: d.place, address: d.address, title: d.title });
  const amount = parseAmount(d.cost);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          {onDelete && (
            <ItemButton variant="ghost" className="text-[var(--danger)]" onClick={onDelete}>
              {mode === "item" ? "Remove" : "Delete"}
            </ItemButton>
          )}
          <ItemButton variant="primary" block disabled={!d.title.trim() || !!linkProblem(d.link)} onClick={() => onSave(d)}>
            Save
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="What">
          <TextInput autoFocus={!initial.title} value={d.title} onChange={(e) => set("title", e.target.value)} placeholder={mode === "idea" ? "Fushimi Inari Shrine" : "Breakfast at Nishiki Market"} />
        </Field>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Type">
          {PLAN_TYPES.map((p) => {
            const Icon = TYPE_ICON[p];
            return (
              <Chip key={p} active={d.type === p} onClick={() => set("type", p)} icon={<Icon className="h-3.5 w-3.5" />}>
                {PLAN_LABEL[p]}
              </Chip>
            );
          })}
        </div>
        {mode === "item" && (
          <>
            {dates && dates.length > 0 && (
              <Field label="Day">
                <Select value={d.date} onChange={(e) => set("date", e.target.value)}>
                  {dates.map((x) => (
                    <option key={x} value={x}>
                      {new Date(`${x}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <FieldRow>
              <Field label="Time" hint="Local time there">
                <TextInput type="time" value={d.time ?? ""} onChange={(e) => set("time", e.target.value || null)} />
              </Field>
              <Field label="Status">
                <Select value={d.status} onChange={(e) => set("status", e.target.value as PlanStatus)}>
                  <option value="idea">Idea</option>
                  <option value="planned">Planned</option>
                  <option value="booked">Booked</option>
                  <option value="done">Done</option>
                </Select>
              </Field>
            </FieldRow>
            {d.time && (
              <button type="button" className="-mt-2 self-start text-xs font-medium text-[var(--item-accent)]" onClick={() => set("time", null)}>
                Make it “anytime”
              </button>
            )}
          </>
        )}
        <Field label="How long">
          <div className="flex flex-wrap gap-2">
            {DURATIONS.map((m) => (
              <Chip key={m} active={d.duration_min === m} onClick={() => set("duration_min", d.duration_min === m ? null : m)}>
                {m < 60 ? `${m} min` : `${m / 60} h`}
              </Chip>
            ))}
            <TextInput
              aria-label="Minutes"
              inputMode="numeric"
              className="w-24"
              placeholder="min"
              value={d.duration_min !== null && !DURATIONS.includes(d.duration_min) ? String(d.duration_min) : ""}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                set("duration_min", Number.isFinite(n) ? Math.min(4320, Math.max(0, n)) : null);
              }}
            />
          </div>
        </Field>
        <FieldRow>
          <Field label="Place">
            <TextInput value={d.place} onChange={(e) => set("place", e.target.value)} placeholder="Name of the place" />
          </Field>
          <Field label="Area" hint="Neighbourhood — groups ideas">
            <TextInput value={d.area} onChange={(e) => set("area", e.target.value)} placeholder="Gion" />
          </Field>
        </FieldRow>
        <FieldRow className="grid-cols-[1fr_7rem]">
          <Field label="Cost" hint={homeHint(trip, amount, d.currency)}>
            <TextInput inputMode="decimal" value={d.cost} onChange={(e) => set("cost", e.target.value)} placeholder="0" />
          </Field>
          <Field label="Currency">
            <CurrencySelect trip={trip} value={d.currency} onChange={(v) => set("currency", v)} />
          </Field>
        </FieldRow>
        {mode === "idea" && (
          <>
            <Field label="Priority">
              <div className="flex gap-2">
                {(["must", "want", "maybe"] as Priority[]).map((p) => (
                  <Chip key={p} active={d.priority === p} onClick={() => set("priority", p)}>
                    {p === "must" ? "Must do" : p === "want" ? "Want to" : "Maybe"}
                  </Chip>
                ))}
              </div>
            </Field>
            <Field label="Tags" hint="Comma-separated: food, rainy day, kids">
              <TextInput value={d.tags} onChange={(e) => set("tags", e.target.value)} />
            </Field>
            <Field label="Opening hours">
              <TextInput value={d.hours} onChange={(e) => set("hours", e.target.value)} placeholder="9:00–17:00, closed Mondays" />
            </Field>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-[var(--text)]">Book ahead</span>
              <Toggle checked={d.book_ahead} onChange={(v) => set("book_ahead", v)} label="Book ahead" />
            </div>
          </>
        )}
        {mode === "item" && (
          <Field label="Getting to the next stop">
            <TextInput value={d.travel_after} onChange={(e) => set("travel_after", e.target.value)} placeholder="15 min walk" />
          </Field>
        )}
        <Field label="Notes">
          <TextArea value={d.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Tips, what to order, tickets…" />
        </Field>
        {more ? (
          <>
            <Field label="Address">
              <TextInput value={d.address} onChange={(e) => set("address", e.target.value)} />
            </Field>
            <Field label="Link" hint={linkProblem(d.link) ?? undefined}>
              <TextInput type="url" value={d.link} onChange={(e) => set("link", e.target.value)} placeholder="https://" />
            </Field>
            <FieldRow>
              <Field label="Latitude">
                <CoordInput value={d.lat} limit={90} onChange={(v) => set("lat", v)} label="Latitude" />
              </Field>
              <Field label="Longitude">
                <CoordInput value={d.lng} limit={180} onChange={(v) => set("lng", v)} label="Longitude" />
              </Field>
            </FieldRow>
          </>
        ) : (
          <button type="button" className="self-start text-sm font-medium text-[var(--item-accent)]" onClick={() => setMore(true)}>
            Address, link & map position…
          </button>
        )}
        {maps && (
          <a href={maps} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 self-start text-sm font-medium text-[var(--item-accent)]">
            <ExternalLink className="h-4 w-4" /> Open in Maps
          </a>
        )}
        {extra}
      </div>
    </Sheet>
  );
}

export function homeHint(trip: Trip, amount: number | null, currency: string): string | undefined {
  if (amount === null || currency === trip.settings.home_currency) return undefined;
  const v = toHome(trip, toMinor(amount, currency), currency);
  return v === null ? `No ${currency} rate yet — set one in Money` : `≈ ${money(v, trip.settings.home_currency)}`;
}

export function CoordInput({ value, limit, onChange, label }: { value: number | null; limit: number; onChange: (v: number | null) => void; label: string }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  return (
    <TextInput
      aria-label={label}
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = parseFloat(e.target.value);
        onChange(Number.isFinite(n) && Math.abs(n) <= limit ? n : null);
      }}
    />
  );
}
