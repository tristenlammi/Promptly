import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Minus, Pause, Play, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { homeApi, type Home, type HomeAction, type HomeEntity } from "@/api/home";
import { Sheet } from "@/components/shared/Sheet";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { stateWords } from "./words";

/**
 * One device, opened: its controls (brightness and warmth for a light, a
 * fan's speed, a blind's position, a thermostat's target, play and volume),
 * and its name and room. A lock, a garage door or a gate asks "are you sure?"
 * before it lets anyone in; the server insists on that too.
 */

const btn =
  "inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-[var(--border)] px-4 text-sm font-medium text-[var(--text)] transition hover:bg-[var(--hover)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const strong =
  "inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--accent-strong)] px-4 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1";
const field =
  "h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

const COLOURS: [string, [number, number, number]][] = [
  ["Warm white", [255, 197, 143]], ["White", [255, 255, 255]], ["Red", [255, 60, 50]], ["Orange", [255, 140, 30]],
  ["Yellow", [255, 220, 60]], ["Green", [70, 220, 110]], ["Blue", [60, 130, 255]], ["Purple", [170, 90, 255]], ["Pink", [255, 105, 180]],
];
const MODE_WORDS: Record<string, string> = { off: "Off", heat: "Heat", cool: "Cool", heat_cool: "Heat and cool", auto: "Auto", dry: "Dry", fan_only: "Fan" };
const NEW_ROOM = "__new__";

/** A slider that shows the number as you drag and sends it when you let go. */
function Slide({ label, value, min, max, step = 1, unit = "", disabled, onSet }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; disabled?: boolean; onSet: (v: number) => void }) {
  const [at, setAt] = useState(value);
  // The latest position, even if you let go before the page has redrawn.
  const latest = useRef(value);
  useEffect(() => {
    setAt(value);
    latest.current = value;
  }, [value]);
  const send = () => {
    if (latest.current !== value) onSet(latest.current);
  };
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-baseline justify-between text-sm font-medium text-[var(--text)]">
        {label}
        <span className="font-normal tabular-nums text-[var(--text-muted)]">{at}{unit}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={at} disabled={disabled} onChange={(e) => { latest.current = Number(e.target.value); setAt(latest.current); }} onPointerUp={send} onKeyUp={send} onBlur={send} className="h-11 w-full accent-[var(--accent)]" />
    </label>
  );
}

export function DeviceSheet({ home, entity, onClose }: { home: Home; entity: HomeEntity | null; onClose: () => void }) {
  const qc = useQueryClient();
  // Keep showing the last one while the sheet closes.
  const [last, setLast] = useState<HomeEntity | null>(entity);
  useEffect(() => {
    if (entity) setLast(entity);
  }, [entity]);
  const e = entity ?? last;
  const [sure, setSure] = useState<{ action: HomeAction; words: string; value?: unknown } | null>(null);
  const [name, setName] = useState("");
  const [area, setArea] = useState("");
  const [room, setRoom] = useState("");
  const key = e ? `${e.box_id}/${e.id}` : "";
  useEffect(() => {
    if (!e) return;
    setName(e.name);
    setArea(e.area ?? "");
    setRoom("");
    setSure(null);
    // Only when a different device is opened, not on every live update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const act = useMutation({
    mutationFn: (a: { action: HomeAction; value?: unknown; confirm?: boolean }) => homeApi.act(home.id, { box_id: e!.box_id, entity_id: e!.id, ...a }),
    onError: (err) => toast.error(apiErrorMessage(err, "That didn't work. Try again.")),
    onSettled: () => setSure(null),
  });
  const save = useMutation({
    mutationFn: async () => {
      if (!e) return;
      let to = area;
      if (to === NEW_ROOM) to = room.trim() ? (await homeApi.addRoom(home.id, e.box_id, room.trim())).id : "";
      const change: { entity_id: string; name?: string; area?: string } = { entity_id: e.id };
      if (name.trim() && name.trim() !== e.name) change.name = name.trim();
      if (to !== (e.area ?? "")) change.area = to;
      if (change.name !== undefined || change.area !== undefined) await homeApi.updateDevice(home.id, e.box_id, change);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["home", "homes"] });
      onClose();
    },
    onError: (err) => toast.error(apiErrorMessage(err, "Couldn't save that. Try again.")),
  });

  if (!e) return null;
  const x = e.x ?? {};
  const dead = !e.online || e.state === "unavailable";
  const busy = act.isPending;
  const go = (action: HomeAction, value?: unknown) => act.mutate({ action, value });
  const careful = (action: HomeAction, words: string, value?: unknown) => (e.careful ? setSure({ action, words, value }) : go(action, value));
  const on = e.state === "on";
  const modes = x.modes ?? [];
  const changed = name.trim() !== e.name || area !== (e.area ?? "");

  return (
    <Sheet
      open={entity !== null}
      onClose={onClose}
      title={e.name}
      size="sm"
      footer={
        <div className="flex w-full gap-2">
          <button type="button" className={btn} onClick={onClose}>Close</button>
          {changed && <button type="button" className={strong} disabled={save.isPending || !name.trim()} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save"}</button>}
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <p className="text-sm text-[var(--text-muted)]" role="status">{stateWords(e)}{e.domain === "climate" && typeof x.cur === "number" ? ` · ${x.cur}° now` : ""}{e.domain === "media_player" && x.title ? ` · ${x.title}` : ""}</p>

        {sure ? (
          <div role="alertdialog" aria-label={sure.words} className="flex flex-col gap-3 rounded-xl border border-[var(--warning)]/60 p-3">
            <p className="text-sm font-medium text-[var(--text)]">{sure.words}</p>
            <div className="flex gap-2">
              <button type="button" className={btn} onClick={() => setSure(null)}>No</button>
              <button type="button" className={strong} disabled={busy} onClick={() => act.mutate({ action: sure.action, value: sure.value, confirm: true })}>{busy ? "Doing it…" : "Yes"}</button>
            </div>
          </div>
        ) : (
          <>
            {e.can_switch && (
              <div className="flex gap-2">
                <button type="button" className={on ? btn : strong} disabled={dead || busy || on} onClick={() => go("turn_on")}>On</button>
                <button type="button" className={on ? strong : btn} disabled={dead || busy || !on} onClick={() => go("turn_off")}>Off</button>
              </div>
            )}
            {e.domain === "light" && modes.some((m) => m !== "onoff") && (
              <Slide label="Brightness" unit="%" min={1} max={100} value={on ? (e.bri ?? 100) : 0} disabled={dead} onSet={(v) => go("set", { bri: Math.max(1, v) })} />
            )}
            {e.domain === "light" && modes.includes("color_temp") && typeof x.kmin === "number" && typeof x.kmax === "number" && (
              <Slide label="Warmth (lower is warmer)" unit=" K" min={x.kmin} max={x.kmax} step={50} value={x.k ?? Math.round((x.kmin + x.kmax) / 2)} disabled={dead} onSet={(v) => go("set", { k: v })} />
            )}
            {e.domain === "light" && modes.some((m) => ["hs", "rgb", "xy", "rgbw", "rgbww"].includes(m)) && (
              <div>
                <p className="mb-2 text-sm font-medium text-[var(--text)]">Colour</p>
                <div className="flex flex-wrap gap-2.5">
                  {COLOURS.map(([label, rgb]) => (
                    <button key={label} type="button" aria-label={label} title={label} disabled={dead || busy} onClick={() => go("set", { rgb })} style={{ backgroundColor: `rgb(${rgb.join(",")})` }} className="h-11 w-11 rounded-full border border-[var(--border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 disabled:opacity-50" />
                  ))}
                </div>
              </div>
            )}
            {e.domain === "fan" && typeof x.pct === "number" && <Slide label="Speed" unit="%" min={0} max={100} value={Math.round(x.pct)} disabled={dead} onSet={(v) => go("speed", v)} />}
            {e.domain === "cover" && (
              <>
                <div className="flex gap-2">
                  <button type="button" className={btn} disabled={dead || busy} onClick={() => careful("open", `Open ${e.name}?`)}>Open</button>
                  <button type="button" className={btn} disabled={dead || busy} onClick={() => go("stop")}>Stop</button>
                  <button type="button" className={btn} disabled={dead || busy} onClick={() => go("close")}>Close</button>
                </div>
                {typeof x.pos === "number" && !e.careful && <Slide label="How far open" unit="%" min={0} max={100} value={Math.round(x.pos)} disabled={dead} onSet={(v) => go("position", v)} />}
              </>
            )}
            {e.domain === "lock" && (
              <div className="flex gap-2">
                <button type="button" className={btn} disabled={dead || busy || e.state === "locked"} onClick={() => go("lock")}>Lock</button>
                <button type="button" className={btn} disabled={dead || busy || e.state === "unlocked"} onClick={() => careful("unlock", `Unlock ${e.name}?`)}>Unlock</button>
              </div>
            )}
            {e.domain === "climate" && (
              <>
                {typeof x.target === "number" && (
                  <div>
                    <p className="mb-2 text-sm font-medium text-[var(--text)]">Set to</p>
                    <div className="flex items-center gap-3">
                      <button type="button" aria-label="Cooler" className={cn(btn, "flex-none px-0 w-12")} disabled={dead || busy || (typeof x.min === "number" && x.target <= x.min)} onClick={() => go("temperature", Math.round((x.target! - (x.step ?? 0.5)) * 10) / 10)}><Minus className="h-4 w-4" /></button>
                      <span className="min-w-20 text-center text-2xl font-semibold tabular-nums text-[var(--text)]">{x.target}°</span>
                      <button type="button" aria-label="Warmer" className={cn(btn, "flex-none px-0 w-12")} disabled={dead || busy || (typeof x.max === "number" && x.target >= x.max)} onClick={() => go("temperature", Math.round((x.target! + (x.step ?? 0.5)) * 10) / 10)}><Plus className="h-4 w-4" /></button>
                    </div>
                  </div>
                )}
                {modes.length > 0 && (
                  <label className="flex flex-col gap-1.5 text-sm font-medium text-[var(--text)]">
                    Mode
                    <select className={field} value={e.state} disabled={dead || busy} onChange={(ev) => go("mode", ev.target.value)}>
                      {modes.map((m) => <option key={m} value={m}>{MODE_WORDS[m] ?? m.replace(/_/g, " ")}</option>)}
                    </select>
                  </label>
                )}
              </>
            )}
            {e.domain === "media_player" && (
              <>
                <div className="flex gap-2">
                  <button type="button" className={btn} disabled={dead || busy} onClick={() => go("play")}><Play className="h-4 w-4" /> Play</button>
                  <button type="button" className={btn} disabled={dead || busy} onClick={() => go("pause")}><Pause className="h-4 w-4" /> Pause</button>
                </div>
                {typeof x.vol === "number" && <Slide label="Volume" unit="%" min={0} max={100} value={x.vol} disabled={dead} onSet={(v) => go("volume", v)} />}
              </>
            )}
          </>
        )}

        <div className="flex flex-col gap-3 border-t border-[var(--border)] pt-4">
          <label className="flex flex-col gap-1.5 text-sm font-medium text-[var(--text)]">
            Name
            <input className={field} value={name} maxLength={80} onChange={(ev) => setName(ev.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-[var(--text)]">
            Room
            <select className={field} value={area} onChange={(ev) => setArea(ev.target.value)}>
              <option value="">No room yet</option>
              {home.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              <option value={NEW_ROOM}>A new room…</option>
            </select>
          </label>
          {area === NEW_ROOM && <input className={field} value={room} maxLength={60} placeholder="Room name" aria-label="New room name" onChange={(ev) => setRoom(ev.target.value)} />}
        </div>
      </div>
    </Sheet>
  );
}
