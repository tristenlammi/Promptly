import { CalendarClock, ExternalLink, FileText, Phone, Plane, Plus, Sparkles, Stamp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { TWO_COL, useTripWidth } from "./layout";
import type { ItemViewProps } from "@/items/types";
import { Card, Chip, EmptyState, Fab, ItemButton, Page, ScrollRow, Section, Segmented, Sheet, safeHref } from "@/items/ui";
import { cn } from "@/utils/cn";

import { BookingSheet, blankBooking } from "./BookingSheet";
import { takeBooking } from "./bus";
import { DocumentsView } from "./Documents";
import { bookingLabel, bookingMinutes, isJourney, mapsUrl, money, toHome } from "./logic";
import { assignChanged } from "./ops";
import type { Booking, BookingType, Trip } from "./types";
import { BOOKING_LABEL } from "./types";
import { dayDiff, fmtDate, fmtHM, fmtMinutes, timeOf, toInstant, zoneAbbr, zoneCity } from "./tz";
import { Attachments, CopyCode, Meta, TypeBadge, tint, useIssues } from "./ui";

type Filter = "all" | "flight" | "stay" | "transport" | "activity" | "other";
const FILTERS: { id: Filter; label: string; types: BookingType[] }[] = [
  { id: "all", label: "All", types: [] },
  { id: "flight", label: "Flights", types: ["flight"] },
  { id: "stay", label: "Stays", types: ["stay"] },
  { id: "transport", label: "Ground", types: ["car", "train", "bus", "ferry"] },
  { id: "activity", label: "Tours & tickets", types: ["tour", "ticket"] },
  { id: "other", label: "Other", types: ["insurance", "other"] },
];

/* ------------------------------------------------------------ cards */

function FlightFace({ b }: { b: Booking }) {
  const mins = bookingMinutes(b);
  const plus = b.start && b.end ? dayDiff(b.start.slice(0, 10), b.end.slice(0, 10)) : 0;
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
      <div className="min-w-0">
        <p className="text-2xl font-semibold tracking-tight tabular-nums text-[var(--text)]">{b.from_code || "—"}</p>
        <p className="text-sm font-semibold tabular-nums text-[var(--text)]">
          {fmtHM(timeOf(b.start))} <span className="text-xs font-medium text-[var(--text-muted)]">{zoneAbbr(b.start, b.start_tz)}</span>
        </p>
        <p className="truncate text-xs text-[var(--text-muted)]">{b.from_place || zoneCity(b.start_tz)}</p>
      </div>
      <div className="flex flex-col items-center gap-0.5 px-1 text-[var(--text-muted)]">
        <span className="text-xs font-medium tabular-nums">{fmtMinutes(mins)}</span>
        <span className="flex items-center gap-1">
          <span className="h-px w-6 bg-[var(--border)] sm:w-10" />
          <Plane className="h-4 w-4 text-[var(--item-accent)]" />
          <span className="h-px w-6 bg-[var(--border)] sm:w-10" />
        </span>
        {b.cabin && <span className="text-[11px]">{b.cabin}</span>}
      </div>
      <div className="min-w-0 text-right">
        <p className="text-2xl font-semibold tracking-tight tabular-nums text-[var(--text)]">{b.to_code || "—"}</p>
        <p className="text-sm font-semibold tabular-nums text-[var(--text)]">
          {fmtHM(timeOf(b.end))} <span className="text-xs font-medium text-[var(--text-muted)]">{zoneAbbr(b.end, b.end_tz)}</span>
          {plus > 0 && <sup className="ml-0.5 text-[10px] font-bold text-[var(--item-accent)]">+{plus}</sup>}
          {plus < 0 && <sup className="ml-0.5 text-[10px] font-bold text-[var(--item-accent)]">{plus}</sup>}
        </p>
        <p className="truncate text-xs text-[var(--text-muted)]">{b.to_place || zoneCity(b.end_tz)}</p>
      </div>
    </div>
  );
}

function when(local: string | null, tz: string, showZone = true): string {
  if (!local) return "";
  const z = showZone ? zoneAbbr(local, tz) : "";
  return `${fmtDate(local.slice(0, 10))}, ${fmtHM(timeOf(local))}${z ? ` ${z}` : ""}`;
}

function BookingCard({ trip, b, selected, onClick }: { trip: Trip; b: Booking; selected?: boolean; onClick: () => void }) {
  const cancelled = b.status === "cancelled";
  const nights = b.type === "stay" && b.start && b.end ? dayDiff(b.start.slice(0, 10), b.end.slice(0, 10)) : 0;
  return (
    <Card
      onClick={onClick}
      className={cn("flex flex-col gap-3", selected && "border-[var(--item-accent)] ring-1 ring-[var(--item-accent)]", cancelled && "opacity-60")}
    >
      <div className="flex items-center gap-3">
        <TypeBadge type={b.type} />
        <div className="min-w-0 flex-1">
          <p className={cn("truncate text-sm font-semibold text-[var(--text)]", cancelled && "line-through")}>{bookingLabel(b)}</p>
          <p className="truncate text-xs text-[var(--text-muted)]">
            {BOOKING_LABEL[b.type]}
            {b.status !== "confirmed" ? ` · ${b.status === "pending" ? "Pending" : "Cancelled"}` : ""}
            {b.type === "stay" && nights > 0 ? ` · ${nights} night${nights === 1 ? "" : "s"}` : ""}
            {!b.paid ? " · Not paid yet" : ""}
          </p>
        </div>
        {b.cost_minor ? <span className="text-sm font-medium tabular-nums text-[var(--text)]">{money(b.cost_minor, b.currency || trip.settings.home_currency, { compact: true })}</span> : null}
      </div>
      {b.type === "flight" ? (
        <FlightFace b={b} />
      ) : isJourney(b.type) ? (
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-sm">
          <div className="min-w-0">
            <p className="font-semibold tabular-nums text-[var(--text)]">{fmtHM(timeOf(b.start))}</p>
            <p className="truncate text-xs text-[var(--text-muted)]">{b.from_place}</p>
          </div>
          <span className="text-xs tabular-nums text-[var(--text-muted)]">{fmtMinutes(bookingMinutes(b))}</span>
          <div className="min-w-0 text-right">
            <p className="font-semibold tabular-nums text-[var(--text)]">{fmtHM(timeOf(b.end))}</p>
            <p className="truncate text-xs text-[var(--text-muted)]">{b.to_place}</p>
          </div>
        </div>
      ) : (
        (b.start || b.end) && (
          <div className="grid grid-cols-2 gap-3">
            <Meta label={b.type === "stay" ? "Check-in" : b.type === "car" ? "Pick-up" : "From"}>{when(b.start, b.start_tz, b.type === "car")}</Meta>
            <Meta label={b.type === "stay" ? "Check-out" : b.type === "car" ? "Drop-off" : "To"}>{when(b.end, b.end_tz || b.start_tz, b.type === "car")}</Meta>
          </div>
        )
      )}
      {(b.confirmation || b.seat || b.terminal_from) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {b.confirmation && <CopyCode code={b.confirmation} />}
          {b.terminal_from && <span className="text-xs text-[var(--text-muted)]">Terminal <b className="text-[var(--text)]">{b.terminal_from}</b></span>}
          {b.seat && <span className="text-xs text-[var(--text-muted)]">Seat <b className="text-[var(--text)]">{b.seat}</b></span>}
        </div>
      )}
    </Card>
  );
}

function BookingDetail({ trip, b, canEdit, onEdit, ask }: { trip: Trip; b: Booking; canEdit: boolean; onEdit: () => void; ask: (p: string) => void }) {
  const maps = mapsUrl({ lat: b.lat, lng: b.lng, place: b.type === "stay" ? b.title : b.to_place || b.title, address: b.address });
  const who = b.traveller_ids.length ? trip.travellers.filter((t) => b.traveller_ids.includes(t.id)).map((t) => t.name).join(", ") : trip.travellers.length > 1 ? "Everyone" : "";
  const home = trip.settings.home_currency;
  const inHome = b.cost_minor && b.currency && b.currency !== home ? toHome(trip, b.cost_minor, b.currency) : null;
  const link = safeHref(b.link);
  return (
    <div className="flex flex-col gap-4">
      <BookingCard trip={trip} b={b} onClick={onEdit} />
      <Card className="grid grid-cols-2 gap-3">
        <Meta label="Provider">{b.provider}</Meta>
        <Meta label="Number">{b.number}</Meta>
        {isJourney(b.type) && <Meta label="Departs">{when(b.start, b.start_tz)}</Meta>}
        {isJourney(b.type) && <Meta label="Arrives">{when(b.end, b.end_tz)}</Meta>}
        <Meta label="Terminals">{[b.terminal_from, b.terminal_to].filter(Boolean).join(" → ")}</Meta>
        <Meta label="Cabin">{b.cabin}</Meta>
        <Meta label="Travellers">{who}</Meta>
        <Meta label="Cost">
          {b.cost_minor ? `${money(b.cost_minor, b.currency || home)}${inHome !== null ? ` (≈ ${money(inHome, home)})` : ""}${b.paid ? "" : " · due"}` : ""}
        </Meta>
      </Card>
      {b.address && (
        <Card className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-sm text-[var(--text)]">{b.address}</p>
          {maps && (
            <a href={maps} target="_blank" rel="noreferrer" className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-[var(--item-accent)] hover:bg-[var(--hover)]">
              <ExternalLink className="h-4 w-4" /> Map
            </a>
          )}
        </Card>
      )}
      {(b.phone || link) && (
        <div className="flex flex-wrap gap-2">
          {b.phone && (
            <a href={`tel:${b.phone.replace(/[^\d+]/g, "")}`} className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 text-sm text-[var(--text)] hover:bg-[var(--hover)]">
              <Phone className="h-4 w-4" /> {b.phone}
            </a>
          )}
          {link && (
            <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 text-sm text-[var(--text)] hover:bg-[var(--hover)]">
              <ExternalLink className="h-4 w-4" /> Manage booking
            </a>
          )}
        </div>
      )}
      {b.notes && <p className="whitespace-pre-wrap rounded-2xl bg-[var(--surface-2)] p-3 text-sm text-[var(--text)]">{b.notes}</p>}
      <Attachments files={b.attachments} />
      <div className="flex flex-wrap gap-2">
        {canEdit && <ItemButton onClick={onEdit}>Edit</ItemButton>}
        {b.type === "flight" && (
          <ItemButton variant="ghost" icon={<Sparkles className="h-4 w-4" />} onClick={() => ask(`For ${bookingLabel(b)}: when should we leave for the airport, how do we get there, and what are the baggage/check-in rules? Check the airline's site.`)}>
            Airport plan
          </ItemButton>
        )}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- tab */

export function BookingsTab({ item, isPhone, ask }: ItemViewProps<Trip>) {
  const t = item.data;
  const width = useTripWidth();
  const narrow = isPhone || width < TWO_COL;
  const [mode, setMode] = useState<"bookings" | "documents">("bookings");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Booking | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const issues = useIssues(item);
  const docIssues = issues.filter((i) => i.document_id || i.kind === "no_passports").length;

  useEffect(() => {
    const id = takeBooking();
    if (id) {
      setMode("bookings");
      setSelected(id);
      if (narrow) setDetail(id);
      window.setTimeout(() => document.getElementById(`trip-booking-${id}`)?.scrollIntoView({ block: "center" }), 60);
    }
  }, [narrow]);

  const groups = useMemo(() => {
    const types = FILTERS.find((f) => f.id === filter)!.types;
    const list = t.bookings.filter((b) => !types.length || types.includes(b.type));
    const sorted = [...list].sort((a, b) => (a.start ?? "9999").localeCompare(b.start ?? "9999"));
    const m = new Map<string, Booking[]>();
    for (const b of sorted) {
      const k = b.start?.slice(0, 10) ?? "";
      m.set(k, [...(m.get(k) ?? []), b]);
    }
    return [...m.entries()];
  }, [t.bookings, filter]);

  const totals = useMemo(() => {
    let sum = 0;
    for (const b of t.bookings) if (b.status !== "cancelled" && b.cost_minor) sum += toHome(t, b.cost_minor, b.currency) ?? 0;
    return sum;
  }, [t]);

  const save = (b: Booking) => {
    const before = editing && t.bookings.some((x) => x.id === editing.id) ? editing : null;
    item.update((d) => {
      const cur = d.bookings.find((x) => x.id === b.id);
      // Only the fields changed in the sheet: a companion's edit meanwhile stays.
      if (cur && before) assignChanged(cur, before, b);
      else if (!cur && !before && d.bookings.length < 300) d.bookings.push(b);
      d.bookings.sort((x, y) => (x.start ?? "9999").localeCompare(y.start ?? "9999"));
    });
    setEditing(null);
    setSelected(b.id);
  };
  const remove = (id: string) => {
    item.update((d) => {
      d.bookings = d.bookings.filter((x) => x.id !== id);
      for (const day of d.days) for (const it of day.items) if (it.booking_id === id) it.booking_id = null;
      for (const e of d.expenses) if (e.booking_id === id) e.booking_id = null;
    });
    setEditing(null);
    setSelected(null);
    setDetail(null);
  };

  // Desktop shows the next booking until one is picked (TripIt opens on what's next).
  const upcoming = useMemo(() => {
    const now = Date.now();
    const live = t.bookings.filter((b) => b.status !== "cancelled");
    return live.find((b) => (toInstant(b.end ?? b.start, b.end ? b.end_tz || b.start_tz : b.start_tz) ?? 0) >= now) ?? live[0] ?? null;
  }, [t.bookings]);
  const sel = t.bookings.find((b) => b.id === selected) ?? (narrow ? null : upcoming);
  const detailBooking = t.bookings.find((b) => b.id === detail) ?? null;

  const header = (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "bookings", label: `Bookings${t.bookings.length ? ` · ${t.bookings.length}` : ""}` },
            { value: "documents", label: <span className="inline-flex items-center gap-1.5">Documents{docIssues ? <span className="h-2 w-2 rounded-full bg-[var(--warning)]" /> : null}</span> },
          ]}
        />
        {!isPhone && item.canEdit && mode === "bookings" && (
          <div className="flex gap-2">
            <ItemButton variant="ghost" icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Find my booking confirmations (PDFs, emails saved as documents) in my files and add every flight, stay and ticket to this trip, with the files attached.")}>
              Import from my files
            </ItemButton>
            <ItemButton variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing(blankBooking())}>
              Add booking
            </ItemButton>
          </div>
        )}
      </div>
      {mode === "bookings" && t.bookings.length > 0 && (
        <ScrollRow>
          {FILTERS.map((f) => (
            <Chip key={f.id} active={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </Chip>
          ))}
        </ScrollRow>
      )}
    </div>
  );

  const list =
    t.bookings.length === 0 ? (
      <EmptyState
        icon={CalendarClock}
        title="No bookings yet"
        text="Add flights, stays, trains, car hire and tickets — with their real local times — or let the assistant read your confirmation PDFs."
        action={
          item.canEdit && (
            <div className="flex flex-wrap justify-center gap-2">
              <ItemButton variant="primary" icon={<FileText className="h-4 w-4" />} onClick={() => ask("Find my booking confirmations in my files and add every flight, stay and ticket to this trip, with the files attached.")}>
                Import from my files
              </ItemButton>
              <ItemButton onClick={() => setEditing(blankBooking())}>Add one</ItemButton>
            </div>
          )
        }
      />
    ) : (
      <div className="flex flex-col gap-5">
        {groups.map(([day, list]) => (
          <Section key={day || "undated"} title={day ? fmtDate(day, true) : "No date yet"}>
            <div className="flex flex-col gap-2">
              {list.map((b) => (
                <div key={b.id} id={`trip-booking-${b.id}`}>
                  <BookingCard
                    trip={t}
                    b={b}
                    selected={!narrow && b.id === sel?.id}
                    onClick={() => (narrow ? setDetail(b.id) : setSelected(b.id))}
                  />
                </div>
              ))}
            </div>
          </Section>
        ))}
        {totals > 0 && (
          <p className="px-1 text-sm text-[var(--text-muted)]">
            Booked so far: <span className="font-semibold tabular-nums text-[var(--text)]">{money(totals, t.settings.home_currency)}</span>
          </p>
        )}
      </div>
    );

  return (
    <Page wide={!narrow}>
      {header}
      {mode === "documents" ? (
        <DocumentsView item={item} ask={ask} issues={issues} isPhone={isPhone} />
      ) : narrow ? (
        list
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(300px,380px)] gap-6">
          <div className="min-w-0">{list}</div>
          <aside className="sticky top-4 self-start">
            {sel ? (
              <BookingDetail trip={t} b={sel} canEdit={item.canEdit} onEdit={() => setEditing(sel)} ask={ask} />
            ) : (
              t.bookings.length > 0 && (
                <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--text-muted)]">
                  <Stamp className="h-6 w-6" style={{ color: tint("flight") }} />
                  Pick a booking to see its details.
                </div>
              )
            )}
          </aside>
        </div>
      )}
      {isPhone && item.canEdit && mode === "bookings" && <Fab label="Booking" icon={Plus} onClick={() => setEditing(blankBooking())} />}

      <Sheet open={!!detailBooking} onClose={() => setDetail(null)} title={detailBooking ? BOOKING_LABEL[detailBooking.type] : ""}>
        {detailBooking && (
          <BookingDetail
            trip={t}
            b={detailBooking}
            canEdit={item.canEdit}
            onEdit={() => {
              setDetail(null);
              setEditing(detailBooking);
            }}
            ask={(p) => {
              setDetail(null);
              ask(p);
            }}
          />
        )}
      </Sheet>
      <BookingSheet
        open={!!editing && item.canEdit}
        onClose={() => setEditing(null)}
        trip={t}
        initial={editing ?? blankBooking()}
        onSave={save}
        onDelete={editing && t.bookings.some((b) => b.id === editing.id) ? () => remove(editing.id) : undefined}
      />
    </Page>
  );
}

