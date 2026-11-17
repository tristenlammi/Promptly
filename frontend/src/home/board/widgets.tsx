import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Music, Pause, Play, Power, SkipBack, SkipForward, Sparkles, Volume2, VolumeX } from "lucide-react";
import type { ReactNode } from "react";

import { homeApi, type Home, type HomeAction, type HomeEntity } from "@/api/home";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { Art, Slide } from "../DeviceControls";
import { can, isZone, keyOf, lit, tapSwitches } from "../kinds";
import { isReading, stateWords } from "../words";
import { itemsOf, speakerFor, speakersOf, type Widget } from "./layout";
import { sceneButton, useScene } from "./RoomSection";
import { HOMES_KEY, iconOf, Tile, useFlip } from "./Tile";

/**
 * What each kind of widget draws. A widget only ever draws from the home's
 * devices as the page already has them, so it can show nothing that isn't in
 * this home. A lock, a garage door, a gate or an alarm is always its tile,
 * which opens its controls: that's where "are you sure?" is asked.
 */

const shape = "flex h-full min-w-0 flex-col gap-3 rounded-2xl border p-3";
const plain = "border-[var(--border)] bg-[var(--surface)]";
const glow = "border-[var(--accent)]/50 bg-[color-mix(in_srgb,var(--accent)_9%,var(--surface))]";
export const card = `${shape} ${plain}`;
const more =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
const round =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-[var(--text)] transition hover:bg-[var(--hover)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

type Send = (e: HomeEntity, action: HomeAction, value?: unknown) => void;

/** Send one thing to one device; says so if it didn't work. */
function useSend(homeId: string): { send: Send; busy: boolean } {
  const act = useMutation({
    mutationFn: (a: { e: HomeEntity; action: HomeAction; value?: unknown }) => homeApi.act(homeId, { box_id: a.e.box_id, entity_id: a.e.id, action: a.action, value: a.value }),
    onError: (err) => toast.error(apiErrorMessage(err, "That didn't work. Try again.")),
  });
  return { send: (e, action, value) => act.mutate({ e, action, value }), busy: act.isPending };
}

const isDead = (e: HomeEntity) => !e.online || e.state === "unavailable";

// ------------------------------------------------------------------ one device

/** A device at more than tile size: its name and switch, and its main control underneath. */
export function DeviceWidget({ home, entity, size, onOpen }: { home: Home; entity: HomeEntity; size: Widget["size"]; onOpen: () => void }) {
  const { send, busy } = useSend(home.id);
  const flip = useFlip(home.id, entity);
  // Small, or anything that asks "are you sure?": the tile, which opens its controls.
  if (size === "s" || entity.careful || entity.domain === "lock" || entity.domain === "alarm_control_panel") {
    return <Tile homeId={home.id} entity={entity} onOpen={onOpen} />;
  }
  const on = lit(entity);
  const dead = isDead(entity);
  const Icon = iconOf(entity);
  const x = entity.x ?? {};
  const switches = tapSwitches(entity);
  const says = `${entity.grp ? "Group · " : isZone(entity) ? "Zone · " : ""}${stateWords(entity)}`;
  const head = (
    <>
      <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full", on && !dead ? "bg-[var(--accent)]/20 text-[var(--accent-text,var(--accent))]" : "bg-[var(--hover)] text-[var(--text-muted)]")}>
        <Icon className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-[var(--text)]">{entity.name}</span>
        <span className="block truncate text-xs text-[var(--text-muted)]">{says || " "}</span>
      </span>
    </>
  );
  let body: ReactNode = null;
  if (entity.domain === "light" && (x.modes ?? []).some((m) => m !== "onoff")) {
    body = <Slide label="Brightness" unit="%" min={1} max={100} value={entity.state === "on" ? (entity.bri ?? 100) : 0} disabled={dead} onSet={(v) => send(entity, "set", { bri: Math.max(1, v) })} />;
  } else if (entity.domain === "fan" && typeof x.pct === "number" && can(entity, "speed")) {
    body = <Slide label="Speed" unit="%" min={0} max={100} value={Math.round(x.pct)} disabled={dead} onSet={(v) => send(entity, "speed", v)} />;
  } else if (entity.domain === "cover" && typeof x.pos === "number" && can(entity, "pos")) {
    body = <Slide label="How far open" unit="%" min={0} max={100} value={Math.round(x.pos)} disabled={dead} onSet={(v) => send(entity, "position", v)} />;
  } else if (entity.domain === "media_player") {
    body = <Player home={home} e={entity} send={send} busy={busy} volume={size === "l"} />;
  } else if (entity.domain === "climate" && (typeof x.cur === "number" || typeof x.target === "number")) {
    body = (
      <p className="flex items-baseline gap-2" aria-label={typeof x.cur === "number" ? `${x.cur} degrees now` : `Set to ${x.target} degrees`}>
        <span className="text-3xl font-semibold tabular-nums text-[var(--text)]">{typeof x.cur === "number" ? x.cur : x.target}°</span>
        <span className="min-w-0 truncate text-xs text-[var(--text-muted)]">
          {typeof x.cur === "number" ? "now" : "set to"}
          {typeof x.cur === "number" && typeof x.target === "number" && entity.state !== "off" ? ` · set to ${x.target}°` : ""}
          {typeof x.hum === "number" ? ` · ${Math.round(x.hum)}% humidity` : ""}
        </span>
      </p>
    );
  } else if (isReading(entity)) {
    body = <p className="truncate text-2xl font-semibold tabular-nums text-[var(--text)]">{stateWords(entity)}</p>;
  }
  return (
    <div className={cn(shape, on && !dead ? glow : plain, dead && "opacity-60")}>
      <div className="flex items-center gap-1">
        {switches ? (
          <button type="button" role="switch" aria-checked={on} aria-label={entity.name} disabled={dead || flip.isPending} onClick={() => flip.mutate()} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed">
            {head}
          </button>
        ) : (
          <button type="button" aria-label={[entity.name, stateWords(entity)].filter(Boolean).join(", ")} onClick={onOpen} className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
            {head}
          </button>
        )}
        {switches && (
          <button type="button" aria-label={`${entity.name}: more`} onClick={onOpen} className={more}>
            <MoreHorizontal className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>
      {body}
    </div>
  );
}

/** What's playing on a speaker, and its buttons. */
function Player({ home, e, send, busy, volume }: { home: Home; e: HomeEntity; send: Send; busy: boolean; volume: boolean }) {
  const x = e.x ?? {};
  const dead = isDead(e);
  const playing = e.state === "playing" || e.state === "buffering";
  const off = ["off", "standby"].includes(e.state);
  const told = Array.isArray(x.can);
  const main = "h-12 w-12 border-transparent bg-[var(--accent-strong)] text-white hover:bg-[var(--accent-strong)] hover:opacity-90";
  return (
    <>
      <div className="flex items-center gap-3">
        {(x.title || x.art) && !off ? (
          <>
            <Art home={home} e={e} />
            <p className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-[var(--text)]">{x.title ?? "Playing"}</span>
              {x.artist && <span className="block truncate text-xs text-[var(--text-muted)]">{x.artist}</span>}
            </p>
          </>
        ) : (
          <p className="flex min-h-20 min-w-0 flex-1 items-center gap-3 text-sm text-[var(--text-muted)]">
            <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl bg-[var(--hover)]"><Music className="h-7 w-7" aria-hidden /></span>
            Nothing playing
          </p>
        )}
      </div>
      <div className="flex items-center justify-center gap-3" role="group" aria-label={`${e.name} playback`}>
        {told && can(e, "prev") && <button type="button" aria-label="Previous" className={round} disabled={dead || busy} onClick={() => send(e, "prev")}><SkipBack className="h-5 w-5" aria-hidden /></button>}
        {playing && can(e, "pause") ? (
          <button type="button" aria-label="Pause" className={cn(round, main)} disabled={dead || busy} onClick={() => send(e, "pause")}><Pause className="h-5 w-5" aria-hidden /></button>
        ) : can(e, "play") ? (
          <button type="button" aria-label="Play" className={cn(round, main)} disabled={dead || busy} onClick={() => send(e, "play")}><Play className="h-5 w-5" aria-hidden /></button>
        ) : null}
        {told && can(e, "next") && <button type="button" aria-label="Next" className={round} disabled={dead || busy} onClick={() => send(e, "next")}><SkipForward className="h-5 w-5" aria-hidden /></button>}
      </div>
      {volume && typeof x.vol === "number" && can(e, "vol") && (
        <div className="flex items-end gap-3">
          <div className="min-w-0 flex-1"><Slide label="Volume" unit="%" min={0} max={100} value={x.vol} disabled={dead} onSet={(v) => send(e, "volume", v)} /></div>
          {told && can(e, "mute") && typeof x.muted === "boolean" && (
            <button type="button" aria-label={x.muted ? "Unmute" : "Mute"} aria-pressed={x.muted} className={cn(round, x.muted && "border-transparent bg-[var(--accent)]/20 text-[var(--accent-text,var(--accent))]")} disabled={dead || busy} onClick={() => send(e, "mute", !x.muted)}>
              {x.muted ? <VolumeX className="h-5 w-5" aria-hidden /> : <Volume2 className="h-5 w-5" aria-hidden />}
            </button>
          )}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ music

/** What's playing, with a choice of speaker. */
export function MusicWidget({ home, widget, onOpen, onPick }: { home: Home; widget: Widget; onOpen: (key: string) => void; /** Remember this speaker (not while the page is being customised). */ onPick?: (key: string) => void }) {
  const { send, busy } = useSend(home.id);
  const speakers = speakersOf(home);
  const e = speakerFor(home, widget);
  if (!e) {
    return (
      <div className={card}>
        <p className="flex items-center gap-2 text-sm font-semibold text-[var(--text-muted)]"><Music className="h-4 w-4" aria-hidden /> Music</p>
        <p className="text-sm text-[var(--text-muted)]">There are no speakers in this home yet.</p>
      </div>
    );
  }
  return (
    <section aria-label="Music" className={cn(card, isDead(e) && "opacity-60")}>
      <div className="flex items-center gap-2">
        <Music className="h-4 w-4 shrink-0 text-[var(--text-muted)]" aria-hidden />
        {speakers.length > 1 ? (
          <select
            aria-label="Speaker"
            value={keyOf(e)}
            onChange={(ev) => onPick?.(ev.target.value)}
            className="h-11 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-medium text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            {speakers.map((s) => <option key={keyOf(s)} value={keyOf(s)}>{s.name}{s.state === "playing" && keyOf(s) !== keyOf(e) ? " (playing)" : ""}</option>)}
          </select>
        ) : (
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--text)]">{e.name}</h2>
        )}
        <button type="button" aria-label={`${e.name}: more`} onClick={() => onOpen(keyOf(e))} className={more}>
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <Player home={home} e={e} send={send} busy={busy} volume />
    </section>
  );
}

// ------------------------------------------------------------------ scenes

export function ScenesWidget({ home, widget }: { home: Home; widget: Widget }) {
  const run = useScene(home.id);
  const scenes = itemsOf(home, widget);
  if (widget.size === "s" && scenes.length === 1) {
    const e = scenes[0];
    return (
      <button
        type="button"
        disabled={isDead(e) || run.isPending}
        onClick={() => run.mutate(e)}
        aria-label={`${e.name}, scene`}
        className="flex h-full min-h-24 w-full flex-col items-start rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-3 py-3 text-left transition hover:border-[var(--accent)]/60 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--hover)] text-[var(--accent-text,var(--accent))]"><Sparkles className="h-[18px] w-[18px]" aria-hidden /></span>
        <span className="mt-2 block w-full truncate text-sm font-medium text-[var(--text)]">{e.name}</span>
        <span className="block w-full truncate text-xs text-[var(--text-muted)]">Scene</span>
      </button>
    );
  }
  const title = widget.title || "Scenes";
  return (
    <section aria-label={title} className="min-w-0">
      <div className="mb-2 flex min-h-9 items-center"><h2 className="min-w-0 truncate text-sm font-semibold text-[var(--text-muted)]">{title}</h2></div>
      <ul className="flex flex-wrap gap-2">
        {scenes.map((e) => (
          <li key={keyOf(e)} className="max-w-full">
            <button type="button" disabled={isDead(e) || run.isPending} onClick={() => run.mutate(e)} className={sceneButton}>
              <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--accent-text,var(--accent))]" aria-hidden />
              <span className="truncate">{e.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------ a group picked by hand

/** What one switch for the group turns on and off: never anything that asks "are you sure?". */
export const groupSwitches = (list: HomeEntity[]) => list.filter((e) => tapSwitches(e) && !e.careful && !isDead(e));

export function GroupWidget({ home, widget, onOpen }: { home: Home; widget: Widget; onOpen: (key: string) => void }) {
  const qc = useQueryClient();
  const list = itemsOf(home, widget);
  const able = groupSwitches(list);
  const anyOn = able.some(lit);
  const all = useMutation({
    mutationFn: async (on: boolean) => {
      const todo = able.filter((e) => lit(e) !== on);
      const done = await Promise.allSettled(todo.map((e) => homeApi.act(home.id, { box_id: e.box_id, entity_id: e.id, action: on ? "turn_on" : "turn_off" })));
      const failed = done.find((d) => d.status === "rejected") as PromiseRejectedResult | undefined;
      if (failed) throw failed.reason;
    },
    // Shows at once; each device's own word follows within a moment.
    onMutate: (on) => {
      const keys = new Set(able.map(keyOf));
      qc.setQueryData<Home[]>(HOMES_KEY, (old) =>
        old?.map((h) => (h.id === home.id ? { ...h, entities: h.entities.map((x) => (keys.has(keyOf(x)) ? { ...x, state: on ? (isZone(x) ? "fan_only" : "on") : "off" } : x)) } : h)),
      );
      navigator.vibrate?.(8);
    },
    onError: (e) => {
      toast.error(apiErrorMessage(e, "Some of those didn't switch. Try again."));
      void qc.invalidateQueries({ queryKey: HOMES_KEY });
    },
  });
  const title = widget.title || "Group";
  return (
    <section aria-label={title} className="min-w-0">
      <div className="mb-2 flex min-h-9 items-center justify-between gap-3">
        <h2 className="min-w-0 truncate text-sm font-semibold text-[var(--text-muted)]">{title}</h2>
        {able.length > 1 && (
          <button
            type="button"
            role="switch"
            aria-checked={anyOn}
            aria-label={`Everything in ${title}`}
            disabled={all.isPending}
            onClick={() => all.mutate(!anyOn)}
            className={cn(
              "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
              anyOn ? "border-[var(--accent)]/50 bg-[color-mix(in_srgb,var(--accent)_12%,var(--surface))] text-[var(--accent-text,var(--accent))]" : "border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)]",
            )}
          >
            <Power className="h-3.5 w-3.5" aria-hidden /> All {anyOn ? "on" : "off"}
          </button>
        )}
      </div>
      {list.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-[var(--border)] px-3 py-4 text-sm text-[var(--text-muted)]">Nothing in here yet. Customise the page to choose its devices.</p>
      ) : (
        <div className={cn("grid grid-cols-2 gap-3", widget.size === "l" && "sm:grid-cols-3")}>
          {list.map((e) => <Tile key={keyOf(e)} homeId={home.id} entity={e} onOpen={() => onOpen(keyOf(e))} />)}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ gone

/** Its device (or room) left the home: say so, and offer to take the widget off. */
export function GoneWidget({ name, what, onRemove }: { name: string; what: "device" | "room" | "devices"; onRemove?: () => void }) {
  return (
    <div className={cn(card, "justify-between border-dashed")}>
      <p className="text-sm text-[var(--text-muted)]">
        <span className="block truncate font-medium text-[var(--text)]">{name}</span>
        {what === "devices" ? "Its devices are no longer in this home." : `This ${what} is no longer in this home.`}
      </p>
      {onRemove && (
        <button type="button" onClick={onRemove} className="inline-flex h-11 items-center justify-center self-start rounded-xl border border-[var(--border)] px-3 text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
          Remove
        </button>
      )}
    </div>
  );
}
