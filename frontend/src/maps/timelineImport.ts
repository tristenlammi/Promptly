/** Reading a Google Timeline export in the browser, so a big file never has to
 *  be uploaded whole: points go to the server in batches. Handles the three
 *  shapes Google has used: Takeout's Records.json, the phone's Timeline.json,
 *  and the iPhone's array. */

export interface TrackPoint {
  at: string;
  lat: number;
  lon: number;
  accuracy?: number | null;
}

/** "-27.47°, 153.02°" or "geo:-27.47,153.02" → [lat, lon]. */
export function parseLatLng(text: unknown): [number, number] | null {
  if (typeof text !== "string") return null;
  const m = text.replace("geo:", "").match(/(-?\d+(?:\.\d+)?)\D*,\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
}

function iso(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/* eslint-disable @typescript-eslint/no-explicit-any -- an outside file's shape */
function fromSegment(seg: any, out: TrackPoint[]): void {
  const start = iso(seg.startTime);
  const end = iso(seg.endTime);
  const put = (where: unknown, at: string | null) => {
    const ll = parseLatLng(where);
    if (ll && at) out.push({ at, lat: ll[0], lon: ll[1] });
  };
  for (const p of seg.timelinePath ?? []) {
    const at = p.time ? iso(p.time) : start && p.durationMinutesOffsetFromStartTime != null
      ? new Date(new Date(start).getTime() + Number(p.durationMinutesOffsetFromStartTime) * 60_000).toISOString()
      : null;
    put(p.point, at);
  }
  const place = seg.visit?.topCandidate?.placeLocation;
  if (place) {
    const where = typeof place === "string" ? place : place.latLng;
    put(where, start);
    put(where, end);
  }
  if (seg.activity) {
    const from = seg.activity.start;
    const to = seg.activity.end;
    put(typeof from === "string" ? from : from?.latLng, start);
    put(typeof to === "string" ? to : to?.latLng, end);
  }
}

export function pointsFromExport(data: any): TrackPoint[] {
  const out: TrackPoint[] = [];
  if (Array.isArray(data)) {
    for (const seg of data) fromSegment(seg, out);
    return out;
  }
  for (const r of data?.locations ?? []) {
    const at = iso(r.timestamp ?? r.timestampMs);
    if (at && typeof r.latitudeE7 === "number" && typeof r.longitudeE7 === "number") {
      out.push({ at, lat: r.latitudeE7 / 1e7, lon: r.longitudeE7 / 1e7, accuracy: r.accuracy ?? null });
    }
  }
  for (const seg of data?.semanticSegments ?? []) fromSegment(seg, out);
  for (const raw of data?.rawSignals ?? []) {
    const ll = parseLatLng(raw.position?.LatLng);
    const at = iso(raw.position?.timestamp);
    if (ll && at) out.push({ at, lat: ll[0], lon: ll[1], accuracy: raw.position?.accuracyMeters ?? null });
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
