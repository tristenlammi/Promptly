/** Links into P Maps, for any app with an address or a pin. Nothing here goes
 *  to an outside map: a place you look up stays on your server. */

export function mapsSearchLink(text: string): string {
  return `/maps?q=${encodeURIComponent(text)}`;
}

/** A whole trip: opens with the route already asked for. */
export function mapsRouteLink(stops: { lat: number; lon: number; name: string }[], mode?: string): string {
  const route = stops.map((s) => `${s.lat},${s.lon},${s.name.replaceAll(";", " ")}`).join(";");
  return `/maps?route=${encodeURIComponent(route)}${mode ? `&mode=${mode}` : ""}`;
}

export function mapsPinLink(lat: number, lon: number, name = "Pin"): string {
  return `/maps?to=${lat},${lon},${encodeURIComponent(name)}`;
}
