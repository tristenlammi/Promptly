import { useQuery } from "@tanstack/react-query";
import { Plane } from "lucide-react";

import { crossApi, type BudgetTrip } from "@/api/crossapp";
import { Field, Select } from "@/items/ui";

import type { H } from "./common";
import type { Txn } from "./types";

/**
 * "Trip": which of your trips this was spent on — it counts towards the
 * trip's "Spent so far" in Trip Planner. A purchase dated within a trip gets
 * a one-tap suggestion. Saved straight away (it's one field).
 */
export function TripTag({ item, txn, date }: { item: H; txn: Txn; date: string }) {
  const { data: trips } = useQuery({ queryKey: ["budget", "trips"], queryFn: crossApi.budgetTrips, staleTime: 5 * 60_000, retry: false });
  if (!trips?.length) return null;
  const live = item.data.transactions.find((t) => t.id === txn.id);
  const current = live?.trip_ref ?? null;
  const during: BudgetTrip | undefined = trips.find((t) => t.start && t.end && t.start <= date && date <= t.end);
  const set = (ref: string | null) =>
    item.update((d) => {
      const t = d.transactions.find((x) => x.id === txn.id);
      if (!t) return;
      if (ref) t.trip_ref = ref;
      else delete t.trip_ref;
    });
  const known = !current || trips.some((t) => t.ref === current);
  return (
    <Field label="Trip" hint="Counts towards the trip's “Spent so far” in Trip Planner">
      <div className="flex flex-col gap-2">
        {!current && during && txn.amount_cents < 0 && item.canEdit && (
          <button
            type="button"
            onClick={() => set(during.ref)}
            className="flex min-h-[44px] items-center gap-2 rounded-xl border border-dashed border-[var(--item-accent)] px-3 text-left text-sm text-[var(--text)] hover:bg-[var(--hover)]"
          >
            <Plane className="h-4 w-4 shrink-0 text-[var(--item-accent)]" />
            <span className="min-w-0 flex-1 truncate">
              Spent on {during.emoji} {during.title}? <span className="font-medium text-[var(--item-accent)]">Tag it</span>
            </span>
          </button>
        )}
        <Select value={current ?? ""} disabled={!item.canEdit} onChange={(e) => set(e.target.value || null)} aria-label="Trip">
          <option value="">No trip</option>
          {!known && current && <option value={current}>A trip you can't see</option>}
          {trips.map((t) => (
            <option key={t.ref} value={t.ref}>
              {t.emoji} {t.title}
            </option>
          ))}
        </Select>
      </div>
    </Field>
  );
}
