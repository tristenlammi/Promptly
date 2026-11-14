/**
 * The Promptly Android app's own GPS, for the map page it opens.
 *
 * A page in the app's launcher is Chrome, and Chrome only hands a page's
 * location request to the app once Google has verified the app against this
 * server. Where that can't happen, `navigator.geolocation` fails for good
 * ("NoTwaFound", "User denied"). So the app gives its position another way:
 *
 * - its launchers open pages with `#pl=<key>`, a random key only the app and
 *   this page know (a fragment never reaches a server);
 * - while the map is in front and the browser can't say where you are, this
 *   asks the server with the key about once a second
 *   (`backend/app/maps/phone_location.py`), and gets back what the app posted;
 * - the app's side (`android/.../maps/PageLocationService.kt`) only runs its
 *   GPS while someone is asking.
 *
 * Imported early (`main.tsx`) to read the key before the router tidies the
 * address. Nothing here runs outside the app's own pages.
 */
import { apiClient } from "@/api/client";

const STORE = "promptly.maps.phoneKey";
const KEY = /^[A-Za-z0-9_-]{32,128}$/;

export interface PhoneFix {
  lat: number;
  lon: number;
  accuracy: number | null;
  heading: number | null;
  speed: number | null;
  /** Seconds since the app sent it. */
  age: number;
}

/** `#pl=<key>` out of the address, and out of sight. */
export function capturePhoneKey(): void {
  try {
    const hash = window.location.hash;
    if (!hash.includes("pl=")) return;
    const q = new URLSearchParams(hash.slice(1));
    const key = q.get("pl") ?? "";
    q.delete("pl");
    if (KEY.test(key)) window.sessionStorage.setItem(STORE, key);
    const rest = q.toString();
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search + (rest ? `#${rest}` : ""));
  } catch {
    /* no storage: the browser's own location is all there is */
  }
}

/** The key this tab was opened with by the app, or null in any other browser. */
export function phoneKey(): string | null {
  try {
    const v = window.sessionStorage.getItem(STORE);
    return v && KEY.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Ask for the phone's position about once a second while this tab is in
 * front; `onFix` gets each new one. Returns the stop. Stopping (or hiding the
 * tab) is what tells the app to turn its GPS off: it stops being asked.
 */
export function watchPhoneLocation(onFix: (fix: PhoneFix) => void, everyMs = 1000): () => void {
  const key = phoneKey();
  if (!key) return () => undefined;
  let live = true;
  let busy = false;
  let last = "";
  const tick = async () => {
    if (!live || busy || document.visibilityState !== "visible") return;
    busy = true;
    try {
      const { data } = await apiClient.post<{ fix: PhoneFix | null }>("/maps/phone-location/ask", { key });
      const fix = data.fix;
      if (live && fix) {
        // The same fix again (the phone hasn't moved on yet) isn't news.
        const mark = `${fix.lat},${fix.lon},${Math.round(fix.age)}`;
        if (mark !== last) {
          last = mark;
          onFix(fix);
        }
      }
    } catch {
      /* offline, signed out, or not this account's phone: the hint line says so */
    } finally {
      busy = false;
    }
  };
  void tick();
  const id = window.setInterval(() => void tick(), everyMs);
  return () => {
    live = false;
    window.clearInterval(id);
  };
}

/** Opens the app for a moment so it can start (or be allowed) its GPS, then
 *  comes straight back. Must be followed from a tap. */
export function phoneLocateLink(): string {
  return "intent://maps/locate#Intent;scheme=promptly;package=org.promptly.app;end";
}

capturePhoneKey();
