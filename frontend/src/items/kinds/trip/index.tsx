import { CalendarRange, Luggage, Plane, Plus, Receipt, Wallet } from "lucide-react";
import { useEffect, useState, type ComponentType } from "react";

import type { ItemModule, ItemViewProps } from "@/items/types";
import { EmptyState, todayISO } from "@/items/ui";
import type { ItemHandle } from "@/items/useItem";
import { useAuthStore } from "@/store/authStore";

import { BookingsTab } from "./BookingsTab";
import { RAIL_MIN, RAIL_W, TripWidth, useMeasuredWidth } from "./layout";
import { addExpensePending, onAddExpense, requestAddExpense, requestNewTrip } from "./bus";
import { meId } from "./logic";
import { MoneyTab } from "./MoneyTab";
import { OnboardingView } from "./NewTrip";
import { claimMe } from "./ops";
import { PackingTab } from "./PackingTab";
import { PlanTab } from "./PlanTab";
import { defaultTripId, fileSettings, selectTrip, titleOf, useSelectedTrip, useTripHandle } from "./trips";
import { TripBar, TripsHome, TripsRail } from "./TripsHome";
import type { Trip, TripFile } from "./types";
import { setClock, setFallbackZone } from "./tz";

/*
 * Trip Planner — one file holds all of a person's trips. The app opens on the
 * trips home (phone) or the current / next trip beside the trips list
 * (desktop). A trip has four tabs: Plan (day-by-day itinerary that opens on
 * today during the trip, with ideas), Bookings (+ documents), Packing, Money
 * (expenses, settle-up, budget, rates). Each tab works on one trip through a
 * scoped handle (see trips.ts). Times are local wall times with each place's
 * IANA zone; money is minor units per currency. Everything works from the
 * device copy offline; only the conflicts check, the assistant and attached
 * Drive files need a connection.
 */

/** The person's own clock / zone settings, and (once) linking the file's
 *  creator to their traveller on trips made before "this is me" existed. */
function useTripEnv(file: ItemHandle<TripFile>, trip: ItemHandle<Trip> | null, isOwner: boolean) {
  const clock = fileSettings(file.data).clock;
  setClock(clock);
  useEffect(() => setClock(clock), [clock]);
  const userId = useAuthStore((s) => s.user?.id) ?? null;
  const zone = useAuthStore((s) => s.user?.settings?.timezone) ?? "";
  setFallbackZone(zone);
  const t = trip?.data;
  const legacy = trip && trip.canEdit && isOwner && !!userId && t && !meId(t, userId) ? t.travellers.find((x) => x.is_me && !x.user_id)?.id : undefined;
  useEffect(() => {
    if (!legacy || !userId || !trip) return;
    trip.update((d) => {
      const x = d.travellers.find((y) => y.id === legacy);
      if (x && !x.user_id && !meId(d, userId)) claimMe(d, userId, legacy);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legacy, userId]);
}

/** Which trip the tabs show: the picked one; on desktop the current / next
 *  one until something is picked; on a phone the trips list until then. The
 *  header's "Add expense" opens the current trip if none is open. */
function useTripChoice(file: ItemHandle<TripFile>, isPhone: boolean): { id: string | null; home: boolean } {
  const picked = useSelectedTrip(file.fileId);
  const trips = file.data.trips ?? [];
  const [, bump] = useState(0);
  useEffect(() => onAddExpense(() => bump((n) => n + 1)), []);
  const fallback = defaultTripId(trips, todayISO());
  const valid = picked && trips.some((t) => t.id === picked) ? picked : null;
  if (valid) return { id: valid, home: false };
  if (picked === undefined && !isPhone) return { id: fallback, home: !fallback };
  if (addExpensePending() && fallback) {
    queueMicrotask(() => selectTrip(file.fileId, fallback));
    return { id: fallback, home: false };
  }
  return { id: null, home: true };
}

function withHost(View: ComponentType<ItemViewProps<Trip>>): ComponentType<ItemViewProps<TripFile>> {
  function Hosted(props: ItemViewProps<TripFile>) {
    const { item: file, isPhone, ask, doc } = props;
    const choice = useTripChoice(file, isPhone);
    const [ref, total] = useMeasuredWidth<HTMLDivElement>();
    const trip = useTripHandle(file, choice.id);
    useTripEnv(file, trip, doc.is_owner);
    if (!Array.isArray(file.data.trips)) {
      return (
        <div className="mx-auto max-w-lg px-4 py-10">
          <EmptyState icon={Plane} title="This trip file needs updating" text="It was saved by an older version of the app. Connect to the internet once and it updates itself — nothing is lost." />
        </div>
      );
    }
    const rec = trip ? file.data.trips.find((t) => t.id === trip.data.id) : undefined;
    const scopedDoc = { ...doc, title: rec ? titleOf(rec) : doc.title } as unknown as ItemViewProps<Trip>["doc"];
    const rail = !isPhone && total >= RAIL_MIN && file.data.trips.length > 0;
    const viewW = rail ? total - RAIL_W : total;
    const body = trip && rec ? <View key={rec.id} {...props} item={trip} doc={scopedDoc} /> : <TripsHome file={file} isPhone={isPhone} ask={ask} />;
    return (
      <div ref={ref} className="min-h-full">
        <TripWidth.Provider value={viewW || 1200}>
          {rail ? (
            <div className="grid min-h-full" style={{ gridTemplateColumns: `${RAIL_W}px minmax(0,1fr)` }}>
              <aside className="border-r border-[var(--border)]">
                <TripsRail file={file} current={trip ? choice.id : null} homeActive={!trip} onHome={() => selectTrip(file.fileId, null)} ask={ask} />
              </aside>
              <div className="min-w-0">{body}</div>
            </div>
          ) : (
            <>
              {trip && rec && <TripBar file={file} trip={rec} ask={ask} />}
              {body}
            </>
          )}
        </TripWidth.Provider>
      </div>
    );
  }
  Hosted.displayName = `Trip(${View.displayName ?? View.name})`;
  return Hosted;
}

function Onboarding(props: ItemViewProps<TripFile>) {
  return <OnboardingView item={props.item} ask={props.ask} />;
}

const module: ItemModule<TripFile> = {
  kind: "trip",
  icon: Plane,
  tabs: [
    { id: "plan", label: "Plan", icon: CalendarRange, View: withHost(PlanTab) },
    { id: "bookings", label: "Bookings", icon: Plane, View: withHost(BookingsTab) },
    { id: "packing", label: "Packing", icon: Luggage, View: withHost(PackingTab) },
    { id: "money", label: "Money", icon: Wallet, View: withHost(MoneyTab) },
  ],
  primaryAction: (h, { goTo }) => {
    if (!h.canEdit) return null;
    if (!(h.data.trips?.length ?? 0))
      return {
        label: "New trip",
        icon: <Plus className="h-4 w-4" />,
        onClick: () => {
          requestNewTrip();
          goTo("plan");
        },
      };
    return {
      label: "Add expense",
      icon: <Receipt className="h-4 w-4" />,
      onClick: () => {
        requestAddExpense();
        goTo("money");
      },
    };
  },
  needsOnboarding: (d) => Array.isArray(d.trips) && d.trips.length === 0 && !d.settings?.onboarded,
  Onboarding,
};

export default module;
