/*
 * Today's study queue, counts, forecasts and stats. The queue rules mirror
 * backend study.py (``counts``) so the badge, the AI and reminders agree
 * with what the Study tab shows.
 */
import * as F from "./fsrs";
import type { Card, Data, Deck, Log, Srs } from "./types";

export interface QItem {
  card: Card;
  srs: Srs;
  kind: "learning" | "review" | "new";
  dueMs: number;
}

export interface Today {
  learning: QItem[]; // due now
  learningLater: QItem[]; // later today (soonest first)
  review: QItem[]; // after the limit
  fresh: QItem[]; // new, after the limit
  newDone: number;
  reviewsDone: number;
  doneToday: number;
}

/** Today's answers. The log is kept in time order, but replays and several
 *  devices can leave entries slightly out of order, so the scan back stops
 *  only once entries are two study days old (mirrors study.py). */
export function todayLog(log: Log[], now: number, cfg: F.Config): Log[] {
  const today = F.dayIndex(now, cfg);
  const out: Log[] = [];
  for (let i = log.length - 1; i >= 0; i--) {
    const t = F.parseMoment(log[i].t);
    if (!Number.isFinite(t)) continue;
    const di = F.dayIndex(t, cfg);
    if (di === today) out.push(log[i]);
    else if (di < today - 1) break;
  }
  return out;
}

/** Where a new entry goes so the log stays in time order (almost always
 *  the end; searched from the back). */
export function logInsertAt(log: Log[], t: number): number {
  let i = log.length;
  while (i > 0) {
    const prev = F.parseMoment(log[i - 1].t);
    if (!(prev > t)) break;
    i--;
  }
  return i;
}

/** deck id -> [deck, parent, grandparent...] (cycle-safe). */
export function deckChains(decks: Deck[]): Map<string, string[]> {
  const parent = new Map(decks.map((d) => [d.id, d.parent_id]));
  const out = new Map<string, string[]>();
  for (const d of decks) {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur: string | null | undefined = d.id;
    while (cur != null && parent.has(cur) && !seen.has(cur) && chain.length < 25) {
      chain.push(cur);
      seen.add(cur);
      cur = parent.get(cur);
    }
    out.set(d.id, chain);
  }
  return out;
}

/** Today's limits: file-wide plus each deck's own (a deck's limit covers its
 *  subdecks; every limit on the way up applies). Mirrors study.py ``Caps``. */
export function makeCaps(data: Data, done: Log[]) {
  const s = data.settings;
  const chains = deckChains(data.decks);
  let newLeft = Math.max(0, s.new_per_day - done.filter((e) => e.s === "n").length);
  let revLeft = Math.max(0, s.max_reviews_per_day - done.filter((e) => e.s === "r").length);
  const deckNew = new Map<string, number>();
  const deckRev = new Map<string, number>();
  for (const d of data.decks) {
    if (d.new_per_day != null) deckNew.set(d.id, d.new_per_day);
    if (d.max_reviews_per_day != null) deckRev.set(d.id, d.max_reviews_per_day);
  }
  if (deckNew.size || deckRev.size) {
    const cardDeck = new Map(data.cards.map((c) => [c.id, c.deck_id]));
    for (const e of done) {
      const lim = e.s === "n" ? deckNew : e.s === "r" ? deckRev : null;
      const did = cardDeck.get(e.c);
      if (!lim || did === undefined) continue;
      for (const x of chains.get(did) ?? []) if (lim.has(x)) lim.set(x, lim.get(x)! - 1);
    }
  }
  return {
    chains,
    deckNew,
    deckRev,
    newLeft: () => newLeft,
    revLeft: () => revLeft,
    take(deckId: string, kind: "new" | "review"): boolean {
      const lim = kind === "new" ? deckNew : deckRev;
      if ((kind === "new" ? newLeft : revLeft) <= 0) return false;
      const chain = lim.size ? (chains.get(deckId) ?? []).filter((x) => lim.has(x)) : [];
      if (chain.some((x) => lim.get(x)! <= 0)) return false;
      for (const x of chain) lim.set(x, lim.get(x)! - 1);
      if (kind === "new") newLeft -= 1;
      else revLeft -= 1;
      return true;
    },
  };
}

/** The part of today's queue that only changes with the data or the study
 *  day. Memoise it on those (``useToday``) and :func:`split` it by the
 *  minute instead of rescanning every card on each tick. */
export interface TodayBase {
  learningAll: QItem[]; // every learning item, soonest first
  review: QItem[];
  fresh: QItem[];
  newDone: number;
  reviewsDone: number;
  doneToday: number;
  end: number;
}

export function todayBase(data: Data, now: number, cfg: F.Config, deckIds: Set<string> | null): TodayBase {
  const s = data.settings;
  const end = F.dayStart(F.dayIndex(now, cfg) + 1, cfg);
  const day = F.studyDate(now, cfg);
  const done = todayLog(data.review_log, now, cfg);
  const studied = new Set(done.map((e) => e.c));
  const newDone = done.filter((e) => e.s === "n").length;
  const reviewsDone = done.filter((e) => e.s === "r").length;
  const bury = s.bury_siblings;
  const learningAll: QItem[] = [];
  const review: QItem[] = [];
  const fresh: QItem[] = [];
  for (const c of data.cards) {
    if (c.suspended || (deckIds && !deckIds.has(c.deck_id))) continue;
    if (c.buried_until && c.buried_until > day) continue;
    let taken = bury && studied.has(c.id);
    for (const srs of c.srs) {
      if (srs.state === "learning" || srs.state === "relearning") {
        learningAll.push({ card: c, srs, kind: "learning", dueMs: srs.due ? F.parseMoment(srs.due) : -Infinity });
        continue;
      }
      if (taken) continue;
      if (srs.state === "review" && srs.due && F.parseMoment(srs.due) < end) {
        review.push({ card: c, srs, kind: "review", dueMs: F.parseMoment(srs.due) });
        taken = bury;
      } else if (srs.state === "new") {
        fresh.push({ card: c, srs, kind: "new", dueMs: 0 });
        taken = bury;
      }
    }
  }
  learningAll.sort((a, b) => a.dueMs - b.dueMs);
  review.sort((a, b) => a.dueMs - b.dueMs);
  const caps = makeCaps(data, done);
  return {
    learningAll,
    review: review.filter((q) => caps.take(q.card.deck_id, "review")),
    fresh: fresh.filter((q) => caps.take(q.card.deck_id, "new")),
    newDone,
    reviewsDone,
    doneToday: done.length,
    end,
  };
}

/** Learning items due now vs later today, for ``now`` (cheap). */
export function split(b: TodayBase, now: number): Today {
  const learning: QItem[] = [];
  const later: QItem[] = [];
  for (const q of b.learningAll) {
    if (q.dueMs <= now) learning.push(q.dueMs === -Infinity ? { ...q, dueMs: now } : q);
    else if (q.dueMs < b.end) later.push(q);
  }
  return { learning, learningLater: later, review: b.review, fresh: b.fresh, newDone: b.newDone, reviewsDone: b.reviewsDone, doneToday: b.doneToday };
}

export function today(data: Data, now: number, cfg: F.Config, deckIds: Set<string> | null): Today {
  return split(todayBase(data, now, cfg, deckIds), now);
}

export function countsOf(t: Today) {
  return { learning: t.learning.length, review: t.review.length, fresh: t.fresh.length, total: t.learning.length + t.review.length + t.fresh.length };
}

/** Reviews interleaved with new cards by ``new_mix``. */
export function mix(review: QItem[], fresh: QItem[], how: "mixed" | "before" | "after"): QItem[] {
  if (how === "before") return [...fresh, ...review];
  if (how === "after" || !fresh.length) return [...review, ...fresh];
  if (!review.length) return fresh;
  const out: QItem[] = [];
  const every = (review.length + fresh.length) / fresh.length;
  let r = 0;
  let n = 0;
  for (let i = 0; i < review.length + fresh.length; i++) {
    if (n < fresh.length && (i + 1) >= every * (n + 1) - 0.0001) out.push(fresh[n++]);
    else if (r < review.length) out.push(review[r++]);
    else out.push(fresh[n++]);
  }
  return out;
}

/**
 * The next item to show: learning due now, then reviews/new, then (when
 * nothing else is left) a learning item due within the learn-ahead window.
 * ``avoid`` = the card just answered, skipped when there's an alternative.
 */
export function nextItem(t: Today, how: "mixed" | "before" | "after", now: number, avoid?: string): QItem | null {
  const pick = (list: QItem[]) => list.find((q) => q.card.id !== avoid) ?? null;
  const main = mix(t.review, t.fresh, how);
  const first = pick(t.learning) ?? pick(main);
  if (first) return first;
  const ahead = t.learningLater.filter((q) => q.dueMs - now <= F.LEARN_AHEAD_MIN * 60_000);
  return pick(ahead) ?? t.learning[0] ?? main[0] ?? ahead[0] ?? null;
}

// ------------------------------------------------------------------ stats

export function streak(log: Log[], now: number, cfg: F.Config): { days: number; studiedToday: boolean; best: number } {
  const days = new Set<number>();
  for (const e of log) days.add(F.dayIndex(F.parseMoment(e.t), cfg));
  const t = F.dayIndex(now, cfg);
  const studiedToday = days.has(t);
  let cur = studiedToday ? t : t - 1;
  let n = 0;
  while (days.has(cur)) {
    n++;
    cur--;
  }
  let best = 0;
  let run = 0;
  let prev: number | null = null;
  for (const d of [...days].sort((a, b) => a - b)) {
    run = prev !== null && d === prev + 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return { days: n, studiedToday, best };
}

export function forecast(data: Data, now: number, cfg: F.Config, days: number, deckIds: Set<string> | null): number[] {
  const t = F.dayIndex(now, cfg);
  const out = new Array(days).fill(0);
  for (const c of data.cards) {
    if (c.suspended || (deckIds && !deckIds.has(c.deck_id))) continue;
    for (const s of c.srs) {
      if (s.state === "new" || !s.due) continue;
      const di = Math.max(t, F.dayIndex(F.parseMoment(s.due), cfg));
      if (di - t < days) out[di - t] += 1;
    }
  }
  return out;
}

export interface DayStat {
  n: number;
  ms: number;
  pass: number;
  reviews: number; // reviews of review-state items (for true retention)
}

export function byDay(log: Log[], cfg: F.Config, ids: Set<string> | null): Map<number, DayStat> {
  const m = new Map<number, DayStat>();
  for (const e of log) {
    if (ids && !ids.has(e.c)) continue;
    const di = F.dayIndex(F.parseMoment(e.t), cfg);
    let s = m.get(di);
    if (!s) m.set(di, (s = { n: 0, ms: 0, pass: 0, reviews: 0 }));
    s.n += 1;
    s.ms += Math.min(e.d, 60_000);
    if (e.s === "r") {
      s.reviews += 1;
      if (e.r > 1) s.pass += 1;
    }
  }
  return m;
}

export interface DeckCount {
  learning: number;
  review: number;
  fresh: number;
  cards: number;
}

/** Due counts for every deck (with its subdecks), in one pass — the same
 *  numbers as ``today(…, subtree)`` per deck, capped by today's limits. */
export function deckCounts(data: Data, now: number, cfg: F.Config): Map<string, DeckCount> {
  const s = data.settings;
  const end = F.dayStart(F.dayIndex(now, cfg) + 1, cfg);
  const day = F.studyDate(now, cfg);
  const done = todayLog(data.review_log, now, cfg);
  const studied = new Set(done.map((e) => e.c));
  const caps = makeCaps(data, done);
  const own = new Map<string, DeckCount>();
  for (const d of data.decks) own.set(d.id, { learning: 0, review: 0, fresh: 0, cards: 0 });
  for (const c of data.cards) {
    const k = own.get(c.deck_id);
    if (!k) continue;
    k.cards += 1;
    if (c.suspended || (c.buried_until && c.buried_until > day)) continue;
    let taken = s.bury_siblings && studied.has(c.id);
    for (const srs of c.srs) {
      if (srs.state === "learning" || srs.state === "relearning") {
        if (!srs.due || F.parseMoment(srs.due) <= now) k.learning += 1;
        continue;
      }
      if (taken) continue;
      if (srs.state === "review" && srs.due && F.parseMoment(srs.due) < end) {
        k.review += 1;
        taken = s.bury_siblings;
      } else if (srs.state === "new") {
        k.fresh += 1;
        taken = s.bury_siblings;
      }
    }
  }
  const kids = new Map<string | null, string[]>();
  for (const d of data.decks) {
    const p = d.parent_id && own.has(d.parent_id) ? d.parent_id : null;
    kids.set(p, [...(kids.get(p) ?? []), d.id]);
  }
  const out = new Map<string, DeckCount>();
  const sum = (id: string, depth: number): DeckCount => {
    const hit = out.get(id);
    if (hit) return hit;
    const base = { ...(own.get(id) ?? { learning: 0, review: 0, fresh: 0, cards: 0 }) };
    if (depth < 25)
      for (const k of kids.get(id) ?? []) {
        const c = sum(k, depth + 1);
        base.learning += c.learning;
        base.review += c.review;
        base.fresh += c.fresh;
        base.cards += c.cards;
      }
    out.set(id, base);
    return base;
  };
  for (const d of data.decks) sum(d.id, 0);
  // Every limit on the way up applies to a deck's numbers (study.py deck_counts).
  for (const [id, v] of out) {
    const chain = caps.chains.get(id) ?? [];
    const nl = chain.filter((x) => caps.deckNew.has(x)).map((x) => caps.deckNew.get(x)!);
    const rl = chain.filter((x) => caps.deckRev.has(x)).map((x) => caps.deckRev.get(x)!);
    v.review = Math.max(0, Math.min(v.review, caps.revLeft(), ...rl));
    v.fresh = Math.max(0, Math.min(v.fresh, caps.newLeft(), ...nl));
  }
  return out;
}
