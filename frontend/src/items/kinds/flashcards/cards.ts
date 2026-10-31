/*
 * Cards, clozes, decks and search — mirrors backend cloze.py / study.py.
 */
import { uid } from "@/items/ui";

import * as F from "./fsrs";
import type { Card, CardType, Data, Deck } from "./types";

export const CLOZE_RE = /\{\{c(\d{1,2})::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;
const OPEN_RE = /\{\{c\d+::/g;

export function clozeNumbers(text: string): number[] {
  const out = new Set<number>();
  for (const m of (text || "").matchAll(CLOZE_RE)) {
    const n = Number(m[1]);
    if (n >= 1) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** An error message, or null when the cloze text is fine. */
export function clozeProblem(text: string): string | null {
  const t = text || "";
  const matches = [...t.matchAll(CLOZE_RE)];
  if (!matches.length) return "Add at least one deletion like {{c1::answer}}.";
  if ((t.match(OPEN_RE) || []).length !== matches.length) return "A deletion isn't closed, or one is inside another.";
  for (const m of matches) {
    if (Number(m[1]) < 1) return "Cloze numbers start at c1.";
    if (!m[2].trim()) return `{{c${m[1]}::…}} has an empty answer.`;
  }
  return null;
}

export function reviewKeys(type: CardType, front: string): string[] {
  if (type === "reversed") return ["f", "r"];
  if (type === "cloze") {
    const nums = clozeNumbers(front);
    return nums.length ? nums.map((n) => `c${n}`) : ["c1"];
  }
  return ["f"];
}

/** Keep the scheduling of review items that still exist; add new ones. */
export function reconcile(card: Card): Card {
  const have = new Map(card.srs.map((s) => [s.k, s]));
  card.srs = reviewKeys(card.type, card.front).map((k) => have.get(k) ?? F.newSrs(k));
  return card;
}

export function cardProblem(c: { type: CardType; front: string; back: string }): string | null {
  if (!c.front.trim()) return "The front is empty.";
  if (c.type === "cloze") return clozeProblem(c.front);
  if (!c.back.trim()) return "Add the answer on the back.";
  if (/\{\{c\d+::/.test(c.front)) return "That front has cloze deletions — switch the type to Cloze.";
  return null;
}

/** Plain text of a cloze side (lists, search, previews). */
export function plain(text: string, active: number | null = null, reveal = true): string {
  return (text || "").replace(CLOZE_RE, (_m, n: string, ans: string, hint?: string) =>
    active !== null && Number(n) === active && !reveal ? (hint ? `[${hint}]` : "[…]") : ans,
  );
}

export function oneLine(text: string, n = 120): string {
  return plain(text)
    .replace(/\$\$?/g, "")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);
}

export function newCard(deckId: string, type: CardType, front: string, back: string, note = "", tags: string[] = []): Card {
  const now = F.iso(Date.now());
  return reconcile({
    id: uid("k"),
    deck_id: deckId,
    type,
    front: front.trim(),
    back: back.trim(),
    note: note.trim(),
    tags,
    flagged: false,
    suspended: false,
    buried_until: null,
    created: now,
    modified: now,
    srs: [],
  });
}

export const normFront = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

// ------------------------------------------------------------------ decks

export function deckPaths(decks: Deck[]): Map<string, string> {
  const byId = new Map(decks.map((d) => [d.id, d]));
  const out = new Map<string, string>();
  const path = (id: string, depth = 0): string => {
    const hit = out.get(id);
    if (hit !== undefined) return hit;
    const d = byId.get(id);
    if (!d) return "";
    const p = d.parent_id && depth <= 20 ? `${path(d.parent_id, depth + 1)}::${d.name}` : d.name;
    out.set(id, p);
    return p;
  };
  for (const d of decks) path(d.id);
  return out;
}

export function childrenOf(decks: Deck[]): Map<string | null, Deck[]> {
  const m = new Map<string | null, Deck[]>();
  for (const d of decks) {
    const key = d.parent_id && decks.some((x) => x.id === d.parent_id) ? d.parent_id : null;
    m.set(key, [...(m.get(key) ?? []), d]);
  }
  for (const list of m.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return m;
}

export function subtree(decks: Deck[], id: string): Set<string> {
  const kids = childrenOf(decks);
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    if (out.has(cur)) continue;
    out.add(cur);
    for (const k of kids.get(cur) ?? []) stack.push(k.id);
  }
  return out;
}

/** A deck flattened in tree order with its depth, for pickers and lists. */
export function deckTree(decks: Deck[]): { deck: Deck; depth: number }[] {
  const kids = childrenOf(decks);
  const out: { deck: Deck; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const d of kids.get(parent) ?? []) {
      out.push({ deck: d, depth });
      if (depth < 20) walk(d.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export const PALETTE = ["#5B6DD9", "#E2725B", "#4E9F5B", "#D9902F", "#7B6CD9", "#2C9CC8", "#C2557A", "#2F8F83"];

/** Ids and time for :func:`ensureDeck`, made *outside* a mutator — mutators
 *  are replayed on newer data, so they must not call ``uid()`` themselves. */
export function deckSeed(): { base: string; at: string } {
  return { base: uid("d"), at: F.iso(Date.now()) };
}

/** The deck at "A::B", created (in ``d``) where missing. Returns its id. */
export function ensureDeck(d: Data, path: string, seed: { base: string; at: string }, color?: string, description = ""): string {
  const parts = path.split("::").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) parts.push("Default");
  let parent: string | null = null;
  let id = "";
  parts.forEach((name, i) => {
    const hit: Deck | undefined = d.decks.find((x) => x.parent_id === parent && x.name.toLowerCase() === name.toLowerCase());
    const last = i === parts.length - 1;
    if (hit) id = hit.id;
    else {
      id = last ? seed.base : `${seed.base}-${i}`;
      d.decks.push({
        id,
        name: name.slice(0, 120),
        parent_id: parent,
        description: last ? description : "",
        color: (last && color) || PALETTE[d.decks.length % PALETTE.length],
        created: seed.at,
      });
    }
    parent = id;
  });
  return id;
}

// ----------------------------------------------------------------- search

export function tokens(q: string): string[] {
  const out: string[] = [];
  const re = /(-?)(?:(\w+):)?"([^"]*)"|(\S+)/g;
  for (const m of (q || "").matchAll(re)) {
    if (m[4] !== undefined) out.push(m[4]);
    else out.push(`${m[1]}${m[2] ? `${m[2]}:` : ""}${m[3]}`);
  }
  return out;
}

export type CardStateLabel = "new" | "learning" | "review" | "suspended";

export function cardState(c: Card): CardStateLabel {
  if (c.suspended) return "suspended";
  const states = new Set(c.srs.map((s) => s.state));
  if (states.has("learning") || states.has("relearning")) return "learning";
  if (!c.srs.length || (states.size === 1 && states.has("new"))) return "new";
  return "review";
}

export function isDue(c: Card, now: number, cfg: F.Config): boolean {
  if (c.suspended) return false;
  const end = F.dayStart(F.dayIndex(now, cfg) + 1, cfg);
  return c.srs.some((s) => s.state !== "new" && !!s.due && F.parseMoment(s.due) < end);
}

/** Search syntax (mirrors Python ``study.matches``). */
export function matches(c: Card, query: string, paths: Map<string, string>, now: number, cfg: F.Config): boolean {
  for (const tok of tokens(query)) {
    const neg = tok.startsWith("-") && tok.length > 1;
    const t = neg ? tok.slice(1) : tok;
    const low = t.toLowerCase();
    let ok: boolean;
    if (low.startsWith("tag:")) {
      const want = low.slice(4);
      ok = c.tags.some((tag) => {
        const x = tag.toLowerCase();
        return x === want || x.startsWith(`${want}::`) || (want.endsWith("*") && x.startsWith(want.slice(0, -1)));
      });
    } else if (low.startsWith("deck:")) {
      const want = low.slice(5);
      const p = (paths.get(c.deck_id) ?? "").toLowerCase();
      ok = p === want || p.startsWith(`${want}::`) || (want.endsWith("*") && p.startsWith(want.slice(0, -1)));
    } else if (low.startsWith("is:")) {
      const what = low.slice(3);
      if (what === "due") ok = isDue(c, now, cfg);
      else if (what === "suspended") ok = c.suspended;
      else if (what === "flagged") ok = c.flagged;
      else if (what === "buried") ok = !!c.buried_until && c.buried_until > F.studyDate(now, cfg);
      else if (what === "leech") ok = c.tags.some((x) => x.toLowerCase() === "leech");
      else ok = cardState(c) === what;
    } else if (low.startsWith("type:")) {
      ok = c.type === low.slice(5);
    } else {
      ok = `${c.front}\n${c.back}\n${c.note}`.toLowerCase().includes(low);
    }
    if (ok === neg) return false;
  }
  return true;
}

export function allTags(cards: Card[]): { tag: string; n: number }[] {
  const m = new Map<string, { tag: string; n: number }>();
  for (const c of cards)
    for (const t of c.tags) {
      const k = t.toLowerCase();
      const hit = m.get(k);
      if (hit) hit.n += 1;
      else m.set(k, { tag: t, n: 1 });
    }
  return [...m.values()].sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
}

// ----------------------------------------------------------------- export

function csvCell(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(d: Data, ids?: Set<string>): string {
  const paths = deckPaths(d.decks);
  const rows = [["front", "back", "tags", "deck", "note", "type"]];
  for (const c of d.cards) {
    if (ids && !ids.has(c.id)) continue;
    rows.push([c.front, c.back, c.tags.join(" "), paths.get(c.deck_id) ?? "", c.note, c.type]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

export function download(name: string, text: string, mime = "text/csv") {
  const blob = new Blob(["﻿", text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const TYPE_LABEL: Record<CardType, string> = {
  basic: "Basic",
  reversed: "Basic + reversed",
  cloze: "Cloze",
  typein: "Type the answer",
};
