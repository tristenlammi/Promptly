import type { StyleSpecification } from "maplibre-gl";

import { useAuthStore } from "@/store/authStore";

type MapLibre = typeof import("maplibre-gl");

let loading: Promise<MapLibre> | null = null;

/** MapLibre, its worker set up. Loaded once, by whichever map opens first. */
export function loadMapLibre(): Promise<MapLibre> {
  loading ??= (async () => {
    const [maplibre, worker] = await Promise.all([
      import("maplibre-gl"),
      // Its worker, bundled here: v6 looks for it beside its own module file,
      // which isn't where a bundle puts it.
      import("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"),
    ]);
    // Run it from an in-page copy (a blob URL), so it follows this page's
    // security rules, not the ones an old cached copy of the file came with.
    let workerUrl = worker.default;
    try {
      const code = await (await fetch(worker.default)).text();
      workerUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    } catch {
      /* the file's own URL still works where the rules allow it */
    }
    maplibre.setWorkerUrl(workerUrl);
    return maplibre;
  })();
  return loading;
}

/** Live traffic tiles come through our own server, which holds the key. */
export function signTrafficRequest(url: string) {
  if (!url.includes("/api/maps/traffic/tile/") && !url.includes("/api/maps/traffic/incidents/")) return undefined;
  const token = useAuthStore.getState().accessToken;
  return { url, headers: token ? { Authorization: `Bearer ${token}` } : {} };
}

let protocolAdded = false;

/** The server's own map as a MapLibre style: tiles read in ranges from its
 *  signed link (``basemap``), fonts and icons from this site. */
export async function serverMapStyle(maplibre: MapLibre, theme: "light" | "dark", basemap: string): Promise<StyleSpecification> {
  if (!protocolAdded) {
    const { Protocol } = await import("pmtiles");
    maplibre.addProtocol("pmtiles", new Protocol().tile);
    protocolAdded = true;
  }
  const text = await (await fetch(`/map-assets/style-${theme}.json`)).text();
  const origin = window.location.origin;
  return JSON.parse(text.replaceAll("__ORIGIN__", origin).replaceAll("__BASEMAP__", `${origin}${basemap}`)) as StyleSpecification;
}
