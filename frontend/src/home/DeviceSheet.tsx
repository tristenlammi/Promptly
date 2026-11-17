import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { homeApi, type Home, type HomeAction, type HomeEntity } from "@/api/home";
import { Sheet } from "@/components/shared/Sheet";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

import { btn, ClimateControls, field, MediaControls, Slide, strong, VacuumControls, type Go } from "./DeviceControls";
import { can } from "./kinds";
import { ASK_OWNER } from "./roles";
import { stateWords } from "./words";

/**
 * One device, opened: its controls (brightness and warmth for a light, a
 * fan's speed, a blind's position, an air con's mode, temperature, fan and
 * zones, a speaker's playback, volume and grouping, a vacuum's start and
 * send-home), and its name and room. A lock, a garage door or a gate asks
 * "are you sure?" before it lets anyone in; the server insists on that too.
 * A kind of device we have no controls for shows what it says, and can
 * still be named and put in a room.
 */

const COLOURS: [string, [number, number, number]][] = [
  ["Warm white", [255, 197, 143]], ["White", [255, 255, 255]], ["Red", [255, 60, 50]], ["Orange", [255, 140, 30]],
  ["Yellow", [255, 220, 60]], ["Green", [70, 220, 110]], ["Blue", [60, 130, 255]], ["Purple", [170, 90, 255]], ["Pink", [255, 105, 180]],
];
const NEW_ROOM = "__new__";

export function DeviceSheet({ home, entity, onClose, onOpen }: { home: Home; entity: HomeEntity | null; onClose: () => void; /** Open another device instead (a zone's unit, a unit's zone). */ onOpen?: (other: HomeEntity) => void }) {
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
    mutationFn: (a: { action: HomeAction; value?: unknown; confirm?: boolean; on?: HomeEntity }) =>
      homeApi.act(home.id, { box_id: (a.on ?? e!).box_id, entity_id: (a.on ?? e!).id, action: a.action, value: a.value, confirm: a.confirm }),
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
  const go: Go = (action, value, on) => act.mutate({ action, value, on });
  const careful = (action: HomeAction, words: string, value?: unknown) => (e.careful ? setSure({ action, words, value }) : go(action, value));
  const on = e.state === "on";
  const modes = x.modes ?? [];
  const changed = name.trim() !== e.name || area !== (e.area ?? "");
  const says = stateWords(e);

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
        {says && <p className="text-sm text-[var(--text-muted)]" role="status">{says}</p>}

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
            {e.domain === "fan" && typeof x.pct === "number" && can(e, "speed") && <Slide label="Speed" unit="%" min={0} max={100} value={Math.round(x.pct)} disabled={dead} onSet={(v) => go("speed", v)} />}
            {e.domain === "fan" && typeof x.osc === "boolean" && Array.isArray(x.can) && x.can.includes("osc") && (
              <div className="flex gap-2">
                <button type="button" className={x.osc ? strong : btn} aria-pressed={x.osc} disabled={dead || busy} onClick={() => go("oscillate", !x.osc)}>{x.osc ? "Turning side to side" : "Turn side to side"}</button>
              </div>
            )}
            {e.domain === "cover" && (
              <>
                <div className="flex gap-2">
                  {can(e, "open") && <button type="button" className={btn} disabled={dead || busy} onClick={() => careful("open", `Open ${e.name}?`)}>Open</button>}
                  {can(e, "stop") && <button type="button" className={btn} disabled={dead || busy} onClick={() => go("stop")}>Stop</button>}
                  {can(e, "close") && <button type="button" className={btn} disabled={dead || busy} onClick={() => go("close")}>Close</button>}
                </div>
                {typeof x.pos === "number" && !e.careful && can(e, "pos") && <Slide label="How far open" unit="%" min={0} max={100} value={Math.round(x.pos)} disabled={dead} onSet={(v) => go("position", v)} />}
              </>
            )}
            {e.domain === "valve" && (
              <div className="flex gap-2">
                <button type="button" className={btn} disabled={dead || busy || e.state === "open"} onClick={() => go("open")}>Open</button>
                <button type="button" className={btn} disabled={dead || busy || e.state === "closed"} onClick={() => go("close")}>Close</button>
              </div>
            )}
            {e.domain === "lock" && (
              <div className="flex gap-2">
                <button type="button" className={btn} disabled={dead || busy || e.state === "locked"} onClick={() => go("lock")}>Lock</button>
                <button type="button" className={btn} disabled={dead || busy || e.state === "unlocked"} onClick={() => careful("unlock", `Unlock ${e.name}?`)}>Unlock</button>
              </div>
            )}
            {e.domain === "climate" && <ClimateControls home={home} e={e} dead={dead} busy={busy} go={go} onOpen={(o) => onOpen?.(o)} />}
            {e.domain === "media_player" && <MediaControls home={home} e={e} dead={dead} busy={busy} go={go} />}
            {e.domain === "vacuum" && <VacuumControls e={e} dead={dead} busy={busy} go={go} />}
            {e.domain === "scene" && (
              <div className="flex gap-2">
                <button type="button" className={strong} disabled={dead || busy} onClick={() => go("run")}>Turn this scene on</button>
              </div>
            )}
          </>
        )}

        {!home.can_manage && <p className="border-t border-[var(--border)] pt-4 text-xs text-[var(--text-muted)]">Its name and room: {ASK_OWNER.charAt(0).toLowerCase() + ASK_OWNER.slice(1)}</p>}
        {home.can_manage && <div className="flex flex-col gap-3 border-t border-[var(--border)] pt-4">
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
        </div>}
      </div>
    </Sheet>
  );
}
