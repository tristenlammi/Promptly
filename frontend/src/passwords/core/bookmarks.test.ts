// Many browsers, one vault, no network. A simulated browser behaves like the real API where it
// matters: indexes shift, a folder with something in it can't be removed, ids are its own.
import { describe, expect, it } from "vitest";

import { type Base, type BookmarkItem, type BookmarkNode, bookmarksHtml, bookmarkTree, type BrowserSide, type DeletedBookmark, massDeleteLimit, reconcile, rootKey, type SyncOptions, syncableUrl, type VaultSide } from "./bookmarks";

type Raw = { id: string; parent: string; title: string; url?: string; added: number };
/** One clock for every browser and the vault: what matters is what came before what. */
let clock = 0;

class FakeBrowser implements BrowserSide {
  raw = new Map<string, Raw>();
  order_ = new Map<string, string[]>();
  next = 1;
  /** A browser that doesn't say when a bookmark was added. */
  undated = false;
  constructor(public name: string) {}
  private list(p: string) {
    let l = this.order_.get(p);
    if (!l) this.order_.set(p, (l = []));
    return l;
  }
  add(parent: string, title: string, url?: string, index?: number): string {
    const id = `${this.name}-${this.next++}`;
    this.raw.set(id, { id, parent, title, url, added: ++clock });
    const l = this.list(parent);
    l.splice(index ?? l.length, 0, id);
    return id;
  }
  async read(): Promise<BookmarkNode[]> {
    return [...this.raw.values()].map((r) => ({ node: r.id, parent: r.parent, title: r.title, url: r.url, index: this.list(r.parent).indexOf(r.id), added: this.undated ? undefined : r.added }));
  }
  async order(p: string) {
    return [...this.list(p)];
  }
  async create(p: { parent: string; title: string; url?: string }) {
    if (!p.parent.startsWith("root:") && !this.raw.has(p.parent)) throw new Error("no parent");
    return this.add(p.parent, p.title, p.url);
  }
  async update(node: string, p: { title?: string; url?: string }) {
    const r = this.raw.get(node)!;
    if (p.title !== undefined) r.title = p.title;
    if (p.url !== undefined) r.url = p.url;
  }
  async move(node: string, p: { parent: string; index?: number }) {
    for (let at = p.parent; !at.startsWith("root:"); at = this.raw.get(at)!.parent) if (at === node) throw new Error("into itself");
    const r = this.raw.get(node)!;
    const from = this.list(r.parent);
    from.splice(from.indexOf(node), 1);
    r.parent = p.parent;
    const to = this.list(p.parent);
    to.splice(p.index ?? to.length, 0, node);
  }
  async remove(node: string) {
    if (this.list(node).length) throw new Error("not empty");
    const r = this.raw.get(node)!;
    const l = this.list(r.parent);
    l.splice(l.indexOf(node), 1);
    this.raw.delete(node);
  }
  removeTree(node: string) {
    for (const c of [...this.list(node)]) this.removeTree(c);
    const r = this.raw.get(node)!;
    const l = this.list(r.parent);
    l.splice(l.indexOf(node), 1);
    this.raw.delete(node);
  }
  /** The tree with its own ids gone, so two browsers can be compared. */
  shape(parent: string = rootKey("other")): unknown[] {
    return this.list(parent).map((id) => {
      const r = this.raw.get(id)!;
      return r.url !== undefined ? `${r.title}=${r.url}` : { [r.title]: this.shape(id) };
    });
  }
  all() {
    return { bar: this.shape(rootKey("bar")), other: this.shape(rootKey("other")), menu: this.shape(rootKey("menu")), mobile: this.shape(rootKey("mobile")) };
  }
}

class FakeVault implements VaultSide {
  items = new Map<string, BookmarkItem>();
  gone = new Set<string>();
  /** Recently deleted: kept, and not in read(). */
  trash = new Map<string, DeletedBookmark>();
  async read() {
    return [...this.items.values()].map((i) => ({ ...i }));
  }
  async deleted() {
    return [...this.trash.values()].map((i) => ({ ...i }));
  }
  restore(id: string) {
    const { at: _at, ...item } = this.trash.get(id)!;
    this.trash.delete(id);
    this.gone.delete(id);
    this.items.set(id, item);
  }
  async create(i: BookmarkItem) {
    this.items.set(i.id, { ...i });
  }
  async update(i: BookmarkItem) {
    if (this.gone.has(i.id)) return;
    this.items.set(i.id, { ...i });
  }
  async remove(id: string) {
    const had = this.items.get(id);
    if (had) this.trash.set(id, { ...had, at: ++clock });
    this.items.delete(id);
    this.gone.add(id);
  }
  /** Another device's copy, as it was when it last synced. */
  copy() {
    const c = new FakeVault();
    c.items = new Map([...this.items].map(([k, v]) => [k, { ...v }]));
    c.gone = new Set(this.gone);
    c.trash = new Map([...this.trash].map(([k, v]) => [k, { ...v }]));
    return c;
  }
  /** Last writer wins per item, deletions stay: what the vault's own sync gives, near enough. */
  absorb(o: FakeVault) {
    for (const id of o.gone) {
      this.gone.add(id);
      this.items.delete(id);
    }
    for (const [id, v] of o.trash) if (!this.trash.has(id)) this.trash.set(id, { ...v });
    for (const [id, v] of o.items) if (!this.gone.has(id)) this.items.set(id, { ...v });
  }
}

let ids = 0;
const options = { hash: (s: string) => `h:${s}`, newId: () => `item-${String(++ids).padStart(6, "0")}` };

class Device {
  base: Base = {};
  constructor(public browser: FakeBrowser, public vault: FakeVault) {}
  async run(allowMassDelete = false, more: Partial<SyncOptions> = {}) {
    const r = await reconcile(this.browser, this.vault, this.base, { ...options, allowMassDelete, ...more });
    if (r.status === "ok") this.base = r.base;
    return r;
  }
}

const BAR = rootKey("bar");
const OTHER = rootKey("other");

/** Runs until nothing's left to do. */
async function settle(devices: Device[]) {
  for (let i = 0; i < 6; i++) for (const d of devices) await d.run(true);
}

describe("bookmark sync", () => {
  it("the first run only adds, and two browsers end up with both sets", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    const b = new Device(new FakeBrowser("b"), vault);
    a.browser.add(BAR, "News", "https://news.example/");
    const f = a.browser.add(BAR, "Work");
    a.browser.add(f, "Wiki", "https://wiki.example/");
    b.browser.add(BAR, "Shop", "https://shop.example/");
    await settle([a, b]);
    expect(a.browser.all()).toEqual(b.browser.all());
    expect(a.browser.raw.size).toBe(4);
    expect(JSON.stringify(a.browser.all())).toContain("Wiki=https://wiki.example/");
    expect(JSON.stringify(b.browser.all())).toContain("News=https://news.example/");
  });

  it("the same bookmarks in two browsers meet up instead of doubling, even if both run at once", async () => {
    const shared = new FakeVault();
    const a = new Device(new FakeBrowser("a"), shared.copy());
    const b = new Device(new FakeBrowser("b"), shared.copy());
    for (const d of [a, b]) {
      const f = d.browser.add(BAR, "Work");
      d.browser.add(f, "Wiki", "https://wiki.example/");
      d.browser.add(BAR, "News", "https://news.example/");
    }
    await a.run();
    await b.run();
    shared.absorb(a.vault);
    shared.absorb(b.vault);
    a.vault = shared;
    b.vault = shared;
    await settle([a, b]);
    expect(a.browser.raw.size).toBe(3);
    expect(b.browser.raw.size).toBe(3);
    expect(a.browser.all()).toEqual(b.browser.all());
    expect(shared.items.size).toBe(3);
  });

  it("add, rename, move and delete reach the other browser", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    const b = new Device(new FakeBrowser("b"), vault);
    const f = a.browser.add(BAR, "Work");
    const w = a.browser.add(BAR, "Wiki", "https://wiki.example/");
    const x = a.browser.add(BAR, "Old", "https://old.example/");
    await settle([a, b]);
    await a.browser.update(w, { title: "Team wiki", url: "https://team.example/" });
    await a.browser.move(w, { parent: f });
    await a.browser.remove(x);
    await settle([a, b]);
    expect(b.browser.all().bar).toEqual([{ Work: ["Team wiki=https://team.example/"] }]);
    expect(a.browser.all()).toEqual(b.browser.all());
  });

  it("keeps the order, including a move to the front, and only writes what moved", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    const b = new Device(new FakeBrowser("b"), vault);
    const n = [1, 2, 3, 4, 5, 6].map((i) => a.browser.add(BAR, `B${i}`, `https://b${i}.example/`));
    await settle([a, b]);
    expect(b.browser.all().bar).toEqual(["B1", "B2", "B3", "B4", "B5", "B6"].map((t) => `${t}=https://b${t[1]}.example/`));
    await a.browser.move(n[5], { parent: BAR, index: 0 });
    const r = await a.run();
    expect(r.status === "ok" && r.counts.changedInVault).toBe(1);
    await settle([a, b]);
    expect((b.browser.all().bar as string[]).map((s) => s.split("=")[0])).toEqual(["B6", "B1", "B2", "B3", "B4", "B5"]);
  });

  it("a second run with nothing changed writes nothing", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    a.browser.add(BAR, "News", "https://news.example/");
    await a.run();
    const r = await a.run();
    expect(r.status === "ok" && r.wroteVault).toBe(false);
    expect(r.status === "ok" && r.counts).toMatchObject({ addedToBrowser: 0, changedInBrowser: 0, removedFromBrowser: 0 });
  });

  it("if both change the same title the vault's wins, and every browser agrees", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    const b = new Device(new FakeBrowser("b"), vault);
    const n = a.browser.add(BAR, "News", "https://news.example/");
    await settle([a, b]);
    const other = [...b.browser.raw.keys()][0];
    await a.browser.update(n, { title: "From A" });
    await a.run();
    await b.browser.update(other, { title: "From B" });
    await settle([b, a]);
    expect(a.browser.all()).toEqual(b.browser.all());
    expect((a.browser.all().bar as string[])[0]).toContain("From A");
  });

  it("a folder deleted elsewhere stays if something new was put in it here", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    const b = new Device(new FakeBrowser("b"), vault);
    const f = a.browser.add(OTHER, "Keep?");
    a.browser.add(f, "Inside", "https://inside.example/");
    await settle([a, b]);
    const bf = [...b.browser.raw.values()].find((r) => r.title === "Keep?")!;
    b.browser.add(bf.id, "New here", "https://new.example/");
    a.browser.removeTree(f);
    await a.run(true);
    await settle([b, a]);
    expect(a.browser.all().other).toEqual([{ "Keep?": ["New here=https://new.example/"] }]);
    expect(b.browser.all().other).toEqual([{ "Keep?": ["New here=https://new.example/"] }]);
  });

  it("a folder deleted here stays if another browser put something new in it", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    const b = new Device(new FakeBrowser("b"), vault);
    const f = a.browser.add(OTHER, "Keep?");
    a.browser.add(f, "Inside", "https://inside.example/");
    await settle([a, b]);
    const bf = [...b.browser.raw.values()].find((r) => r.title === "Keep?")!;
    b.browser.add(bf.id, "New there", "https://new.example/");
    await b.run();
    a.browser.removeTree(f);
    await a.run();
    await settle([b, a]);
    expect(a.browser.all().other).toEqual([{ "Keep?": ["New there=https://new.example/"] }]);
    expect(b.browser.all().other).toEqual([{ "Keep?": ["New there=https://new.example/"] }]);
  });

  it("a bookmark renamed here and deleted elsewhere is kept", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    const b = new Device(new FakeBrowser("b"), vault);
    const n = a.browser.add(OTHER, "Old name", "https://x.example/");
    await settle([a, b]);
    await a.browser.remove(n);
    await a.run();
    const there = [...b.browser.raw.values()][0];
    await b.browser.update(there.id, { title: "New name" });
    await settle([b, a]);
    expect(b.browser.all().other).toEqual(["New name=https://x.example/"]);
    expect(a.browser.all().other).toEqual(["New name=https://x.example/"]);
  });

  it("if the vault and this browser move two folders into each other in one run, neither is lost", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    const fx = a.browser.add(OTHER, "X");
    const fy = a.browser.add(OTHER, "Y");
    a.browser.add(fx, "In X", "https://inx.example/");
    await a.run();
    const items = [...vault.items.values()];
    const x = items.find((i) => i.title === "X")!;
    const y = items.find((i) => i.title === "Y")!;
    // Elsewhere, X went into Y. Here, Y goes into X.
    vault.items.set(x.id, { ...x, parent: y.id });
    await a.browser.move(fy, { parent: fx });
    await a.run();
    // Nothing in the vault points round in a circle, even straight after that run.
    for (const start of vault.items.values()) {
      const seen = new Set<string>();
      for (let at = start.parent; !at.startsWith("root:"); at = vault.items.get(at)!.parent) {
        expect(seen.has(at)).toBe(false);
        seen.add(at);
      }
    }
    await a.run();
    const text = JSON.stringify(a.browser.all());
    for (const t of ["X", "Y", "In X"]) expect(text).toContain(t);
    expect(a.browser.raw.size).toBe(3);
  });

  it("a change the browser refused is tried again, and its old value isn't taken for an edit", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    a.browser.add(OTHER, "Old", "https://x.example/");
    await a.run();
    const [item] = [...vault.items.values()];
    vault.items.set(item.id, { ...item, title: "New from elsewhere" });
    const real = a.browser.update.bind(a.browser);
    a.browser.update = async () => {
      throw new Error("Can't modify");
    };
    const r = await a.run();
    expect(r.status === "ok" && r.counts.failed).toBe(1);
    a.browser.update = real;
    await a.run();
    expect(a.browser.all().other).toEqual(["New from elsewhere=https://x.example/"]);
    expect([...vault.items.values()][0].title).toBe("New from elsewhere");
  });

  it("a bookmark the browser wouldn't create doesn't stop the rest, and is tried again", async () => {
    const vault = new FakeVault();
    vault.items.set("one", { id: "one", parent: OTHER, title: "One", url: "https://one.example/", pos: 1 });
    vault.items.set("two", { id: "two", parent: OTHER, title: "Two", url: "https://two.example/", pos: 2 });
    const a = new Device(new FakeBrowser("a"), vault);
    const real = a.browser.create.bind(a.browser);
    a.browser.create = async (p) => {
      if (p.title === "One") throw new Error("nope");
      return real(p);
    };
    await a.run();
    expect(a.browser.all().other).toEqual(["Two=https://two.example/"]);
    expect(vault.items.size).toBe(2);
    a.browser.create = real;
    await a.run();
    expect(a.browser.all().other).toEqual(["One=https://one.example/", "Two=https://two.example/"]);
  });

  it("stops and changes nothing when a run would delete a lot, on either side", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    for (let i = 0; i < 200; i++) a.browser.add(OTHER, `B${i}`, `https://b${i}.example/`);
    await a.run();
    expect(vault.items.size).toBe(200);

    // The browser's bookmarks vanish: a wiped profile, say.
    const keep = a.base;
    for (const id of [...a.browser.raw.keys()]) await a.browser.remove(id);
    const held = await a.run();
    expect(held.status).toBe("held");
    expect(held.status === "held" && held.fromBrowser).toBe(200);
    expect(vault.items.size).toBe(200);
    expect(a.base).toEqual(keep);

    // Asked to, it restores nothing and deletes them. Saying no is the other way: forget the base.
    a.base = {};
    await a.run();
    expect(a.browser.raw.size).toBe(200);
    expect(vault.items.size).toBe(200);

    // The vault's emptied by another device.
    for (const id of [...vault.items.keys()]) await vault.remove(id);
    const heldToo = await a.run();
    expect(heldToo.status).toBe("held");
    expect(heldToo.status === "held" && heldToo.fromVault).toBe(200);
    expect(a.browser.raw.size).toBe(200);
  });

  it("a few bookmarks all gone from one side still stops and asks: a server reset looks like this", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    for (const t of ["One", "Two", "Three"]) a.browser.add(OTHER, t, `https://${t.toLowerCase()}.example/`);
    await a.run();

    // The vault's items are simply gone, with no deletions behind them.
    vault.items.clear();
    const held = await a.run();
    expect(held.status === "held" && held.fromVault).toBe(3);
    expect(a.browser.raw.size).toBe(3);

    // Starting over puts them back rather than losing them.
    a.base = {};
    await a.run();
    expect(a.browser.raw.size).toBe(3);
    expect(vault.items.size).toBe(3);

    // And the other way, a browser's bookmarks gone.
    for (const id of [...a.browser.raw.keys()]) await a.browser.remove(id);
    expect((await a.run()).status).toBe("held");
    expect(vault.items.size).toBe(3);
  });

  it("a bookmark too long for the vault stays in the browser, on every run", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    a.browser.add(OTHER, "x".repeat(5000), "https://long.example/");
    a.browser.add(OTHER, "Long address", `https://long.example/${"y".repeat(20000)}`);
    a.browser.add(OTHER, "Fine", "https://fine.example/");
    await a.run();
    await a.run();
    await a.run();
    expect(a.browser.raw.size).toBe(3);
    expect(vault.items.size).toBe(1);
  });

  it("many can't go a few at a time, and a yes covers only what was shown", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    for (let i = 0; i < 100; i++) a.browser.add(OTHER, `B${i}`, `https://b${i}.example/`);
    await a.run();
    const run = (o: object) => reconcile(a.browser, vault, a.base, { ...options, ...o });
    const ids = [...vault.items.keys()];
    for (const id of ids.slice(0, 5)) await vault.remove(id);
    // Few enough by itself, but not on top of the 23 that went earlier today.
    const held = await run({ deletedLately: 23 });
    expect(held.status).toBe("held");
    expect(a.browser.raw.size).toBe(100);
    // The person agreed to five, and now it's six.
    await vault.remove(ids[5]);
    expect((await run({ deletedLately: 23, allowUpTo: 5 })).status).toBe("held");
    const yes = await run({ deletedLately: 23, allowUpTo: 6 });
    expect(yes.status === "ok" && yes.deleted).toBe(6);
    expect(a.browser.raw.size).toBe(94);
  });

  it("doesn't ask for a root's order when nothing's going in it: that can create a folder", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    a.browser.add(BAR, "One", "https://one.example/");
    const asked: string[] = [];
    const real = a.browser.order.bind(a.browser);
    a.browser.order = async (p) => {
      asked.push(p);
      return real(p);
    };
    await a.run();
    expect(asked).toEqual([BAR]);
  });

  it("a small delete doesn't ask", async () => {
    expect(massDeleteLimit(10)).toBe(25);
    expect(massDeleteLimit(1000)).toBe(200);
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    const n = a.browser.add(OTHER, "One", "https://one.example/");
    a.browser.add(OTHER, "Two", "https://two.example/");
    await a.run();
    await a.browser.remove(n);
    expect((await a.run()).status).toBe("ok");
    expect(vault.items.size).toBe(1);
  });

  it("ignores items with a javascript: or other address, and bad shapes", async () => {
    expect(syncableUrl("javascript:alert(1)")).toBe(false);
    expect(syncableUrl("file:///c:/x")).toBe(false);
    expect(syncableUrl("chrome://settings")).toBe(false);
    expect(syncableUrl("https://ok.example/")).toBe(true);
    const vault = new FakeVault();
    vault.items.set("bad", { id: "bad", parent: BAR, title: "Evil", url: "javascript:alert(1)", pos: 1 });
    vault.items.set("worse", { id: "worse", parent: BAR, title: "x".repeat(5000), url: "https://long.example/", pos: 2 });
    vault.items.set("fine", { id: "fine", parent: BAR, title: "Fine", url: "https://fine.example/", pos: 3 });
    const a = new Device(new FakeBrowser("a"), vault);
    await a.run();
    expect(a.browser.all().bar).toEqual(["Fine=https://fine.example/"]);
  });

  it("repairs a loop, an orphan and a bookmark used as a folder without losing anything", async () => {
    const vault = new FakeVault();
    vault.items.set("x", { id: "x", parent: "y", title: "X", pos: 1 });
    vault.items.set("y", { id: "y", parent: "x", title: "Y", pos: 2 });
    vault.items.set("o", { id: "o", parent: "nowhere", title: "Orphan", url: "https://o.example/", pos: 3 });
    vault.items.set("b", { id: "b", parent: OTHER, title: "Book", url: "https://b.example/", pos: 4 });
    vault.items.set("c", { id: "c", parent: "b", title: "Child", url: "https://c.example/", pos: 5 });
    const a = new Device(new FakeBrowser("a"), vault);
    await a.run();
    const text = JSON.stringify(a.browser.all());
    for (const t of ["Orphan", "Book", "Child"]) expect(text).toContain(t);
    expect(a.browser.raw.size).toBe(5);
    await a.run();
    expect(a.browser.raw.size).toBe(5);
  });

  it("two browsers that move two folders into each other don't lose them", async () => {
    const shared = new FakeVault();
    const a = new Device(new FakeBrowser("a"), shared);
    const b = new Device(new FakeBrowser("b"), shared);
    const fa = a.browser.add(OTHER, "A");
    const fb = a.browser.add(OTHER, "B");
    a.browser.add(fa, "In A", "https://ina.example/");
    a.browser.add(fb, "In B", "https://inb.example/");
    await settle([a, b]);
    const aCopy = shared.copy();
    const bCopy = shared.copy();
    a.vault = aCopy;
    b.vault = bCopy;
    await a.browser.move(fa, { parent: fb });
    const bf = [...b.browser.raw.values()];
    await b.browser.move(bf.find((r) => r.title === "B")!.id, { parent: bf.find((r) => r.title === "A")!.id });
    await a.run();
    await b.run();
    shared.absorb(aCopy);
    shared.absorb(bCopy);
    a.vault = shared;
    b.vault = shared;
    await settle([a, b]);
    expect(a.browser.all()).toEqual(b.browser.all());
    for (const t of ["In A", "In B"]) expect(JSON.stringify(a.browser.all())).toContain(t);
  });

  it("random edits on three browsers, some working from a stale copy, always settle on one tree", async () => {
    for (let seed = 1; seed <= 25; seed++) {
      let s = seed * 2654435761;
      const rand = (n: number) => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return Math.floor((s / 2 ** 32) * n);
      };
      const shared = new FakeVault();
      const devices = ["a", "b", "c"].map((n) => new Device(new FakeBrowser(n), shared));
      const added = new Set<string>();
      const deleted = new Set<string>();
      let serial = 0;
      for (let round = 0; round < 12; round++) {
        // Each works from its own copy, so changes cross.
        const copies = devices.map(() => shared.copy());
        devices.forEach((d, i) => (d.vault = copies[i]));
        for (const d of devices) {
          const nodes = [...d.browser.raw.values()];
          const folders = nodes.filter((n) => n.url === undefined);
          const pickParent = () => (folders.length && rand(2) ? folders[rand(folders.length)].id : [BAR, OTHER][rand(2)]);
          for (let op = rand(4); op > 0; op--) {
            const list = [...d.browser.raw.values()];
            const pick = list[rand(Math.max(list.length, 1))];
            switch (rand(5)) {
              case 0: {
                const t = `T${serial++}`;
                added.add(t);
                d.browser.add(pickParent(), t, `https://${t.toLowerCase()}.example/`);
                break;
              }
              case 1:
                d.browser.add(pickParent(), `F${serial++}`);
                break;
              case 2:
                if (pick) await d.browser.update(pick.id, { title: `${pick.title}r` });
                break;
              case 3:
                if (pick) await d.browser.move(pick.id, { parent: pickParent() }).catch(() => undefined);
                break;
              case 4:
                if (pick && pick.url !== undefined) {
                  deleted.add(pick.url);
                  await d.browser.remove(pick.id);
                }
                break;
            }
          }
          await d.run(true);
        }
        copies.forEach((c) => shared.absorb(c));
        devices.forEach((d) => (d.vault = shared));
      }
      devices.forEach((d) => (d.vault = shared));
      await settle(devices);
      const [a, b, c] = devices;
      expect(b.browser.all(), `seed ${seed}`).toEqual(a.browser.all());
      expect(c.browser.all(), `seed ${seed}`).toEqual(a.browser.all());
      // Nothing anyone added has gone missing unless someone deleted it.
      const text = JSON.stringify(a.browser.all());
      for (const t of added) if (!deleted.has(`https://${t.toLowerCase()}.example/`)) expect(text, `seed ${seed}: ${t}`).toContain(`https://${t.toLowerCase()}.example/`);
      // And it's stable: another pass writes nothing.
      for (const d of devices) {
        const r = await d.run();
        expect(r.status === "ok" && r.wroteVault, `seed ${seed}`).toBe(false);
      }
    }
  });

  // ---- Deletions that have to stick ------------------------------------------------------

  it("a deletion goes to the vault's recently deleted and from the other browser, and a restore brings it back to both", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    const b = new Device(new FakeBrowser("b"), vault);
    a.browser.add(BAR, "Keep", "https://keep.example/");
    const x = a.browser.add(BAR, "Old", "https://old.example/");
    await settle([a, b]);
    await a.browser.remove(x);
    const r = await a.run();
    expect(r.status === "ok" && r.counts.removedFromVault).toBe(1);
    expect([...vault.trash.values()].map((t) => t.title)).toEqual(["Old"]);
    const rb = await b.run();
    expect(rb.status === "ok" && rb.counts.removedFromBrowser).toBe(1);
    expect(b.browser.all().bar).toEqual(["Keep=https://keep.example/"]);
    // Nothing brings it back on later runs.
    await settle([a, b]);
    expect(vault.items.size).toBe(1);
    expect(a.browser.all()).toEqual(b.browser.all());
    vault.restore([...vault.trash.keys()][0]);
    await settle([a, b]);
    expect(a.browser.all().bar).toEqual(["Keep=https://keep.example/", "Old=https://old.example/"]);
    expect(a.browser.all()).toEqual(b.browser.all());
    expect(vault.items.size).toBe(2);
  });

  it("a browser that's forgotten the last run doesn't bring back what was deleted elsewhere", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    const b = new Device(new FakeBrowser("b"), vault);
    a.browser.add(BAR, "Keep", "https://keep.example/");
    const x = a.browser.add(BAR, "Old", "https://old.example/");
    await settle([a, b]);
    await a.browser.remove(x);
    await a.run();
    // Off and on, or the extension reinstalled: b still has the bookmark and remembers nothing.
    b.base = {};
    const r = await b.run();
    expect(r.status === "ok" && r.counts.removedFromBrowser).toBe(1);
    expect(r.status === "ok" && r.counts.addedToVault).toBe(0);
    await settle([a, b]);
    expect(b.browser.all().bar).toEqual(["Keep=https://keep.example/"]);
    expect(a.browser.all()).toEqual(b.browser.all());
    expect(vault.items.size).toBe(1);
    expect(vault.trash.size).toBe(1);
  });

  it("one added again after it was deleted is a new bookmark, even to a browser that's forgotten", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    const b = new Device(new FakeBrowser("b"), vault);
    const x = a.browser.add(BAR, "Old", "https://old.example/");
    a.browser.add(BAR, "Keep", "https://keep.example/");
    await settle([a, b]);
    await a.browser.remove(x);
    await settle([a, b]);
    expect(b.browser.raw.size).toBe(1);
    b.browser.add(BAR, "Old", "https://old.example/");
    b.base = {};
    await settle([b, a]);
    expect(JSON.stringify(a.browser.all().bar)).toContain("Old=https://old.example/");
    expect(a.browser.all()).toEqual(b.browser.all());
    expect(vault.items.size).toBe(2);
  });

  it("a browser that doesn't say when a bookmark was added keeps it", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    const b = new Device(new FakeBrowser("b"), vault);
    const x = a.browser.add(BAR, "Old", "https://old.example/");
    await settle([a, b]);
    await a.browser.remove(x);
    await a.run();
    b.browser.undated = true;
    b.base = {};
    await settle([b, a]);
    expect(a.browser.all().bar).toEqual(["Old=https://old.example/"]);
  });

  it("\"keep them everywhere\" brings back what was deleted elsewhere", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    const b = new Device(new FakeBrowser("b"), vault);
    const x = a.browser.add(BAR, "Old", "https://old.example/");
    a.browser.add(BAR, "Keep", "https://keep.example/");
    await settle([a, b]);
    await a.browser.remove(x);
    await a.run();
    b.base = {};
    const r = await b.run(false, { keepAll: true });
    expect(r.status === "ok" && r.counts.addedToVault).toBe(1);
    expect(r.status === "ok" && r.counts.removedFromBrowser).toBe(0);
    await settle([a, b]);
    expect(JSON.stringify(a.browser.all().bar)).toContain("Old=https://old.example/");
    expect(a.browser.all()).toEqual(b.browser.all());
  });

  it("a folder deleted elsewhere goes from a browser that's forgotten, unless something new is in it", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    const b = new Device(new FakeBrowser("b"), vault);
    const c = new Device(new FakeBrowser("c"), vault);
    const f = a.browser.add(BAR, "Work");
    a.browser.add(f, "Wiki", "https://wiki.example/");
    a.browser.add(f, "Mail", "https://mail.example/");
    a.browser.add(BAR, "Keep", "https://keep.example/");
    await settle([a, b, c]);
    a.browser.removeTree(f);
    await a.run();
    const inC = [...c.browser.raw.values()].find((r) => r.title === "Work")!.id;
    c.browser.add(inC, "Notes", "https://notes.example/");
    b.base = {};
    c.base = {};
    await b.run();
    expect(b.browser.all().bar).toEqual(["Keep=https://keep.example/"]);
    await c.run();
    expect(c.browser.all().bar).toEqual([{ Work: ["Notes=https://notes.example/"] }, "Keep=https://keep.example/"]);
    await settle([a, b, c]);
    expect(a.browser.all()).toEqual(c.browser.all());
    expect(b.browser.all()).toEqual(c.browser.all());
    expect(JSON.stringify(a.browser.all())).not.toContain("wiki.example");
  });

  it("a lot deleted elsewhere still stops and asks in a browser that's forgotten, and nothing goes without a yes", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    const b = new Device(new FakeBrowser("b"), vault);
    const n = Array.from({ length: 60 }, (_, i) => a.browser.add(BAR, `B${i}`, `https://b${i}.example/`));
    await settle([a, b]);
    for (const node of n.slice(0, 30)) await a.browser.remove(node);
    await a.run(true);
    b.base = {};
    const held = await b.run();
    expect(held.status).toBe("held");
    expect(held.status === "held" && held.fromVault).toBe(30);
    expect(b.browser.raw.size).toBe(60);
    expect(vault.items.size).toBe(30);
    const kept = await b.run(false, { keepAll: true });
    expect(kept.status === "ok" && kept.counts.addedToVault).toBe(30);
    expect(b.browser.raw.size).toBe(60);
  });

  it("a bookmark the browser wouldn't remove is tried again, and doesn't go back to the vault as new", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    const b = new Device(new FakeBrowser("b"), vault);
    a.browser.add(BAR, "Keep", "https://keep.example/");
    const x = a.browser.add(BAR, "Old", "https://old.example/");
    await settle([a, b]);
    await a.browser.remove(x);
    await a.run();
    const real = b.browser.remove.bind(b.browser);
    let refuse = 2;
    b.browser.remove = async (node: string) => {
      if (refuse-- > 0) throw new Error("busy");
      return real(node);
    };
    const first = await b.run();
    expect(first.status === "ok" && first.counts.failed).toBe(1);
    expect(first.status === "ok" && first.deleted).toBe(0);
    await a.run();
    const second = await b.run();
    expect(second.status === "ok" && second.counts.addedToVault).toBe(0);
    expect(vault.items.size).toBe(1);
    expect(a.browser.raw.size).toBe(1);
    const third = await b.run();
    expect(third.status === "ok" && third.counts.removedFromBrowser).toBe(1);
    expect(b.browser.all().bar).toEqual(["Keep=https://keep.example/"]);
    await settle([a, b]);
    expect(vault.items.size).toBe(1);
    expect(a.browser.all()).toEqual(b.browser.all());
  });

  it("the same refusal in a browser that's forgotten is tried again too", async () => {
    const vault = new FakeVault();
    const a = new Device(new FakeBrowser("a"), vault);
    const b = new Device(new FakeBrowser("b"), vault);
    a.browser.add(BAR, "Keep", "https://keep.example/");
    const x = a.browser.add(BAR, "Old", "https://old.example/");
    await settle([a, b]);
    await a.browser.remove(x);
    await a.run();
    b.base = {};
    const real = b.browser.remove.bind(b.browser);
    let refuse = 1;
    b.browser.remove = async (node: string) => {
      if (refuse-- > 0) throw new Error("busy");
      return real(node);
    };
    const first = await b.run();
    expect(first.status === "ok" && first.counts.failed).toBe(1);
    expect(vault.items.size).toBe(1);
    await settle([a, b]);
    expect(b.browser.all().bar).toEqual(["Keep=https://keep.example/"]);
    expect(a.browser.all()).toEqual(b.browser.all());
    expect(vault.items.size).toBe(1);
  });

  it("the tree for showing is in order, and an orphan or a loop can still be reached", () => {
    const tree = bookmarkTree([
      { id: "f", parent: BAR, title: "Folder", pos: 2 },
      { id: "b", parent: BAR, title: "First", url: "https://first.example/", pos: 1 },
      { id: "c2", parent: "f", title: "Later", url: "https://later.example/", pos: 9 },
      { id: "c1", parent: "f", title: "Sooner", url: "https://sooner.example/", pos: 3 },
      { id: "o", parent: "gone", title: "Orphan", url: "https://orphan.example/", pos: 1 },
      { id: "x", parent: "y", title: "X", pos: 1 },
      { id: "y", parent: "x", title: "Y", pos: 2 },
      { id: "bad", parent: BAR, title: "Evil", url: "javascript:alert(1)", pos: 0 },
    ]);
    expect(tree.bar.map((n) => n.title)).toEqual(["First", "Folder"]);
    expect(tree.bar[1].children.map((n) => n.title)).toEqual(["Sooner", "Later"]);
    expect(JSON.stringify(tree)).not.toContain("javascript:");
    for (const t of ["Orphan", "X", "Y"]) expect(JSON.stringify(tree.other)).toContain(t);
  });

  it("the HTML copy escapes what came from web pages and leaves out what isn't a web address", () => {
    const html = bookmarksHtml([
      { node: "1", parent: BAR, title: "A <b>\"title\"</b>", url: "https://a.example/?a=1&b=2", index: 0 },
      { node: "2", parent: BAR, title: "Folder", index: 1 },
      { node: "3", parent: "2", title: "Inside", url: "https://inside.example/", index: 0 },
      { node: "4", parent: BAR, title: "Bad", url: "javascript:alert(1)", index: 2 },
    ]);
    expect(html).toContain("A &lt;b&gt;&quot;title&quot;&lt;/b&gt;");
    expect(html).toContain('HREF="https://a.example/?a=1&amp;b=2"');
    expect(html).toContain("Inside");
    expect(html).not.toContain("javascript:");
  });
});
