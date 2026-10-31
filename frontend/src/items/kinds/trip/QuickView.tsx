import { ExternalLink, MapPin, Phone, WifiOff } from "lucide-react";

import { ItemButton, Sheet, safeHref } from "@/items/ui";

import { bookingLabel, bookingMinutes, isJourney, mapsUrl } from "./logic";
import type { Booking, Trip } from "./types";
import { BOOKING_LABEL } from "./types";
import { fmtDate, fmtHM, fmtMinutes, timeOf, zoneAbbr } from "./tz";
import { Attachments, CopyCode, Meta, TypeBadge } from "./ui";

const EDGE: Record<Booking["type"], [string, string]> = {
  flight: ["Departs", "Arrives"],
  train: ["Departs", "Arrives"],
  bus: ["Departs", "Arrives"],
  ferry: ["Departs", "Arrives"],
  stay: ["Check-in", "Check-out"],
  car: ["Pick-up", "Drop-off"],
  tour: ["Starts", "Ends"],
  ticket: ["Starts", "Ends"],
  insurance: ["Cover from", "Cover to"],
  other: ["Starts", "Ends"],
};

function at(local: string | null, tz: string): string {
  if (!local) return "";
  const z = zoneAbbr(local, tz);
  return `${fmtDate(local.slice(0, 10))} · ${fmtHM(timeOf(local))}${z ? ` ${z}` : ""}`;
}

/** "Show booking" at the gate / front desk: the reference big enough to
 *  read out, the times, terminal and seat, and the attached ticket — all
 *  from the trip file, so it works offline (the attached Drive file itself
 *  needs a connection to open). */
export function BookingQuickView({ trip, booking, onClose, onOpenFull }: { trip: Trip; booking: Booking | null; onClose: () => void; onOpenFull?: () => void }) {
  const b = booking;
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const link = b ? safeHref(b.link) : undefined;
  const maps = b ? mapsUrl({ lat: b.lat, lng: b.lng, place: b.type === "stay" ? b.title : b.to_place || b.title, address: b.address }) : null;
  const [sw, ew] = b ? EDGE[b.type] : ["", ""];
  const mins = b && isJourney(b.type) ? bookingMinutes(b) : null;
  return (
    <Sheet open={!!b} onClose={onClose} title={b ? BOOKING_LABEL[b.type] : ""}>
      {b && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <TypeBadge type={b.type} size={44} />
            <div className="min-w-0">
              <p className="text-base font-semibold text-[var(--text)]">{bookingLabel(b)}</p>
              {b.status !== "confirmed" && <p className="text-xs font-semibold text-[var(--warning)]">{b.status === "pending" ? "Pending" : "Cancelled"}</p>}
            </div>
          </div>
          {b.confirmation ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface-2)] p-4 text-center">
              <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Booking reference</span>
              <span className="select-all font-mono text-3xl font-bold tracking-[0.2em] text-[var(--text)]">{b.confirmation}</span>
              <CopyCode code={b.confirmation} />
            </div>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">No booking reference saved for this one.</p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Meta label={sw}>{at(b.start, b.start_tz)}</Meta>
            <Meta label={ew}>{at(b.end, b.end_tz || b.start_tz)}</Meta>
            {isJourney(b.type) && <Meta label="From">{[b.from_code, b.from_place].filter(Boolean).join(" · ")}</Meta>}
            {isJourney(b.type) && <Meta label="To">{[b.to_code, b.to_place].filter(Boolean).join(" · ")}</Meta>}
            <Meta label="Terminal">{[b.terminal_from, b.terminal_to].filter(Boolean).join(" → ")}</Meta>
            <Meta label="Seat">{b.seat}</Meta>
            <Meta label="Cabin">{b.cabin}</Meta>
            <Meta label="Takes">{mins !== null ? fmtMinutes(mins) : ""}</Meta>
            <Meta label="Number">{[b.provider, b.number].filter(Boolean).join(" ")}</Meta>
            <Meta label="Travellers">{b.traveller_ids.length ? trip.travellers.filter((x) => b.traveller_ids.includes(x.id)).map((x) => x.name).join(", ") : ""}</Meta>
          </div>
          {b.address && (
            <p className="flex items-start gap-2 text-sm text-[var(--text)]">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
              <span className="min-w-0 flex-1">{b.address}</span>
              {maps && !offline && (
                <a href={maps} target="_blank" rel="noreferrer" className="shrink-0 text-sm font-medium text-[var(--item-accent)]">
                  Map
                </a>
              )}
            </p>
          )}
          {(b.phone || link) && (
            <div className="flex flex-wrap gap-2">
              {b.phone && (
                <a href={`tel:${b.phone.replace(/[^\d+]/g, "")}`} className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 text-sm text-[var(--text)] hover:bg-[var(--hover)]">
                  <Phone className="h-4 w-4" /> {b.phone}
                </a>
              )}
              {link && (
                <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 text-sm text-[var(--text)] hover:bg-[var(--hover)]">
                  <ExternalLink className="h-4 w-4" /> Manage booking
                </a>
              )}
            </div>
          )}
          {b.attachments.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[var(--text-muted)]">Tickets & confirmations</span>
              <Attachments files={b.attachments} />
              <p className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                {offline && <WifiOff className="h-3.5 w-3.5" />}
                Attached files open from Files and need a connection — everything else here works offline.
              </p>
            </div>
          )}
          {b.notes && <p className="whitespace-pre-wrap rounded-2xl bg-[var(--surface-2)] p-3 text-sm text-[var(--text)]">{b.notes}</p>}
          {onOpenFull && (
            <ItemButton variant="ghost" className="self-start" onClick={onOpenFull}>
              All details in Bookings
            </ItemButton>
          )}
        </div>
      )}
    </Sheet>
  );
}
