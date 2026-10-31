import { Check, ChevronDown, ChevronLeft, Copy, LayoutGrid, Luggage, MoreHorizontal, Pencil, Plane, Plus, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ItemHandle } from "@/items/useItem";
import { Avatar, EmptyState, Fab, IconButton, ItemButton, Section, Sheet, TextInput, todayISO, uid } from "@/items/ui";
import { cn } from "@/utils/cn";

import { onNewTrip, takeNewTrip } from "./bus";
import { nextUp, packingProgress } from "./logic";
import { NewTripSheet } from "./NewTrip";
import { TripSheet } from "./TripSheet";
import { copyTrip, countdownText, MAX_TRIPS, onTrip, ordered, selectTrip, titleOf, viewOf, type Bucket } from "./trips";
import type { Trip, TripFile, TripRecord } from "./types";
import { dateRange, fmtDate, fmtHM, fmtRange } from "./tz";

const BUCKET_TITLE: Record<Bucket, string> = { now: "Happening now", upcoming: "Upcoming", undated: "Someday", past: "Past trips" };

const cover = (c: string) => `linear-gradient(135deg, ${c} 0%, color-mix(in srgb, ${c} 58%, #000) 100%)`;

function nights(t: TripRecord): number {
  return Math.max(0, dateRange(t.start, t.end).length - 1);
}

/** The ``New trip`` sheet, opened from anywhere through ``requestNewTrip``. */
export function useNewTripSignal(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(() => takeNewTrip());
  useEffect(
    () =>
      onNewTrip(() => {
        if (takeNewTrip()) setOpen(true);
      }),
    [],
  );
  return [open, setOpen];
}

/* ------------------------------------------------------------ cards */

function TripTile({ t, size = 44 }: { t: TripRecord; size?: number }) {
  return (
    <span aria-hidden className="flex shrink-0 items-center justify-center rounded-xl" style={{ width: size, height: size, background: cover(t.color), fontSize: size * 0.5 }}>
      {t.emoji}
    </span>
  );
}

function TripCard({ t, bucket, today, onOpen, big }: { t: TripRecord; bucket: Bucket; today: string; onOpen: () => void; big?: boolean }) {
  const view = useMemo(() => viewOf({ trips: [], settings: {} } as unknown as TripFile, t), [t]);
  const pack = packingProgress(view);
  const flights = t.bookings.filter((b) => b.type === "flight" && b.status !== "cancelled").length;
  const stays = t.bookings.filter((b) => b.type === "stay" && b.status !== "cancelled").length;
  const when = countdownText(t, today);
  const n = nights(t);
  const soon = (bucket === "now" || bucket === "upcoming") && t.start && dateRange(today, t.start).length <= 31 ? nextUp(view, Date.now(), 1)[0] : undefined;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full flex-col overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface)] text-left shadow-[var(--shadow-sm)] transition hover:border-[var(--item-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] active:scale-[0.99]"
    >
      <div className={cn("relative w-full overflow-hidden px-4 text-white", big ? "pb-4 pt-4" : "pb-3 pt-3")} style={{ background: cover(t.color) }}>
        <span aria-hidden className={cn("pointer-events-none absolute -right-1 select-none leading-none opacity-40", big ? "-top-3 text-[96px]" : "-top-2 text-[72px]")}>
          {t.emoji}
        </span>
        <div className="relative flex flex-col gap-1">
          {when && (
            <span className="inline-flex w-fit items-center rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-semibold tabular-nums backdrop-blur-sm">
              {bucket === "now" && <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-white" />}
              {when}
            </span>
          )}
          <h3 className={cn("truncate pr-14 font-semibold", big ? "text-2xl" : "text-lg")}>{titleOf(t)}</h3>
          <p className="text-sm tabular-nums text-white/90">
            {fmtRange(t.start, t.end)}
            {n > 0 && ` · ${n} night${n === 1 ? "" : "s"}`}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-2 px-4 py-3">
        {t.destinations.length > 0 && <p className="truncate text-sm text-[var(--text)]">{t.destinations.map((d) => d.name).join(" → ")}</p>}
        {soon && (
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <span className="shrink-0 rounded-md bg-[color-mix(in_srgb,var(--item-accent)_16%,transparent)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--item-accent)]">Next</span>
            <span className="truncate tabular-nums">
              {soon.title} · {fmtDate(soon.day)}
              {soon.time ? `, ${fmtHM(soon.time)}` : ""}
            </span>
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-[var(--text-muted)]">
            {flights > 0 && (
              <span className="inline-flex items-center gap-1">
                <Plane className="h-3.5 w-3.5" /> {flights}
              </span>
            )}
            {stays > 0 && <span>{stays} stay{stays === 1 ? "" : "s"}</span>}
            {pack.total > 0 && bucket !== "past" && (
              <span className="inline-flex items-center gap-1">
                <Luggage className="h-3.5 w-3.5" /> {pack.done}/{pack.total}
              </span>
            )}
            {!flights && !stays && !t.destinations.length && <span>Nothing booked yet</span>}
          </div>
          {t.travellers.length > 1 && (
            <div className="flex -space-x-2">
              {t.travellers.slice(0, 4).map((x) => (
                <span key={x.id} title={x.name} className="rounded-full ring-2 ring-[var(--surface)]">
                  <Avatar name={x.name} size={24} />
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

function PastRow({ t, onOpen }: { t: TripRecord; onOpen: () => void }) {
  const n = dateRange(t.start, t.end).length;
  return (
    <button type="button" onClick={onOpen} className="flex min-h-[60px] w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]">
      <TripTile t={t} size={40} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-[var(--text)]">{titleOf(t)}</span>
        <span className="block truncate text-xs tabular-nums text-[var(--text-muted)]">
          {fmtRange(t.start, t.end)}
          {n > 0 && ` · ${n} day${n === 1 ? "" : "s"}`}
          {t.destinations.length > 0 && ` · ${t.destinations.map((d) => d.name).join(", ")}`}
        </span>
      </span>
    </button>
  );
}

/* ------------------------------------------------------------- home */

/** All trips: now, upcoming (with countdown), someday, past (by year). */
export function TripsHome({ file, isPhone, ask }: { file: ItemHandle<TripFile>; isPhone: boolean; ask: (p: string, o?: { send?: boolean }) => void }) {
  const today = todayISO();
  const rows = useMemo(() => ordered(file.data.trips ?? [], today), [file.data.trips, today]);
  const [newOpen, setNewOpen] = useNewTripSignal();
  const open = (id: string) => selectTrip(file.fileId, id);
  const groups = (b: Bucket) => rows.filter((r) => r.bucket === b).map((r) => r.trip);
  const past = groups("past");
  const years = useMemo(() => {
    const m = new Map<string, TripRecord[]>();
    for (const t of past) {
      const y = (t.end ?? t.start ?? "").slice(0, 4) || "Undated";
      m.set(y, [...(m.get(y) ?? []), t]);
    }
    return [...m.entries()];
  }, [past]);
  const live = rows.filter((r) => r.bucket !== "past").length;
  const countries = new Set(past.flatMap((t) => t.destinations.map((d) => d.country || d.name)).filter(Boolean)).size;

  return (
    <div className={cn("mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-4 md:px-6 md:py-6", isPhone && "pb-28")}>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-[var(--text)]">Trips</h1>
          <p className="text-sm tabular-nums text-[var(--text-muted)]">
            {rows.length === 0
              ? "Everything for every trip, in one place."
              : [live && `${live} coming up`, past.length && `${past.length} taken`, countries && `${countries} place${countries === 1 ? "" : "s"} visited`].filter(Boolean).join(" · ")}
          </p>
        </div>
        {file.canEdit && !isPhone && (
          <div className="flex gap-2">
            <ItemButton variant="ghost" icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Start a new trip: ask me where, when and who's coming, then create it.")}>
              Plan with AI
            </ItemButton>
            <ItemButton variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setNewOpen(true)}>
              New trip
            </ItemButton>
          </div>
        )}
      </div>

      {rows.length === 0 && (
        <EmptyState
          icon={Plane}
          title="Where to next?"
          text="Add a trip to keep its flights, stays, day plans, packing and shared costs together — or let the assistant set it up from your booking emails and PDFs."
          action={
            file.canEdit && (
              <div className="flex flex-wrap justify-center gap-2">
                <ItemButton variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setNewOpen(true)}>
                  New trip
                </ItemButton>
                <ItemButton variant="secondary" icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Add the trips from my booking confirmations in my files.")}>
                  Import with AI
                </ItemButton>
              </div>
            )
          }
        />
      )}

      {(["now", "upcoming", "undated"] as Bucket[]).map((b) => {
        const list = groups(b);
        if (!list.length) return null;
        return (
          <Section key={b} title={BUCKET_TITLE[b]} hint={b === "undated" ? "Ideas and plans without dates yet" : undefined}>
            <div className={cn("grid gap-3", b === "now" ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3")}>
              {list.map((t) => (
                <TripCard key={t.id} t={t} bucket={b} today={today} big={b === "now"} onOpen={() => open(t.id)} />
              ))}
            </div>
          </Section>
        );
      })}

      {years.length > 0 && (
        <Section title="Past trips">
          <div className="flex flex-col gap-3">
            {years.map(([y, list]) => (
              <div key={y} className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
                <div className="border-b border-[var(--border)] px-3 py-1.5 text-xs font-semibold tabular-nums text-[var(--text-muted)]">{y}</div>
                <div className="divide-y divide-[var(--border)]">
                  {list.map((t) => (
                    <PastRow key={t.id} t={t} onOpen={() => open(t.id)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {isPhone && file.canEdit && rows.length > 0 && <Fab label="New trip" icon={Plus} onClick={() => setNewOpen(true)} />}
      {file.canEdit && <NewTripSheet file={file} open={newOpen} onClose={() => setNewOpen(false)} ask={ask} />}
    </div>
  );
}

/* ------------------------------------------------- desktop: the rail */

export function TripsRail({ file, current, onHome, homeActive, ask }: { file: ItemHandle<TripFile>; current: string | null; onHome: () => void; homeActive: boolean; ask: (p: string) => void }) {
  const today = todayISO();
  const rows = useMemo(() => ordered(file.data.trips ?? [], today), [file.data.trips, today]);
  const [newOpen, setNewOpen] = useNewTripSignal();
  const [menuFor, setMenuFor] = useState<string | null>(null);
  let last: Bucket | null = null;
  return (
    <nav aria-label="Trips" className="sticky top-0 flex max-h-[calc(100dvh-120px)] flex-col gap-1 overflow-y-auto py-6 pl-4 pr-1">
      <div className="mb-1 flex items-center justify-between gap-2 px-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Trips</span>
        {file.canEdit && <IconButton label="New trip" icon={Plus} onClick={() => setNewOpen(true)} />}
      </div>
      <button
        type="button"
        onClick={onHome}
        aria-current={homeActive ? "page" : undefined}
        className={cn("flex h-10 items-center gap-2.5 rounded-xl px-2.5 text-sm font-medium", homeActive ? "bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]")}
      >
        <LayoutGrid className="h-4 w-4" /> All trips
      </button>
      {rows.map(({ bucket, trip: t }) => {
        const head = bucket !== last ? BUCKET_TITLE[bucket] : null;
        last = bucket;
        const on = t.id === current && !homeActive;
        return (
          <div key={t.id}>
            {head && <div className="px-2.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{head}</div>}
            <div className={cn("group flex items-center rounded-xl", on ? "bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)]" : "hover:bg-[var(--hover)]")}>
              <button type="button" aria-current={on ? "page" : undefined} onClick={() => selectTrip(file.fileId, t.id)} className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left">
                <TripTile t={t} size={34} />
                <span className="min-w-0">
                  <span className={cn("block truncate text-sm", on ? "font-semibold text-[var(--text)]" : "font-medium text-[var(--text)]")}>{titleOf(t)}</span>
                  <span className="block truncate text-xs tabular-nums text-[var(--text-muted)]">{bucket === "past" || bucket === "undated" ? fmtRange(t.start, t.end) : countdownText(t, today)}</span>
                </span>
              </button>
              {on && file.canEdit && (
                <button type="button" aria-label={`More for ${titleOf(t)}`} onClick={() => setMenuFor(t.id)} className="mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover-strong)] hover:text-[var(--text)]">
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        );
      })}
      {file.canEdit && <NewTripSheet file={file} open={newOpen} onClose={() => setNewOpen(false)} ask={ask} />}
      {menuFor && <TripMenuSheet file={file} tripId={menuFor} onClose={() => setMenuFor(null)} />}
    </nav>
  );
}

/* --------------------------------------------- phone: the trip bar */

export function TripBar({ file, trip, ask }: { file: ItemHandle<TripFile>; trip: TripRecord; ask: (p: string) => void }) {
  const [switching, setSwitching] = useState(false);
  const [menu, setMenu] = useState(false);
  const [newOpen, setNewOpen] = useNewTripSignal();
  const today = todayISO();
  const rows = useMemo(() => ordered(file.data.trips ?? [], today), [file.data.trips, today]);
  return (
    <>
      <div className="sticky top-0 z-20 flex h-14 items-center gap-1 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] px-2 backdrop-blur-md">
        <button type="button" onClick={() => selectTrip(file.fileId, null)} className="flex h-11 shrink-0 items-center gap-0.5 rounded-xl pl-1 pr-2.5 text-sm font-medium text-[var(--item-accent)] hover:bg-[var(--hover)]">
          <ChevronLeft className="h-5 w-5" /> Trips
        </button>
        <button
          type="button"
          onClick={() => setSwitching(true)}
          aria-label={`Switch trip (now ${titleOf(trip)})`}
          className="mx-auto flex h-11 min-w-0 max-w-[60%] items-center gap-1.5 rounded-xl px-2.5 text-sm font-semibold text-[var(--text)] hover:bg-[var(--hover)]"
        >
          <span aria-hidden>{trip.emoji}</span>
          <span className="truncate">{titleOf(trip)}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
        </button>
        {file.canEdit ? <IconButton label="Trip options" icon={MoreHorizontal} onClick={() => setMenu(true)} /> : <span className="w-11" />}
      </div>
      <Sheet open={switching} onClose={() => setSwitching(false)} title="Your trips">
        <div className="flex flex-col gap-1">
          {rows.map(({ bucket, trip: t }) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                selectTrip(file.fileId, t.id);
                setSwitching(false);
              }}
              className={cn("flex min-h-[56px] items-center gap-3 rounded-xl px-2 text-left", t.id === trip.id ? "bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)]" : "hover:bg-[var(--hover)]")}
            >
              <TripTile t={t} size={40} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-[var(--text)]">{titleOf(t)}</span>
                <span className="block truncate text-xs tabular-nums text-[var(--text-muted)]">
                  {fmtRange(t.start, t.end)}
                  {bucket !== "past" && bucket !== "undated" ? ` · ${countdownText(t, today)}` : ""}
                </span>
              </span>
              {t.id === trip.id && <Check className="h-4 w-4 text-[var(--item-accent)]" />}
            </button>
          ))}
          {file.canEdit && (
            <ItemButton
              variant="secondary"
              className="mt-2"
              icon={<Plus className="h-4 w-4" />}
              onClick={() => {
                setSwitching(false);
                setNewOpen(true);
              }}
            >
              New trip
            </ItemButton>
          )}
        </div>
      </Sheet>
      {menu && <TripMenuSheet file={file} tripId={trip.id} onClose={() => setMenu(false)} />}
      {file.canEdit && <NewTripSheet file={file} open={newOpen} onClose={() => setNewOpen(false)} ask={ask} />}
    </>
  );
}

/* ------------------------------------------------ edit / copy / delete */

function MenuRow({ icon: Icon, label, sub, onClick, danger }: { icon: typeof Pencil; label: string; sub?: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className="flex min-h-[52px] w-full items-center gap-3 rounded-xl px-2 text-left hover:bg-[var(--hover)]">
      <Icon className={cn("h-5 w-5 shrink-0", danger ? "text-[var(--danger)]" : "text-[var(--text-muted)]")} />
      <span className="min-w-0">
        <span className={cn("block text-sm font-medium", danger ? "text-[var(--danger)]" : "text-[var(--text)]")}>{label}</span>
        {sub && <span className="block text-xs text-[var(--text-muted)]">{sub}</span>}
      </span>
    </button>
  );
}

export function TripMenuSheet({ file, tripId, onClose }: { file: ItemHandle<TripFile>; tripId: string; onClose: () => void }) {
  const t = file.data.trips?.find((x) => x.id === tripId);
  const [mode, setMode] = useState<"menu" | "copy" | "delete" | "edit">("menu");
  const [copyTitle, setCopyTitle] = useState(() => (t ? `${titleOf(t)} (copy)` : ""));
  const [copyStart, setCopyStart] = useState("");
  const handle = useMemo<ItemHandle<Trip> | null>(() => {
    if (!t) return null;
    return {
      ...file,
      data: viewOf(file.data, t),
      update: (fn: (d: Trip) => void) => file.update((d) => onTrip(d, tripId, fn)),
      runAction: (n: string, a: Record<string, unknown> = {}) => file.runAction(n, { ...a, trip: tripId }),
      accept: () => undefined,
    } as ItemHandle<Trip>;
  }, [file, t, tripId]);
  if (!t) return null;
  const money = t.expenses.length + t.settlements.length;
  const done = t.status === "done";

  if (mode === "edit" && handle) return <TripSheet item={handle} open onClose={onClose} fallbackTitle={titleOf(t)} />;

  return (
    <Sheet open onClose={onClose} title={mode === "copy" ? "Duplicate trip" : mode === "delete" ? "Delete trip?" : titleOf(t)}>
      {mode === "menu" && (
        <div className="flex flex-col gap-0.5">
          <MenuRow icon={Pencil} label="Edit trip details" sub="Name, dates, places, travellers, currency" onClick={() => setMode("edit")} />
          <MenuRow icon={Copy} label="Duplicate" sub="Plan another trip from this one" onClick={() => setMode("copy")} />
          <MenuRow
            icon={done ? RotateCcw : Check}
            label={done ? "Reopen trip" : "Mark as done"}
            sub={done ? "Back to upcoming and reminders on" : "Moves it to Past trips; reminders stop"}
            onClick={() => {
              const target = done ? "planning" : "done";
              file.update((d) => {
                const x = d.trips.find((y) => y.id === tripId);
                if (x) x.status = target;
              });
              onClose();
            }}
          />
          <MenuRow icon={Trash2} label="Delete trip" danger onClick={() => setMode("delete")} />
        </div>
      )}
      {mode === "copy" && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[var(--text-muted)]">Copies places, travellers, the day plan, ideas, packing (unticked), budget and rates — not bookings, expenses or visas.</p>
          <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--text-muted)]">
            Name
            <TextInput value={copyTitle} onChange={(e) => setCopyTitle(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--text-muted)]">
            New first day (optional — the plan shifts to it)
            <TextInput type="date" value={copyStart} onChange={(e) => setCopyStart(e.target.value)} />
          </label>
          <ItemButton
            variant="primary"
            block
            disabled={!copyTitle.trim() || (file.data.trips?.length ?? 0) >= MAX_TRIPS}
            onClick={() => {
              const rec = copyTrip(t, uid("trip-"), copyTitle.trim().slice(0, 120), copyStart || null);
              file.update((d) => {
                if (!d.trips.some((x) => x.id === rec.id) && d.trips.length < MAX_TRIPS) d.trips.push(structuredClone(rec));
              });
              selectTrip(file.fileId, rec.id);
              onClose();
            }}
          >
            Duplicate
          </ItemButton>
        </div>
      )}
      {mode === "delete" && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[var(--text)]">
            {titleOf(t)} and everything in it — {t.bookings.length} booking{t.bookings.length === 1 ? "" : "s"}, the plan, packing
            {money ? `, and ${t.expenses.length} expense${t.expenses.length === 1 ? "" : "s"} (who paid what is lost)` : ""} — will be deleted.
          </p>
          {money > 0 && !done && <p className="text-sm text-[var(--text-muted)]">To keep it for the record, mark it as done instead.</p>}
          <div className="flex gap-2">
            <ItemButton variant="ghost" block onClick={() => setMode("menu")}>
              Keep
            </ItemButton>
            <ItemButton
              variant="primary"
              block
              className="bg-[var(--danger)]"
              onClick={() => {
                file.update((d) => {
                  d.trips = d.trips.filter((x) => x.id !== tripId);
                });
                selectTrip(file.fileId, null);
                onClose();
              }}
            >
              Delete trip
            </ItemButton>
          </div>
        </div>
      )}
    </Sheet>
  );
}
