/**
 * A small still picture of the map around a place, for a place card in a
 * conversation. Drawn in the browser from this server's own map (the same
 * tiles P Maps shows): nothing is asked of any outside map service.
 *
 * One hidden map does all of them, one at a time, and each picture is kept
 * for the rest of the visit. A long conversation with many places therefore
 * never holds more than one live map, and the map is let go again shortly
 * after the last picture.
 */
import type { Map as MapLibreMap } from "maplibre-gl";

import { loadMapLibre, serverMapStyle } from "@/components/maps/mapStyle";

export type PreviewTheme = "light" | "dark";

/** CSS pixels of the picture (drawn at up to 2x for sharp screens). */
export const PREVIEW_W = 560;
export const PREVIEW_H = 240;
const ZOOM = 14.6;
const WAIT_MS = 9000;
const LET_GO_MS = 20_000;
const MAX_KEPT = 60;

const kept = new Map<string, string>();
let queue: Promise<unknown> = Promise.resolve();
let stage: { map: MapLibreMap; el: HTMLDivElement; theme: PreviewTheme; basemap: string } | null = null;
let letGo: ReturnType<typeof setTimeout> | null = null;

/** Close enough is the same picture (about 10 m). */
export function previewKey(theme: PreviewTheme, lat: number, lon: number): string {
  return `${theme}|${lat.toFixed(4)}|${lon.toFixed(4)}`;
}

export function keptPreview(theme: PreviewTheme, lat: number, lon: number): string | null {
  return kept.get(previewKey(theme, lat, lon)) ?? null;
}

function dropStage() {
  if (letGo) clearTimeout(letGo);
  letGo = null;
  if (!stage) return;
  try {
    stage.map.remove();
  } catch {
    /* already gone */
  }
  stage.el.remove();
  stage = null;
}

function settled(map: MapLibreMap): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), WAIT_MS);
    void map.once("idle").then(() => finish(true));
  });
}

async function draw(basemap: string, theme: PreviewTheme, lat: number, lon: number): Promise<string | null> {
  const maplibre = await loadMapLibre();
  if (stage && (stage.theme !== theme || stage.basemap !== basemap)) dropStage();
  if (!stage) {
    const el = document.createElement("div");
    el.setAttribute("aria-hidden", "true");
    el.style.cssText = `position:fixed;left:-10000px;top:0;width:${PREVIEW_W}px;height:${PREVIEW_H}px;pointer-events:none;visibility:hidden;contain:strict;`;
    document.body.appendChild(el);
    const style = await serverMapStyle(maplibre, theme, basemap);
    const map = new maplibre.Map({
      container: el,
      style,
      center: [lon, lat],
      zoom: ZOOM,
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      pixelRatio: Math.min(2, window.devicePixelRatio || 1),
      // So the finished frame can be read back as a picture.
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    stage = { map, el, theme, basemap };
  } else {
    stage.map.jumpTo({ center: [lon, lat], zoom: ZOOM });
  }
  const ok = await settled(stage.map);
  if (!ok) {
    // The map never finished (no tiles, a lost graphics context): start clean next time.
    dropStage();
    return null;
  }
  let url: string | null = null;
  try {
    url = stage.map.getCanvas().toDataURL("image/jpeg", 0.82);
    // A blank read-back is a tiny file: treat it as no picture.
    if (url.length < 2000) url = null;
  } catch {
    url = null;
  }
  return url;
}

/** The picture for this place (a data URL), or null when the map can't be drawn here. */
export function placePreview(basemap: string, theme: PreviewTheme, lat: number, lon: number): Promise<string | null> {
  const key = previewKey(theme, lat, lon);
  const have = kept.get(key);
  if (have) return Promise.resolve(have);
  const job = queue.then(async () => {
    const again = kept.get(key);
    if (again) return again;
    if (letGo) clearTimeout(letGo);
    letGo = null;
    let url: string | null = null;
    try {
      url = await draw(basemap, theme, lat, lon);
    } catch {
      dropStage();
    }
    if (url) {
      kept.set(key, url);
      if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value as string);
    }
    letGo = setTimeout(dropStage, LET_GO_MS);
    return url;
  });
  queue = job.catch(() => null);
  return job;
}
