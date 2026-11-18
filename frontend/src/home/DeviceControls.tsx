import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Home as HomeIcon, MapPin, Minus, Music, Pause, Play, Plus, Power, SkipBack, SkipForward, Square, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { homeApi, type Home, type HomeAction, type HomeEntity } from "@/api/home";
import { cn } from "@/utils/cn";

import { can, groupable, stepTemp, unitOf, ventOf, zonesOf } from "./kinds";
import { fanWord, modeWord, stateWords } from "./words";

/**
 * The controls inside a device's sheet, for the kinds that need more than
 * on and off: air con (a unit, and the zones of a ducted one), speakers and
 * TVs, a robot vacuum. Each draws only what the device says it can do.
 */

export const btn =
  "inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 text-sm font-medium text-[var(--text)] transition hover:bg-[var(--hover)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
export const strong =
  "inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--accent-strong)] px-4 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1";
export const field =
  "h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const round =
  "inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-[var(--text)] transition hover:bg-[var(--hover)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

export type Go = (action: HomeAction, value?: unknown, on?: HomeEntity) => void;

/**
 * A slider that shows the number as you drag and sends it when you let go.
 *
 * While you're holding it, and for a moment after you let go, what the
 * device reports is ignored: a light answers a change with a burst of its
 * own updates (and the page hears about other changes every couple of
 * seconds), and any of them used to snap the thumb back mid-drag, so letting
 * go sent nothing.
 */
export function Slide({ label, value, min, max, step = 1, unit = "", disabled, onSet }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; disabled?: boolean; onSet: (v: number) => void }) {
  const [at, setAt] = useState(value);
  const latest = useRef(value);
  const held = useRef(false);
  const settle = useRef(0);
  useEffect(() => {
    if (held.current) return;
    setAt(value);
    latest.current = value;
  }, [value]);
  useEffect(() => () => window.clearTimeout(settle.current), []);
  const move = (v: number) => {
    held.current = true;
    window.clearTimeout(settle.current);
    latest.current = v;
    setAt(v);
  };
  const send = () => {
    if (!held.current) return;
    onSet(latest.current);
    // Keep showing what was asked for until the device has had time to say so itself.
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      held.current = false;
    }, 2500);
  };
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-baseline justify-between text-sm font-medium text-[var(--text)]">
        {label}
        <span className="font-normal tabular-nums text-[var(--text-muted)]">{at}{unit}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={at} disabled={disabled} onChange={(e) => move(Number(e.target.value))} onPointerUp={send} onKeyUp={send} onBlur={send} className="h-11 w-full accent-[var(--accent)]" />
    </label>
  );
}

/** One of a few choices, as buttons in a row that wraps: the one it's on is filled. */
function Choices({ label, options, value, disabled, onPick }: { label: string; options: { value: string; label: string }[]; value: string; disabled?: boolean; onPick: (v: string) => void }) {
  return (
    <div role="radiogroup" aria-label={label}>
      <p className="mb-2 text-sm font-medium text-[var(--text)]">{label}</p>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            disabled={disabled}
            onClick={() => o.value !== value && onPick(o.value)}
            className={cn(
              "inline-flex h-11 min-w-16 items-center justify-center rounded-xl border px-3.5 text-sm font-medium transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
              o.value === value ? "border-transparent bg-[var(--accent-strong)] text-white" : "border-[var(--border)] text-[var(--text)] hover:bg-[var(--hover)]",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Warmer and cooler. Taps add up and are sent once you stop (so five taps
 * are one change, counted from where you are and not from what the device
 * last said), and the number you asked for stays until the device agrees.
 */
function Temperature({ e, disabled, onSet }: { e: HomeEntity; disabled: boolean; onSet: (v: number) => void }) {
  const x = e.x ?? {};
  const [want, setWant] = useState<number | null>(null);
  const timer = useRef(0);
  const settle = useRef(0);
  useEffect(() => () => { window.clearTimeout(timer.current); window.clearTimeout(settle.current); }, []);
  useEffect(() => {
    // The device caught up: its word is the truth again.
    if (want !== null && x.target === want) setWant(null);
  }, [x.target, want]);
  if (typeof x.target !== "number") return null;
  const shown = want ?? x.target;
  const nudge = (dir: 1 | -1) => {
    const next = stepTemp(x, shown, dir);
    if (next === shown) return;
    setWant(next);
    window.clearTimeout(timer.current);
    window.clearTimeout(settle.current);
    timer.current = window.setTimeout(() => {
      onSet(next);
      settle.current = window.setTimeout(() => setWant(null), 6000);
    }, 700);
  };
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-[var(--text)]">Set to</p>
      <div className="flex items-center justify-center gap-5">
        <button type="button" aria-label="Cooler" className={round} disabled={disabled || (typeof x.min === "number" && shown <= x.min)} onClick={() => nudge(-1)}><Minus className="h-5 w-5" aria-hidden /></button>
        <span className="min-w-24 text-center text-4xl font-semibold tabular-nums text-[var(--text)]" aria-live="polite" aria-label={`Set to ${shown} degrees`}>{shown}°</span>
        <button type="button" aria-label="Warmer" className={round} disabled={disabled || (typeof x.max === "number" && shown >= x.max)} onClick={() => nudge(1)}><Plus className="h-5 w-5" aria-hidden /></button>
      </div>
      {typeof x.cur === "number" && <p className="mt-2 text-center text-xs text-[var(--text-muted)]">{x.cur}° in the room now{typeof x.hum === "number" ? ` · ${Math.round(x.hum)}% humidity` : ""}</p>}
    </div>
  );
}

/** A small switch for a row (a zone in its unit's list). */
function RowSwitch({ on, label, disabled, onFlip }: { on: boolean; label: string; disabled?: boolean; onFlip: () => void }) {
  return (
    // The button is the finger-sized target; the track inside it is the switch you see.
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onFlip} className="group inline-flex h-11 w-14 shrink-0 items-center justify-center rounded-full disabled:opacity-50 focus-visible:outline-none">
      <span className={cn("relative block h-7 w-12 rounded-full transition group-focus-visible:ring-2 group-focus-visible:ring-[var(--accent)] group-focus-visible:ring-offset-2", on ? "bg-[var(--accent-strong)]" : "bg-[var(--border)]")}>
        <span className={cn("absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all", on ? "left-[22px]" : "left-0.5")} />
      </span>
    </button>
  );
}

export function ClimateControls({ home, e, dead, busy, go, onOpen }: { home: Home; e: HomeEntity; dead: boolean; busy: boolean; go: Go; onOpen: (other: HomeEntity) => void }) {
  const x = e.x ?? {};
  const all = home.entities;
  const roomName = (z: HomeEntity) => home.areas.find((a) => a.id === z.area)?.name;

  if (x.zone) {
    const unit = unitOf(all, e);
    const vent = ventOf(all, e);
    const on = e.state !== "off";
    return (
      <>
        <div className="flex gap-2">
          <button type="button" className={on ? btn : strong} disabled={dead || busy || on} onClick={() => go("turn_on")}>On</button>
          <button type="button" className={on ? strong : btn} disabled={dead || busy || !on} onClick={() => go("turn_off")}>Off</button>
        </div>
        {can(e, "temp") && <Temperature e={e} disabled={dead} onSet={(v) => go("temperature", v)} />}
        {vent && typeof vent.x?.pos === "number" && (
          typeof x.target === "number"
            ? <p className="text-sm text-[var(--text-muted)]">Its vent is {Math.round(vent.x.pos)}% open. It opens and closes by itself to reach the temperature.</p>
            : <Slide label="How far its vent is open" unit="%" min={0} max={100} step={5} value={Math.round(vent.x.pos)} disabled={dead || !can(vent, "pos")} onSet={(v) => go("position", v, vent)} />
        )}
        {unit && (
          <button type="button" onClick={() => onOpen(unit)} className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-[var(--border)] px-3 py-2 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
            <HomeIcon className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
            <span className="min-w-0 flex-1 text-sm">
              <span className="block truncate font-medium text-[var(--text)]">Part of {unit.name}</span>
              <span className="block text-[var(--text-muted)]">{unit.state === "off" ? (on ? "The air con is off, so nothing is blowing here yet" : "The air con is off") : stateWords(unit)}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
          </button>
        )}
      </>
    );
  }

  const modes = x.modes ?? [];
  const zones = zonesOf(all, e);
  const hasOff = modes.includes("off");
  const options = modes.map((m) => ({ value: m, label: modeWord(m) }));
  return (
    <>
      {modes.length > 0 && (
        <Choices
          label="Mode"
          options={options}
          value={e.state}
          disabled={dead || busy}
          onPick={(m) => (m === "off" ? go("turn_off") : go("mode", m))}
        />
      )}
      {e.state === "off" && x.last && modes.includes(x.last) && (
        <button type="button" className={strong} disabled={dead || busy} onClick={() => go("turn_on")}><Power className="h-4 w-4" aria-hidden /> Turn on ({modeWord(x.last)}, as it was)</button>
      )}
      {!hasOff && modes.length === 0 && (
        <div className="flex gap-2">
          <button type="button" className={btn} disabled={dead || busy} onClick={() => go("turn_off")}>Off</button>
          <button type="button" className={btn} disabled={dead || busy} onClick={() => go("turn_on")}>On</button>
        </div>
      )}
      {can(e, "temp") && <Temperature e={e} disabled={dead} onSet={(v) => go("temperature", v)} />}
      {can(e, "fan") && (x.fans?.length ?? 0) > 0 && (
        <Choices label="Fan" options={x.fans!.map((f) => ({ value: f, label: fanWord(f) }))} value={x.fan ?? ""} disabled={dead || busy} onPick={(f) => go("fan", f)} />
      )}
      {zones.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium text-[var(--text)]">Zones</p>
          <ul className="flex flex-col divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]" aria-label="Zones">
            {zones.map((z) => {
              const zOn = z.state !== "off";
              const gone = !z.online || z.state === "unavailable";
              return (
                <li key={z.id} className="flex min-h-14 items-center gap-3 px-3 py-2">
                  <button type="button" onClick={() => onOpen(z)} className="min-w-0 flex-1 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
                    <span className="block truncate text-sm font-medium text-[var(--text)]">{z.name}</span>
                    <span className="flex items-center gap-1 truncate text-xs text-[var(--text-muted)]">
                      {roomName(z) && roomName(z) !== z.name && <><MapPin className="h-3 w-3 shrink-0" aria-hidden />{roomName(z)} · </>}
                      {gone ? "Not responding" : typeof z.x?.cur === "number" ? `${z.x.cur}° now${zOn && typeof z.x?.target === "number" ? `, set to ${z.x.target}°` : ""}` : stateWords(z)}
                    </span>
                  </button>
                  <RowSwitch on={zOn} label={`${z.name} zone`} disabled={dead || busy || gone} onFlip={() => go(zOn ? "turn_off" : "turn_on", undefined, z)} />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}

/** The picture of what's playing, fetched through the home's box. Nothing shows if there is none. */
export function Art({ home, e }: { home: Home; e: HomeEntity }) {
  const mark = e.x?.art;
  const { data } = useQuery({
    queryKey: ["home", "art", home.id, e.box_id, e.id, mark],
    queryFn: () => homeApi.art(home.id, e.box_id, e.id),
    enabled: !!mark && e.online,
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
  });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!data) {
      setUrl(null);
      return;
    }
    const made = URL.createObjectURL(data);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [data]);
  return (
    <span className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[var(--hover)] text-[var(--text-muted)]">
      {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <Music className="h-7 w-7" aria-hidden />}
    </span>
  );
}

export function MediaControls({ home, e, dead, busy, go }: { home: Home; e: HomeEntity; dead: boolean; busy: boolean; go: Go }) {
  const x = e.x ?? {};
  const tv = e.cls === "tv" || e.cls === "receiver";
  const off = ["off", "standby"].includes(e.state);
  const playing = e.state === "playing" || e.state === "buffering";
  const others = groupable(home.entities, e);
  const members = (x.members ?? []).filter((m) => m !== e.id);
  const transport = (["prev", "play", "pause", "next", "stop"] as const).some((c) => can(e, c));
  const power = can(e, "on") || can(e, "off");
  // (An older box doesn't say what a device can do: then only what it always had is drawn.)
  const told = Array.isArray(x.can);
  return (
    <>
      {(x.title || x.art) && !off && (
        <div className="flex items-center gap-3">
          <Art home={home} e={e} />
          <p className="min-w-0 flex-1">
            <span className="block truncate text-base font-semibold text-[var(--text)]">{x.title ?? "Playing"}</span>
            {x.artist && <span className="block truncate text-sm text-[var(--text-muted)]">{x.artist}</span>}
            {x.src && <span className="block truncate text-xs text-[var(--text-muted)]">From {x.src}</span>}
          </p>
        </div>
      )}
      {told && power && (
        <div className="flex gap-2">
          <button type="button" className={off ? strong : btn} disabled={dead || busy || !off || !can(e, "on")} onClick={() => go("turn_on")}>On</button>
          <button type="button" className={off ? btn : strong} disabled={dead || busy || off || !can(e, "off")} onClick={() => go("turn_off")}>Off</button>
        </div>
      )}
      {transport && !(tv && off) && (
        <div className="flex items-center justify-center gap-4" role="group" aria-label="Playback">
          {told && can(e, "prev") && <button type="button" aria-label="Previous" className={round} disabled={dead || busy} onClick={() => go("prev")}><SkipBack className="h-5 w-5" aria-hidden /></button>}
          {playing && can(e, "pause") ? (
            <button type="button" aria-label="Pause" className={cn(round, "h-14 w-14 border-transparent bg-[var(--accent-strong)] text-white hover:bg-[var(--accent-strong)] hover:opacity-90")} disabled={dead || busy} onClick={() => go("pause")}><Pause className="h-6 w-6" aria-hidden /></button>
          ) : can(e, "play") ? (
            <button type="button" aria-label="Play" className={cn(round, "h-14 w-14 border-transparent bg-[var(--accent-strong)] text-white hover:bg-[var(--accent-strong)] hover:opacity-90")} disabled={dead || busy} onClick={() => go("play")}><Play className="h-6 w-6" aria-hidden /></button>
          ) : told && can(e, "stop") ? (
            <button type="button" aria-label="Stop" className={round} disabled={dead || busy} onClick={() => go("stop")}><Square className="h-5 w-5" aria-hidden /></button>
          ) : null}
          {told && can(e, "next") && <button type="button" aria-label="Next" className={round} disabled={dead || busy} onClick={() => go("next")}><SkipForward className="h-5 w-5" aria-hidden /></button>}
        </div>
      )}
      {typeof x.vol === "number" && can(e, "vol") && (
        <div className="flex items-end gap-3">
          <div className="min-w-0 flex-1"><Slide label="Volume" unit="%" min={0} max={100} value={x.vol} disabled={dead} onSet={(v) => go("volume", v)} /></div>
          {told && can(e, "mute") && typeof x.muted === "boolean" && (
            <button type="button" aria-label={x.muted ? "Unmute" : "Mute"} aria-pressed={x.muted} className={cn(round, "h-11 w-11", x.muted && "border-transparent bg-[var(--accent)]/20 text-[var(--accent-text,var(--accent))]")} disabled={dead || busy} onClick={() => go("mute", !x.muted)}>
              {x.muted ? <VolumeX className="h-5 w-5" aria-hidden /> : <Volume2 className="h-5 w-5" aria-hidden />}
            </button>
          )}
        </div>
      )}
      {told && can(e, "src") && (x.srcs?.length ?? 0) > 0 && (
        <label className="flex flex-col gap-1.5 text-sm font-medium text-[var(--text)]">
          {tv ? "Input" : "Playing from"}
          <select className={field} value={x.src && x.srcs!.includes(x.src) ? x.src : ""} disabled={dead || busy} onChange={(ev) => ev.target.value && go("source", ev.target.value)}>
            {!(x.src && x.srcs!.includes(x.src)) && <option value="">Choose…</option>}
            {x.srcs!.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      )}
      {others.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium text-[var(--text)]">Play together with</p>
          <ul className="flex flex-col divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]" aria-label="Play together with">
            {others.map((o) => {
              const inGroup = members.includes(o.id);
              return (
                <li key={o.id} className="flex min-h-12 items-center gap-3 px-3 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{o.name}</span>
                  <RowSwitch on={inGroup} label={`Play together with ${o.name}`} disabled={dead || busy || !o.online || o.state === "unavailable"} onFlip={() => (inGroup ? go("unjoin", undefined, o) : go("join", [o.id]))} />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}

export function VacuumControls({ e, dead, busy, go }: { e: HomeEntity; dead: boolean; busy: boolean; go: Go }) {
  const told = Array.isArray(e.x?.can);
  const cleaning = e.state === "cleaning";
  const row: { action: HomeAction; label: string; show: boolean; main?: boolean }[] = [
    { action: "start", label: e.state === "paused" ? "Carry on" : "Start cleaning", show: can(e, "start") && !cleaning, main: true },
    { action: "pause", label: "Pause", show: can(e, "pause") && cleaning, main: true },
    { action: "dock", label: "Send home", show: can(e, "dock") && e.state !== "docked" },
    { action: "stop", label: "Stop", show: told && can(e, "stop") && (cleaning || e.state === "returning" || e.state === "paused") },
    { action: "locate", label: "Find it", show: told && can(e, "locate") },
  ];
  const shown = row.filter((r) => r.show);
  let out: ReactNode = null;
  if (shown.length > 0) {
    out = (
      <div className="flex flex-wrap gap-2">
        {shown.map((r) => <button key={r.action} type="button" className={cn(r.main ? strong : btn, "min-w-[45%]")} disabled={dead || busy} onClick={() => go(r.action)}>{r.label}</button>)}
      </div>
    );
  }
  return (
    <>
      {out}
      {typeof e.x?.bat === "number" && <p className="text-sm text-[var(--text-muted)]">Battery {Math.round(e.x.bat)}%</p>}
    </>
  );
}
