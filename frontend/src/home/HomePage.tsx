import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AirVent,
  Blinds,
  BatteryMedium,
  Bot,
  DoorClosed,
  Droplet,
  Droplets,
  Fan,
  LayoutGrid,
  Lightbulb,
  Lock,
  MoreHorizontal,
  Plug,
  Plus,
  Power,
  Radio,
  Router,
  Settings,
  Shield,
  Sparkles,
  Speaker,
  Thermometer,
  Tv,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { homeApi, type Home, type HomeEntity } from "@/api/home";
import { TopNav } from "@/components/layout/TopNav";
import { EmptyState } from "@/components/shared/EmptyState";
import { Sheet } from "@/components/shared/Sheet";
import { Skeleton } from "@/components/shared/Skeleton";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { AddDeviceSheet } from "./AddDeviceSheet";
import { DeviceSheet } from "./DeviceSheet";
import { HomeSettingsSheet } from "./HomeSettingsSheet";
import { byKind, isScene, isTile, isZone, keyOf, lit, tapSwitches } from "./kinds";
import { RoomsSheet } from "./RoomsSheet";
import { looseDevices, SortSheet } from "./SortSheet";
import { byReading, isReading, noteLine, stateWords } from "./words";

/**
 * Home: the devices in your home, through the box that lives there.
 *
 * Your home, its rooms, each device as a tile: lights first, then air con,
 * speakers and TVs, and the rest. Lights, plugs, switches, fans and an air
 * con's zones turn on and off with a tap, and "…" opens the rest
 * (brightness, warmth, speed); a blind, an air con, a lock, a speaker or a
 * vacuum opens its controls. Scenes are a row of buttons, and readings (a
 * temperature, a door, a battery) a row under each room. A kind of device
 * with no controls yet is a tile that says what it's doing. A room with
 * lights has one switch for all of them. Rooms are
 * made, named, ordered and merged under "Rooms"; devices with no room yet
 * sit last, with "Sort into rooms". A brand's bridge, and its own "rooms" of
 * lights, are never tiles. "Add a device" runs a brand's set-up steps on the home's box;
 * "Add a home box" takes the code on the box's card (the card's QR opens
 * this page with the code filled in).
 *
 * Live: while the page is in front it asks the server every two seconds
 * whether anything changed (one number comes back when nothing has).
 */

const KEY = ["home", "homes"];
const POLL_MS = 2000;

const primary =
  "inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[var(--accent-strong)] px-4 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1";
const quiet =
  "inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 text-sm font-medium text-[var(--text)] transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

/** The code from a card's QR: ``/home#claim=ABCD-EFGH-JKMN``. */
function codeFromAddress(): string {
  const m = /(?:^#|&)claim=([^&]+)/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]) : "";
}

export function HomePage() {
  const qc = useQueryClient();
  const { data: on, isLoading: checking } = useQuery({ queryKey: ["home", "available"], queryFn: homeApi.available, staleTime: 5 * 60_000 });
  const { data: homes, isLoading, isError, refetch } = useQuery({ queryKey: KEY, queryFn: homeApi.homes, enabled: on === true });
  const { data: bundled } = useQuery({ queryKey: ["home", "bundled"], queryFn: homeApi.bundled, enabled: on === true, staleTime: 5 * 60_000 });
  const [picked, setPicked] = useState<string | null>(null);
  const [adding, setAdding] = useState(() => codeFromAddress() !== "");
  const [addingDevice, setAddingDevice] = useState(false);
  const [settings, setSettings] = useState(false);
  const [rooms, setRooms] = useState(false);
  const [sorting, setSorting] = useState(false);
  const home = useMemo(() => homes?.find((h) => h.id === picked) ?? homes?.[0] ?? null, [homes, picked]);

  useLive(home);

  if (checking || (on && isLoading)) {
    return (
      <>
        <TopNav title="Home" />
        <div className="mx-auto grid w-full max-w-3xl grid-cols-2 gap-3 px-4 py-4 sm:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
        </div>
      </>
    );
  }
  if (on === false) {
    return (
      <>
        <TopNav title="Home" />
        <div className="mx-auto w-full max-w-3xl px-4 py-10">
          <EmptyState icon={<Router className="h-5 w-5" />} title="Promptly Home isn't turned on" description="Whoever looks after this Promptly can turn it on in Admin → Home." />
        </div>
      </>
    );
  }
  return (
    <>
      <TopNav
        title={home?.name ?? "Home"}
        actions={
          home && (
            <div className="flex items-center gap-2">
              {home.boxes.some((b) => b.ready) && (
                <button type="button" onClick={() => setAddingDevice(true)} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--accent-strong)] px-3 text-xs font-medium text-white hover:opacity-90">
                  <Plus className="h-3.5 w-3.5" /> Add a device
                </button>
              )}
              <button type="button" onClick={() => setRooms(true)} aria-label="Rooms" title="Rooms" className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]">
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => setSettings(true)} aria-label="Home settings" title="Home settings" className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]">
                <Settings className="h-4 w-4" />
              </button>
            </div>
          )
        }
      />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-4 pb-24 md:px-6">
        {isError && (
          <p role="alert" className="text-sm text-[var(--text-muted)]">
            Couldn't load your home. <button type="button" className="font-medium text-[var(--accent-text,var(--accent))] hover:underline" onClick={() => void refetch()}>Try again</button>
          </p>
        )}
        {homes && homes.length > 1 && (
          <div role="tablist" aria-label="Your homes" className="flex gap-2 overflow-x-auto">
            {homes.map((h) => (
              <button key={h.id} type="button" role="tab" aria-selected={h.id === home?.id} onClick={() => setPicked(h.id)} className={cn("h-9 shrink-0 rounded-full px-3 text-sm", h.id === home?.id ? "bg-[var(--accent)]/15 font-medium text-[var(--accent-text,var(--accent))]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]")}>
                {h.name}
              </button>
            ))}
          </div>
        )}
        {homes && !home && bundled !== false && (
          <div className="flex flex-col items-center gap-4">
            <EmptyState
              icon={<Router className="h-5 w-5" />}
              title="You're not in a home yet"
              description="Ask whoever set up Home on this Promptly to add you. They open Home, tap the settings button, and add your username under People."
            />
            <button type="button" className="text-xs text-[var(--text-muted)] underline-offset-2 hover:underline" onClick={() => setAdding(true)}>I have a separate home box with a code</button>
          </div>
        )}
        {homes && !home && bundled === false && (
          <div className="flex flex-col gap-5">
            <EmptyState
              icon={<Router className="h-5 w-5" />}
              title="Add your home box"
              description="A home box is a small computer that lives in your home and connects your lights, plugs and other devices to Promptly. Plug it in, then type the code from its card."
              action={<button type="button" className={primary} onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Add a home box</button>}
            />
            <p className="mx-auto max-w-md text-center text-xs text-[var(--text-muted)]">No box? Ask whoever looks after this Promptly.</p>
          </div>
        )}
        {home && <Devices home={home} onAddDevice={() => setAddingDevice(true)} onSort={() => setSorting(true)} />}
      </div>
      {home && <AddDeviceSheet open={addingDevice} home={home} onClose={() => setAddingDevice(false)} onSort={() => setSorting(true)} />}
      {home && <RoomsSheet open={rooms} home={home} onClose={() => setRooms(false)} />}
      {home && <SortSheet open={sorting} home={home} onClose={() => setSorting(false)} />}
      {home && (
        <HomeSettingsSheet
          open={settings}
          home={home}
          onClose={() => setSettings(false)}
          onAddBox={() => { setSettings(false); setAdding(true); }}
          onLeft={() => { setSettings(false); setPicked(null); }}
        />
      )}
      <AddBoxSheet
        open={adding}
        home={home}
        onClose={() => {
          setAdding(false);
          if (window.location.hash.includes("claim=")) history.replaceState(null, "", window.location.pathname);
        }}
        onAdded={(homeId) => {
          setPicked(homeId);
          void qc.invalidateQueries({ queryKey: KEY });
        }}
      />
    </>
  );
}

/** Keep the open home fresh while the page is in front. */
function useLive(home: Home | null) {
  const qc = useQueryClient();
  const rev = useRef(-1);
  const id = home?.id;
  rev.current = home?.rev ?? -1;
  useEffect(() => {
    if (!id) return;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const now = await homeApi.state(id, rev.current);
          if (!stopped && now.changed) {
            qc.setQueryData<Home[]>(KEY, (old) => old?.map((h) => (h.id === id ? { ...h, rev: now.rev, boxes: now.boxes, areas: now.areas, entities: now.entities } : h)));
          }
        } catch {
          // Offline or signed out: the next tick (or the page's own error) says so.
        }
      }
      if (!stopped) timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);
    const front = () => {
      if (document.visibilityState === "visible") {
        window.clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", front);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", front);
    };
  }, [id, qc]);
}

const NO_ROOM = "Not in a room yet";

function Devices({ home, onAddDevice, onSort }: { home: Home; onAddDevice: () => void; onSort: () => void }) {
  const qc = useQueryClient();
  // This server's own box takes a minute or two to come up (longer the first
  // time, while it sets itself up): that's "starting", not "offline".
  const starting = home.boxes.filter((b) => b.builtin && !b.ready);
  const offline = home.boxes.filter((b) => !b.online && !b.builtin);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const opened = openKey ? home.entities.find((e) => keyOf(e) === openKey) ?? null : null;
  // In the order set under Rooms; what has no room yet comes last.
  const rooms = useMemo(() => {
    const known = new Map(home.areas.map((a) => [a.id, a]));
    const groups = new Map<string, HomeEntity[]>();
    for (const e of home.entities) {
      const key = e.area && known.has(e.area) ? e.area : "";
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    const out: { id: string; name: string; list: HomeEntity[] }[] = [];
    for (const a of home.areas) if (groups.has(a.id)) out.push({ id: a.id, name: a.name, list: groups.get(a.id)! });
    if (groups.has("")) out.push({ id: "", name: NO_ROOM, list: groups.get("")! });
    return out;
  }, [home.areas, home.entities]);
  const loose = useMemo(() => looseDevices(home.entities).length, [home.entities]);
  const noted = home.boxes.filter((b) => b.note);
  const gotIt = useMutation({
    mutationFn: (boxId: string) => homeApi.clearNote(home.id, boxId),
    onMutate: (boxId) => qc.setQueryData<Home[]>(KEY, (old) => old?.map((h) => (h.id === home.id ? { ...h, boxes: h.boxes.map((b) => (b.id === boxId ? { ...b, note: null } : b)) } : h))),
  });
  const runScene = useMutation({
    mutationFn: (e: HomeEntity) => homeApi.act(home.id, { box_id: e.box_id, entity_id: e.id, action: "run" }),
    onMutate: () => void navigator.vibrate?.(8),
    onSuccess: (_r, e) => toast.success(`${e.name} is on`),
    onError: (e) => toast.error(apiErrorMessage(e, "That didn't work. Try again.")),
  });
  const allLights = useMutation({
    mutationFn: (v: { boxId: string; area: string; on: boolean }) => homeApi.roomLights(home.id, v.boxId, v.area, v.on),
    // Shows at once; the lights' own word follows within a moment.
    onMutate: (v) => {
      qc.setQueryData<Home[]>(KEY, (old) =>
        old?.map((h) => (h.id === home.id ? { ...h, entities: h.entities.map((x) => (x.domain === "light" && x.area === v.area && x.box_id === v.boxId && x.state !== "unavailable" ? { ...x, state: v.on ? "on" : "off" } : x)) } : h)),
      );
      navigator.vibrate?.(8);
    },
    onError: (e) => {
      toast.error(apiErrorMessage(e, "That didn't work. Try again."));
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });

  if (home.boxes.length === 0) {
    return <EmptyState icon={<Router className="h-5 w-5" />} title="This home has no box yet" description="Add one with the code on its card." />;
  }
  return (
    <>
      {offline.length > 0 && (
        <div role="status" className="flex items-start gap-3 rounded-2xl border border-[var(--warning)]/50 bg-[var(--surface)] px-4 py-3">
          <WifiOff className="mt-0.5 h-5 w-5 shrink-0 text-[var(--warning)]" aria-hidden />
          <div className="min-w-0 text-sm">
            <p className="font-medium text-[var(--text)]">{offline.length === home.boxes.length ? "Your home box is offline" : `${offline[0].name} is offline`}</p>
            <p className="text-[var(--text-muted)]">Check it has power and is plugged into your router. Your devices will come back by themselves.</p>
          </div>
        </div>
      )}
      {starting.length > 0 && (
        <div role="status" className="flex items-start gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
          <Router className="mt-0.5 h-5 w-5 shrink-0 animate-pulse text-[var(--accent-text,var(--accent))]" aria-hidden />
          <div className="min-w-0 text-sm">
            <p className="font-medium text-[var(--text)]">Home is starting up</p>
            <p className="text-[var(--text-muted)]">
              This takes a minute or two, a little longer the very first time. This page fills in by itself.
              {home.entities.length > 0 ? " What you see below is from last time." : ""}
            </p>
          </div>
        </div>
      )}
      {noted.map((b) => (
        <div key={b.id} role="status" className="flex items-start gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
          <Radio className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent-text,var(--accent))]" aria-hidden />
          <p className="min-w-0 flex-1 text-sm text-[var(--text)]">{noteLine(b.note!)}</p>
          <button type="button" aria-label="Got it" title="Got it" onClick={() => gotIt.mutate(b.id)} className="-mr-1 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ))}
      {home.entities.length === 0 && offline.length === 0 && starting.length === 0 && (
        <EmptyState
          icon={<Lightbulb className="h-5 w-5" />}
          title="No devices yet"
          description="Your box is connected. Add your lights, plugs and bridges, and they'll show here."
          action={<button type="button" className={primary} onClick={onAddDevice}><Plus className="h-4 w-4" /> Add a device</button>}
        />
      )}
      {rooms.map(({ id, name: room, list }) => {
        const tiles = list.filter((e) => isTile(e, home.entities)).sort(byKind);
        const scenes = list.filter(isScene).sort((a, b) => a.name.localeCompare(b.name));
        const readings = list.filter(isReading).sort(byReading);
        // One switch for the room's lights (two or more: one light has its own tile).
        const lights = id ? tiles.filter((e) => e.domain === "light" && e.online && e.state !== "unavailable") : [];
        const anyOn = lights.some((e) => e.state === "on");
        return (
          <section key={id || "none"} aria-label={room}>
            <div className="mb-2 flex min-h-9 items-center justify-between gap-3">
              <h2 className="min-w-0 truncate text-sm font-semibold text-[var(--text-muted)]">{room}</h2>
              {lights.length > 1 && (
                <button
                  type="button"
                  role="switch"
                  aria-checked={anyOn}
                  aria-label={`All lights in ${room}`}
                  disabled={allLights.isPending}
                  onClick={() => allLights.mutate({ boxId: lights[0].box_id, area: id, on: !anyOn })}
                  className={cn(
                    "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                    anyOn ? "border-[var(--accent)]/50 bg-[color-mix(in_srgb,var(--accent)_12%,var(--surface))] text-[var(--accent-text,var(--accent))]" : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)]",
                  )}
                >
                  <Lightbulb className="h-3.5 w-3.5" aria-hidden /> All lights {anyOn ? "on" : "off"}
                </button>
              )}
              {!id && loose > 0 && home.boxes.some((b) => b.ready) && (
                <button type="button" onClick={onSort} className="inline-flex h-9 shrink-0 items-center rounded-full border border-[var(--border)] px-3 text-xs font-medium text-[var(--text)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
                  Sort into rooms
                </button>
              )}
            </div>
            {tiles.length > 0 && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {tiles.map((e) => <Tile key={keyOf(e)} homeId={home.id} entity={e} onOpen={() => setOpenKey(keyOf(e))} />)}
              </div>
            )}
            {scenes.length > 0 && (
              // One line that scrolls sideways: a brand can bring a dozen scenes to a room.
              <ul className={cn("-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [-ms-overflow-style:none] md:-mx-6 md:px-6 [&::-webkit-scrollbar]:hidden", tiles.length > 0 && "mt-3")} aria-label={`${room} scenes`}>
                {scenes.map((e) => (
                  <li key={keyOf(e)} className="shrink-0">
                    <button type="button" disabled={!e.online || e.state === "unavailable" || runScene.isPending} onClick={() => runScene.mutate(e)} className="inline-flex h-10 max-w-52 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
                      <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--accent-text,var(--accent))]" aria-hidden />
                      <span className="truncate">{e.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {readings.length > 0 && (
              <ul className={cn("flex flex-wrap gap-2", (tiles.length > 0 || scenes.length > 0) && "mt-3")} aria-label={`${room} readings`}>
                {readings.map((e) => {
                  const Icon = iconOf(e);
                  return (
                    <li key={keyOf(e)}>
                      <button type="button" onClick={() => setOpenKey(keyOf(e))} className={cn("inline-flex min-h-9 max-w-full items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-left text-xs hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]", !e.online && "opacity-60")}>
                        <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" aria-hidden />
                        <span className="truncate text-[var(--text-muted)]">{e.name}</span>
                        <span className="shrink-0 font-medium text-[var(--text)]">{stateWords(e)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
      <DeviceSheet home={home} entity={opened} onClose={() => setOpenKey(null)} onOpen={(other) => setOpenKey(keyOf(other))} />
    </>
  );
}

const ICONS: Record<string, LucideIcon> = {
  light: Lightbulb, switch: Plug, input_boolean: Power, fan: Fan, lock: Lock, cover: Blinds, climate: Thermometer, media_player: Speaker,
  vacuum: Bot, humidifier: Droplets, valve: Droplet, remote: Power, alarm_control_panel: Shield, water_heater: Thermometer, lawn_mower: Bot, siren: Radio,
};

function iconOf(e: HomeEntity): LucideIcon {
  if (e.domain === "media_player") return e.cls === "tv" || e.cls === "receiver" ? Tv : Speaker;
  if (e.domain === "climate") return isZone(e) ? AirVent : Thermometer;
  if (e.cls === "temperature") return Thermometer;
  if (e.cls === "humidity" || e.cls === "moisture") return Droplets;
  if (e.cls === "battery") return BatteryMedium;
  if (e.cls === "door" || e.cls === "window" || e.cls === "opening" || e.cls === "garage_door") return DoorClosed;
  if (e.domain === "cover" && (e.cls === "garage" || e.cls === "door" || e.cls === "gate")) return DoorClosed;
  return ICONS[e.domain] ?? Radio;
}

function Tile({ homeId, entity, onOpen }: { homeId: string; entity: HomeEntity; onOpen: () => void }) {
  const qc = useQueryClient();
  const on = lit(entity);
  const dead = !entity.online || entity.state === "unavailable";
  const flip = useMutation({
    mutationFn: () => homeApi.act(homeId, { box_id: entity.box_id, entity_id: entity.id, action: on ? "turn_off" : "turn_on" }),
    // Shows at once; the box's own word follows within a moment.
    onMutate: () => {
      qc.setQueryData<Home[]>(KEY, (old) =>
        old?.map((h) => (h.id === homeId ? { ...h, entities: h.entities.map((x) => (x.id === entity.id && x.box_id === entity.box_id ? { ...x, state: on ? "off" : isZone(entity) ? "fan_only" : "on" } : x)) } : h)),
      );
      navigator.vibrate?.(8);
    },
    onError: (e) => {
      toast.error(apiErrorMessage(e, "That didn't work. Try again."));
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
  const Icon = iconOf(entity);
  const body = (
    <>
      <span className={cn("flex h-9 w-9 items-center justify-center rounded-full", on && !dead ? "bg-[var(--accent)]/20 text-[var(--accent-text,var(--accent))]" : "bg-[var(--hover)] text-[var(--text-muted)]")}>
        <Icon className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="mt-2 block w-full truncate text-sm font-medium text-[var(--text)]">{entity.name}</span>
      <span className="block w-full truncate text-xs text-[var(--text-muted)]">{entity.grp ? "Group · " : isZone(entity) ? "Zone · " : ""}{stateWords(entity) || "\u00a0"}</span>
    </>
  );
  const shell = cn(
    "flex min-h-24 w-full flex-col items-start rounded-2xl border px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
    on && !dead ? "border-[var(--accent)]/50 bg-[color-mix(in_srgb,var(--accent)_9%,var(--surface))]" : "border-[var(--border)] bg-[var(--surface)]",
    dead && "opacity-60",
  );
  // A blind, an air con, a lock, a speaker: the tile opens its controls.
  if (!tapSwitches(entity)) {
    return <button type="button" aria-label={[entity.name, stateWords(entity)].filter(Boolean).join(", ")} onClick={onOpen} className={cn(shell, "hover:border-[var(--accent)]/60")}>{body}</button>;
  }
  return (
    <div className="relative">
      <button type="button" role="switch" aria-checked={on} aria-label={entity.name} disabled={dead || flip.isPending} onClick={() => flip.mutate()} className={cn(shell, "hover:border-[var(--accent)]/60 disabled:cursor-not-allowed")}>
        {body}
      </button>
      <button type="button" aria-label={`${entity.name}: more`} onClick={onOpen} className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

function AddBoxSheet({ open, home, onClose, onAdded }: { open: boolean; home: Home | null; onClose: () => void; onAdded: (homeId: string) => void }) {
  const [code, setCode] = useState(codeFromAddress);
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<{ online: boolean } | null>(null);
  useEffect(() => {
    if (open) {
      setCode(codeFromAddress());
      setProblem(null);
      setDone(null);
    }
  }, [open]);
  const claim = useMutation({
    mutationFn: () => homeApi.claim({ code, ...(home ? { home_id: home.id } : name.trim() ? { home_name: name.trim() } : {}) }),
    onSuccess: (r) => {
      setDone({ online: r.online });
      onAdded(r.home_id);
    },
    onError: (e) => setProblem(apiErrorMessage(e, "Couldn't add that box. Try again.")),
  });
  const ready = code.replace(/[^A-Za-z0-9]/g, "").length === 12;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={done ? "Box added" : "Add a home box"}
      size="sm"
      footer={
        done ? (
          <button type="button" className={cn(primary, "w-full")} onClick={onClose}>Done</button>
        ) : (
          <div className="flex w-full gap-2">
            <button type="button" className={cn(quiet, "flex-1")} onClick={onClose}>Not now</button>
            <button type="button" className={cn(primary, "flex-1")} disabled={!ready || claim.isPending} onClick={() => { setProblem(null); claim.mutate(); }}>
              {claim.isPending ? "Adding…" : "Add this box"}
            </button>
          </div>
        )
      }
    >
      {done ? (
        <p className="text-sm text-[var(--text)]">
          {done.online
            ? "It's connected. Devices it finds will show on your Home page in a moment."
            : "It's yours. It isn't online yet: plug it into power and your router, and its devices will show by themselves."}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[var(--text-muted)]">Plug the box into power and your router first. Then type the code from its card.</p>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-[var(--text)]">
            Code on the card
            <input
              data-autofocus
              value={code}
              onChange={(e) => { setCode(e.target.value.toUpperCase()); setProblem(null); }}
              placeholder="ABCD-EFGH-JKMN"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              aria-invalid={problem ? true : undefined}
              className="h-12 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-center font-mono text-lg tracking-widest text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            />
          </label>
          {!home && (
            <label className="flex flex-col gap-1.5 text-sm font-medium text-[var(--text)]">
              Name your home
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Our place" maxLength={80} className="h-11 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-normal text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" />
            </label>
          )}
          {home && <p className="text-xs text-[var(--text-muted)]">It will be added to {home.name}.</p>}
          {problem && <p role="alert" className="text-sm text-[var(--danger)]">{problem}</p>}
        </div>
      )}
    </Sheet>
  );
}
