import { useEffect, useState } from "react";

/** Which colours the map wears: by the sun where you are, or always one way. */
export type MapTheme = "auto" | "light" | "dark";

export const MAP_THEMES: { value: MapTheme; label: string }[] = [
  { value: "auto", label: "Automatic" },
  { value: "light", label: "Always light" },
  { value: "dark", label: "Always dark" },
];

const KEY = "promptly.maps.theme";
// The sun's centre is this far below a flat horizon when its top edge touches it.
const HORIZON = -0.833;

const rad = (degrees: number) => (degrees * Math.PI) / 180;
const turn = (degrees: number) => ((degrees % 360) + 360) % 360;

/** How high the sun is, in degrees: below zero, it's under the horizon. Worked out
 *  here from where and when (the same sums as the phone app); nothing is looked up. */
export function sunElevation(lat: number, lon: number, at: Date): number {
  // Days since noon on 1 January 2000, the almanac's starting point.
  const n = at.getTime() / 86_400_000 + 2440587.5 - 2451545.0;
  const meanLongitude = rad(turn(280.46 + 0.9856474 * n));
  const anomaly = rad(turn(357.528 + 0.9856003 * n));
  const longitude = meanLongitude + rad(1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly));
  const tilt = rad(23.439 - 0.0000004 * n);
  const rightAscension = Math.atan2(Math.cos(tilt) * Math.sin(longitude), Math.cos(longitude));
  const declination = Math.asin(Math.sin(tilt) * Math.sin(longitude));
  const greenwichHours = 18.697374558 + 24.06570982441908 * n;
  const hourAngle = rad(turn(greenwichHours * 15 + lon)) - rightAscension;
  const latitude = rad(lat);
  return (Math.asin(Math.sin(latitude) * Math.sin(declination) + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle)) * 180) / Math.PI;
}

/** Not knowing where you are: dark from six in the evening to six in the morning. */
export function darkByClock(at: Date): boolean {
  const hour = at.getHours();
  return hour >= 18 || hour < 6;
}

/** Should the map be dark now? */
export function mapDark(theme: MapTheme, position: { lat: number; lon: number } | null, at: Date = new Date()): boolean {
  if (theme === "light") return false;
  if (theme === "dark") return true;
  return position ? sunElevation(position.lat, position.lon, at) < HORIZON : darkByClock(at);
}

export function savedMapTheme(): MapTheme {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "auto";
  } catch {
    return "auto";
  }
}

export function saveMapTheme(theme: MapTheme): void {
  try {
    window.localStorage.setItem(KEY, theme);
  } catch {
    // Private windows can refuse; the choice then lasts until the page closes.
  }
}

/** Light or dark for the map, looked at again every minute so it turns at sunset
 *  and sunrise while the page is open. */
export function useMapColours(theme: MapTheme, position: { lat: number; lon: number } | null): "light" | "dark" {
  // To a tenth of a degree is plenty for the sun, and doesn't redo this on every GPS fix.
  const lat = position ? Math.round(position.lat * 10) / 10 : null;
  const lon = position ? Math.round(position.lon * 10) / 10 : null;
  const work = () => (mapDark(theme, lat != null && lon != null ? { lat, lon } : null) ? "dark" : "light");
  const [colours, setColours] = useState<"light" | "dark">(work);
  useEffect(() => {
    setColours(work());
    if (theme !== "auto") return;
    const timer = window.setInterval(() => setColours(work()), 60_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, lat, lon]);
  return colours;
}
