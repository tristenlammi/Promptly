import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { mapsApi } from "./api";

/**
 * True when P Maps works for you here: the server has map data and lets you
 * in. False while it's loading, when Maps isn't set up, or on any error —
 * callers quietly leave map links and map search out. Shares the Maps app's
 * ``maps-config`` query.
 */
export function useMapsReady(enabled = true): boolean {
  const { data } = useQuery({
    queryKey: ["maps-config"],
    queryFn: mapsApi.config,
    staleTime: 3_600_000,
    retry: false,
    enabled,
  });
  return data?.ready === true;
}

let lastFix: { lat: number; lon: number } | null = null;

/**
 * Where you are, only when you've already let this site have your location:
 * it never asks (no permission prompt just for suggestions). Null otherwise.
 */
export function useKnownPosition(enabled: boolean): { lat: number; lon: number } | null {
  const [pos, setPos] = useState(lastFix);
  useEffect(() => {
    if (!enabled || pos || typeof navigator === "undefined" || !navigator.permissions?.query || !navigator.geolocation) return;
    let live = true;
    navigator.permissions
      .query({ name: "geolocation" as PermissionName })
      .then((state) => {
        if (!live || state.state !== "granted") return;
        navigator.geolocation.getCurrentPosition(
          (p) => {
            lastFix = { lat: p.coords.latitude, lon: p.coords.longitude };
            if (live) setPos(lastFix);
          },
          () => undefined,
          { enableHighAccuracy: false, maximumAge: 15 * 60_000, timeout: 5_000 },
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled, pos]);
  return pos;
}
