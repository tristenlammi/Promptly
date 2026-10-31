import { fmtDay } from "@/items/ui/format";

import type { Data, Game, Play, Player } from "./types";

/*
 * Stats for the dashboards — the mirror of the backend's stats.py (so the
 * Stats tab is instant and works offline). Elo is multiplayer Elo by
 * pairwise decomposition: K/(N−1) × Σ(actual − expected) over opponents.
 */

export const START_ELO = 1500;

export function finished(data: Data): Play[] {
  return data.plays
    .filter((p) => p.status === "finished")
    .sort((a, b) => a.date.localeCompare(b.date) || (a.ended_at ?? a.created_at ?? "").localeCompare(b.ended_at ?? b.created_at ?? "") || a.id.localeCompare(b.id));
}

export const winOf = (g: Game | undefined) => g?.scoring.win ?? "high";

export function competitive(p: Play, g: Game | undefined): boolean {
  return winOf(g) !== "coop" && p.seats.filter((s) => s.place).length >= 2;
}

const expected = (ra: number, rb: number) => 1 / (1 + 10 ** ((rb - ra) / 400));

export function eloUpdate(r: Map<string, number>, play: Play, k: number): Map<string, number> {
  const seats = play.seats.filter((s) => s.place);
  const deltas = new Map<string, number>();
  if (seats.length < 2) return deltas;
  for (const s of seats) if (!r.has(s.player_id)) r.set(s.player_id, START_ELO);
  for (const a of seats) {
    const opp = seats.filter((b) => b !== a && !(a.team_id && a.team_id === b.team_id));
    if (!opp.length) continue;
    const ra = r.get(a.player_id)!;
    let t = 0;
    for (const b of opp) {
      const actual = a.place! < b.place! ? 1 : a.place === b.place ? 0.5 : 0;
      t += actual - expected(ra, r.get(b.player_id)!);
    }
    deltas.set(a.player_id, (k / opp.length) * t);
  }
  for (const [pid, d] of deltas) r.set(pid, r.get(pid)! + d);
  return deltas;
}

export function eloRatings(data: Data, gameId?: string) {
  const k = data.settings.elo_k || 32;
  const games = new Map(data.games.map((g) => [g.id, g]));
  const ratings = new Map<string, number>();
  const history = new Map<string, { date: string; elo: number }[]>();
  for (const p of finished(data)) {
    if (gameId && p.game_id !== gameId) continue;
    if (!competitive(p, games.get(p.game_id))) continue;
    const d = eloUpdate(ratings, p, k);
    for (const pid of d.keys()) {
      const h = history.get(pid) ?? [];
      h.push({ date: p.date, elo: Math.round(ratings.get(pid)!) });
      history.set(pid, h);
    }
  }
  return { ratings, history };
}

export function streaks(results: boolean[]) {
  let longest = 0;
  let cur = 0;
  for (const w of results) {
    cur = w ? cur + 1 : 0;
    longest = Math.max(longest, cur);
  }
  let curWin = 0;
  for (let i = results.length - 1; i >= 0 && results[i]; i--) curWin++;
  let curLoss = 0;
  for (let i = results.length - 1; i >= 0 && !results[i]; i--) curLoss++;
  return { curWin, longest, curLoss };
}

export interface H2HRecord {
  played: number;
  wins: number;
  losses: number;
  ties: number;
}

export interface PlayerGameRow {
  game: Game | undefined;
  gameId: string;
  plays: number;
  wins: number;
  best: number | null;
  avgPlace: number | null;
  elo: number | null;
}

export function playerStats(data: Data, pid: string) {
  const games = new Map(data.games.map((g) => [g.id, g]));
  const plays = finished(data).filter((p) => p.seats.some((s) => s.player_id === pid));
  const byGame = new Map<string, { plays: number; wins: number; best: number | null; places: number[] }>();
  const results: boolean[] = [];
  const places: number[] = [];
  const recent: { play: Play; won: boolean; place: number | null }[] = [];
  let coopPlays = 0;
  let coopWins = 0;
  let minutes = 0;
  const h2h = new Map<string, H2HRecord>();
  for (const p of plays) {
    const g = games.get(p.game_id);
    const seat = p.seats.find((s) => s.player_id === pid)!;
    const rec = byGame.get(p.game_id) ?? { plays: 0, wins: 0, best: null, places: [] };
    byGame.set(p.game_id, rec);
    rec.plays++;
    minutes += p.duration_min ?? 0;
    recent.push({ play: p, won: seat.winner, place: seat.place });
    if (winOf(g) === "coop") {
      coopPlays++;
      if (seat.winner) {
        coopWins++;
        rec.wins++;
      }
      continue;
    }
    if (!competitive(p, g)) continue;
    if (seat.winner) rec.wins++;
    results.push(seat.winner);
    if (seat.place) {
      places.push(seat.place);
      rec.places.push(seat.place);
      for (const o of p.seats) {
        if (o.player_id === pid || !o.place || (seat.team_id && seat.team_id === o.team_id)) continue;
        const r = h2h.get(o.player_id) ?? { played: 0, wins: 0, losses: 0, ties: 0 };
        r.played++;
        if (seat.place < o.place) r.wins++;
        else if (seat.place > o.place) r.losses++;
        else r.ties++;
        h2h.set(o.player_id, r);
      }
    }
    if (seat.score !== null) {
      const low = winOf(g) === "low";
      if (rec.best === null || (low ? seat.score < rec.best : seat.score > rec.best)) rec.best = seat.score;
    }
  }
  const wins = results.filter(Boolean).length;
  const { ratings, history } = eloRatings(data);
  const gamesRows: PlayerGameRow[] = [...byGame.entries()]
    .map(([gid, r]) => ({
      gameId: gid,
      game: games.get(gid),
      plays: r.plays,
      wins: r.wins,
      best: r.best,
      avgPlace: r.places.length ? r.places.reduce((a, b) => a + b, 0) / r.places.length : null,
      elo: (() => {
        const e = eloRatings(data, gid).ratings.get(pid);
        return e === undefined ? null : Math.round(e);
      })(),
    }))
    .sort((a, b) => b.plays - a.plays || b.wins - a.wins);
  return {
    plays: plays.length,
    competitive: results.length,
    wins,
    winRate: results.length ? wins / results.length : null,
    avgPlace: places.length ? places.reduce((a, b) => a + b, 0) / places.length : null,
    coop: { plays: coopPlays, wins: coopWins },
    hours: minutes / 60,
    streak: streaks(results),
    elo: Math.round(ratings.get(pid) ?? START_ELO),
    eloHistory: history.get(pid) ?? [],
    games: gamesRows,
    h2h: [...h2h.entries()].sort((a, b) => b[1].played - a[1].played),
    recent: recent.reverse().slice(0, 10),
    lastPlayed: plays.length ? plays[plays.length - 1].date : null,
  };
}

export function gameStats(data: Data, gid: string) {
  const g = data.games.find((x) => x.id === gid);
  const win = winOf(g);
  const low = win === "low";
  const plays = finished(data).filter((p) => p.game_id === gid);
  const players = new Map(data.players.map((p) => [p.id, p]));
  const seatScores: { score: number; pid: string; date: string }[] = [];
  for (const p of plays) for (const s of p.seats) if (s.score !== null) seatScores.push({ score: s.score, pid: s.player_id, date: p.date });
  const pick = (best: boolean) => {
    if (!seatScores.length) return null;
    const hi = best !== low;
    return seatScores.reduce((m, c) => (hi ? (c.score > m.score ? c : m) : c.score < m.score ? c : m));
  };
  const over = plays
    .map((p) => {
      const sc = p.seats.map((s) => s.score).filter((v): v is number => v !== null);
      if (!sc.length) return null;
      return { x: p.date.slice(5), date: p.date, winning: low ? Math.min(...sc) : Math.max(...sc), avg: sc.reduce((a, b) => a + b, 0) / sc.length };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);
  const durations = plays.map((p) => p.duration_min).filter((v): v is number => !!v);
  const wins = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const p of plays)
    for (const s of p.seats) {
      seen.set(s.player_id, (seen.get(s.player_id) ?? 0) + 1);
      if (s.winner && win !== "coop") wins.set(s.player_id, (wins.get(s.player_id) ?? 0) + 1);
    }
  const minPlays = data.settings.min_plays_for_best || 3;
  let best: { player: Player | undefined; wins: number; plays: number; rate: number } | null = null;
  if (win !== "coop")
    for (const [pid, n] of seen) {
      if (n < minPlays) continue;
      const w = wins.get(pid) ?? 0;
      if (!best || w / n > best.rate || (w / n === best.rate && w > best.wins)) best = { player: players.get(pid), wins: w, plays: n, rate: w / n };
    }
  const seatWins: { seat: number; plays: number; wins: number }[] = [];
  for (const p of plays) {
    if (!competitive(p, g)) continue;
    p.seats.forEach((s, i) => {
      const r = seatWins[i] ?? { seat: i + 1, plays: 0, wins: 0 };
      r.plays++;
      if (s.winner) r.wins++;
      seatWins[i] = r;
    });
  }
  const cats = new Map<string, { name: string; mult: number; sub: boolean }>();
  for (const c of g?.scoring.categories ?? []) cats.set(c.id, { name: c.name, mult: c.multiplier, sub: c.subtract });
  for (const ex of g?.expansions ?? []) for (const c of ex.categories) cats.set(c.id, { name: c.name, mult: c.multiplier, sub: c.subtract });
  const catSum = new Map<string, number[]>();
  for (const p of plays)
    for (const s of p.seats)
      for (const [cid, v] of Object.entries(s.scores)) {
        const c = cats.get(cid);
        if (!c || v === null) continue;
        const arr = catSum.get(c.name) ?? [];
        arr.push(v * c.mult * (c.sub ? -1 : 1));
        catSum.set(c.name, arr);
      }
  const elo = eloRatings(data, gid).ratings;
  const all = seatScores.map((s) => s.score);
  return {
    plays: plays.length,
    first: plays[0]?.date ?? null,
    last: plays[plays.length - 1]?.date ?? null,
    high: pick(true),
    low: pick(false),
    avg: all.length ? all.reduce((a, b) => a + b, 0) / all.length : null,
    avgWinning: over.length ? over.reduce((a, b) => a + b.winning, 0) / over.length : null,
    avgMinutes: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
    best,
    coop: win === "coop" ? { plays: plays.length, wins: plays.filter((p) => p.coop_won).length } : null,
    seatWins: seatWins.filter(Boolean),
    categoryAvg: [...catSum.entries()].map(([name, v]) => ({ name, avg: v.reduce((a, b) => a + b, 0) / v.length })),
    leaderboard: [...elo.entries()].sort((a, b) => b[1] - a[1]).map(([pid, r]) => ({ player: players.get(pid), elo: Math.round(r), wins: wins.get(pid) ?? 0, plays: seen.get(pid) ?? 0 })),
    over,
  };
}

export function headToHead(data: Data, a: string, b: string) {
  const games = new Map(data.games.map((g) => [g.id, g]));
  const out = { played: 0, a: 0, b: 0, ties: 0, byGame: new Map<string, { played: number; a: number; b: number }>() };
  for (const p of finished(data)) {
    const g = games.get(p.game_id);
    const sa = p.seats.find((s) => s.player_id === a);
    const sb = p.seats.find((s) => s.player_id === b);
    if (!sa || !sb || !competitive(p, g) || !sa.place || !sb.place) continue;
    if (sa.team_id && sa.team_id === sb.team_id) continue;
    out.played++;
    const r = out.byGame.get(p.game_id) ?? { played: 0, a: 0, b: 0 };
    r.played++;
    if (sa.place < sb.place) {
      out.a++;
      r.a++;
    } else if (sb.place < sa.place) {
      out.b++;
      r.b++;
    } else out.ties++;
    out.byGame.set(p.game_id, r);
  }
  return out;
}

export function hIndex(counts: number[]): number {
  let h = 0;
  [...counts].sort((x, y) => y - x).forEach((n, i) => {
    if (n >= i + 1) h = i + 1;
  });
  return h;
}

export function overall(data: Data) {
  const plays = finished(data);
  const perGame = new Map<string, number>();
  for (const p of plays) perGame.set(p.game_id, (perGame.get(p.game_id) ?? 0) + 1);
  const perMonth = new Map<string, number>();
  for (const p of plays) perMonth.set(p.date.slice(0, 7), (perMonth.get(p.date.slice(0, 7)) ?? 0) + 1);
  const minutes = plays.reduce((n, p) => n + (p.duration_min ?? 0), 0);
  const counts = [...perGame.values()];
  const byGame = new Map(data.games.map((g) => [g.id, g]));
  const bucket = (lo: number, hi: number) =>
    [...perGame.entries()].filter(([, n]) => n >= lo && n < hi).map(([gid, n]) => ({ game: byGame.get(gid), n })).sort((a, b) => b.n - a.n);
  return {
    plays: plays.length,
    gamesPlayed: perGame.size,
    hours: minutes / 60,
    hIndex: hIndex(counts),
    mostPlayed: [...perGame.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([gid, n]) => ({ game: byGame.get(gid), n })),
    nickels: bucket(5, 10),
    dimes: bucket(10, 25),
    quarters: bucket(25, 100),
    dollars: bucket(100, Infinity),
    perMonth,
    unplayed: data.games.filter((g) => g.owned && !perGame.has(g.id)),
  };
}

export function lastNMonths(n: number, today = new Date()): string[] {
  const out: string[] = [];
  const d = new Date(today.getFullYear(), today.getMonth(), 1);
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

export function superlatives(data: Data): { title: string; text: string }[] {
  const games = new Map(data.games.map((g) => [g.id, g]));
  const players = new Map(data.players.map((p) => [p.id, p]));
  const nm = (pid: string) => players.get(pid)?.name ?? "?";
  const gn = (gid: string) => games.get(gid)?.name ?? "?";
  const plays = finished(data);
  const out: { title: string; text: string }[] = [];
  let hi: { s: number; pid: string; p: Play } | null = null;
  for (const p of plays) {
    if (winOf(games.get(p.game_id)) === "low") continue;
    for (const s of p.seats) if (s.score !== null && (!hi || s.score > hi.s)) hi = { s: s.score, pid: s.player_id, p };
  }
  if (hi) out.push({ title: "Highest score ever", text: `${nm(hi.pid)} — ${hi.s} in ${gn(hi.p.game_id)}` });
  const margins: { m: number; p: Play }[] = [];
  for (const p of plays) {
    const g = games.get(p.game_id);
    if (!competitive(p, g)) continue;
    const sc = p.seats.map((s) => s.score).filter((v): v is number => v !== null).sort((a, b) => (winOf(g) === "low" ? a - b : b - a));
    if (sc.length >= 2) margins.push({ m: Math.abs(sc[0] - sc[1]), p });
  }
  if (margins.length) {
    const big = margins.reduce((a, b) => (b.m > a.m ? b : a));
    const w = big.p.seats.find((s) => s.winner);
    if (big.m > 0 && w) out.push({ title: "Biggest blowout", text: `${nm(w.player_id)} won ${gn(big.p.game_id)} by ${big.m}` });
    if (margins.length > 1) {
      const close = margins.reduce((a, b) => (b.m < a.m ? b : a));
      out.push({ title: "Photo finish", text: `${gn(close.p.game_id)} on ${fmtDay(close.p.date)} — decided by ${close.m}` });
    }
  }
  const long = plays.filter((p) => p.duration_min);
  if (long.length) {
    const p = long.reduce((a, b) => ((b.duration_min ?? 0) > (a.duration_min ?? 0) ? b : a));
    out.push({ title: "Marathon", text: `${gn(p.game_id)} took ${p.duration_min} min` });
  }
  const days = new Map<string, number>();
  for (const p of plays) days.set(p.date, (days.get(p.date) ?? 0) + 1);
  const bigDay = [...days.entries()].sort((a, b) => b[1] - a[1])[0];
  if (bigDay && bigDay[1] > 1) out.push({ title: "Biggest game night", text: `${bigDay[1]} plays on ${fmtDay(bigDay[0])}` });
  const pairs = new Map<string, number>();
  for (const p of plays) {
    const ids = [...new Set(p.seats.map((s) => s.player_id))].sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.set(`${ids[i]}|${ids[j]}`, (pairs.get(`${ids[i]}|${ids[j]}`) ?? 0) + 1);
  }
  const pair = [...pairs.entries()].sort((a, b) => b[1] - a[1])[0];
  if (pair && pair[1] > 1) {
    const [a, b] = pair[0].split("|");
    out.push({ title: "Inseparable", text: `${nm(a)} & ${nm(b)} — ${pair[1]} games together` });
  }
  let streak: { pid: string; n: number } | null = null;
  for (const pl of data.players) {
    const res = plays.filter((p) => competitive(p, games.get(p.game_id))).flatMap((p) => p.seats.filter((s) => s.player_id === pl.id).map((s) => s.winner));
    const { longest } = streaks(res);
    if (longest >= 2 && (!streak || longest > streak.n)) streak = { pid: pl.id, n: longest };
  }
  if (streak) out.push({ title: "On fire", text: `${nm(streak.pid)} once won ${streak.n} in a row` });
  const me = data.settings.me_player_id;
  if (me) {
    const st = playerStats(data, me);
    const rivals = st.h2h.filter(([, r]) => r.played >= 3);
    if (rivals.length) {
      const [pid, r] = rivals.reduce((a, b) => (b[1].losses - b[1].wins > a[1].losses - a[1].wins ? b : a));
      if (r.losses > r.wins) out.push({ title: "Your nemesis", text: `${nm(pid)} — ${r.wins}–${r.losses} against you` });
      const [vp, vr] = rivals.reduce((a, b) => (b[1].wins - b[1].losses > a[1].wins - a[1].losses ? b : a));
      if (vr.wins > vr.losses) out.push({ title: "Your favourite victim", text: `${nm(vp)} — ${vr.wins}–${vr.losses}` });
    }
  }
  return out;
}

export function leaderboard(data: Data, gameId?: string) {
  const games = new Map(data.games.map((g) => [g.id, g]));
  const { ratings } = eloRatings(data, gameId);
  const plays = new Map<string, number>();
  const wins = new Map<string, number>();
  for (const p of finished(data)) {
    if (gameId && p.game_id !== gameId) continue;
    if (!competitive(p, games.get(p.game_id))) continue;
    for (const s of p.seats) {
      plays.set(s.player_id, (plays.get(s.player_id) ?? 0) + 1);
      if (s.winner) wins.set(s.player_id, (wins.get(s.player_id) ?? 0) + 1);
    }
  }
  return data.players
    .filter((p) => !p.archived && plays.has(p.id))
    .map((p) => ({ player: p, elo: Math.round(ratings.get(p.id) ?? START_ELO), plays: plays.get(p.id) ?? 0, wins: wins.get(p.id) ?? 0 }))
    .sort((a, b) => b.elo - a.elo || b.wins - a.wins);
}
