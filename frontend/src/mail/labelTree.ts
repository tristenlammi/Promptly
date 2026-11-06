import type { MailLabel } from "./api";

/** Labels nest by name, the way Gmail keeps them: "Homes/Lot 7534" sits under "Homes". */

export interface LabelRow {
  /** Its whole name, as a mailbox would write it. */
  path: string;
  /** Just its own part of the name. */
  name: string;
  depth: number;
  /** Null for a parent that's only a heading: "Homes/Lot 7534" with no "Homes". */
  label: MailLabel | null;
  hasChildren: boolean;
  /** Unread here and in everything under it, for when those are folded away. */
  unreadInside: number;
}

interface Node {
  path: string;
  name: string;
  label: MailLabel | null;
  children: Map<string, Node>;
}

const parts = (name: string) => name.split("/").map((p) => p.trim()).filter(Boolean);

export const shortName = (name: string) => parts(name).at(-1) ?? name;

/** Every label in order, each one followed by what's inside it. */
export function labelRows(labels: MailLabel[]): LabelRow[] {
  const root: Node = { path: "", name: "", label: null, children: new Map() };
  for (const label of labels) {
    let at = root;
    for (const part of parts(label.name)) {
      const key = part.toLowerCase();
      let next = at.children.get(key);
      if (!next) {
        next = { path: at.path ? `${at.path}/${part}` : part, name: part, label: null, children: new Map() };
        at.children.set(key, next);
      }
      at = next;
    }
    if (at !== root) at.label = label;
  }
  const rows: LabelRow[] = [];
  const walk = (node: Node, depth: number): number => {
    const row: LabelRow = { path: node.path, name: node.name, depth, label: node.label, hasChildren: node.children.size > 0, unreadInside: 0 };
    rows.push(row);
    row.unreadInside = (node.label?.unread ?? 0) + inOrder(node).reduce((sum, child) => sum + walk(child, depth + 1), 0);
    return row.unreadInside;
  };
  inOrder(root).forEach((node) => walk(node, 0));
  return rows;
}

function inOrder(node: Node): Node[] {
  return [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

/** Leaves out whatever is inside a folded-away parent. */
export function unfolded(rows: LabelRow[], folded: Set<string>): LabelRow[] {
  const out: LabelRow[] = [];
  let hideBelow: number | null = null;
  for (const row of rows) {
    if (hideBelow !== null && row.depth > hideBelow) continue;
    hideBelow = row.hasChildren && folded.has(row.path.toLowerCase()) ? row.depth : null;
    out.push(row);
  }
  return out;
}

/** The label this one sits inside, or "" at the top. */
export function parentOf(name: string): string {
  return parts(name).slice(0, -1).join("/");
}

export const joinLabel = (parent: string, name: string) => (parent ? `${parent}/${name.trim()}` : name.trim());

/** Places this label could go: not itself, nor anything already inside it. */
export function placesFor(rows: LabelRow[], name?: string): string[] {
  const self = name ? parts(name).join("/").toLowerCase() : null;
  return rows.map((r) => r.path).filter((p) => !self || (p.toLowerCase() !== self && !p.toLowerCase().startsWith(`${self}/`)));
}

const FOLDED_KEY = "promptly.mail.foldedLabels";

export function readFolded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function saveFolded(folded: Set<string>) {
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded]));
  } catch {
    // Only a convenience: it just opens unfolded next time.
  }
}
