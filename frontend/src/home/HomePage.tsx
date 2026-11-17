import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutGrid, Lightbulb, Plus, Radio, Router, Settings, WifiOff, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { homeApi, type Home } from "@/api/home";
import { TopNav } from "@/components/layout/TopNav";
import { EmptyState } from "@/components/shared/EmptyState";
import { Sheet } from "@/components/shared/Sheet";
import { Skeleton } from "@/components/shared/Skeleton";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { AddDeviceSheet } from "./AddDeviceSheet";
import { Board } from "./board/Board";
import { DeviceSheet } from "./DeviceSheet";
import { HomeSettingsSheet } from "./HomeSettingsSheet";
import { keyOf } from "./kinds";
import { RoomsSheet } from "./RoomsSheet";
import { SortSheet } from "./SortSheet";
import { noteLine } from "./words";

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
 * The devices themselves are drawn by ``board/Board``: as rooms, the way
 * they always were, until the person customises their own page (widgets
 * they add, size, drag and remove; see ``board/layout.ts``).
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

function Devices({ home, onAddDevice, onSort }: { home: Home; onAddDevice: () => void; onSort: () => void }) {
  const qc = useQueryClient();
  // This server's own box takes a minute or two to come up (longer the first
  // time, while it sets itself up): that's "starting", not "offline".
  const starting = home.boxes.filter((b) => b.builtin && !b.ready);
  const offline = home.boxes.filter((b) => !b.online && !b.builtin);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const opened = openKey ? home.entities.find((e) => keyOf(e) === openKey) ?? null : null;
  const noted = home.boxes.filter((b) => b.note);
  const gotIt = useMutation({
    mutationFn: (boxId: string) => homeApi.clearNote(home.id, boxId),
    onMutate: (boxId) => qc.setQueryData<Home[]>(KEY, (old) => old?.map((h) => (h.id === home.id ? { ...h, boxes: h.boxes.map((b) => (b.id === boxId ? { ...b, note: null } : b)) } : h))),
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
      <Board key={home.id} home={home} onOpen={setOpenKey} onSort={onSort} />
      <DeviceSheet home={home} entity={opened} onClose={() => setOpenKey(null)} onOpen={(other) => setOpenKey(keyOf(other))} />
    </>
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
