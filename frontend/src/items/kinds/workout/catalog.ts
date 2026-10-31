import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { apiClient } from "@/api/client";

import { BUNDLED_CATALOG } from "./catalogData";
import type { Catalog, CustomExercise, Exercise, WorkoutData } from "./types";

const STORE_KEY = "promptly.workout.catalog";

/** The last library fetched from the server on this device (it can be newer
 *  than the bundle); falls back to the bundled one. Never throws. */
function cachedCatalog(): Catalog {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw) {
      const c = JSON.parse(raw) as Catalog;
      if (Array.isArray(c?.exercises) && c.exercises.length >= BUNDLED_CATALOG.exercises.length && c.muscles && c.patterns && c.equipment) return c;
    }
  } catch {
    /* private mode / quota / bad JSON: the bundle will do */
  }
  return BUNDLED_CATALOG;
}

/** The built-in library. Available immediately and offline (bundled with the
 *  module, or the copy last fetched on this device); refreshed from the
 *  server once per session in the background when there's a connection —
 *  nothing waits on that request. */
export function useCatalog(): Catalog {
  const q = useQuery({
    queryKey: ["items", "workout", "catalog"],
    queryFn: async (): Promise<Catalog> => {
      const c: Catalog = (await apiClient.get("/items/k/workout/catalog")).data;
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(c));
      } catch {
        /* not persisted — fine */
      }
      return c;
    },
    initialData: cachedCatalog,
    initialDataUpdatedAt: 0, // stale at once → one background refresh
    staleTime: Infinity,
    gcTime: Infinity,
    retry: (n) => n < 2 && (typeof navigator === "undefined" || navigator.onLine),
    networkMode: "online",
  });
  return q.data ?? BUNDLED_CATALOG;
}

/** A library outside React (the header's quick action): the same data. */
export function libraryFor(data: WorkoutData, catalog: Catalog = cachedCatalog()): Library {
  return makeLibrary(data, catalog);
}

export function customToExercise(c: CustomExercise): Exercise {
  return {
    id: c.id,
    name: c.name,
    equipment: c.equipment,
    needs: [[c.equipment]],
    pattern: c.pattern,
    log: c.log,
    primary: c.primary,
    secondary: c.secondary,
    compound: c.compound,
    start: null,
    aliases: [],
    custom: true,
    archived: c.archived,
    notes: c.notes,
  };
}

export interface Library {
  byId: Record<string, Exercise>;
  list: Exercise[];
  catalog: Catalog;
  get: (id: string) => Exercise;
}

const UNKNOWN = (id: string): Exercise => ({
  id,
  name: id.replace(/_/g, " "),
  equipment: "bodyweight",
  needs: [["bodyweight"]],
  pattern: "core",
  log: "weight_reps",
  primary: [],
  secondary: [],
  compound: false,
  start: null,
  aliases: [],
  custom: true,
});

function makeLibrary(data: WorkoutData, catalog: Catalog): Library {
  const byId: Record<string, Exercise> = {};
  for (const e of catalog.exercises) byId[e.id] = e;
  for (const c of data.exercises) byId[c.id] = customToExercise(c);
  const list = Object.values(byId).sort((a, b) => a.name.localeCompare(b.name));
  return { byId, list, catalog, get: (id: string) => byId[id] ?? UNKNOWN(id) };
}

export function useLibrary(data: WorkoutData, catalog: Catalog): Library {
  return useMemo(() => makeLibrary(data, catalog), [catalog, data.exercises]); // eslint-disable-line react-hooks/exhaustive-deps
}

export const GOALS: { value: WorkoutData["settings"]["goal"]; label: string; hint: string }[] = [
  { value: "hypertrophy", label: "Build muscle", hint: "6–30 reps close to failure, 10–20 sets/muscle/week" },
  { value: "strength", label: "Get stronger", hint: "Heavy compounds, 1–6 reps at 80–92%" },
  { value: "powerlifting", label: "Powerlifting", hint: "Squat, bench, deadlift — peaking blocks" },
  { value: "fat_loss", label: "Lose fat", hint: "Keep the muscle while you diet" },
  { value: "general", label: "General fitness", hint: "Strong, healthy, consistent" },
  { value: "endurance", label: "Endurance", hint: "Higher reps, shorter rests, conditioning" },
];

export const EQUIP_PRESETS: { id: string; label: string; hint: string; equipment: WorkoutData["settings"]["equipment"] }[] = [
  { id: "gym", label: "Full gym", hint: "Barbells, racks, cables, machines", equipment: ["full_gym"] },
  { id: "home", label: "Home gym", hint: "Rack, barbell, dumbbells, bench", equipment: ["barbell", "rack", "bench", "dumbbell", "pullup_bar", "band"] },
  { id: "db", label: "Dumbbells only", hint: "Dumbbells + a bench", equipment: ["dumbbell", "bench", "band"] },
  { id: "bw", label: "Bodyweight", hint: "Bands, pull-up bar, nothing else", equipment: ["pullup_bar", "band", "bodyweight"] },
];
