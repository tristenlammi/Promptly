import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import type { ItemHandle } from "@/items/useItem";
import { Field, ItemButton, Sheet, TextInput, Toggle, uid } from "@/items/ui";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";

import { blankDestination, COVER_COLORS } from "./TripSheet";
import { blankTrip, fileSettings, MAX_TRIPS, selectTrip } from "./trips";
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
  who: string;
  mine: boolean;
  home: string;
  emoji: string;
}

const empty = (home: string): Form => ({ title: "", where: "", country: "", tz: "", start: "", end: "", who: "", mine: true, home, emoji: "✈️" });

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
  if (f.mine || !f.who.trim()) {
    const me = { id: uid("t-"), name: user?.username?.trim().slice(0, 60) || "Me", is_me: true, user_id: user?.id ?? "", age_group: "adult" as const, passport_country: "" };
    t.travellers.push(me);
    if (user?.id) t.me_by_user[user.id] = me.id;
  }
  for (const n of f.who.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 19)) {
    if (!t.travellers.some((x) => x.name.toLowerCase() === n.toLowerCase()))
      t.travellers.push({ id: uid("t-"), name: n.slice(0, 60), is_me: false, user_id: "", age_group: "adult", passport_country: "" });
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
      <Field label="Who else is coming?" hint="Names, separated by commas">
        <TextInput placeholder="Sam, Kai" value={f.who} onChange={(e) => set("who", e.target.value)} />
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
