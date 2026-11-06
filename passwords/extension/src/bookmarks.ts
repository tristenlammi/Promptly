// The browser's side of bookmark sync, and the vault's: frontend/src/passwords/core/bookmarks.ts
// decides what changes. See passwords/BOOKMARKS.md.
import { type BookmarkItem, type BookmarkNode, type BookmarkRoot, type BrowserSide, isRootKey, rootKey, syncableNode, syncableUrl, type VaultSide } from "../../../frontend/src/passwords/core/bookmarks";
import { newBody } from "../../../frontend/src/passwords/core/model";
import type { VaultClient } from "../../../frontend/src/passwords/core/vault";
import { ext } from "./rpc";

type Tree = chrome.bookmarks.BookmarkTreeNode & { folderType?: string; syncing?: boolean; type?: string };

const FIREFOX_ROOTS: Record<string, BookmarkRoot> = { toolbar_____: "bar", unfiled_____: "other", menu________: "menu", mobile______: "mobile" };
const CHROMIUM_IDS: Record<string, BookmarkRoot> = { "1": "bar", "2": "other", "3": "mobile" };
const FOLDER_TYPES: Record<string, BookmarkRoot> = { "bookmarks-bar": "bar", other: "other", mobile: "mobile" };
/** Chromium has no Bookmarks menu, and refuses its Mobile folder on a computer unless it's signed in
 *  to its own sync, so what's in Firefox's lives in a folder of this name in Other bookmarks. */
const STAND_INS: Partial<Record<BookmarkRoot, string>> = { menu: "Bookmarks menu", mobile: "Mobile bookmarks" };

function rootOf(n: Tree): BookmarkRoot | undefined {
  if (n.folderType) return FOLDER_TYPES[n.folderType];
  return FIREFOX_ROOTS[n.id] ?? CHROMIUM_IDS[n.id];
}

export class BrowserBookmarks implements BrowserSide {
  private roots = new Map<BookmarkRoot, string>();
  private keyOf = new Map<string, string>();
  /** How many were left out, to say so on screen. */
  unsynced = 0;

  private async tree(): Promise<Tree[]> {
    const [top] = (await ext.bookmarks.getTree()) as Tree[];
    this.roots.clear();
    this.keyOf.clear();
    // A browser signed in to its own sync can have an account copy and a local copy of the same
    // folder. New bookmarks go to the account copy there, so that's the one that's used.
    const found = new Map<BookmarkRoot, Tree>();
    for (const n of top.children ?? []) {
      const r = rootOf(n);
      if (!r) continue;
      const had = found.get(r);
      if (!had || (n.syncing && !had.syncing)) found.set(r, n);
    }
    for (const [r, n] of found) {
      this.roots.set(r, n.id);
      this.keyOf.set(n.id, rootKey(r));
    }
    return top.children ?? [];
  }

  async read(): Promise<BookmarkNode[]> {
    await this.tree();
    const out: BookmarkNode[] = [];
    this.unsynced = 0;
    const walk = (n: Tree, parent: string, inMenuFolder: boolean) => {
      (n.children ?? []).forEach((c: Tree, index) => {
        // Managed folders can't be changed, and separators have nothing in them to sync.
        if (c.unmodifiable || c.type === "separator") return;
        if (c.url !== undefined && !syncableNode(c.title ?? "", c.url)) {
          this.unsynced++;
          return;
        }
        // A stand-in for a root this browser hasn't got isn't a folder of its own.
        const standsFor = c.url === undefined && parent === rootKey("other") && !inMenuFolder ? (Object.keys(STAND_INS) as BookmarkRoot[]).find((r) => STAND_INS[r] === c.title && !this.roots.has(r)) : undefined;
        if (standsFor) {
          this.roots.set(standsFor, c.id);
          this.keyOf.set(c.id, rootKey(standsFor));
          walk(c, rootKey(standsFor), true);
          return;
        }
        out.push({ node: c.id, parent, title: c.title ?? "", url: c.url, index });
        if (c.url === undefined) walk(c, c.id, inMenuFolder);
      });
    };
    const [top] = (await ext.bookmarks.getTree()) as Tree[];
    for (const r of top.children ?? []) {
      const key = this.keyOf.get(r.id);
      if (key) walk(r, key, false);
    }
    return out;
  }

  private async idOf(parent: string): Promise<string> {
    if (!isRootKey(parent)) return parent;
    const name = parent.slice("root:".length) as BookmarkRoot;
    const known = this.roots.get(name);
    if (known) return known;
    const standIn = STAND_INS[name];
    if (standIn && this.roots.has("other")) {
      const made = await ext.bookmarks.create({ parentId: this.roots.get("other")!, title: standIn });
      this.roots.set(name, made.id);
      return made.id;
    }
    // A root this browser doesn't have. Its bookmarks still need to be somewhere.
    const other = this.roots.get("other");
    if (!other) throw new Error("No bookmarks folder to use");
    return other;
  }

  async order(parent: string): Promise<string[]> {
    const id = await this.idOf(parent);
    return (await ext.bookmarks.getChildren(id)).map((c) => c.id);
  }

  async create(p: { parent: string; title: string; url?: string }): Promise<string> {
    if (!syncableUrl(p.url)) throw new Error("Not a web address");
    const made = await ext.bookmarks.create({ parentId: await this.idOf(p.parent), title: p.title, url: p.url });
    return made.id;
  }

  async update(node: string, p: { title?: string; url?: string }): Promise<void> {
    if (!syncableUrl(p.url)) throw new Error("Not a web address");
    await ext.bookmarks.update(node, p);
  }

  async move(node: string, p: { parent: string; index?: number }): Promise<void> {
    await ext.bookmarks.move(node, { parentId: await this.idOf(p.parent), ...(p.index === undefined ? {} : { index: p.index }) });
  }

  /** Never a whole tree: a folder with something this doesn't sync in it stays. */
  async remove(node: string): Promise<void> {
    await ext.bookmarks.remove(node);
  }
}

/** Only this person's own vault counts. Anyone who can write to a shared vault could otherwise
 *  plant bookmarks in every browser they've got. */
export class VaultBookmarks implements VaultSide {
  constructor(private client: VaultClient, private vaultId: string) {}

  async read(): Promise<BookmarkItem[]> {
    return this.client
      .allItems({ includeSystem: true })
      .filter((i) => i.body.kind === "bookmark" && i.vaultId === this.vaultId && !i.deleted && i.body.bookmark)
      .map((i) => ({ id: i.id, title: i.body.title, parent: i.body.bookmark!.parent, url: i.body.bookmark!.url, pos: i.body.bookmark!.pos }));
  }

  async create(i: BookmarkItem): Promise<void> {
    await this.client.saveNew(this.vaultId, newBody("bookmark", i.title, { bookmark: { parent: i.parent, pos: i.pos, url: i.url } }), i.id);
  }

  async update(i: BookmarkItem): Promise<void> {
    const had = this.client.get(i.id);
    if (!had) return;
    // The merge's keep-both copies mean nothing here: this side and the browser's have just agreed.
    await this.client.update(i.id, { ...had.body, title: i.title, bookmark: { parent: i.parent, pos: i.pos, url: i.url }, conflicts: undefined });
  }

  async remove(id: string): Promise<void> {
    if (this.client.get(id)) await this.client.trashItem(id);
  }
}
