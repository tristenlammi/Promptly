// A stand-in for a Promptly Home box: it dials the server's box socket and
// speaks the box protocol (backend/app/home/relay.py), with a few made-up
// devices and no Home Assistant behind it. Enough for the Home page to be
// driven end to end: devices by room, a tap that changes one, going offline.
import { BASE_URL } from "./stack";

export type Entity = { id: string; domain: string; name: string; state: string; area?: string; unit?: string; cls?: string; dev?: string; x?: Record<string, unknown> };
type Setup = { s: string; b: string; k: string };
export type Found = { uri: string; kind: string; name: string; artist?: string; album?: string; by?: string };
/** A box with a music service: what's linked, and what a search finds for each set of words. */
export type Music = { linked: boolean; finds: Record<string, Found[]>; approved: boolean; /** What was played here lately (for a bare "play music"). */ recent?: Found[] };

export function readSetup(setup: string): Setup {
  const body = setup.replace(/^pbox1\./, "").replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(body, "base64").toString("utf8"));
}

export class FakeBox {
  private ws: WebSocket | null = null;
  readonly asked: { op: string; args: Record<string, unknown> }[] = [];
  areas: { id: string; name: string }[];
  entities: Entity[];
  /** Set it to give this box a music service (see ``Music``). */
  music: Music | null = null;

  constructor(private setup: Setup, areas: { id: string; name: string }[], entities: Entity[]) {
    this.areas = areas;
    this.entities = entities;
  }

  private send(msg: unknown) {
    this.ws?.send(JSON.stringify(msg));
  }

  /** Connect, say who we are, and (once welcomed) send what's in the home. */
  async up(): Promise<{ claimed: boolean }> {
    const url = BASE_URL.replace(/^http/, "ws") + "/api/home/box/ws";
    const ws = new WebSocket(url);
    this.ws = ws;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the fake box was never welcomed")), 15_000);
      ws.addEventListener("open", () => this.send({ t: "hello", box: this.setup.b, key: this.setup.k, v: "e2e" }));
      ws.addEventListener("error", () => reject(new Error("the fake box couldn't reach the server's box socket")));
      ws.addEventListener("message", (ev) => {
        const m = JSON.parse(String(ev.data)) as { t: string; id?: string; op?: string; args?: Record<string, unknown>; claimed?: boolean };
        if (m.t === "welcome") {
          clearTimeout(timer);
          this.snapshot();
          resolve({ claimed: !!m.claimed });
        } else if (m.t === "ping") this.send({ t: "pong" });
        else if (m.t === "claimed") this.snapshot();
        else if (m.t === "req") this.answer(m.id!, m.op!, m.args ?? {});
      });
    });
  }

  snapshot() {
    this.send({ t: "snapshot", areas: this.areas, entities: this.entities });
  }

  private answer(id: string, op: string, args: Record<string, unknown>) {
    this.asked.push({ op, args });
    if (op === "do") {
      const e = this.entities.find((x) => x.id === args.entity);
      if (!e) return this.send({ t: "res", id, ok: false, error: "No such device" });
      const a = String(args.action);
      if (a === "turn_on") e.state = e.domain === "climate" ? String(e.x?.last ?? "fan_only") : "on";
      else if (a === "turn_off") e.state = "off";
      else if (a === "mode") e.state = String(args.value);
      else if (a === "pause") e.state = "paused";
      else if (a === "play") e.state = "playing";
      else if (a === "toggle") e.state = e.state === "on" ? "off" : "on";
      this.send({ t: "res", id, ok: true, data: null });
      return this.send({ t: "state", e });
    }
    if (op === "room.lights") {
      const lights = this.entities.filter((x) => x.domain === "light" && x.area === args.area);
      if (!lights.length) return this.send({ t: "res", id, ok: false, error: "There are no lights in that room." });
      for (const e of lights) e.state = args.action === "turn_on" ? "on" : "off";
      this.send({ t: "res", id, ok: true, data: null });
      for (const e of lights) this.send({ t: "state", e });
      return;
    }
    if (op.startsWith("music.")) return this.musicOp(id, op, args);
    if (op === "flows.found") return this.send({ t: "res", id, ok: true, data: [] });
    if (op === "entries.list") return this.send({ t: "res", id, ok: true, data: [] });
    this.send({ t: "res", id, ok: false, error: "The test box doesn't do that." });
  }

  /** Music by name, as a real box answers (backend/app/home/relay.py). */
  private musicOp(id: string, op: string, args: Record<string, unknown>) {
    const m = this.music;
    const ok = (data: unknown) => this.send({ t: "res", id, ok: true, data });
    const no = (error: string) => this.send({ t: "res", id, ok: false, error });
    if (!m) return no("This home's box has no music service. It may need updating.");
    const open = { state: "open", brand: "tidal", name: "Tidal", flow: "e2eflow1", url: "https://link.tidal.com/E2EAB", code: "E2EAB", until: Math.floor(Date.now() / 1000) + 300 };
    if (op === "music.status") {
      return ok({
        brands: [{ id: "tidal", name: "Tidal" }],
        sources: m.linked ? [{ id: "tidal--e2e", brand: "tidal", name: "Tidal" }] : [],
        speakers: this.entities.filter((e) => ((e.x?.can as string[] | undefined) ?? []).includes("music")).map((e) => e.id),
      });
    }
    if (op === "music.link.start") return m.linked ? no("Tidal is already linked.") : ok(open);
    if (op === "music.link.get") {
      if (m.approved) m.linked = true;
      return ok(m.linked ? { state: "done", brand: "tidal", name: "Tidal" } : open);
    }
    if (op === "music.link.abort") return ok(null);
    if (op === "music.unlink") {
      m.linked = false;
      m.approved = false;
      return ok(null);
    }
    if (op === "music.search") {
      if (!m.linked) return no("No music service is linked to this home yet.");
      const kinds = (args.kinds as string[] | undefined) ?? [];
      return ok((m.finds[String(args.q).toLowerCase()] ?? []).filter((r) => kinds.includes(r.kind)));
    }
    if (op === "music.suggest") {
      if (!m.linked) return no("No music service is linked to this home yet.");
      return ok(m.recent ?? []);
    }
    if (op === "music.play") {
      const e = this.entities.find((x) => x.id === args.entity);
      const found = [...Object.values(m.finds).flat(), ...(m.recent ?? [])].find((r) => r.uri === args.uri);
      if (!e || !found) return no("That isn't something from this home's music.");
      e.state = "playing";
      e.x = { ...e.x, title: found.name, artist: found.artist ?? "" };
      ok(null);
      return this.send({ t: "state", e });
    }
    return no("The test box doesn't do that.");
  }

  /** Something changed at the device itself. */
  change(entityId: string, state: string) {
    const e = this.entities.find((x) => x.id === entityId);
    if (!e) throw new Error(`no ${entityId}`);
    e.state = state;
    this.send({ t: "state", e });
  }

  down() {
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = null;
  }
}
