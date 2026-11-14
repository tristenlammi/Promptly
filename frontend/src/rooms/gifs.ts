/**
 * The GIF library (GIPHY or KLIPY), searched straight from this device.
 *
 * Both libraries' terms require it this way: searches and GIFs go from the
 * person's own app or browser to the library, never through the app's
 * server, and the app keeps no copies. So the server only hands over which
 * library is on and its key (``Bootstrap.media.gif_search``); everything
 * here talks to the library directly.
 *
 * What the library learns: this device's internet address and the words
 * searched. What it doesn't: who you are on this server, or this server's
 * address (no referrer is sent, and no cookies).
 *
 * Adding a library: write a ``search`` like the two below that returns
 * ``LibraryGif``s, add it to ``LIBRARIES``, add its hosts to
 * ``GIF_HOSTS`` (api/rooms.ts), ``PROVIDER_HOSTS`` (backend
 * rooms/media.py) and the page's CSP (nginx/nginx.conf).
 */
import type { GifProvider, GifSearchConfig, LibraryGif } from "@/api/rooms";
import { isLibraryUrl } from "@/api/rooms";

export interface GifPage {
  gifs: LibraryGif[];
  /** Pass back for the next page; null when there is no more. */
  next: number | null;
}

export class GifLibraryError extends Error {
  constructor(
    message: string,
    /** "busy": over the key's allowance. "key": the key was refused. */
    public readonly kind: "busy" | "key" | "down",
  ) {
    super(message);
  }
}

export const LIBRARY_NAMES: Record<GifProvider, string> = { giphy: "GIPHY", klipy: "KLIPY" };

const PER_PAGE = 24;

async function getJson(url: string, name: string, signal?: AbortSignal): Promise<unknown> {
  let r: Response;
  try {
    r = await fetch(url, { signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") throw e;
    throw new GifLibraryError(`Couldn't reach ${name}. Check your connection and try again.`, "down");
  }
  if (r.status === 429) throw new GifLibraryError(`${name} is taking a break: this server has used its searches for the hour. Try again soon.`, "busy");
  if (r.status === 401 || r.status === 403) throw new GifLibraryError(`${name} refused this server's key. An admin needs to check it in Admin → Rooms.`, "key");
  if (!r.ok) throw new GifLibraryError(`${name} couldn't answer just now. Try again in a moment.`, "down");
  try {
    return await r.json();
  } catch {
    throw new GifLibraryError(`${name} sent something this page couldn't read.`, "down");
  }
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

// ------------------------------------------------------------------ GIPHY

const GIPHY_RATING = { family: "g", teen: "pg-13", all: "r" } as const;

async function giphy(cfg: GifSearchConfig, q: string, offset: number, signal?: AbortSignal): Promise<GifPage> {
  const params = new URLSearchParams({ api_key: cfg.key, limit: String(PER_PAGE), offset: String(offset), rating: GIPHY_RATING[cfg.rating] });
  // The exact words typed, as GIPHY asks (it caps them at 50 characters).
  if (q) params.set("q", q.slice(0, 50));
  const data = obj(await getJson(`https://api.giphy.com/v1/gifs/${q ? "search" : "trending"}?${params}`, "GIPHY", signal));
  const rows = Array.isArray(data.data) ? data.data : [];
  const gifs: LibraryGif[] = [];
  for (const row of rows) {
    const g = obj(row);
    const images = obj(g.images);
    const original = obj(images.original);
    const medium = obj(images.downsized_medium);
    const small = obj(images.fixed_width);
    // Addresses are used exactly as GIPHY returns them.
    const url = str(original.webp) || str(medium.url) || str(original.url);
    if (!isLibraryUrl("giphy", url)) continue;
    const preview = str(small.webp) || str(small.url);
    gifs.push({
      provider: "giphy",
      id: str(g.id),
      url,
      preview_url: isLibraryUrl("giphy", preview) ? preview : null,
      page_url: isLibraryUrl("giphy", g.url) ? str(g.url) : null,
      width: num(original.width),
      height: num(original.height),
      title: str(g.title).replace(/\s+GIF.*$/i, "").slice(0, 120),
    });
  }
  const page = obj(data.pagination);
  const total = num(page.total_count) ?? 0;
  const got = offset + rows.length;
  return { gifs, next: rows.length > 0 && got < Math.min(total, 500) ? got : null };
}

// ------------------------------------------------------------------ KLIPY

const KLIPY_FILTER = { family: "high", teen: "medium", all: "off" } as const;
const KLIPY_ID_KEY = "promptly:rooms:gif-device";

/** KLIPY asks for a steady id per user. This is a random one for this
 *  browser: it isn't your account, and it never leaves this device except
 *  to KLIPY. */
function klipyDevice(): string {
  try {
    let id = localStorage.getItem(KLIPY_ID_KEY);
    if (!id) {
      id = crypto.randomUUID().replace(/-/g, "");
      localStorage.setItem(KLIPY_ID_KEY, id);
    }
    return id;
  } catch {
    return "anon";
  }
}

async function klipy(cfg: GifSearchConfig, q: string, page: number, signal?: AbortSignal): Promise<GifPage> {
  const n = Math.max(1, page || 1);
  const params = new URLSearchParams({ page: String(n), per_page: String(PER_PAGE), customer_id: klipyDevice(), content_filter: KLIPY_FILTER[cfg.rating] });
  if (q) params.set("q", q.slice(0, 80));
  const base = `https://api.klipy.com/api/v1/${encodeURIComponent(cfg.key)}/gifs/${q ? "search" : "trending"}`;
  const body = obj(await getJson(`${base}?${params}`, "KLIPY", signal));
  const data = obj(body.data);
  const rows = Array.isArray(data.data) ? data.data : [];
  const gifs: LibraryGif[] = [];
  for (const row of rows) {
    const g = obj(row);
    const file = obj(g.file);
    const pick = (size: string) => {
      const s = obj(file[size]);
      const f = obj(s.webp).url ? obj(s.webp) : obj(s.gif);
      return isLibraryUrl("klipy", f.url) ? f : null;
    };
    const big = pick("hd") ?? pick("md") ?? pick("sm");
    if (!big) continue;
    const small = pick("sm") ?? pick("xs") ?? big;
    gifs.push({
      provider: "klipy",
      id: str(g.slug) || String(g.id ?? ""),
      url: str(big.url),
      preview_url: str(small.url),
      page_url: null,
      width: num(big.width),
      height: num(big.height),
      title: str(g.title).slice(0, 120),
    });
  }
  return { gifs, next: data.has_next === true && rows.length > 0 ? n + 1 : null };
}

const LIBRARIES: Record<GifProvider, (cfg: GifSearchConfig, q: string, cursor: number, signal?: AbortSignal) => Promise<GifPage>> = { giphy, klipy };

/** Search the library (no words: what's trending). ``cursor``: 0 to start,
 *  then the page's ``next``. */
export function searchGifs(cfg: GifSearchConfig, q: string, cursor = 0, signal?: AbortSignal): Promise<GifPage> {
  return LIBRARIES[cfg.provider](cfg, q.trim(), cursor, signal);
}

/** "Search GIPHY" / "Search KLIPY": both ask for their name on the box. */
export function searchLabel(provider: GifProvider): string {
  return `Search ${LIBRARY_NAMES[provider]}`;
}

/** Does the person's device ask for less motion? */
export function prefersLessMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
