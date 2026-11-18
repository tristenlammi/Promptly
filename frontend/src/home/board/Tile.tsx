import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AirVent,
  BatteryMedium,
  Blinds,
  Bot,
  DoorClosed,
  Droplet,
  Droplets,
  Fan,
  Lightbulb,
  Lock,
  MoreHorizontal,
  Plug,
  Power,
  Radio,
  Shield,
  Speaker,
  Thermometer,
  Tv,
  type LucideIcon,
} from "lucide-react";

import { homeApi, type Home, type HomeEntity } from "@/api/home";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { isZone, lit, tapSwitches } from "../kinds";
import { stateWords } from "../words";

/**
 * One device as a tile: lights, plugs, switches, fans and an air con's zones
 * turn on and off with a tap, and "…" opens the rest; a blind, an air con, a
 * lock, a speaker or a vacuum opens its controls (which is where a lock or a
 * garage door asks "are you sure?").
 */

/** The query that holds the person's homes and their devices. */
export const HOMES_KEY = ["home", "homes"];

const ICONS: Record<string, LucideIcon> = {
  light: Lightbulb, switch: Plug, input_boolean: Power, fan: Fan, lock: Lock, cover: Blinds, climate: Thermometer, media_player: Speaker,
  vacuum: Bot, humidifier: Droplets, valve: Droplet, remote: Power, alarm_control_panel: Shield, water_heater: Thermometer, lawn_mower: Bot, siren: Radio,
};

export function iconOf(e: HomeEntity): LucideIcon {
  if (e.domain === "media_player") return e.cls === "tv" || e.cls === "receiver" ? Tv : Speaker;
  if (e.domain === "climate") return isZone(e) ? AirVent : Thermometer;
  if (e.cls === "temperature") return Thermometer;
  if (e.cls === "humidity" || e.cls === "moisture") return Droplets;
  if (e.cls === "battery") return BatteryMedium;
  if (e.cls === "door" || e.cls === "window" || e.cls === "opening" || e.cls === "garage_door") return DoorClosed;
  if (e.domain === "cover" && (e.cls === "garage" || e.cls === "door" || e.cls === "gate")) return DoorClosed;
  return ICONS[e.domain] ?? Radio;
}

/** Switch one device on or off: shows at once, and the box's own word follows within a moment. */
export function useFlip(homeId: string, entity: HomeEntity) {
  const qc = useQueryClient();
  const on = lit(entity);
  return useMutation({
    mutationFn: () => homeApi.act(homeId, { box_id: entity.box_id, entity_id: entity.id, action: on ? "turn_off" : "turn_on" }),
    onMutate: () => {
      qc.setQueryData<Home[]>(HOMES_KEY, (old) =>
        old?.map((h) => (h.id === homeId ? { ...h, entities: h.entities.map((x) => (x.id === entity.id && x.box_id === entity.box_id ? { ...x, state: on ? "off" : isZone(entity) ? "fan_only" : "on" } : x)) } : h)),
      );
      navigator.vibrate?.(8);
    },
    onError: (e) => {
      toast.error(apiErrorMessage(e, "That didn't work. Try again."));
      void qc.invalidateQueries({ queryKey: HOMES_KEY });
    },
  });
}

export function Tile({ homeId, entity, onOpen }: { homeId: string; entity: HomeEntity; onOpen: () => void }) {
  const on = lit(entity);
  const dead = !entity.online || entity.state === "unavailable";
  const flip = useFlip(homeId, entity);
  const Icon = iconOf(entity);
  const body = (
    <>
      <span className={cn("flex h-9 w-9 items-center justify-center rounded-full", on && !dead ? "bg-[var(--accent)]/20 text-[var(--accent-text,var(--accent))]" : "bg-[var(--hover)] text-[var(--text-muted)]")}>
        <Icon className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="mt-2 block w-full truncate text-sm font-medium text-[var(--text)]">{entity.name}</span>
      <span className="block w-full truncate text-xs text-[var(--text-muted)]">{entity.grp ? "Group · " : isZone(entity) ? "Zone · " : ""}{stateWords(entity) || " "}</span>
    </>
  );
  const shell = cn(
    "flex h-full min-h-24 w-full flex-col items-start rounded-2xl border px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
    on && !dead ? "border-[var(--accent)]/50 bg-[color-mix(in_srgb,var(--accent)_9%,var(--surface))]" : "border-[var(--border)] bg-[var(--surface)]",
    dead && "opacity-60",
  );
  // A blind, an air con, a lock, a speaker: the tile opens its controls.
  if (!tapSwitches(entity)) {
    return <button type="button" aria-label={[entity.name, stateWords(entity)].filter(Boolean).join(", ")} onClick={onOpen} className={cn(shell, "hover:border-[var(--accent)]/60")}>{body}</button>;
  }
  return (
    <div className="relative h-full">
      <button type="button" role="switch" aria-checked={on} aria-label={entity.name} disabled={dead || flip.isPending} onClick={() => flip.mutate()} className={cn(shell, "hover:border-[var(--accent)]/60 disabled:cursor-not-allowed")}>
        {body}
      </button>
      <button type="button" aria-label={`${entity.name}: more`} onClick={onOpen} className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
