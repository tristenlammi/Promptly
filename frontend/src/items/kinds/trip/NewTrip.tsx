import { Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { ItemHandle } from "@/items/useItem";
import { Field, ItemButton, Sheet, TextInput, Toggle, uid } from "@/items/ui";
import { PersonInput } from "@/items/ui/PersonInput";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";

import { blankDestination, COVER_COLORS } from "./TripSheet";
import { blankTrip, fileSettings, MAX_TRIPS, myLastPassport, selectTrip } from "./trips";
import type { Trip, TripFile, TripRecord } from "./types";
import { CurrencySelect, FieldRow, ZoneInput } from "./ui";
import { allZones, fallbackZone, validZone } from "./tz";

const EMOJIS = ["✈️", "🗾", "🏝️", "🏔️", "🗽", "🏰", "🌋", "🏜️", "🚆", "🚗", "⛵", "🎿", "🏖️", "🌏"];

interface Form {
  title: string;
  where: string;
  country: string;
  tz: string;
  start: string;
  end: string;
  /** What's typed in the "who" box (commas split it into people). */
  who: string;
  /** Companions added so far — picked from Contacts / Promptly, or typed. */
  people: Companion[];
  mine: boolean;
  home: string;
  emoji: string;
}

interface Companion {
  name: string;
  user_id: string;
  contact_id: string;
}

const empty = (home: string): Form => ({ title: "", where: "", country: "", tz: "", start: "", end: "", who: "", people: [], mine: true, home, emoji: "✈️" });

const typedPeople = (who: string): Companion[] =>
  who.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map((name) => ({ name: name.slice(0, 60), user_id: "", contact_id: "" }));

/** Build the new trip outside the mutator (ids are made once), then add it. */
function buildTrip(f: Form, file: TripFile, user: { id: string; username: string } | null): TripRecord {
  const title = f.title.trim() || f.where.trim() || "New trip";
  const t = blankTrip(uid("trip-"), title, f.home);
  t.emoji = f.emoji;
  t.color = COVER_COLORS[file.trips.length % COVER_COLORS.length];
  t.start = f.start || null;
  t.end = f.end || f.start || null;
  if (t.start && t.end && t.end < t.start) [t.start, t.end] = [t.end, t.start];
  if (f.where.trim()) t.destinations.push({ ...blankDestination(), name: f.where.trim(), country: f.country.trim(), tz: validZone(f.tz) ? f.tz : "", start: t.start, end: t.end });
  const others = [...f.people, ...typedPeople(f.who)];
  if (f.mine || !others.length) {
    // Your passport from your last trip, so it isn't typed in again.
    const last = myLastPassport(file, user?.id);
    const me = { id: uid("t-"), name: user?.username?.trim().slice(0, 60) || "Me", is_me: true, user_id: user?.id ?? "", contact_id: "", age_group: "adult" as const, passport_country: last.country.slice(0, 60) };
    t.travellers.push(me);
    if (user?.id) t.me_by_user[user.id] = me.id;
    if (last.doc) t.documents.push({ ...structuredClone(last.doc), id: uid("doc-"), traveller_id: me.id, remind_on: null });
  }
  for (const c of others.slice(0, 19)) {
    if (t.travellers.some((x) => x.name.toLowerCase() === c.name.toLowerCase() || (c.user_id && x.user_id === c.user_id))) continue;
    t.travellers.push({ id: uid("t-"), name: c.name, is_me: false, user_id: c.user_id, contact_id: c.contact_id, age_group: "adult", passport_country: "" });
  }
  return t;
}

/** Add ``trip`` to the file (once — a replay finds it there) and open it. */
export function addTrip(file: ItemHandle<TripFile>, trip: TripRecord) {
  file.update((d) => {
    d.trips ??= [];
    if (d.trips.length >= MAX_TRIPS || d.trips.some((x) => x.id === trip.id)) return;
    d.trips.push(structuredClone(trip));
    d.settings.onboarded = true;
  });
  selectTrip(file.fileId, trip.id);
}

/** The IANA zone named after a city ("Tokyo" → Asia/Tokyo), if any. */
function zoneForCity(city: string): string {
  const key = city.trim().toLowerCase().replace(/\s+/g, "_");
  if (key.length < 3) return "";
  return allZones().find((z) => z.toLowerCase().split("/").pop() === key) ?? "";
}

function NewTripFields({ f, set }: { f: Form; set: <K extends keyof Form>(k: K, v: Form[K]) => void }) {
  const pseudo = { settings: { home_currency: f.home }, currencies: [] } as unknown as Trip;
  const addPeople = (more: Companion[]) => {
    const next = [...f.people];
    for (const c of more) {
      if (!next.some((x) => x.name.toLowerCase() === c.name.toLowerCase() || (c.user_id && x.user_id === c.user_id))) next.push(c);
    }
    set("people", next.slice(0, 19));
    set("who", "");
  };
  return (
    <div className="flex flex-col gap-4">
      <Field label="Where are you going?">
        <div className="flex gap-2">
          <TextInput
            autoFocus
            placeholder="Tokyo"
            value={f.where}
            onChange={(e) => set("where", e.target.value)}
            onBlur={() => {
              const z = zoneForCity(f.where);
              if (z && !f.tz) set("tz", z);
            }}
          />
          <TextInput placeholder="Country" value={f.country} onChange={(e) => set("country", e.target.value)} />
        </div>
      </Field>
      <Field label="Trip name" hint="Blank uses the place">
        <TextInput placeholder={f.where.trim() ? `${f.where.trim()} ${f.start.slice(0, 4) || ""}`.trim() : "Japan 2027"} value={f.title} onChange={(e) => set("title", e.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Trip emoji">
        {EMOJIS.map((e) => (
          <button
            key={e}
            type="button"
            aria-label={`Emoji ${e}`}
            aria-pressed={f.emoji === e}
            onClick={() => set("emoji", e)}
            className={cn("flex h-11 w-11 items-center justify-center rounded-xl text-xl", f.emoji === e ? "bg-[var(--hover-strong)] ring-2 ring-[var(--item-accent)]" : "hover:bg-[var(--hover)]")}
          >
            {e}
          </button>
        ))}
      </div>
      <FieldRow>
        <Field label="Leaving">
          <TextInput type="date" value={f.start} onChange={(e) => set("start", e.target.value)} />
        </Field>
        <Field label="Home again">
          <TextInput type="date" value={f.end} min={f.start || undefined} onChange={(e) => set("end", e.target.value)} />
        </Field>
      </FieldRow>
      <Field label="Its time zone" hint={`So bookings show the right local times. You're in ${fallbackZone()}.`}>
        <ZoneInput value={f.tz} onChange={(v) => set("tz", v)} />
      </Field>
      <Field label="Who else is coming?" hint="Pick from your contacts, or type a name and press Enter">
        <div className="flex flex-col gap-2">
          {f.people.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {f.people.map((c, i) => (
                <span key={`${c.name}-${i}`} className="inline-flex h-8 items-center gap-1 rounded-full border border-[var(--border)] pl-3 pr-1 text-xs font-medium text-[var(--text)]">
                  {c.name}
                  <button
                    type="button"
                    aria-label={`Remove ${c.name}`}
                    onClick={() => set("people", f.people.filter((_, n) => n !== i))}
                    className="flex h-6 w-6 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)]"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <PersonInput
            placeholder={f.people.length ? "Anyone else?" : "Sam, Kai"}
            aria-label="Who else is coming?"
            value={f.who}
            excludeUserIds={f.people.map((c) => c.user_id).filter(Boolean)}
            excludeNames={f.people.map((c) => c.name)}
            onChange={(v) => {
              if (/[,\n]$/.test(v)) addPeople(typedPeople(v));
              else set("who", v);
            }}
            onPick={(p) => addPeople([{ name: p.name.slice(0, 60), user_id: p.user_id, contact_id: p.contact_id }])}
            onEnter={() => addPeople(typedPeople(f.who))}
          />
        </div>
      </Field>
      <div className="flex min-h-[44px] items-center justify-between gap-3">
        <span className="text-sm text-[var(--text)]">I'm going too</span>
        <Toggle checked={f.mine} onChange={(v) => set("mine", v)} label="I'm going too" />
      </div>
      <Field label="Home currency" hint="Budgets and settle-up for this trip">
        <CurrencySelect trip={pseudo} value={f.home} onChange={(v) => set("home", v)} />
      </Field>
    </div>
  );
}

function useForm(file: TripFile) {
  const [f, setF] = useState<Form>(() => empty(fileSettings(file).home_currency));
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  return { f, set, reset: () => setF(empty(fileSettings(file).home_currency)) };
}

/** "New trip" as a bottom sheet. */
export function NewTripSheet({ file, open, onClose, ask }: { file: ItemHandle<TripFile>; open: boolean; onClose: () => void; ask: (p: string) => void }) {
  const { f, set, reset } = useForm(file.data);
  const user = useAuthStore((s) => s.user);
  useEffect(() => {
    if (open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const full = (file.data.trips?.length ?? 0) >= MAX_TRIPS;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New trip"
      footer={
        <>
          <ItemButton
            variant="ghost"
            className="shrink-0 whitespace-nowrap"
            icon={<Sparkles className="h-4 w-4" />}
            onClick={() => {
              onClose();
              ask("Start a new trip: ask me where, when and who's coming, then create it.");
            }}
          >
            Ask AI
          </ItemButton>
          <ItemButton
            variant="primary"
            block
            disabled={full || !(f.where.trim() || f.title.trim())}
            onClick={() => {
              addTrip(file, buildTrip(f, file.data, user));
              onClose();
            }}
          >
            Create trip
          </ItemButton>
        </>
      }
    >
      {full ? <p className="text-sm text-[var(--warning)]">This file holds {MAX_TRIPS} trips — archive past trips first.</p> : <NewTripFields f={f} set={set} />}
    </Sheet>
  );
}

/** The first run (no trips yet): plan the first trip, or hand it to the assistant. */
export function OnboardingView({ item, ask }: { item: ItemHandle<TripFile>; ask: (p: string) => void }) {
  const { f, set } = useForm(item.data);
  const user = useAuthStore((s) => s.user);
  const skip = () =>
    item.update((x) => {
      x.settings.onboarded = true;
    });
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-5 px-4 py-8">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="text-5xl" aria-hidden>
          {f.emoji}
        </span>
        <h1 className="text-xl font-semibold text-[var(--text)]">Plan your first trip</h1>
        <p className="text-sm text-[var(--text-muted)]">All your trips live here — add more any time. Everything can be changed later.</p>
      </div>
      <NewTripFields f={f} set={set} />
      <ItemButton variant="primary" size="lg" block disabled={!(f.where.trim() || f.title.trim())} onClick={() => addTrip(item, buildTrip(f, item.data, user))}>
        Start planning
      </ItemButton>
      <div className="flex justify-center gap-2">
        <ItemButton
          variant="ghost"
          onClick={() => {
            skip();
            ask("Help me start a trip: ask me where, when and who's coming, then create it.");
          }}
        >
          Set it up with the assistant
        </ItemButton>
        <ItemButton variant="ghost" onClick={skip}>
          Skip
        </ItemButton>
      </div>
    </div>
  );
}
