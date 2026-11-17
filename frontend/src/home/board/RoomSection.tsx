import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Lightbulb, Sparkles } from "lucide-react";

import { homeApi, type Home, type HomeEntity } from "@/api/home";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { byKind, isScene, isTile, keyOf } from "../kinds";
import { looseDevices } from "../SortSheet";
import { byReading, isReading, stateWords } from "../words";
import { HOMES_KEY, iconOf, Tile } from "./Tile";

/**
 * One room, as the page has always shown it: its devices as tiles (lights
 * first), one switch for all its lights, its scenes in a row that scrolls
 * sideways, and its readings (a temperature, a door, a battery) underneath.
 */

/** Run a scene. */
export function useScene(homeId: string) {
  return useMutation({
    mutationFn: (e: HomeEntity) => homeApi.act(homeId, { box_id: e.box_id, entity_id: e.id, action: "run" }),
    onMutate: () => void navigator.vibrate?.(8),
    onSuccess: (_r, e) => toast.success(`${e.name} is on`),
    onError: (e) => toast.error(apiErrorMessage(e, "That didn't work. Try again.")),
  });
}

export const sceneButton =
  "inline-flex h-10 max-w-52 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

export function RoomSection({
  home,
  id,
  name: room,
  list,
  narrow,
  onOpen,
  onSort,
}: {
  home: Home;
  /** The room's id; "" is "not in a room yet". */
  id: string;
  name: string;
  list: HomeEntity[];
  /** In half the page's width: two tiles across, and no bleed past the edges. */
  narrow?: boolean;
  onOpen: (key: string) => void;
  onSort: () => void;
}) {
  const qc = useQueryClient();
  const runScene = useScene(home.id);
  const allLights = useMutation({
    mutationFn: (v: { boxId: string; area: string; on: boolean }) => homeApi.roomLights(home.id, v.boxId, v.area, v.on),
    // Shows at once; the lights' own word follows within a moment.
    onMutate: (v) => {
      qc.setQueryData<Home[]>(HOMES_KEY, (old) =>
        old?.map((h) => (h.id === home.id ? { ...h, entities: h.entities.map((x) => (x.domain === "light" && x.area === v.area && x.box_id === v.boxId && x.state !== "unavailable" ? { ...x, state: v.on ? "on" : "off" } : x)) } : h)),
      );
      navigator.vibrate?.(8);
    },
    onError: (e) => {
      toast.error(apiErrorMessage(e, "That didn't work. Try again."));
      void qc.invalidateQueries({ queryKey: HOMES_KEY });
    },
  });
  const tiles = list.filter((e) => isTile(e, home.entities)).sort(byKind);
  const scenes = list.filter(isScene).sort((a, b) => a.name.localeCompare(b.name));
  const readings = list.filter(isReading).sort(byReading);
  // One switch for the room's lights (two or more: one light has its own tile).
  const lights = id ? tiles.filter((e) => e.domain === "light" && e.online && e.state !== "unavailable") : [];
  const anyOn = lights.some((e) => e.state === "on");
  const loose = id ? 0 : looseDevices(home.entities).length;
  return (
    <section aria-label={room}>
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
        <div className={cn("grid grid-cols-2 gap-3", !narrow && "sm:grid-cols-3")}>
          {tiles.map((e) => <Tile key={keyOf(e)} homeId={home.id} entity={e} onOpen={() => onOpen(keyOf(e))} />)}
        </div>
      )}
      {scenes.length > 0 && (
        // One line that scrolls sideways: a brand can bring a dozen scenes to a room.
        <ul
          className={cn(
            "flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden",
            !narrow && "-mx-4 px-4 md:-mx-6 md:px-6",
            tiles.length > 0 && "mt-3",
          )}
          aria-label={`${room} scenes`}
        >
          {scenes.map((e) => (
            <li key={keyOf(e)} className="shrink-0">
              <button type="button" disabled={!e.online || e.state === "unavailable" || runScene.isPending} onClick={() => runScene.mutate(e)} className={sceneButton}>
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
              <li key={keyOf(e)} className="max-w-full">
                <button type="button" onClick={() => onOpen(keyOf(e))} className={cn("inline-flex min-h-9 max-w-full items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-left text-xs hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]", !e.online && "opacity-60")}>
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
}
