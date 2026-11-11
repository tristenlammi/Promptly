// The live channel's client with a fake socket and a fake clock: when it pulls, when it doesn't
// (its own writes coming back), how it coalesces a burst, and how it reconnects.
import { describe, expect, it } from "vitest";

import { LiveChannel, type LiveOptions, type LiveSocket, liveUrl } from "./live";

class FakeSocket implements LiveSocket {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  closedWith: number | null = null;
  constructor(public url: string) {}
  send(d: string) {
    this.sent.push(d);
  }
  close(code = 1000) {
    this.closedWith = code;
    this.readyState = 3;
  }
  // The server's side.
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  say(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function rig(over: Partial<LiveOptions> = {}) {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; f: () => void }>();
  const sockets: FakeSocket[] = [];
  const local: Record<string, number> = { personal: 5, shared: 2 };
  const pulls: number[] = [];
  let unlocked = true;
  const ch = new LiveChannel({
    baseUrl: () => "https://promptly.example/",
    credentials: async () => (unlocked ? { token: "pwd_tok", session: "pws_sess" } : null),
    behind: async (r) => Object.entries(r).some(([id, rev]) => (local[id] ?? -1) < rev),
    pull: async () => {
      pulls.push(t);
      // A pull brings this device up to what the server had.
      Object.assign(local, server);
    },
    socket: (u) => {
      const s = new FakeSocket(u);
      sockets.push(s);
      return s;
    },
    now: () => t,
    setTimer: (f, ms) => {
      timers.set(++seq, { at: t + ms, f });
      return seq;
    },
    clearTimer: (id) => void timers.delete(id as number),
    ...over,
  });
  const server: Record<string, number> = { ...local };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  async function advance(ms: number) {
    const end = t + ms;
    for (;;) {
      await flush();
      const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      t = due[1].at;
      due[1].f();
      await flush();
    }
    t = end;
    await flush();
  }
  const last = () => sockets[sockets.length - 1];
  async function connect() {
    ch.start(true);
    await flush();
    last().open();
    last().say({ t: "hello", vaults: { ...server } });
    await advance(0);
  }
  return { ch, sockets, last, local, server, pulls, advance, connect, flush, lock: () => (unlocked = false), now: () => t };
}

describe("liveUrl", () => {
  it("swaps the scheme and keeps a path prefix, never a query", () => {
    expect(liveUrl("https://promptly.example")).toBe("wss://promptly.example/api/passwords/live");
    expect(liveUrl("http://localhost:8092/")).toBe("ws://localhost:8092/api/passwords/live");
    expect(liveUrl("https://h.example/sub/?x=1#y")).toBe("wss://h.example/sub/api/passwords/live");
    expect(liveUrl("")).toBeNull();
    expect(liveUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("LiveChannel", () => {
  it("signs in with its first message, not the URL", async () => {
    const r = rig();
    await r.connect();
    expect(r.last().url).toBe("wss://promptly.example/api/passwords/live");
    expect(JSON.parse(r.last().sent[0])).toEqual({ token: "pwd_tok", session: "pws_sess" });
    expect(r.ch.connected).toBe(true);
  });

  it("pulls on hello only when it missed something", async () => {
    const r = rig();
    await r.connect();
    expect(r.pulls).toEqual([]);
    const s = rig();
    s.server.personal = 9;
    await s.connect();
    expect(s.pulls.length).toBe(1);
  });

  it("a change elsewhere is pulled within the settle time", async () => {
    const r = rig();
    await r.connect();
    r.server.personal = 6;
    r.last().say({ t: "changed", vault: "personal", revision: 6 });
    await r.advance(399);
    expect(r.pulls).toEqual([]);
    await r.advance(1);
    expect(r.pulls.length).toBe(1);
    expect(r.local.personal).toBe(6);
  });

  it("a burst is one pull", async () => {
    const r = rig();
    await r.connect();
    for (let i = 6; i < 30; i++) {
      r.server.personal = i;
      r.last().say({ t: "changed", vault: "personal", revision: i });
      await r.advance(100);
    }
    await r.advance(1000);
    expect(r.pulls.length).toBe(1);
    expect(r.local.personal).toBe(29);
  });

  it("its own write coming back isn't pulled again (no echo)", async () => {
    const r = rig();
    await r.connect();
    // This device pushed revision 6 and has already pulled past it when the news arrives.
    r.local.personal = 6;
    r.server.personal = 6;
    r.last().say({ t: "changed", vault: "personal", revision: 6 });
    await r.advance(1000);
    expect(r.pulls).toEqual([]);
  });

  it("a change heard during a pull is looked at after it", async () => {
    let release: () => void = () => undefined;
    const r = rig({
      pull: () => new Promise<void>((res) => (release = res)),
    });
    await r.connect();
    r.last().say({ t: "changed", vault: "personal", revision: 6 });
    await r.advance(400);
    r.last().say({ t: "changed", vault: "shared", revision: 3 });
    await r.advance(400);
    release();
    await r.advance(10);
    release();
    await r.advance(10);
    expect(r.ch.pulls).toBe(2);
  });

  it("reconnects with a growing wait, and a hello resets it", async () => {
    const r = rig();
    await r.connect();
    r.last().drop();
    await r.advance(1999);
    expect(r.sockets.length).toBe(1);
    await r.advance(1);
    expect(r.sockets.length).toBe(2);
    r.last().drop(); // never opened
    await r.advance(3999);
    expect(r.sockets.length).toBe(2);
    await r.advance(1);
    expect(r.sockets.length).toBe(3);
    r.last().open();
    r.last().say({ t: "hello", vaults: { ...r.server } });
    r.last().drop();
    await r.advance(2000);
    expect(r.sockets.length).toBe(4);
  });

  it("start() while waiting out a failure doesn't hammer the server, unless it's an unlock", async () => {
    const r = rig();
    await r.connect();
    r.last().drop();
    r.ch.start();
    await r.flush();
    expect(r.sockets.length).toBe(1);
    r.ch.start(true);
    await r.flush();
    expect(r.sockets.length).toBe(2);
  });

  it("a refusal waits the long time", async () => {
    const r = rig({ refusedMs: 60_000 });
    await r.connect();
    r.last().drop(4401);
    await r.advance(59_999);
    expect(r.sockets.length).toBe(1);
    await r.advance(1);
    expect(r.sockets.length).toBe(2);
  });

  it("silence means a dead link: it closes and connects again", async () => {
    const r = rig();
    await r.connect();
    await r.advance(69_999);
    expect(r.sockets.length).toBe(1);
    await r.advance(1);
    expect(r.sockets[0].closedWith).toBe(4000);
    await r.advance(2000);
    expect(r.sockets.length).toBe(2);
  });

  it("pings keep it open", async () => {
    const r = rig();
    await r.connect();
    for (let i = 0; i < 10; i++) {
      await r.advance(25_000);
      r.last().say({ t: "ping" });
    }
    expect(r.sockets.length).toBe(1);
    expect(r.sockets[0].closedWith).toBeNull();
  });

  it("stop() closes it and nothing comes back, and a pending pull is dropped", async () => {
    const r = rig();
    await r.connect();
    r.server.personal = 7;
    r.last().say({ t: "changed", vault: "personal", revision: 7 });
    r.ch.stop();
    expect(r.sockets[0].closedWith).toBe(1000);
    await r.advance(10 * 60_000);
    expect(r.sockets.length).toBe(1);
    expect(r.pulls).toEqual([]);
  });

  it("locked, it doesn't connect at all", async () => {
    const r = rig();
    r.lock();
    r.ch.start(true);
    await r.advance(1000);
    expect(r.sockets.length).toBe(0);
  });

  it("only one socket however often it's started", async () => {
    const r = rig();
    for (let i = 0; i < 5; i++) r.ch.start(true);
    await r.flush();
    expect(r.sockets.length).toBe(1);
  });
});
