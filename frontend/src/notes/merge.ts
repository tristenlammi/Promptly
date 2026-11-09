/**
 * Putting two people's edits together (``docs/notes-plan.md`` §5, Sync).
 *
 * A save carries what the note looked like when you started (``base``).
 * When the server has moved on, the title, colour and body are merged
 * three ways: whatever only one side changed is taken from that side. The
 * body merges block by block (each paragraph and heading has a stable id);
 * a block changed on both sides keeps both, theirs first, with a line
 * saying so — nothing anyone typed is lost.
 */
import { blockId, type DocNode, type Note } from "./types";
import type { Base, NoteFields } from "./ops";

/** What a body (or block) says, ignoring how it's written down: the server
 *  keeps bodies as jsonb (other key order) and drops editor-only attributes
 *  (a link's target and rel), which mustn't count as someone's change. */
function sem(n: DocNode | null | undefined): unknown {
  if (!n) return null;
  return [
    n.type,
    n.type === "heading" ? n.attrs?.level ?? 2 : 0,
    n.type === "text" ? n.text ?? "" : null,
    (n.marks ?? []).map((m) => (m.type === "link" ? `link:${String(m.attrs?.href ?? "")}` : m.type)).sort(),
    (n.content ?? []).map(sem),
  ];
}
const same = (a: DocNode | null | undefined, b: DocNode | null | undefined) => JSON.stringify(sem(a)) === JSON.stringify(sem(b));

function idOf(b: DocNode): string | undefined {
  const id = b.attrs?.id;
  return typeof id === "string" && id ? id : undefined;
}

/** Give every block an id (old notes, imports, plain-text writes). */
function withIds(doc: DocNode | null): DocNode[] {
  return (doc?.content ?? []).map((b) => (idOf(b) ? b : { ...b, attrs: { ...(b.attrs ?? {}), id: blockId() } }));
}

export function mergeDocs(base: DocNode | null, theirs: DocNode | null, mine: DocNode | null, theirName: string): DocNode | null {
  if (same(base, theirs)) return mine;
  if (same(base, mine)) return theirs;
  const B = new Map(withIds(base).flatMap((b) => (idOf(b) ? [[idOf(b) as string, b] as const] : [])));
  const T = withIds(theirs);
  const M = withIds(mine);
  const Tmap = new Map(T.map((b) => [idOf(b) as string, b]));
  const Mmap = new Map(M.map((b) => [idOf(b) as string, b]));

  const out: DocNode[] = [];
  for (const t of T) {
    const id = idOf(t) as string;
    const m = Mmap.get(id);
    const b = B.get(id);
    if (!m) {
      // Gone on my side: keep it only if they changed it (or added it).
      if (!b || !same(b, t)) out.push(t);
      continue;
    }
    if (same(m, t) || (b && same(m, b))) out.push(t);
    else if (b && same(t, b)) out.push(m);
    else {
      out.push(t);
      out.push({ type: "paragraph", attrs: { id: blockId() }, content: [{ type: "text", text: `${theirName} changed this while you were editing — your version is below.`, marks: [{ type: "italic" }] }] });
      out.push({ ...m, attrs: { ...(m.attrs ?? {}), id: blockId() } });
    }
  }
  // Mine that aren't in theirs: new on my side (place after the block before
  // them), or deleted by them (keep only if I changed it).
  let prev: string | null = null;
  for (const m of M) {
    const id = idOf(m) as string;
    if (!Tmap.has(id)) {
      const b = B.get(id);
      if (!b || !same(b, m)) {
        const at = prev ? out.findIndex((x) => idOf(x) === prev) : -1;
        out.splice(at + 1, 0, m);
      }
    }
    if (out.some((x) => idOf(x) === id)) prev = id;
  }
  return out.length ? { type: "doc", content: out } : null;
}

/** The fields to send so that ``mine`` (made from ``base``) lands on top of
 *  ``server`` without undoing anything someone else did meanwhile. */
export function mergeFields(base: Base, server: Note, fields: NoteFields, theirName: string): NoteFields {
  const out: NoteFields = { ...fields };
  if (fields.title !== undefined && fields.title === base.title) delete out.title;
  if (fields.color !== undefined && fields.color === base.color) delete out.color;
  if (fields.body_doc !== undefined) {
    if (server.kind !== "text") delete out.body_doc;
    else out.body_doc = mergeDocs(base.body_doc, server.body_doc ?? null, fields.body_doc, theirName);
  }
  return out;
}
