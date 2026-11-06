// Bookmarks kept in the vault, in the same list everywhere. Only the extension can change a
// browser's bookmarks, so on the web and in the Windows app this is for finding and opening them.
import { Bookmark, ChevronDown, ChevronRight, ExternalLink, Folder, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { type BookmarkItem, type BookmarkRoot, bookmarkTree, type BookmarkTreeNode } from "../core/bookmarks";
import { Callout, inputClass, safeHref, useVault } from "./kit";

const ROOTS: [BookmarkRoot, string][] = [
  ["bar", "Bookmarks bar"],
  ["other", "Other bookmarks"],
  ["menu", "Bookmarks menu"],
  ["mobile", "Mobile bookmarks"],
];

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

function Link({ node }: { node: BookmarkTreeNode }) {
  const href = safeHref(node.url ?? "");
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--text)] hover:bg-[var(--surface-1)]">
      <Bookmark className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
      <span className="min-w-0 flex-1 truncate">{node.title || href}</span>
      <span className="hidden max-w-[40%] truncate text-xs text-[var(--text-muted)] sm:block">{hostOf(href)}</span>
      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] opacity-0 group-hover:opacity-100" />
    </a>
  );
}

function FolderRow({ title, nodes, open: startOpen = false }: { title: string; nodes: BookmarkTreeNode[]; open?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-[var(--text)] hover:bg-[var(--surface-1)]">
        <Chevron className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
        <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="text-xs font-normal text-[var(--text-muted)]">{nodes.length}</span>
      </button>
      {open && <div className="ml-3 border-l border-[var(--border)] pl-2">{nodes.map((n) => <NodeRow key={n.id} node={n} />)}</div>}
    </div>
  );
}

function NodeRow({ node }: { node: BookmarkTreeNode }) {
  return node.url !== undefined ? <Link node={node} /> : <FolderRow title={node.title} nodes={node.children} />;
}

export function BookmarksScreen() {
  const { vault, version, platform } = useVault();
  const [query, setQuery] = useState("");
  const [personal, setPersonal] = useState<string | null>(null);
  useEffect(() => {
    vault.personalVaultId().then(setPersonal).catch(() => setPersonal(null));
  }, [vault, version]);
  const items = useMemo<BookmarkItem[]>(() => {
    void version;
    // Only your own vault's count, as in the sync: a shared vault's could be anyone's.
    return vault
      .allItems({ includeSystem: true })
      .filter((i) => i.body.kind === "bookmark" && i.vaultId === personal && i.body.bookmark)
      .map((i) => ({ id: i.id, title: i.body.title, parent: i.body.bookmark!.parent, url: i.body.bookmark!.url, pos: i.body.bookmark!.pos }));
  }, [vault, version, personal]);
  const tree = useMemo(() => bookmarkTree(items), [items]);
  const links = items.filter((i) => i.url !== undefined);
  const hits = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return links.filter((i) => words.every((w) => `${i.title} ${i.url}`.toLowerCase().includes(w))).slice(0, 200);
  }, [query, items]);
  const shown = ROOTS.filter(([r]) => tree[r].length > 0);
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 overflow-y-auto p-4" data-testid="bookmarks-screen">
      <div>
        <h1 className="text-lg font-semibold text-[var(--text)]">Bookmarks</h1>
        <p className="text-sm text-[var(--text-muted)]">Encrypted in your vault, so your server can't read them.</p>
      </div>
      {platform.bookmarkControls ?? (
        <Callout kind="info">
          <span data-testid="bookmarks-get-extension">To keep your bookmarks the same in every browser, install the Promptly Passwords extension in each one, and turn on bookmark sync under Bookmarks there. This page shows what's synced.</span>
        </Callout>
      )}
      {links.length > 0 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
          <input aria-label="Search bookmarks" placeholder="Search bookmarks" className={`${inputClass} pl-8`} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      )}
      {query ? (
        <div>
          {hits.map((i) => <Link key={i.id} node={{ ...i, children: [] }} />)}
          {hits.length === 0 && <p className="text-sm text-[var(--text-muted)]">No bookmarks match that.</p>}
        </div>
      ) : shown.length ? (
        <div className="flex flex-col gap-1">
          {shown.map(([r, name], i) => <FolderRow key={r} title={name} nodes={tree[r]} open={i === 0} />)}
        </div>
      ) : (
        <p className="text-sm text-[var(--text-muted)]">No bookmarks yet.</p>
      )}
    </div>
  );
}

