import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Blinds,
  DoorClosed,
  Droplets,
  Fan,
  Lightbulb,
  Lock,
  Plug,
  Plus,
  Power,
  Radio,
  Router,
  Thermometer,
  Tv,
  WifiOff,
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

/**
 * Home: the devices in your home, through the box that lives there.
 *
 * The first page of Promptly Home: your home, its rooms, each device as a
 * tile. Lights, plugs and switches turn on and off with a tap; everything
 * else shows what it's doing. "Add a home box" takes the code on the box's
 * card (the card's QR opens this page with the code filled in).
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
  const [picked, setPicked] = useState<string | null>(null);
  const [adding, setAdding] = useState(() => codeFromAddress() !== "");
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
            <button type="button" onClick={() => setAdding(true)} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-[var(--border)] px-3 text-xs font-medium text-[var(--text)] hover:bg-[var(--hover)]">
              <Plus className="h-3.5 w-3.5" /> Add a box
            </button>
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
        {homes && !home && (
          <EmptyState
            icon={<Router className="h-5 w-5" />}
            title="Add your home box"
            description="Plug the box into power and your router. Then scan the code on its card with your phone's camera, or type it here."
            action={<button type="button" className={primary} onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Add a home box</button>}
          />
        )}
        {home && <Devices home={home} />}
      </div>
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

function Devices({ home }: { home: Home }) {
  const offline = home.boxes.filter((b) => !b.online);
  const rooms = useMemo(() => {
    const names = new Map(home.areas.map((a) => [a.id, a.name]));
    const groups = new Map<string, HomeEntity[]>();
    for (const e of home.entities) {
      const room = (e.area && names.get(e.area)) || "Not in a room yet";
      groups.set(room, [...(groups.get(room) ?? []), e]);
    }
    return [...groups.entries()].sort(([a], [b]) => (a === "Not in a room yet" ? 1 : b === "Not in a room yet" ? -1 : a.localeCompare(b)));
  }, [home.areas, home.entities]);

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
      {home.entities.length === 0 && offline.length === 0 && (
        <EmptyState icon={<Lightbulb className="h-5 w-5" />} title="No devices yet" description="Your box is connected. Devices it finds will show here." />
      )}
      {rooms.map(([room, list]) => (
        <section key={room} aria-label={room}>
          <h2 className="mb-2 text-sm font-semibold text-[var(--text-muted)]">{room}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {list.map((e) => <Tile key={`${e.box_id}/${e.id}`} homeId={home.id} entity={e} />)}
          </div>
        </section>
      ))}
    </>
  );
}

const ICONS: Record<string, LucideIcon> = { light: Lightbulb, switch: Plug, input_boolean: Power, fan: Fan, lock: Lock, cover: Blinds, climate: Thermometer, media_player: Tv };

function iconOf(e: HomeEntity): LucideIcon {
  if (e.cls === "temperature") return Thermometer;
  if (e.cls === "humidity" || e.cls === "moisture") return Droplets;
  if (e.cls === "door" || e.cls === "window" || e.cls === "opening" || e.cls === "garage_door") return DoorClosed;
  return ICONS[e.domain] ?? Radio;
}

/** What a device is doing, in plain words. */
export function stateWords(e: HomeEntity): string {
  if (!e.online) return "Offline";
  const s = e.state;
  if (s === "unavailable" || s === "unknown" || s === "") return "Not responding";
  if (e.domain === "sensor") return e.unit ? `${s} ${e.unit}` : s;
  if (e.domain === "binary_sensor") {
    const on = s === "on";
    if (e.cls === "door" || e.cls === "window" || e.cls === "opening" || e.cls === "garage_door") return on ? "Open" : "Closed";
    if (e.cls === "motion" || e.cls === "occupancy" || e.cls === "presence") return on ? "Movement" : "Clear";
    if (e.cls === "moisture") return on ? "Wet" : "Dry";
    if (e.cls === "smoke" || e.cls === "gas" || e.cls === "carbon_monoxide") return on ? "Detected" : "Clear";
    return on ? "On" : "Off";
  }
  if (e.domain === "light" && s === "on" && typeof e.bri === "number" && e.bri > 0 && e.bri < 100) return `On · ${e.bri}%`;
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

function Tile({ homeId, entity }: { homeId: string; entity: HomeEntity }) {
  const qc = useQueryClient();
  const on = entity.state === "on";
  const dead = !entity.online || entity.state === "unavailable";
  const flip = useMutation({
    mutationFn: () => homeApi.act(homeId, { box_id: entity.box_id, entity_id: entity.id, action: on ? "turn_off" : "turn_on" }),
    // Shows at once; the box's own word follows within a moment.
    onMutate: () => {
      qc.setQueryData<Home[]>(KEY, (old) =>
        old?.map((h) => (h.id === homeId ? { ...h, entities: h.entities.map((x) => (x.id === entity.id && x.box_id === entity.box_id ? { ...x, state: on ? "off" : "on" } : x)) } : h)),
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
      <span className="block w-full truncate text-xs text-[var(--text-muted)]">{stateWords(entity)}</span>
    </>
  );
  const shell = cn(
    "flex min-h-24 flex-col items-start rounded-2xl border px-3 py-3 text-left transition",
    on && !dead ? "border-[var(--accent)]/50 bg-[color-mix(in_srgb,var(--accent)_9%,var(--surface))]" : "border-[var(--border)] bg-[var(--surface)]",
    dead && "opacity-60",
  );
  if (!entity.can_switch) return <div className={shell}>{body}</div>;
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={entity.name} disabled={dead || flip.isPending} onClick={() => flip.mutate()} className={cn(shell, "hover:border-[var(--accent)]/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed")}>
      {body}
    </button>
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
