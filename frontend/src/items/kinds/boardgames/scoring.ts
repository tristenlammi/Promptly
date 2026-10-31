import type { Entry, Game, Play, ScoreCategory, Seat, Team } from "./types";

/*
 * Totals, places and winners — the mirror of the backend's scoring.py (the
 * live pad works offline). Keep the two in step.
 */

export function cleanNum(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function playCategories(game: Game | undefined, play?: Pick<Play, "expansions"> | null): ScoreCategory[] {
  if (!game) return [];
  const cats = [...game.scoring.categories];
  const used = new Set(play?.expansions ?? []);
  for (const ex of game.expansions) if (used.has(ex.id)) cats.push(...ex.categories);
  return cats;
}

/** Points for one box. With ``scores`` (the whole entry), a category that
 *  ``requires`` another counts only once that one scored (Yahtzee bonus). */
export function categoryPoints(cat: ScoreCategory, value: number | null | undefined, scores?: Record<string, number>): number {
  if (value === null || value === undefined) return 0;
  if (cat.requires && scores && !scores[cat.requires]) return 0;
  const pts = value * (cat.multiplier ?? 1);
  return cat.subtract ? -pts : pts;
}

export interface BonusState {
  id: string;
  name: string;
  progress: number;
  threshold: number;
  points: number;
  earned: boolean;
}

export function bonusStates(game: Game | undefined, entry: Pick<Entry, "scores">, cats: ScoreCategory[]): BonusState[] {
  if (!game) return [];
  const byId = new Map(cats.map((c) => [c.id, c]));
  return game.scoring.bonuses.map((b) => {
    const ids = b.categories.length ? b.categories : cats.map((c) => c.id);
    const progress = ids.reduce((n, id) => {
      const c = byId.get(id);
      return c ? n + categoryPoints(c, entry.scores[id], entry.scores) : n;
    }, 0);
    return { id: b.id, name: b.name, progress: cleanNum(progress), threshold: b.threshold, points: b.points, earned: progress >= b.threshold };
  });
}

export function hasEntries(e: Partial<Entry>): boolean {
  return (
    (e.total !== null && e.total !== undefined) ||
    Object.values(e.scores ?? {}).some((v) => v !== null && v !== undefined) ||
    (e.rounds ?? []).some((v) => v !== null && v !== undefined)
  );
}

export function entryTotal(game: Game | undefined, entry: Entry, cats?: ScoreCategory[]): number {
  if (entry.total !== null && entry.total !== undefined) return cleanNum(entry.total);
  const list = cats ?? playCategories(game);
  const byId = new Map(list.map((c) => [c.id, c]));
  let total = 0;
  for (const [cid, v] of Object.entries(entry.scores ?? {})) {
    const c = byId.get(cid);
    if (c) total += categoryPoints(c, v, entry.scores); // values for removed categories don't count
  }
  for (const b of bonusStates(game, entry, list)) if (b.earned) total += b.points;
  for (const r of entry.rounds ?? []) if (r !== null && r !== undefined) total += r;
  return cleanNum(total);
}

/** Category ids holding typed values on this play that aren't on the sheet
 *  any more (deleted, or an expansion switched off) — they don't count. */
export function orphanCategories(game: Game | undefined, play: Play): string[] {
  const known = new Set(playCategories(game, play).map((c) => c.id));
  const out: string[] = [];
  for (const r of [...play.seats, ...play.teams])
    for (const [cid, v] of Object.entries(r.scores ?? {})) if (v !== null && v !== undefined && !known.has(cid) && !out.includes(cid)) out.push(cid);
  return out;
}

export function usesTeams(game: Game | undefined, play: Play): boolean {
  return play.teams.length > 0 && (game?.scoring.win === "teams" || play.seats.some((s) => !!s.team_id));
}

/** The rows the pad scores: teams in a team play, else seats. */
export function rowsOf(game: Game | undefined, play: Play): (Seat | Team)[] {
  return usesTeams(game, play) ? play.teams : play.seats;
}

/** Competition ranking by score (then tiebreak). Rows without a score are
 *  unplaced — a blank seat is missing, not a zero. */
function rank(rows: Entry[], low: boolean) {
  const key = (e: Entry) => [(low ? 1 : -1) * (e.score as number), e.tiebreak ?? 10_000] as const;
  for (const r of rows) if (r.score === null || r.score === undefined) r.place = null;
  const ordered = rows.filter((r) => r.score !== null && r.score !== undefined).sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka[0] - kb[0] || ka[1] - kb[1];
  });
  let prev: { k: readonly [number, number]; place: number } | null = null;
  ordered.forEach((e, i) => {
    const k = key(e);
    if (!prev || k[0] !== prev.k[0] || k[1] !== prev.k[1]) prev = { k, place: i + 1 };
    e.place = prev.place;
  });
}

/** Rows (seats or teams) with no score in a game decided by scores while
 *  someone else has one — Finish warns about these. */
export function unscoredRows(game: Game | undefined, play: Play): (Seat | Team)[] {
  const win = game?.scoring.win ?? "high";
  if (win === "coop" || win === "winlose" || play.manual) return [];
  const rows = rowsOf(game, play);
  const scored = rows.filter((r) => hasEntries(r));
  if ((win === "teams" || win === "ranked") && !scored.length) return [];
  return rows.filter((r) => !hasEntries(r));
}

/** Fill score/place/winner on ``play`` (mutates; use on a draft). */
export function computeResults(game: Game | undefined, play: Play): { winners: string[]; tied: boolean; teams: boolean } {
  const win = game?.scoring.win ?? "high";
  const cats = playCategories(game, play);
  const teams = usesTeams(game, play);
  const rows: Entry[] = teams ? play.teams : play.seats;
  for (const r of rows) r.score = hasEntries(r) ? entryTotal(game, r, cats) : null;

  if (play.manual) {
    if (rows.some((r) => r.place)) rows.forEach((r) => (r.winner = r.place === 1));
    else if (rows.some((r) => r.winner)) rows.forEach((r) => (r.place = r.winner ? 1 : 2));
  } else if (win === "coop") {
    rows.forEach((r) => {
      r.place = null;
      r.winner = !!play.coop_won;
    });
  } else if (win === "winlose" || (win === "teams" && teams && !rows.some((r) => r.score !== null))) {
    const any = rows.some((r) => r.winner);
    rows.forEach((r) => {
      r.winner = !!r.winner;
      r.place = any ? (r.winner ? 1 : 2) : null;
    });
  } else if (win === "ranked") {
    // Scored: the order follows the scores (recomputed every time, so a
    // fixed or re-finished play never keeps stale places). Unscored: the
    // finishing order typed at Finish stands.
    if (rows.some((r) => r.score !== null)) rank(rows, false);
    rows.forEach((r) => (r.winner = r.place === 1));
  } else {
    rank(rows, win === "low");
    rows.forEach((r) => (r.winner = r.place === 1));
  }

  if (teams) {
    const byTeam = new Map(play.teams.map((t) => [t.id, t]));
    for (const s of play.seats) {
      const t = s.team_id ? byTeam.get(s.team_id) : undefined;
      s.score = null;
      s.place = t ? t.place : null;
      s.winner = t ? !!t.winner : false;
    }
  }
  const winners = play.seats.filter((s) => s.winner).map((s) => s.player_id);
  const firsts = rows.filter((r) => r.place === 1).length;
  const tied = win !== "coop" && win !== "winlose" && firsts > 1 && !play.manual;
  return { winners, tied, teams };
}

/** Live standings for the pad: {key, total, place, scored} best first.
 *  Seats with nothing typed go last and never lead (a blank isn't a winning
 *  0 in a lowest-wins game). */
export function standings(game: Game | undefined, play: Play): { key: string; total: number; place: number; scored: boolean }[] {
  const cats = playCategories(game, play);
  const teams = usesTeams(game, play);
  const low = game?.scoring.win === "low";
  const rows = (teams ? play.teams : play.seats).map((r) => ({
    key: teams ? (r as Team).id : (r as Seat).player_id,
    total: entryTotal(game, r, cats),
    place: 0,
    scored: hasEntries(r),
  }));
  const anyScored = rows.some((r) => r.scored);
  const sorted = [...rows].sort((a, b) => Number(b.scored) - Number(a.scored) || (low ? a.total - b.total : b.total - a.total));
  sorted.forEach((r, i) => {
    const p = sorted[i - 1];
    if (anyScored && !r.scored) r.place = rows.length;
    else r.place = i > 0 && p.scored === r.scored && p.total === r.total ? p.place : i + 1;
  });
  return sorted;
}

/** Whether the pad shows a "leader" at all. */
export function scoresMatter(game: Game | undefined): boolean {
  const w = game?.scoring.win ?? "high";
  return w === "high" || w === "low" || w === "teams" || w === "ranked";
}

export function elapsedSeconds(play: Play, now = Date.now()): number {
  let s = play.timer_elapsed_s || 0;
  if (play.timer_started_at) s += Math.max(0, Math.floor((now - new Date(play.timer_started_at).getTime()) / 1000));
  return s;
}
