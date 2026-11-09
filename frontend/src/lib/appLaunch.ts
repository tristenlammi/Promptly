/**
 * Which window is this: Promptly, or one of its apps installed on its own?
 *
 * Every app installs separately (its own manifest, scope and icon), but an
 * installed app's window and the installed Promptly window both report
 * ``display-mode: standalone``, so the display mode alone can't tell them
 * apart. The launch can: each app's manifest ``start_url`` carries
 * ``source=pwa`` (and the Android launchers add ``source=android``), so the
 * first page an installed app opens on says which app it is. That's
 * remembered for the window (sessionStorage lives as long as the window
 * does) and read everywhere a page decides whether to show Promptly's
 * navigation.
 *
 * The rule: a page shows Promptly's navigation unless this window was
 * launched as that page's own app. A browser tab, the installed Promptly
 * window, a window opened from a notification, anything without the
 * launch marker: all of those are "inside Promptly".
 *
 * No imports on purpose: the isolated Passwords page (its own document, its
 * own CSP) uses this too, and must not pull in any of the main app.
 */

const LAUNCH_KEY = "promptly:launched-app";
const MARKERS = new Set(["pwa", "android"]);

export type Launch = { key: string; via: "pwa" | "android" };

/** Running as an installed app (its own window), not in a browser tab. */
export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.matchMedia?.("(display-mode: window-controls-overlay)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** Which of Promptly's apps a path belongs to (each installs separately). */
export function appKeyFor(path: string): string {
  const under = (base: string) => path === base || path.startsWith(`${base}/`);
  if (under("/photos")) return "photos";
  if (under("/rooms")) return "rooms";
  if (under("/calendar")) return "calendar";
  if (under("/maps")) return "maps";
  if (under("/mail")) return "mail";
  if (under("/notes")) return "notes";
  if (under("/passwords")) return "passwords";
  // An Android launcher's fixed address for an Item Store app; it becomes
  // that person's ``/app/<file>/`` once opened (see rememberLaunchedApp).
  const open = /^\/app\/open\/([^/]+)/.exec(path);
  if (open) return `open:${open[1]}`;
  const m = /^\/app\/([^/]+)/.exec(path);
  return m ? `app:${m[1]}` : "promptly";
}

/** The launch a URL marks, or null. ``source=pwa`` counts only in an
 *  installed window (a copied start URL in a browser tab is still a tab);
 *  ``source=android`` comes from Promptly's own Android launchers. */
export function launchFromUrl(href: string, standalone: boolean): Launch | null {
  let url: URL;
  try {
    url = new URL(href, "http://x");
  } catch {
    return null;
  }
  const source = url.searchParams.get("source");
  if (!source || !MARKERS.has(source)) return null;
  if (source === "pwa" && !standalone) return null;
  return { key: appKeyFor(url.pathname), via: source as Launch["via"] };
}

function readLaunch(): Launch | null {
  try {
    const raw = sessionStorage.getItem(LAUNCH_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Launch>;
    return typeof v.key === "string" && (v.via === "pwa" || v.via === "android") ? (v as Launch) : null;
  } catch {
    return null;
  }
}

function writeLaunch(launch: Launch): void {
  try {
    sessionStorage.setItem(LAUNCH_KEY, JSON.stringify(launch));
  } catch {
    /* storage blocked: the window counts as Promptly */
  }
}

/** Remember the launch this page's address marks (a fresh launch replaces
 *  an older one). Runs on import; safe to call again. */
export function recordLaunch(): void {
  if (typeof window === "undefined") return;
  const launch = launchFromUrl(window.location.href, isStandaloneDisplay());
  if (launch) writeLaunch(launch);
}

recordLaunch();

/** The app this window was launched as (``"promptly"``, ``"rooms"``,
 *  ``"app:<file>"``…) when it was launched as an installed app, else null. */
export function launchedAppKey(): string | null {
  const launch = typeof window === "undefined" ? null : readLaunch();
  if (launch && (launch.via === "android" || isStandaloneDisplay())) return launch.key;
  return isStandaloneDisplay() ? "promptly" : null;
}

/** The launcher's address resolved to the app it opens: carry the launch
 *  over (``/app/open/budget`` → ``/app/<file>/``). Only when this window
 *  really was launched at ``from``. */
export function rememberLaunchedApp(from: string, to: string): void {
  const launch = readLaunch();
  if (launch && launch.key === from) writeLaunch({ key: to, via: launch.via });
}

/** This window is the given app running as its own installed app. */
export function isOwnAppWindow(appKey: string): boolean {
  return appKey !== "promptly" && launchedAppKey() === appKey;
}

/** Show Promptly's navigation on a page of this app? Yes, unless the window
 *  is that app installed on its own. */
export function showsPromptlyNav(appKey: string): boolean {
  return !isOwnAppWindow(appKey);
}
