// The live channel's client: a WebSocket to /api/passwords/live that says "this vault is at
// revision N" the moment another device writes to it, so this one pulls now instead of on its
// next minute (backend/app/passwords/live.py, passwords/BOOKMARKS.md). It never carries an
// item; what changed comes through the normal sync. No browser APIs beyond WebSocket and
// timers, both injectable, so it's tested in Node (live.test.ts).

export type LiveMessage = { t: "hello"; vaults: Record<string, number> } | { t: "changed"; vault: string; revision: number } | { t: "ping" };

/** The bits of a WebSocket this uses. */
export interface LiveSocket {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number): void;
}

export type LiveOptions = {
  /** The server's address, as the vault API has it ("" or null: none yet). */
  baseUrl: () => string | null;
  /** The same bearer and vault session the API sends; null while locked. */
  credentials: () => Promise<{ token: string; session: string } | null>;
  /** Would a sync bring anything, given these revisions? (VaultClient.behind) */
  behind: (revisions: Record<string, number>) => Promise<boolean>;
  /** Sync, and whatever runs after one (bookmarks). */
  pull: () => Promise<unknown>;
  socket?: (url: string) => LiveSocket;
  /** A burst of writes (a folder import, a batch) is one pull. */
  settleMs?: number;
  /** Nothing heard for this long (the server pings every 25 s) means a dead link. */
  silenceMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** After the server refused (locked, revoked, turned off). Default: the cap. */
  refusedMs?: number;
  now?: () => number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
};

const OPEN = 1;
/** Locked, revoked, or Passwords turned off: trying again soon won't help. */
const REFUSED = new Set([4401, 4403]);

export function liveUrl(baseUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/api/passwords/live`;
  u.search = "";
  u.hash = "";
  return u.toString();
}

export class LiveChannel {
  private ws: LiveSocket | null = null;
  private opening = false;
  private stopped = true;
  private backoff: number;
  private notBefore = 0;
  private retryTimer: unknown = null;
  private silenceTimer: unknown = null;
  private settleTimer: unknown = null;
  private wanted: Record<string, number> = {};
  private pulling: Promise<void> | null = null;
  private again = false;
  /** For the settings screen and tests. */
  hellos = 0;
  pulls = 0;

  constructor(private o: LiveOptions) {
    this.backoff = o.minBackoffMs ?? 2000;
  }

  private get now() {
    return (this.o.now ?? Date.now)();
  }
  private timer(f: () => void, ms: number): unknown {
    return (this.o.setTimer ?? ((g, m) => setTimeout(g, m)))(f, ms);
  }
  private clear(t: unknown) {
    if (t !== null && t !== undefined) (this.o.clearTimer ?? ((x) => clearTimeout(x as ReturnType<typeof setTimeout>)))(t);
  }

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === OPEN && this.hellos > 0;
  }

  /** Connects unless it's connected, connecting, or waiting out a failure. `fresh` (an unlock)
   *  doesn't wait. Safe to call every time the worker wakes. */
  start(fresh = false): void {
    this.stopped = false;
    if (this.ws || this.opening) return;
    if (fresh) {
      this.notBefore = 0;
      this.backoff = this.o.minBackoffMs ?? 2000;
    }
    if (this.now < this.notBefore) return;
    void this.open();
  }

  /** Locking: the socket goes, and nothing reconnects until start(). */
  stop(): void {
    this.stopped = true;
    this.clear(this.retryTimer);
    this.clear(this.silenceTimer);
    this.clear(this.settleTimer);
    this.retryTimer = this.silenceTimer = this.settleTimer = null;
    this.wanted = {};
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000);
    } catch {
      /* already gone */
    }
  }

  private async open(): Promise<void> {
    const base = this.o.baseUrl();
    const url = base ? liveUrl(base) : null;
    if (!url) return;
    this.opening = true;
    let creds: { token: string; session: string } | null;
    try {
      creds = await this.o.credentials();
    } catch {
      creds = null;
    } finally {
      this.opening = false;
    }
    if (!creds || this.stopped || this.ws) return;
    let ws: LiveSocket;
    try {
      ws = (this.o.socket ?? ((u) => new WebSocket(u) as unknown as LiveSocket))(url);
    } catch {
      this.failed(false);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      ws.send(JSON.stringify({ token: creds.token, session: creds.session }));
      this.heard(ws);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.heard(ws);
      let m: LiveMessage;
      try {
        m = JSON.parse(String(ev.data)) as LiveMessage;
      } catch {
        return;
      }
      if (m.t === "hello" && m.vaults && typeof m.vaults === "object") {
        this.hellos++;
        this.backoff = this.o.minBackoffMs ?? 2000;
        // Anything missed while there was no socket shows here.
        this.want(m.vaults, 0);
      } else if (m.t === "changed" && typeof m.vault === "string" && typeof m.revision === "number") {
        this.want({ [m.vault]: m.revision }, this.o.settleMs ?? 400);
      }
    };
    ws.onerror = () => undefined;
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clear(this.silenceTimer);
      this.silenceTimer = null;
      if (!this.stopped) this.failed(REFUSED.has(ev.code));
    };
  }

  private heard(ws: LiveSocket): void {
    this.clear(this.silenceTimer);
    this.silenceTimer = this.timer(() => {
      if (this.ws !== ws) return;
      // No ping in time: a proxy or a sleeping laptop has left a socket that goes nowhere.
      this.ws = null;
      try {
        ws.close(4000);
      } catch {
        /* gone */
      }
      if (!this.stopped) this.failed(false);
    }, this.o.silenceMs ?? 70_000);
  }

  /** Waits longer each time, up to the cap. A refusal waits `refusedMs`: by then the minute's
   *  sync will have proved the session again, if it can. */
  private failed(refused: boolean): void {
    const max = this.o.maxBackoffMs ?? 5 * 60_000;
    const wait = refused ? (this.o.refusedMs ?? max) : this.backoff;
    this.backoff = Math.min(max, this.backoff * 2);
    this.notBefore = this.now + wait;
    this.clear(this.retryTimer);
    this.retryTimer = this.timer(() => {
      this.retryTimer = null;
      if (!this.stopped) this.start();
    }, wait);
  }

  private want(revisions: Record<string, number>, ms: number): void {
    for (const [id, r] of Object.entries(revisions)) if (typeof r === "number") this.wanted[id] = Math.max(this.wanted[id] ?? 0, r);
    this.clear(this.settleTimer);
    this.settleTimer = this.timer(() => {
      this.settleTimer = null;
      void this.pullIfBehind();
    }, ms);
  }

  /** One pull at a time. A change heard during one is looked at again after it. */
  private pullIfBehind(): Promise<void> {
    if (this.pulling) {
      this.again = true;
      return this.pulling;
    }
    this.pulling = (async () => {
      try {
        do {
          this.again = false;
          const wanted = this.wanted;
          this.wanted = {};
          if (this.stopped || !Object.keys(wanted).length) continue;
          // Our own write comes back too, once this device has already pulled past it: no pull.
          if (!(await this.o.behind(wanted).catch(() => true))) continue;
          this.pulls++;
          await this.o.pull().catch(() => undefined);
        } while (this.again);
      } finally {
        this.pulling = null;
      }
    })();
    return this.pulling;
  }
}
