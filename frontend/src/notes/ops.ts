/**
 * Changes to notes, as this device makes them. Each one is applied to the
 * note on screen at once and queued in the outbox; the sync loop
 * (``store.ts``) sends them in order. Every op carries the ids it needs
 * (client-made note and item ids), so sending one twice does nothing new,
 * and applying one twice to a note gives the same note — which is what lets
 * a sent change stay on screen until the refreshed note arrives.
 */
import { attachmentCounts, docText, textDoc, type DocNode, type Note, type NoteAttachment, type NoteItem, type NoteKind, type NoteLabel } from "./types";

export type ItemFields = { text?: string; checked?: boolean; parent_id?: string | null; position?: number };
export type MeFields = { pinned?: boolean; archived?: boolean; position?: number };
export type NoteFields = { title?: string; body_doc?: DocNode | null; color?: string; kind?: NoteKind; list_opts?: Record<string, boolean> };
export type Base = { title: string; body_doc: DocNode | null; color: string };

export type Op =
  | { k: "create"; id: string; note: Note }
  | { k: "patch"; id: string; fields: NoteFields; base: Base }
  | { k: "item_add"; id: string; item: NoteItem; after_id: string | null }
  | { k: "item_patch"; id: string; iid: string; fields: ItemFields }
  | { k: "item_delete"; id: string; iid: string }
  | { k: "items_bulk"; id: string; action: "untick_all" | "delete_ticked" | "sort" }
  | { k: "me"; id: string; fields: MeFields }
  | { k: "labels"; id: string; labels: NoteLabel[] }
  | { k: "trash"; id: string; owner: boolean }
  | { k: "restore"; id: string }
  | { k: "forever"; id: string }
  | { k: "empty_trash"; id: "" }
  // A picture or recording already in Drive (uploaded, or from Photos) goes in the note.
  | { k: "attach"; id: string; att: NoteAttachment }
  | { k: "detach"; id: string; aid: string; kind: "image" | "audio" }
  | { k: "transcribe"; id: string; aid: string };

export interface QueuedOp {
  seq: number;
  op: Op;
  /** Sent and accepted; kept on screen until the note is refetched. */
  landed?: number;
}

const now = () => new Date().toISOString();

/** Items in the order a list shows them: each top-level item, then its own. */
export function grouped(items: NoteItem[]): NoteItem[] {
  const byPos = [...items].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const ids = new Set(byPos.map((i) => i.id));
  const tops = byPos.filter((i) => !i.parent_id || !ids.has(i.parent_id));
  const kids = new Map<string, NoteItem[]>();
  for (const i of byPos) if (i.parent_id && ids.has(i.parent_id)) kids.set(i.parent_id, [...(kids.get(i.parent_id) ?? []), i]);
  return tops.flatMap((t) => [t, ...(kids.get(t.id) ?? [])]);
}

function recount(n: Note): Note {
  // A card only has a preview of its list: keep the server's counts and
  // adjust by what changed here (see the item ops below).
  return n;
}

function withItems(n: Note, items: NoteItem[], delta: { total?: number; checked?: number } = {}): Note {
  return recount({
    ...n,
    items,
    items_total: Math.max(0, n.items_total + (delta.total ?? 0)),
    items_checked: Math.max(0, n.items_checked + (delta.checked ?? 0)),
  });
}

function positionAfter(items: NoteItem[], afterId: string | null): number {
  const sorted = [...items].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  if (!afterId) return (sorted.length ? sorted[sorted.length - 1].position ?? 0 : 0) + 1;
  const i = sorted.findIndex((x) => x.id === afterId);
  if (i < 0) return (sorted.length ? sorted[sorted.length - 1].position ?? 0 : 0) + 1;
  const a = sorted[i].position ?? 0;
  const b = sorted[i + 1]?.position;
  return b === undefined ? a + 1 : (a + b) / 2;
}

/** ``note`` with ``op`` applied (null: the note is gone from this device). */
export function applyOp(note: Note | null, op: Op): Note | null {
  if (op.k === "create") return note ?? op.note;
  if (op.k === "empty_trash") return note && note.trashed_at ? null : note;
  if (!note) return null;
  switch (op.k) {
    case "patch": {
      let n: Note = { ...note };
      const f = op.fields;
      if (f.kind && f.kind !== n.kind) n = convert(n, f.kind);
      if (f.title !== undefined) n.title = f.title;
      if (f.color !== undefined) n.color = f.color;
      if (f.list_opts !== undefined) n.list_opts = { ...f.list_opts };
      if (f.body_doc !== undefined && n.kind === "text") {
        n.body_doc = f.body_doc;
        n.body_text = docText(f.body_doc);
        n.snippet = n.snippet === null ? null : n.body_text.slice(0, 1000);
      }
      return n;
    }
    case "item_add": {
      if (note.items.some((i) => i.id === op.item.id)) return note;
      const item = { ...op.item, position: op.item.position ?? positionAfter(note.items, op.after_id) };
      return withItems(note, [...note.items, item], { total: 1, checked: item.checked ? 1 : 0 });
    }
    case "item_patch": {
      const cur = note.items.find((i) => i.id === op.iid);
      if (!cur) {
        // A card's preview may not hold the item: only the counts move.
        if (op.fields.checked === undefined) return note;
        return withItems(note, note.items, { checked: op.fields.checked ? 1 : -1 });
      }
      const next = { ...cur, ...op.fields };
      if (op.fields.checked !== undefined && op.fields.checked !== cur.checked) next.checked_at = op.fields.checked ? now() : null;
      const d = op.fields.checked === undefined || op.fields.checked === cur.checked ? 0 : op.fields.checked ? 1 : -1;
      return withItems(
        note,
        note.items.map((i) => (i.id === op.iid ? next : i)),
        { checked: d },
      );
    }
    case "item_delete": {
      const cur = note.items.find((i) => i.id === op.iid);
      if (!cur) return note;
      const items = note.items.filter((i) => i.id !== op.iid).map((i) => (i.parent_id === op.iid ? { ...i, parent_id: null } : i));
      return withItems(note, items, { total: -1, checked: cur.checked ? -1 : 0 });
    }
    case "items_bulk": {
      if (op.action === "untick_all") {
        return { ...note, items: note.items.map((i) => (i.checked ? { ...i, checked: false, checked_at: null } : i)), items_checked: 0 };
      }
      if (op.action === "delete_ticked") {
        const gone = new Set(note.items.filter((i) => i.checked).map((i) => i.id));
        const items = note.items.filter((i) => !gone.has(i.id)).map((i) => (i.parent_id && gone.has(i.parent_id) ? { ...i, parent_id: null } : i));
        return { ...note, items, items_total: Math.max(0, note.items_total - note.items_checked), items_checked: 0 };
      }
      const tops = note.items.filter((i) => !i.parent_id).sort((a, b) => a.text.localeCompare(b.text, undefined, { sensitivity: "base" }) || (a.position ?? 0) - (b.position ?? 0));
      const order = tops.flatMap((t) => [t, ...note.items.filter((i) => i.parent_id === t.id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))]);
      const seen = new Set(order.map((i) => i.id));
      const rest = note.items.filter((i) => !seen.has(i.id));
      return { ...note, items: [...order, ...rest].map((i, n) => ({ ...i, position: n + 1 })) };
    }
    case "me": {
      const n = { ...note };
      if (op.fields.archived !== undefined) {
        n.archived = op.fields.archived;
        if (op.fields.archived) n.pinned = false;
      }
      if (op.fields.pinned !== undefined) {
        n.pinned = op.fields.pinned;
        if (op.fields.pinned) n.archived = false;
      }
      if (op.fields.position !== undefined) n.position = op.fields.position;
      return n;
    }
    case "labels":
      return { ...note, labels: op.labels };
    case "trash":
      return op.owner ? { ...note, trashed_at: note.trashed_at ?? now(), pinned: note.pinned } : null;
    case "restore":
      return { ...note, trashed_at: null };
    case "forever":
      return null;
    case "attach": {
      const a = note.attachments;
      if (Array.isArray(a)) return a.some((x) => x.id === op.att.id) ? note : { ...note, attachments: [...a, op.att] };
      // A card: only the counts move.
      const c = attachmentCounts(note);
      return {
        ...note,
        attachments: op.att.kind === "image" ? { ...c, images: c.images + 1 } : { ...c, audio: c.audio + 1, audio_ms: c.audio_ms + (op.att.duration_ms ?? 0) },
      };
    }
    case "detach": {
      const a = note.attachments;
      if (Array.isArray(a)) return { ...note, attachments: a.filter((x) => x.id !== op.aid) };
      const c = attachmentCounts(note);
      return {
        ...note,
        covers: note.covers?.filter((x) => x.id !== op.aid),
        attachments: op.kind === "image" ? { ...c, images: Math.max(0, c.images - 1) } : { ...c, audio: Math.max(0, c.audio - 1) },
      };
    }
    case "transcribe": {
      const a = note.attachments;
      if (!Array.isArray(a)) return note;
      return { ...note, attachments: a.map((x) => (x.id === op.aid ? { ...x, transcript_state: "pending" as const } : x)) };
    }
  }
}

/** Show or hide checkboxes, as the server does: lines ↔ items. */
function convert(n: Note, kind: NoteKind): Note {
  if (kind === "list") {
    const lines = (n.body_text ?? docText(n.body_doc) ?? n.snippet ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const top = n.items.reduce((m, i) => Math.max(m, i.position ?? 0), 0);
    const items = lines.map((text, i) => ({ id: `conv-${n.id}-${i}`, parent_id: null, text, checked: false, position: top + i + 1 }));
    return { ...n, kind, body_doc: null, body_text: "", snippet: n.snippet === null ? null : "", items: [...n.items, ...items], items_total: n.items_total + items.length };
  }
  const lines = grouped(n.items).map((i) => (i.parent_id ? "  " : "") + i.text);
  const before = n.body_text ? n.body_text.split("\n") : [];
  const doc = textDoc([...before, ...lines].join("\n"));
  const text = docText(doc);
  return { ...n, kind, items: [], items_total: 0, items_checked: 0, body_doc: doc, body_text: text, snippet: n.snippet === null ? null : text.slice(0, 1000) };
}

/** Fold ``next`` into ``prev`` when they're the same kind of change to the
 *  same thing (typing makes many; the server needs the last). */
export function coalesce(prev: Op, next: Op): Op | null {
  if (prev.id !== next.id) return null;
  if (prev.k === "create" && next.k !== "create") {
    // Not sent yet: the new note simply starts with the change in it.
    const n = applyOp(prev.note, next);
    return n && ["patch", "item_add", "item_patch", "item_delete", "items_bulk", "me", "labels"].includes(next.k) ? { ...prev, note: n } : null;
  }
  if (prev.k === "patch" && next.k === "patch") {
    if (next.fields.kind !== undefined && next.fields.kind !== prev.fields.kind) return null;
    return { ...prev, fields: { ...prev.fields, ...next.fields } };
  }
  if (prev.k === "item_patch" && next.k === "item_patch" && prev.iid === next.iid) return { ...prev, fields: { ...prev.fields, ...next.fields } };
  if (prev.k === "item_add" && next.k === "item_patch" && prev.item.id === next.iid) return { ...prev, item: { ...prev.item, ...next.fields } };
  if (prev.k === "me" && next.k === "me") return { ...prev, fields: { ...prev.fields, ...next.fields } };
  if (prev.k === "labels" && next.k === "labels") return next;
  return null;
}

export { docText };
