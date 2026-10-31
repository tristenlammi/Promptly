import type { Data } from "./types";

/*
 * Plays log → CSV (one row per player per play): date, game, player, team,
 * score, place, winner, first play, minutes, location, play id. Built in the
 * browser, so it works offline.
 */

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // Quote anything with a separator, quote or newline; defuse spreadsheet
  // formulas (a name starting with = + - @).
  const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function playsCsv(data: Data, playIds?: string[]): string {
  const players = new Map(data.players.map((p) => [p.id, p]));
  const games = new Map(data.games.map((g) => [g.id, g]));
  const only = playIds ? new Set(playIds) : null;
  const lines = [["date", "game", "player", "team", "score", "place", "winner", "first_play", "duration_min", "location", "play_id"].join(",")];
  const plays = data.plays
    .filter((p) => p.status === "finished" && (!only || only.has(p.id)))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.ended_at ?? "").localeCompare(b.ended_at ?? ""));
  for (const p of plays) {
    const g = games.get(p.game_id);
    const coop = g?.scoring.win === "coop";
    for (const s of p.seats) {
      const team = s.team_id ? p.teams.find((t) => t.id === s.team_id) : undefined;
      const score = s.score ?? team?.score ?? null;
      lines.push(
        [
          p.date,
          g?.name ?? "?",
          players.get(s.player_id)?.name ?? "?",
          team?.name ?? "",
          score,
          s.place,
          coop ? (p.coop_won ? "yes" : "no") : s.winner ? "yes" : "no",
          s.first_play ? "yes" : "no",
          p.duration_min,
          p.location,
          p.id,
        ]
          .map(cell)
          .join(","),
      );
    }
  }
  return lines.join("\r\n") + "\r\n";
}

/** Hand the CSV to the browser as a download. */
export function downloadCsv(name: string, csv: string) {
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
