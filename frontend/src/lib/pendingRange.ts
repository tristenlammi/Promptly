import type { Node as PMNode } from "@tiptap/pm/model";
import type { Mapping } from "@tiptap/pm/transform";

/**
 * A document range waiting on something slow (an AI rewrite, WP-4.1 R-222).
 * The positions are mapped through every change made meanwhile — by you or
 * a collaborator — so the result lands where the text now is, and the text
 * itself is compared before anything is replaced.
 */
export interface PendingRange {
  from: number;
  to: number;
  /** The plain text the range held when it was taken. */
  text: string;
}

export function rangeText(doc: PMNode, from: number, to: number): string {
  const end = Math.min(to, doc.content.size);
  const start = Math.min(Math.max(0, from), end);
  return doc.textBetween(start, end, "\n").trim();
}

/** Map ``range`` through a transaction's mapping. Text typed right at the
 *  edges stays outside it. Null once the range has been deleted. */
export function mapPendingRange(range: PendingRange, mapping: Mapping): PendingRange | null {
  const from = mapping.mapResult(range.from, 1);
  const to = mapping.mapResult(range.to, -1);
  if (to.pos <= from.pos || (from.deleted && to.deleted)) return null;
  return { ...range, from: from.pos, to: to.pos };
}

/** Does the range still hold the text it was taken with? */
export function rangeUnchanged(doc: PMNode, range: PendingRange): boolean {
  return rangeText(doc, range.from, range.to) === range.text;
}

/** Just after the top-level block the range ends in — where "Insert
 *  below" puts a rewrite when the original changed. */
export function afterRangeBlock(doc: PMNode, range: PendingRange): number {
  const pos = Math.min(range.to, doc.content.size);
  const $pos = doc.resolve(pos);
  return $pos.depth >= 1 ? $pos.after(1) : pos;
}
