/* Wiki-link hrefs — plain helpers with no editor dependency, so the chat
 * (which links to workspace items) doesn't pull the TipTap editor into
 * every page load just to build a URL. */

/** A single selectable wiki-link target.
 *
 * The ``@`` menu reuses this shape for people and dates too, discriminated
 * by ``kind``: a normal item (note/board/…) inserts a wiki Link mark; a
 * ``"person"`` inserts a mention chip (``@name``); a ``"date"`` inserts
 * ``insertText`` as plain text. ``[[`` only ever yields items. */
export interface WikiTarget {
  id: string;
  kind: string;
  refId: string | null;
  title: string;
  workspaceId: string;
  /** For ``kind === "date"`` — the literal text to drop in (e.g. the
   *  formatted date); ignored for items/people. */
  insertText?: string;
}

/** Build the in-app relative href the Link mark carries. Relative on
 *  purpose — survives the Yjs → HTML → bleach snapshot pipeline, and the
 *  backend backlinks scan looks for the ``item=<id>`` substring. */
export function buildWikiHref(target: WikiTarget): string {
  const params = new URLSearchParams();
  params.set("item", target.id);
  params.set("kind", target.kind);
  if (target.refId) params.set("ref", target.refId);
  return `/workspaces/${target.workspaceId}?${params.toString()}`;
}

/** Parse the ``item`` / ``kind`` / ``ref`` params back out of a wiki href.
 *  Returns ``null`` when the href isn't a wiki-link (no ``item=``). Tolerant
 *  of absolute hrefs too in case the browser resolved the relative URL. */
export function parseWikiHref(
  href: string | null | undefined
): { item: string; kind: string; ref: string | null } | null {
  if (!href || !href.includes("item=")) return null;
  // Parse against a dummy base so a relative href resolves cleanly.
  let search: string;
  try {
    search = new URL(href, "http://x").search;
  } catch {
    // Fall back to whatever follows the first ``?``.
    const qi = href.indexOf("?");
    search = qi >= 0 ? href.slice(qi) : "";
  }
  const params = new URLSearchParams(search);
  const item = params.get("item");
  if (!item) return null;
  return {
    item,
    kind: params.get("kind") ?? "note",
    ref: params.get("ref"),
  };
}
