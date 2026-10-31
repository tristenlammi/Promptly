import { Paperclip, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Chip, Field, ItemButton, Segmented, Sheet, TextArea, TextInput, Toggle, uid } from "@/items/ui";

import { airport } from "./airports";
import { bookingMinutes, dayZone, isJourney, toMajor, toMinor } from "./logic";
import { homeHint } from "./PlanItemSheet";
import type { Booking, BookingStatus, BookingType, Trip } from "./types";
import { BOOKING_LABEL, BOOKING_TYPES } from "./types";
import { fallbackZone, fmtMinutes, inGap, validZone, zoneAbbr } from "./tz";
import { Attachments, ConfirmDelete, CurrencySelect, DrivePicker, FieldRow, linkProblem, parseAmount, TravellerChips, TYPE_ICON, ZoneInput } from "./ui";

export function blankBooking(type: BookingType = "flight"): Booking {
  return {
    id: uid("b-"), type, title: "", status: "confirmed", start: null, start_tz: "", end: null, end_tz: "", provider: "", number: "",
    from_code: "", to_code: "", from_place: "", to_place: "", terminal_from: "", terminal_to: "", seat: "", cabin: "", address: "",
    lat: null, lng: null, confirmation: "", cost_minor: null, currency: null, paid: true, traveller_ids: [], attachments: [], link: "",
    phone: "", notes: "",
  };
}

const WORDS: Record<BookingType, { start: string; end: string; provider: string; title?: string; from?: string; to?: string }> = {
  flight: { start: "Departs (local)", end: "Arrives (local)", provider: "Airline" },
  stay: { start: "Check-in", end: "Check-out", provider: "Booked via", title: "Hotel / place name" },
  car: { start: "Pick-up", end: "Drop-off", provider: "Rental company", from: "Pick-up location", to: "Drop-off location" },
  train: { start: "Departs (local)", end: "Arrives (local)", provider: "Operator", from: "From station", to: "To station" },
  bus: { start: "Departs (local)", end: "Arrives (local)", provider: "Operator", from: "From", to: "To" },
  ferry: { start: "Departs (local)", end: "Arrives (local)", provider: "Operator", from: "From port", to: "To port" },
  tour: { start: "Starts", end: "Ends", provider: "Operator", title: "Tour name" },
  ticket: { start: "Starts", end: "Ends", provider: "Venue / seller", title: "Event / attraction" },
  insurance: { start: "Cover from", end: "Cover to", provider: "Insurer", title: "Policy name" },
  other: { start: "Starts", end: "Ends", provider: "Provider", title: "What" },
};

export function BookingSheet({
  open,
  onClose,
  trip,
  initial,
  onSave,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  trip: Trip;
  initial: Booking;
  onSave: (b: Booking) => void;
  onDelete?: () => void;
}) {
  const [b, setB] = useState<Booking>(initial);
  const [cost, setCost] = useState("");
  const [cur, setCur] = useState(trip.settings.home_currency);
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    if (!open) return;
    setB(structuredClone(initial));
    const c = initial.currency || trip.settings.home_currency;
    setCur(c);
    setCost(initial.cost_minor !== null ? String(toMajor(initial.cost_minor, c)) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = <K extends keyof Booking>(k: K, v: Booking[K]) => setB((x) => ({ ...x, [k]: v }));
  const w = WORDS[b.type];
  const journey = isJourney(b.type);
  const isNew = !trip.bookings.some((x) => x.id === b.id);

  const setCode = (edge: "from" | "to", raw: string) => {
    const code = raw.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
    setB((x) => {
      const ap = airport(code);
      const tzKey = edge === "from" ? "start_tz" : "end_tz";
      const placeKey = edge === "from" ? "from_place" : "to_place";
      const prevAp = airport(edge === "from" ? x.from_code : x.to_code);
      return {
        ...x,
        [edge === "from" ? "from_code" : "to_code"]: code,
        ...(ap ? { [tzKey]: ap[2], [placeKey]: !x[placeKey] || x[placeKey] === prevAp?.[0] ? ap[0] : x[placeKey], ...(edge === "to" ? { lat: ap[3], lng: ap[4] } : {}) } : {}),
      };
    });
  };

  const defaultZone = () => (b.start ? dayZone(trip, b.start.slice(0, 10)) : "") || trip.destinations.find((d) => d.tz)?.tz || fallbackZone();

  const mins = useMemo(() => bookingMinutes(b), [b]);
  const warnings: string[] = [];
  if (b.start && b.end && mins !== null && mins < 0) warnings.push("It ends before it starts — check the dates and time zones.");
  if (b.type === "flight" && mins !== null && mins > 21 * 60) warnings.push("That's longer than any non-stop flight — check the time zones.");
  if (b.start && b.start_tz && validZone(b.start_tz) && inGap(b.start, b.start_tz)) warnings.push(`${b.start.slice(11)} doesn't exist that day in ${b.start_tz} (clocks change).`);
  const badZone = [b.start_tz, b.end_tz].some((z) => z && !validZone(z));
  const amount = parseAmount(cost);

  const save = () => {
    const out: Booking = {
      ...b,
      start_tz: validZone(b.start_tz) ? b.start_tz : "",
      end_tz: validZone(b.end_tz) ? b.end_tz : "",
      cost_minor: amount === null ? null : toMinor(amount, cur),
      // No currency = the home currency; keep it that way unless one was picked.
      currency: amount === null ? null : cur === trip.settings.home_currency && !initial.currency ? null : cur,
      link: b.link.trim(),
    };
    if (!journey && b.type !== "car") out.end_tz = out.end_tz || out.start_tz;
    if (!out.start_tz && out.start && b.type !== "flight") out.start_tz = defaultZone();
    if (out.type === "stay" && !out.end_tz) out.end_tz = out.start_tz;
    onSave(out);
  };

  const label = [b.title, b.provider, b.number, b.from_code].some(Boolean);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="lg"
      title={isNew ? "Add booking" : BOOKING_LABEL[b.type]}
      footer={
        <>
          {onDelete && <ConfirmDelete question="Delete this booking?" onConfirm={onDelete} />}
          <ItemButton variant="primary" block disabled={!label || badZone || !!linkProblem(b.link)} onClick={save}>
            Save
          </ItemButton>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Type">
          {BOOKING_TYPES.map((x) => {
            const Icon = TYPE_ICON[x];
            return (
              <Chip key={x} active={b.type === x} onClick={() => set("type", x)} icon={<Icon className="h-3.5 w-3.5" />}>
                {BOOKING_LABEL[x]}
              </Chip>
            );
          })}
        </div>

        {w.title && (
          <Field label={w.title}>
            <TextInput autoFocus={isNew} value={b.title} onChange={(e) => set("title", e.target.value)} />
          </Field>
        )}
        <FieldRow>
          <Field label={w.provider}>
            <TextInput value={b.provider} onChange={(e) => set("provider", e.target.value)} placeholder={b.type === "flight" ? "Qantas" : ""} />
          </Field>
          {(journey || b.type === "flight") && (
            <Field label={b.type === "flight" ? "Flight number" : "Number"}>
              <TextInput value={b.number} onChange={(e) => set("number", e.target.value.toUpperCase())} placeholder={b.type === "flight" ? "QF25" : ""} />
            </Field>
          )}
          {!journey && (
            <Field label="Status">
              <StatusPicker value={b.status} onChange={(v) => set("status", v)} />
            </Field>
          )}
        </FieldRow>

        {b.type === "flight" && (
          <FieldRow>
            <Field label="From (airport code)" hint={airport(b.from_code)?.[0]}>
              <TextInput value={b.from_code} onChange={(e) => setCode("from", e.target.value)} placeholder="SYD" autoCapitalize="characters" />
            </Field>
            <Field label="To (airport code)" hint={airport(b.to_code)?.[0]}>
              <TextInput value={b.to_code} onChange={(e) => setCode("to", e.target.value)} placeholder="HND" autoCapitalize="characters" />
            </Field>
          </FieldRow>
        )}
        {(w.from || (journey && b.type !== "flight")) && (
          <FieldRow>
            <Field label={w.from ?? "From"}>
              <TextInput value={b.from_place} onChange={(e) => set("from_place", e.target.value)} />
            </Field>
            <Field label={w.to ?? "To"}>
              <TextInput value={b.to_place} onChange={(e) => set("to_place", e.target.value)} />
            </Field>
          </FieldRow>
        )}

        <WhenField label={w.start} local={b.start} tz={b.start_tz} onLocal={(v) => set("start", v)} onTz={(v) => set("start_tz", v)} dateOnly={b.type === "insurance"} showTz={b.type !== "insurance"} />
        <WhenField
          label={w.end}
          local={b.end}
          tz={journey || b.type === "car" ? b.end_tz : b.end_tz || b.start_tz}
          onLocal={(v) => set("end", v)}
          onTz={(v) => set("end_tz", v)}
          dateOnly={b.type === "insurance"}
          showTz={journey || b.type === "car"}
          min={b.start?.slice(0, 10)}
        />
        {journey && mins !== null && mins >= 0 && (
          <p className="-mt-2 text-sm text-[var(--text-muted)]">
            Takes <span className="font-semibold tabular-nums text-[var(--text)]">{fmtMinutes(mins)}</span> (time zones included)
          </p>
        )}
        {warnings.map((x) => (
          <p key={x} className="-mt-2 flex items-start gap-1.5 text-sm text-[var(--warning)]">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {x}
          </p>
        ))}

        {b.type === "flight" && (
          <FieldRow className="grid-cols-2 sm:grid-cols-4">
            <Field label="Terminal (dep)">
              <TextInput value={b.terminal_from} onChange={(e) => set("terminal_from", e.target.value)} />
            </Field>
            <Field label="Terminal (arr)">
              <TextInput value={b.terminal_to} onChange={(e) => set("terminal_to", e.target.value)} />
            </Field>
            <Field label="Seat">
              <TextInput value={b.seat} onChange={(e) => set("seat", e.target.value)} placeholder="34A" />
            </Field>
            <Field label="Cabin">
              <TextInput value={b.cabin} onChange={(e) => set("cabin", e.target.value)} placeholder="Economy" />
            </Field>
          </FieldRow>
        )}
        {(journey && b.type !== "flight") && (
          <Field label="Seat / carriage">
            <TextInput value={b.seat} onChange={(e) => set("seat", e.target.value)} />
          </Field>
        )}
        {(b.type === "stay" || b.type === "tour" || b.type === "ticket" || b.type === "other" || b.type === "car") && (
          <Field label="Address">
            <TextInput value={b.address} onChange={(e) => set("address", e.target.value)} />
          </Field>
        )}
        {journey && (
          <Field label="Status">
            <StatusPicker value={b.status} onChange={(v) => set("status", v)} />
          </Field>
        )}

        <Field label={b.type === "insurance" ? "Policy number" : "Booking reference"}>
          <TextInput value={b.confirmation} onChange={(e) => set("confirmation", e.target.value)} className="font-mono uppercase" />
        </Field>
        <FieldRow className="grid-cols-[1fr_7rem]">
          <Field label="Cost" hint={homeHint(trip, amount, cur)}>
            <TextInput inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0" />
          </Field>
          <Field label="Currency">
            <CurrencySelect trip={trip} value={cur} onChange={setCur} />
          </Field>
        </FieldRow>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-[var(--text)]">Paid already</span>
          <Toggle checked={b.paid} onChange={(v) => set("paid", v)} label="Paid already" />
        </div>
        {trip.travellers.length > 1 && (
          <Field label="Who it's for">
            <TravellerChips trip={trip} value={b.traveller_ids} onChange={(v) => set("traveller_ids", v)} />
          </Field>
        )}
        <FieldRow>
          <Field label="Phone">
            <TextInput type="tel" value={b.phone} onChange={(e) => set("phone", e.target.value)} />
          </Field>
          <Field label="Link" hint={linkProblem(b.link) ?? undefined}>
            <TextInput type="url" value={b.link} onChange={(e) => set("link", e.target.value)} placeholder="https://" />
          </Field>
        </FieldRow>
        <Field label="Notes">
          <TextArea value={b.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Baggage, breakfast included, pick-up instructions…" />
        </Field>
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-[var(--text-muted)]">Tickets & confirmations</span>
          <Attachments files={b.attachments} onRemove={(id) => set("attachments", b.attachments.filter((a) => a.file_id !== id))} />
          <ItemButton size="sm" className="self-start" icon={<Paperclip className="h-4 w-4" />} disabled={b.attachments.length >= 20} onClick={() => setPicking(true)}>
            Attach from Files
          </ItemButton>
        </div>
      </div>
      <DrivePicker
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(a) => set("attachments", b.attachments.some((x) => x.file_id === a.file_id) ? b.attachments : [...b.attachments, a])}
      />
    </Sheet>
  );
}

function StatusPicker({ value, onChange }: { value: BookingStatus; onChange: (v: BookingStatus) => void }) {
  return (
    <Segmented<BookingStatus>
      size="sm"
      value={value}
      onChange={onChange}
      options={[
        { value: "confirmed", label: "Confirmed" },
        { value: "pending", label: "Pending" },
        { value: "cancelled", label: "Cancelled" },
      ]}
    />
  );
}

function WhenField({
  label,
  local,
  tz,
  onLocal,
  onTz,
  dateOnly,
  showTz,
  min,
}: {
  label: string;
  local: string | null;
  tz: string;
  onLocal: (v: string | null) => void;
  onTz: (v: string) => void;
  dateOnly?: boolean;
  showTz?: boolean;
  min?: string;
}) {
  const abbr = local && tz && validZone(tz) ? zoneAbbr(local, tz) : "";
  return (
    <Field label={label} hint={showTz ? (tz && !validZone(tz) ? "Unknown time zone — pick one from the list" : abbr ? `${tz} · ${abbr}` : "Time zone of that place") : undefined}>
      <div className={showTz ? "grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr]" : ""}>
        {dateOnly ? (
          <TextInput type="date" value={local?.slice(0, 10) ?? ""} min={min} onChange={(e) => onLocal(e.target.value ? `${e.target.value}T00:00` : null)} />
        ) : (
          <TextInput type="datetime-local" value={local ?? ""} min={min ? `${min}T00:00` : undefined} onChange={(e) => onLocal(e.target.value ? e.target.value.slice(0, 16) : null)} />
        )}
        {showTz && <ZoneInput label={`${label} time zone`} value={tz} onChange={onTz} />}
      </div>
    </Field>
  );
}
