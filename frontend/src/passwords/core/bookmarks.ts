// Bookmark sync: what's in this browser against what's in the vault (passwords/BOOKMARKS.md).
//
// Each bookmark or folder is one encrypted item, so the ordinary sync moves them and the server
// sees only blobs. This file decides what changed by comparing both sides with what they looked
// like after the last run. It's a comparison of states and not a log of events, so a browser
// that was shut, locked or offline catches up by running it again.
//
// It has no browser or network in it: both sides are interfaces, so a test can run many browsers
// against one vault. The rule it must keep is that a bug here can't quietly empty someone's
// bookmarks. So the first run only adds, and a run that would delete a lot stops and asks.

import { sha256 } from "@noble/hashes/sha2.js";

import { b64u, utf8 } from "./bytes";

export type BookmarkRoot = "bar" | "other" | "menu" | "mobile";
export const rootKey = (r: BookmarkRoot) => `root:${r}`;
export const isRootKey = (s: string) => s.startsWith("root:");
const FALLBACK = rootKey("other");

/** One bookmark or folder as the browser has it. `parent` is a node id or a root key. */
export type BookmarkNode = { node: string; parent: string; title: string; url?: string; index: number };
/** The same in the vault. `parent` is an item id or a root key. A folder has no url. */
export type BookmarkItem = { id: string; parent: string; title: string; url?: string; pos: number };

export interface BrowserSide {
  /** Everything that syncs. Separators, bookmarklets and managed folders aren't listed. */
  read(): Promise<BookmarkNode[]>;
  /** A parent's children in order, including ones that aren't listed by read(). */
  order(parent: string): Promise<string[]>;
  create(p: { parent: string; title: string; url?: string }): Promise<string>;
  update(node: string, p: { title?: string; url?: string }): Promise<void>;
  move(node: string, p: { parent: string; index?: number }): Promise<void>;
  remove(node: string): Promise<void>;
}

export interface VaultSide {
  read(): Promise<BookmarkItem[]>;
  create(item: BookmarkItem): Promise<void>;
  update(item: BookmarkItem): Promise<void>;
  remove(id: string): Promise<void>;
}

/** What one item looked like after the last run. Hashed, since this is kept on disk beside a
 *  vault that's encrypted, and comparing is all it's for. */
export type BaseEntry = { node: string; parent: string; title: string; url: string; pos: number };
export type Base = Record<string, BaseEntry>;

export type SyncCounts = { addedToVault: number; changedInVault: number; removedFromVault: number; addedToBrowser: number; changedInBrowser: number; removedFromBrowser: number; merged: number; failed: number };
export type SyncResult =
  | { status: "ok"; base: Base; counts: SyncCounts; total: number; wroteVault: boolean }
  /** Nothing was changed. Someone has to say whether this many deletions is right. */
  | { status: "held"; base: Base; fromBrowser: number; fromVault: number; total: number };

export type SyncOptions = { hash: (s: string) => string; newId: () => string; allowMassDelete?: boolean };

/** Deleting more than this in one go needs a yes. */
export function massDeleteLimit(total: number): number {
  return Math.max(25, Math.floor(total * 0.2));
}

/** Only ordinary web addresses move between browsers. A javascript: bookmark from elsewhere would
 *  be code that runs on whatever page it's clicked on, and a browser's own pages differ. */
export function syncableUrl(url: string | undefined): boolean {
  if (url === undefined) return true;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

const MAX_TITLE = 2048;
const MAX_URL = 16384;
const MAX_DEPTH = 64;
const GAP = 1024;

/** Items come from this person's own vault, but that's no reason to trust the shape. */
export function validItem(i: BookmarkItem): boolean {
  return typeof i.id === "string" && typeof i.parent === "string" && typeof i.title === "string" && i.title.length <= MAX_TITLE && (i.url === undefined || (typeof i.url === "string" && i.url.length <= MAX_URL && syncableUrl(i.url)));
}

/** Longest run that's already in order: those stay where they are, and the rest move. */
function longestIncreasing(values: number[]): Set<number> {
  const tails: number[] = [];
  const prev = new Array<number>(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] < values[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out = new Set<number>();
  let at = tails.length ? tails[tails.length - 1] : -1;
  while (at !== -1) {
    out.add(at);
    at = prev[at];
  }
  return out;
}

const byPlace = (a: BookmarkItem, b: BookmarkItem) => a.pos - b.pos || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const keyOf = (parent: string, title: string, url: string | undefined) => `${parent}\u0000${title}\u0000${url ?? "\u0001folder"}`;

function childrenOf(items: Map<string, BookmarkItem>): Map<string, BookmarkItem[]> {
  const kids = new Map<string, BookmarkItem[]>();
  for (const it of items.values()) {
    const list = kids.get(it.parent);
    if (list) list.push(it);
    else kids.set(it.parent, [it]);
  }
  return kids;
}

/** Orphans and loops go to the top of Other bookmarks, so nothing's ever unreachable. */
function repairTree(items: Map<string, BookmarkItem>, touched: Set<string>) {
  for (const it of items.values()) {
    if (it.parent === it.id || (!isRootKey(it.parent) && !items.has(it.parent))) {
      it.parent = FALLBACK;
      touched.add(it.id);
      continue;
    }
    const seen = new Set([it.id]);
    let at = it.parent;
    let depth = 0;
    while (!isRootKey(at)) {
      const up = items.get(at);
      if (!up || seen.has(at) || ++depth > MAX_DEPTH) {
        it.parent = FALLBACK;
        touched.add(it.id);
        break;
      }
      // A bookmark can't hold anything.
      if (up.url !== undefined) {
        it.parent = FALLBACK;
        touched.add(it.id);
        break;
      }
      seen.add(at);
      at = up.parent;
    }
  }
}

/** For comparing against the last run. Salted per browser, and short: it's not a proof of anything. */
export const bookmarkHash = (salt: string) => (s: string) => b64u(sha256(utf8(`${salt}\u0000${s}`)).subarray(0, 12));

export async function reconcile(browser: BrowserSide, vault: VaultSide, base: Base, opts: SyncOptions): Promise<SyncResult> {
  const h = opts.hash;
  const nodes = new Map((await browser.read()).map((n) => [n.node, n]));
  const items = new Map((await vault.read()).filter(validItem).map((i) => [i.id, { ...i, pos: Number.isFinite(i.pos) ? i.pos : 0 }]));
  const entries = new Map(Object.entries(base));
  const created = new Set<string>();
  const touched = new Set<string>();
  const removedItems = new Set<string>();
  const removeNodes = new Set<string>();
  const counts: SyncCounts = { addedToVault: 0, changedInVault: 0, removedFromVault: 0, addedToBrowser: 0, changedInBrowser: 0, removedFromBrowser: 0, merged: 0, failed: 0 };

  repairTree(items, touched);

  // ---- Exact duplicates ------------------------------------------------------------------
  // Two browsers with the same bookmarks that both run for the first time each add them all. The
  // copies are the same in every way, so every device keeps the lowest id and they meet up.
  const dropped = new Set<string>();
  {
    const kids = childrenOf(items);
    const walk = (parents: string[], canon: string) => {
      const list = parents.flatMap((p) => kids.get(p) ?? []);
      const groups = new Map<string, BookmarkItem[]>();
      for (const it of list) {
        const k = keyOf("", it.title, it.url);
        const g = groups.get(k);
        if (g) g.push(it);
        else groups.set(k, [it]);
      }
      for (const group of groups.values()) {
        group.sort((a, b) => (a.id < b.id ? -1 : 1));
        const keep = group[0];
        if (keep.parent !== canon) {
          keep.parent = canon;
          touched.add(keep.id);
        }
        for (const dup of group.slice(1)) {
          dropped.add(dup.id);
          counts.merged++;
          const was = entries.get(dup.id);
          if (was) {
            const had = entries.get(keep.id);
            if (!had) entries.set(keep.id, was);
            else if (was.node !== had.node) removeNodes.add(was.node);
            entries.delete(dup.id);
          }
        }
        if (keep.url === undefined) walk(group.map((g) => g.id), keep.id);
      }
    };
    for (const root of ["bar", "other", "menu", "mobile"] as BookmarkRoot[]) walk([rootKey(root)], rootKey(root));
    for (const id of dropped) {
      items.delete(id);
      touched.delete(id);
    }
  }

  // ---- What's gone from one side ---------------------------------------------------------
  const nodeToItem = new Map<string, string>();
  const itemToNode = new Map<string, string>();
  const browserDelete = new Set<string>();
  const vaultDelete = new Set<string>();
  const forget = (id: string) => {
    const e = entries.get(id);
    if (e) {
      nodeToItem.delete(e.node);
      if (itemToNode.get(id) === e.node) itemToNode.delete(id);
    }
    entries.delete(id);
  };
  for (const [id, e] of entries) {
    const n = nodes.get(e.node);
    const it = items.get(id);
    if (!n && !it) {
      entries.delete(id);
      continue;
    }
    if (n && !it) {
      // Gone from the vault. If it was changed here since, keep the change and treat it as new.
      const changedHere = h(n.title) !== e.title || h(n.url ?? "") !== e.url;
      if (changedHere) entries.delete(id);
      else if (!removeNodes.has(e.node)) {
        browserDelete.add(e.node);
        nodeToItem.set(e.node, id);
      }
      continue;
    }
    if (!n && it) {
      const changedThere = h(it.title) !== e.title || h(it.url ?? "") !== e.url || h(it.parent) !== e.parent;
      if (changedThere) entries.delete(id);
      else vaultDelete.add(id);
      continue;
    }
    nodeToItem.set(e.node, id);
    itemToNode.set(id, e.node);
  }
  for (const node of removeNodes) nodeToItem.delete(node);

  // A folder can't go while something newer is still inside it, on either side.
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of nodes.values()) {
      if (browserDelete.has(n.node) || removeNodes.has(n.node)) continue;
      if (browserDelete.has(n.parent)) {
        const folderItem = nodeToItem.get(n.parent);
        browserDelete.delete(n.parent);
        if (folderItem) forget(folderItem);
        nodeToItem.delete(n.parent);
        changed = true;
      }
    }
    for (const it of items.values()) {
      if (!vaultDelete.has(it.id) && vaultDelete.has(it.parent)) {
        vaultDelete.delete(it.parent);
        forget(it.parent);
        changed = true;
      }
    }
  }

  const total = Math.max(items.size, nodes.size);
  if (browserDelete.size + vaultDelete.size > massDeleteLimit(total) && !opts.allowMassDelete) {
    return { status: "held", base, fromBrowser: vaultDelete.size, fromVault: browserDelete.size, total };
  }
  for (const id of vaultDelete) {
    items.delete(id);
    removedItems.add(id);
    entries.delete(id);
  }

  // ---- New in the browser ----------------------------------------------------------------
  const depthOf = (n: BookmarkNode): number => {
    let d = 0;
    let at = n.parent;
    while (!isRootKey(at) && d <= MAX_DEPTH) {
      const up = nodes.get(at);
      if (!up) break;
      at = up.parent;
      d++;
    }
    return d;
  };
  const live = [...nodes.values()].filter((n) => !browserDelete.has(n.node) && !removeNodes.has(n.node)).sort((a, b) => depthOf(a) - depthOf(b) || a.index - b.index);
  const parentInVault = (n: BookmarkNode) => (isRootKey(n.parent) ? n.parent : nodeToItem.get(n.parent) ?? FALLBACK);

  const waiting = new Map<string, BookmarkItem[]>();
  for (const it of items.values()) {
    if (itemToNode.has(it.id)) continue;
    const k = keyOf(it.parent, it.title, it.url);
    const q = waiting.get(k);
    if (q) q.push(it);
    else waiting.set(k, [it]);
  }
  for (const n of live) {
    if (nodeToItem.has(n.node)) continue;
    const parent = parentInVault(n);
    const match = waiting.get(keyOf(parent, n.title, n.url))?.shift();
    if (match) {
      nodeToItem.set(n.node, match.id);
      itemToNode.set(match.id, n.node);
      continue;
    }
    const id = opts.newId();
    items.set(id, { id, parent, title: n.title, url: n.url, pos: NaN });
    created.add(id);
    nodeToItem.set(n.node, id);
    itemToNode.set(id, n.node);
  }

  // ---- Edited on one side or both --------------------------------------------------------
  // If both changed the same thing, the vault's wins, so every browser ends up the same.
  const nodeEdits = new Map<string, { title?: string; url?: string }>();
  for (const [id, e] of entries) {
    const it = items.get(id);
    const n = it && nodes.get(e.node);
    if (!it || !n || nodeToItem.get(e.node) !== id) continue;
    const edit: { title?: string; url?: string } = {};
    if (h(it.title) !== e.title) edit.title = it.title;
    else if (h(n.title) !== e.title) {
      it.title = n.title;
      touched.add(id);
    }
    if (it.url !== undefined && n.url !== undefined) {
      if (h(it.url) !== e.url) edit.url = it.url;
      else if (h(n.url) !== e.url) {
        it.url = n.url;
        touched.add(id);
      }
    }
    if (edit.title !== undefined || edit.url !== undefined) nodeEdits.set(e.node, edit);
    if (h(it.parent) === e.parent) {
      const was = parentInVault(n);
      if (h(was) !== e.parent) {
        it.parent = was;
        touched.add(id);
      }
    }
  }
  // Those can't both be right if two browsers moved two folders into each other.
  for (const id of vaultDelete) touched.delete(id);
  repairTree(items, touched);

  // ---- Order -----------------------------------------------------------------------------
  const kids = childrenOf(items);
  for (const [parent, list] of kids) {
    const here = list
      .filter((it) => {
        const node = itemToNode.get(it.id);
        const n = node ? nodes.get(node) : undefined;
        return n && parentInVault(n) === parent;
      })
      .sort((a, b) => nodes.get(itemToNode.get(a.id)!)!.index - nodes.get(itemToNode.get(b.id)!)!.index);
    const movedInVault = (it: BookmarkItem) => {
      const e = entries.get(it.id);
      return !!e && Number.isFinite(it.pos) && it.pos !== e.pos;
    };
    const order = here.filter((it) => !movedInVault(it));
    const steady = new Set<number>();
    {
      const known = order.map((it, i) => ({ it, i })).filter(({ it }) => Number.isFinite(it.pos));
      for (const at of longestIncreasing(known.map(({ it }) => it.pos))) steady.add(known[at].i);
    }
    for (let i = 0; i < order.length; ) {
      if (steady.has(i)) {
        i++;
        continue;
      }
      let end = i;
      while (end < order.length && !steady.has(end)) end++;
      const lo = i > 0 ? order[i - 1].pos : undefined;
      const hi = end < order.length ? order[end].pos : undefined;
      const count = end - i;
      for (let k = 0; k < count; k++) {
        const it = order[i + k];
        const pos = lo === undefined && hi === undefined ? GAP * (k + 1) : lo === undefined ? hi! - GAP * (count - k) : hi === undefined ? lo + GAP * (k + 1) : lo + ((hi - lo) * (k + 1)) / (count + 1);
        if (it.pos !== pos) {
          it.pos = pos;
          if (!created.has(it.id)) touched.add(it.id);
        }
      }
      i = end;
    }
    list.sort(byPlace);
    if (list.some((it, i) => i > 0 && it.pos - list[i - 1].pos < 1e-6 && it.pos !== list[i - 1].pos)) {
      list.forEach((it, i) => {
        it.pos = GAP * (i + 1);
        if (!created.has(it.id)) touched.add(it.id);
      });
    }
  }

  // ---- Do it: the vault first, then the browser ------------------------------------------
  const failed = new Set<string>();
  for (const id of [...dropped, ...removedItems]) {
    await vault.remove(id);
    if (removedItems.has(id)) counts.removedFromVault++;
  }
  for (const id of created) {
    await vault.create(items.get(id)!);
    counts.addedToVault++;
  }
  for (const id of touched) {
    const it = items.get(id);
    if (!it || created.has(id)) continue;
    await vault.update(it);
    counts.changedInVault++;
  }

  const walkBrowser = async (parent: string, parentNode: string) => {
    const list = (kids.get(parent) ?? []).slice().sort(byPlace);
    for (const it of list) {
      let node = itemToNode.get(it.id);
      try {
        if (!node) {
          node = await browser.create({ parent: parentNode, title: it.title, url: it.url });
          itemToNode.set(it.id, node);
          nodeToItem.set(node, it.id);
          counts.addedToBrowser++;
        } else {
          const edit = nodeEdits.get(node);
          if (edit) {
            await browser.update(node, edit);
            counts.changedInBrowser++;
          }
          const n = nodes.get(node);
          if (n && n.parent !== parentNode) {
            await browser.move(node, { parent: parentNode });
            counts.changedInBrowser++;
          }
        }
      } catch {
        failed.add(it.id);
        counts.failed++;
      }
    }
    // Only if the order's really different. That leaves separators and the like where they are.
    const want = list.map((it) => itemToNode.get(it.id)).filter((x): x is string => !!x);
    const inPlace = await browser.order(parentNode).catch(() => [] as string[]);
    const wanted = new Set(want);
    const current = inPlace.filter((x) => wanted.has(x));
    if (current.length === want.length && current.some((x, i) => x !== want[i])) {
      let after = -1;
      const working = [...inPlace];
      for (const node of want) {
        const place = after + 1;
        if (working[place] !== node) {
          try {
            await browser.move(node, { parent: parentNode, index: place });
            working.splice(working.indexOf(node), 1);
            working.splice(place, 0, node);
            counts.changedInBrowser++;
          } catch {
            counts.failed++;
          }
        }
        after = working.indexOf(node);
      }
    }
    for (const it of list) {
      const node = itemToNode.get(it.id);
      if (it.url === undefined && node && !failed.has(it.id)) await walkBrowser(it.id, node);
    }
  };
  for (const root of ["bar", "other", "menu", "mobile"] as BookmarkRoot[]) await walkBrowser(rootKey(root), rootKey(root));

  // Innermost first, since a folder with something left in it stays.
  const gone = [...browserDelete, ...removeNodes].map((n) => nodes.get(n)).filter((n): n is BookmarkNode => !!n);
  gone.sort((a, b) => depthOf(b) - depthOf(a));
  for (const n of gone) {
    try {
      await browser.remove(n.node);
      counts.removedFromBrowser++;
    } catch {
      counts.failed++;
    }
  }

  // ---- Remember what both sides look like now --------------------------------------------
  const next: Base = {};
  for (const it of items.values()) {
    const node = itemToNode.get(it.id);
    if (!node) continue;
    if (failed.has(it.id)) {
      // Try again next time rather than taking the browser's older value for a change.
      const old = entries.get(it.id);
      if (old) next[it.id] = old;
      continue;
    }
    next[it.id] = { node, parent: h(it.parent), title: h(it.title), url: h(it.url ?? ""), pos: it.pos };
  }
  return { status: "ok", base: next, counts, total: items.size, wroteVault: dropped.size + removedItems.size + created.size + touched.size > 0 };
}

// ---- Showing them ---------------------------------------------------------------------------

export type BookmarkTreeNode = BookmarkItem & { children: BookmarkTreeNode[] };

/** For showing: each root's contents in order. Repairs a copy, so an orphan's still reachable. */
export function bookmarkTree(items: BookmarkItem[]): Record<BookmarkRoot, BookmarkTreeNode[]> {
  const copies = new Map(items.filter(validItem).map((i) => [i.id, { ...i }]));
  repairTree(copies, new Set());
  const nodes = new Map([...copies.values()].map((i) => [i.id, { ...i, children: [] as BookmarkTreeNode[] }]));
  const out: Record<BookmarkRoot, BookmarkTreeNode[]> = { bar: [], other: [], menu: [], mobile: [] };
  for (const n of nodes.values()) {
    if (isRootKey(n.parent)) (out[n.parent.slice("root:".length) as BookmarkRoot] ?? out.other).push(n);
    else nodes.get(n.parent)?.children.push(n);
  }
  const order = (list: BookmarkTreeNode[]) => {
    list.sort(byPlace);
    for (const n of list) order(n.children);
  };
  for (const list of Object.values(out)) order(list);
  return out;
}

// ---- Items in the vault --------------------------------------------------------------------

/** A copy to keep: the format every browser can import. Titles and addresses are text from web
 *  pages, so they're escaped, and an address that isn't http(s) isn't written as a link. */
export function bookmarksHtml(nodes: BookmarkNode[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const kids = new Map<string, BookmarkNode[]>();
  for (const n of nodes) {
    const list = kids.get(n.parent);
    if (list) list.push(n);
    else kids.set(n.parent, [n]);
  }
  const write = (parent: string, indent: string, seen: Set<string>): string => {
    const list = (kids.get(parent) ?? []).slice().sort((a, b) => a.index - b.index);
    let out = "";
    for (const n of list) {
      if (seen.has(n.node)) continue;
      seen.add(n.node);
      if (n.url === undefined) out += `${indent}<DT><H3>${esc(n.title)}</H3>\n${indent}<DL><p>\n${write(n.node, `${indent}    `, seen)}${indent}</DL><p>\n`;
      else if (syncableUrl(n.url)) out += `${indent}<DT><A HREF="${esc(n.url)}">${esc(n.title)}</A>\n`;
    }
    return out;
  };
  const seen = new Set<string>();
  const sections: [BookmarkRoot, string][] = [["bar", "Bookmarks bar"], ["other", "Other bookmarks"], ["menu", "Bookmarks menu"], ["mobile", "Mobile bookmarks"]];
  let body = "";
  for (const [root, name] of sections) {
    const inner = write(rootKey(root), "        ", seen);
    if (inner) body += `    <DT><H3>${name}</H3>\n    <DL><p>\n${inner}    </DL><p>\n`;
  }
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${body}</DL><p>\n`;
}
