import { AlertTriangle, ArrowDown, ArrowUp, PartyPopper, RotateCcw, Scale, Trophy, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ItemHandle } from "@/items/useItem";
import { Field, ItemButton, Sheet, TextArea, TextInput, Toggle, nowISO } from "@/items/ui";
import { cn } from "@/utils/cn";

import { Confetti, PlayerBadge, TeamBadge, fmtScore, markFirstPlays, ordinal, prefersReducedMotion, rematchOf, useLookups } from "./bits";
import { computeResults, elapsedSeconds, hasEntries, rowsOf, standings, unscoredRows, usesTeams } from "./scoring";
import type { Data, Game, Play, Seat, Team } from "./types";

/*
 * Finishing a play: the one question the win condition needs (who won? the
 * finishing order? did we beat the game?), a tiebreak prompt when first is
 * shared, then the celebration.
 */

type Row = { key: string; name: string; color: string; isTeam: boolean };

export function FinishSheet({
  open,
  onClose,
  item,
  play,
  game,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  item: ItemHandle<Data>;
  play: Play;
  game: Game | undefined;
  onDone: (playId: string) => void;
}) {
  const { players } = useLookups(item.data);
  const win = game?.scoring.win ?? "high";
  const teams = usesTeams(game, play);
  const rows: Row[] = teams
    ? play.teams.map((t) => ({ key: t.id, name: t.name, color: t.color, isTeam: true }))
    : play.seats.map((s) => ({ key: s.player_id, name: players.get(s.player_id)?.name ?? "?", color: players.get(s.player_id)?.color ?? "#888", isTeam: false }));
  const scored = rowsOf(game, play).some((r) => hasEntries(r));
  const pickMode: "coop" | "winners" | "order" | "scores" =
    win === "coop" ? "coop" : win === "winlose" || (win === "teams" && !scored) ? "winners" : win === "ranked" && !scored ? "order" : "scores";

  const [coop, setCoop] = useState<boolean | null>(play.coop_won);
  const [winners, setWinners] = useState<string[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const [override, setOverride] = useState(false);
  const [tieWinner, setTieWinner] = useState<string | "shared" | null>(null);
  const [minutes, setMinutes] = useState(0);
  const [notes, setNotes] = useState(play.notes);
  const [location, setLocation] = useState(play.location);
  const [date, setDate] = useState(play.date);
  const [unscoredOk, setUnscoredOk] = useState(false);
  // What the sheet opened with: only fields the person changed are written
  // back (someone else may edit the notes meanwhile).
  const opened = useRef({ notes: play.notes, location: play.location, date: play.date });

  useEffect(() => {
    if (!open) return;
    opened.current = { notes: play.notes, location: play.location, date: play.date };
    setUnscoredOk(false);
    setMinutes(Math.round(elapsedSeconds(play) / 60));
    setNotes(play.notes);
    setLocation(play.location);
    setDate(play.date);
    setCoop(play.coop_won);
    setWinners([]);
    setOrder(win === "ranked" ? rows.map((r) => r.key) : []);
    setOverride(false);
    setTieWinner(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const stand = useMemo(() => standings(game, play), [game, play]);
  const tiedFirst = pickMode === "scores" && !override ? stand.filter((s) => s.place === 1) : [];
  const isTie = tiedFirst.length > 1;
  const mode = override ? (win === "ranked" ? "order" : "winners") : pickMode;

  // Seats with no score in a score game: a blank isn't a 0 (it would win a
  // lowest-score game) — warn, and only finish once that's confirmed.
  const keyOfRow = (e: Seat | Team) => (teams ? (e as Team).id : (e as Seat).player_id);
  const unscored = mode === "scores" ? unscoredRows(game, play).map((e) => rows.find((r) => r.key === keyOfRow(e))).filter((r): r is Row => !!r) : [];
  const noScores = mode === "scores" && !scored && (win === "high" || win === "low" || win === "teams");

  const ready =
    (mode === "coop" && coop !== null) ||
    (mode === "winners" && winners.length > 0) ||
    (mode === "order" && order.length === rows.length) ||
    (mode === "scores" && !noScores && (unscored.length === 0 || unscoredOk));

  const finish = () => {
    const ended = nowISO();
    const at = Date.now(); // read the clock here, not in the (replayable) mutator
    const changed = opened.current;
    item.update((d) => {
      const p = d.plays.find((x) => x.id === play.id);
      if (!p) return;
      const g = d.games.find((x) => x.id === p.game_id);
      const ents: (Seat | Team)[] = rowsOf(g, p);
      const keyOf = (e: Seat | Team) => (teams ? (e as Team).id : (e as Seat).player_id);
      p.timer_elapsed_s = elapsedSeconds(p, at);
      p.timer_started_at = null;
      p.duration_min = minutes || null;
      p.ended_at = ended;
      p.status = "finished";
      if (notes !== changed.notes) p.notes = notes.slice(0, 2000);
      if (location !== changed.location) p.location = location.slice(0, 80);
      if (date !== changed.date && /^\d{4}-\d{2}-\d{2}$/.test(date)) p.date = date;
      // Decided afresh every time it's finished (a reopened play must not
      // keep the last result): hand-picked only when picked by hand now.
      p.manual = override;
      if (mode === "coop") p.coop_won = coop;
      if (mode === "winners") {
        for (const e of ents) {
          e.winner = winners.includes(keyOf(e));
          e.place = e.winner ? 1 : 2;
        }
      }
      if (mode === "order") {
        for (const e of ents) {
          const i = order.indexOf(keyOf(e));
          e.place = i >= 0 ? i + 1 : order.length + 1;
          e.winner = e.place === 1;
        }
      }
      for (const e of ents) e.tiebreak = null;
      if (isTie && tieWinner && tieWinner !== "shared") {
        for (const e of ents) if (tiedFirst.some((t) => t.key === keyOf(e))) e.tiebreak = keyOf(e) === tieWinner ? 0 : 1;
        p.tiebreak_note = `Tiebreak: ${rows.find((r) => r.key === tieWinner)?.name ?? ""}`;
      }
      computeResults(g, p);
      markFirstPlays(d, p);
    });
    onDone(play.id);
  };

  const toggleWinner = (k: string) => setWinners((w) => (w.includes(k) ? w.filter((x) => x !== k) : win === "teams" || teams ? [k] : [...w, k]));
  const move = (i: number, by: number) =>
    setOrder((o) => {
      const n = [...o];
      const j = i + by;
      if (j < 0 || j >= n.length) return o;
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });

  const badge = (r: Row, size = 32) => (r.isTeam ? <TeamBadge team={r} size={size} /> : <PlayerBadge player={r} size={size} />);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Finish ${game?.name ?? "game"}`}
      footer={
        <ItemButton variant="primary" size="lg" block disabled={!ready} icon={<Trophy className="h-5 w-5" />} onClick={finish}>
          {mode === "coop" && coop === false ? "Log the loss" : "Crown the winner"}
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-4 pb-2">
        {mode === "coop" && (
          <div className="grid grid-cols-2 gap-2">
            {[
              { v: true, label: "We won! 🎉" },
              { v: false, label: "The game won 😩" },
            ].map((o) => (
              <button
                key={String(o.v)}
                type="button"
                aria-pressed={coop === o.v}
                onClick={() => setCoop(o.v)}
                className={cn(
                  "h-20 rounded-2xl border text-base font-semibold transition",
                  coop === o.v ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] text-[var(--text)]" : "border-[var(--border)] text-[var(--text-muted)]",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}

        {mode === "winners" && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-[var(--text-muted)]">{teams ? "Which team won?" : "Who won? Tap everyone who shares the win."}</p>
            <div className="grid grid-cols-2 gap-2">
              {rows.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  aria-pressed={winners.includes(r.key)}
                  onClick={() => toggleWinner(r.key)}
                  className={cn(
                    "flex h-14 items-center gap-2 rounded-2xl border px-3 text-left text-sm font-semibold transition",
                    winners.includes(r.key) ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)]" : "border-[var(--border)]",
                  )}
                >
                  {badge(r, 30)}
                  <span className="min-w-0 flex-1 truncate text-[var(--text)]">{r.name}</span>
                  {winners.includes(r.key) && <Trophy className="h-4 w-4 text-[var(--item-accent)]" />}
                </button>
              ))}
            </div>
          </div>
        )}

        {mode === "order" && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-[var(--text-muted)]">Finishing order — first at the top.</p>
            <ol className="flex flex-col gap-1.5">
              {order.map((k, i) => {
                const r = rows.find((x) => x.key === k)!;
                return (
                  <li key={k} className="flex items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5">
                    <span className="w-9 text-center text-sm font-bold tabular-nums text-[var(--item-accent)]">{ordinal(i + 1)}</span>
                    {badge(r, 28)}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text)]">{r.name}</span>
                    <button type="button" aria-label={`Move ${r.name} up`} disabled={i === 0} onClick={() => move(i, -1)} className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] disabled:opacity-30">
                      <ArrowUp className="h-4 w-4" />
                    </button>
                    <button type="button" aria-label={`Move ${r.name} down`} disabled={i === order.length - 1} onClick={() => move(i, 1)} className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] disabled:opacity-30">
                      <ArrowDown className="h-4 w-4" />
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        {mode === "scores" && (
          <div className="flex flex-col gap-1.5">
            {stand.map((s) => {
              const r = rows.find((x) => x.key === s.key)!;
              return (
                <div key={s.key} className={cn("flex items-center gap-2 rounded-2xl border px-3 py-2", s.place === 1 ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_10%,transparent)]" : "border-[var(--border)]")}>
                  <span className="w-9 text-sm font-bold tabular-nums text-[var(--text-muted)]">{ordinal(s.place)}</span>
                  {badge(r, 28)}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text)]">{r.name}</span>
                  <span className="text-lg font-bold tabular-nums text-[var(--text)]">{fmtScore(s.total)}</span>
                </div>
              );
            })}
          </div>
        )}

        {isTie && (
          <div className="flex flex-col gap-2 rounded-2xl border border-[var(--warning-border)] bg-[var(--warning-bg)] p-3">
            <p className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
              <Scale className="h-4 w-4 text-[var(--warning)]" /> It's a tie for first!
            </p>
            <p className="text-sm text-[var(--text)]">{game?.scoring.tiebreaker || "This game has no tiebreaker on file — decide at the table, or share the win."}</p>
            <div className="flex flex-wrap gap-2">
              {tiedFirst.map((t) => {
                const r = rows.find((x) => x.key === t.key)!;
                return (
                  <button
                    key={t.key}
                    type="button"
                    aria-pressed={tieWinner === t.key}
                    onClick={() => setTieWinner(t.key)}
                    className={cn("inline-flex h-11 items-center gap-2 rounded-xl border px-3 text-sm font-medium", tieWinner === t.key ? "border-[var(--item-accent)] bg-[var(--surface)]" : "border-[var(--border)]")}
                  >
                    {badge(r, 24)} {r.name} wins it
                  </button>
                );
              })}
              <button
                type="button"
                aria-pressed={tieWinner === "shared"}
                onClick={() => setTieWinner("shared")}
                className={cn("inline-flex h-11 items-center rounded-xl border px-3 text-sm font-medium", tieWinner === "shared" ? "border-[var(--item-accent)] bg-[var(--surface)]" : "border-[var(--border)]")}
              >
                Share the win
              </button>
            </div>
          </div>
        )}

        {noScores && (
          <p className="flex items-start gap-2 rounded-2xl border border-[var(--warning-border)] bg-[var(--warning-bg)] p-3 text-sm text-[var(--text)]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" />
            No scores yet — enter them on the pad, or pick the result by hand below.
          </p>
        )}
        {unscored.length > 0 && (
          <div className="flex flex-col gap-2 rounded-2xl border border-[var(--warning-border)] bg-[var(--warning-bg)] p-3" role="alert">
            <p className="flex items-start gap-2 text-sm text-[var(--text)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" />
              <span>
                No score for <strong>{unscored.map((r) => r.name).join(", ")}</strong>. A blank isn't a 0 — go back and enter it, or finish with them unplaced.
              </span>
            </p>
            <label className="flex items-center justify-between gap-3 text-sm text-[var(--text)]">
              <span>Finish anyway (unplaced)</span>
              <Toggle checked={unscoredOk} onChange={setUnscoredOk} label="Finish anyway without their score" />
            </label>
          </div>
        )}

        {pickMode !== "coop" && (
          <label className="flex items-center justify-between gap-3 text-sm text-[var(--text)]">
            <span>
              Pick the result by hand
              <span className="block text-xs text-[var(--text-muted)]">Instant wins, concessions, house rules</span>
            </span>
            <Toggle checked={override} onChange={(v) => (setOverride(v), setOrder(rows.map((r) => r.key)))} label="Pick the result by hand" />
          </label>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-[1.2fr_0.8fr_1.5fr]">
          <Field label="Date">
            <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Minutes">
            <TextInput inputMode="numeric" value={minutes ? String(minutes) : ""} onChange={(e) => setMinutes(Math.max(0, Math.min(10000, parseInt(e.target.value || "0", 10) || 0)))} />
          </Field>
          <Field label="Location" className="col-span-2 sm:col-span-1">
            <TextInput value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Home" />
          </Field>
        </div>
        <Field label="Notes">
          <TextArea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Memorable moments, house rules…" />
        </Field>
      </div>
    </Sheet>
  );
}

/** The winner's moment. Full screen; confetti unless reduced motion. */
export function Celebration({
  item,
  playId,
  onClose,
  onRematch,
}: {
  item: ItemHandle<Data>;
  playId: string;
  onClose: () => void;
  onRematch: (id: string) => void;
}) {
  const play = item.data.plays.find((p) => p.id === playId);
  const { players, games } = useLookups(item.data);
  const game = play ? games.get(play.game_id) : undefined;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!play) return null;
  const win = game?.scoring.win ?? "high";
  const teams = usesTeams(game, play);
  const winnersSeats = play.seats.filter((s) => s.winner);
  const winTeams = play.teams.filter((t) => t.winner);
  const lost = win === "coop" ? !play.coop_won : winnersSeats.length === 0;
  const headline =
    win === "coop"
      ? play.coop_won
        ? "You beat the game!"
        : "The game wins this time"
      : teams
        ? winTeams.length
          ? `${winTeams.map((t) => t.name).join(" & ")} win!`
          : "Game over"
        : winnersSeats.length > 1
          ? `${winnersSeats.map((s) => players.get(s.player_id)?.name).join(" & ")} share the win!`
          : winnersSeats.length
            ? `${players.get(winnersSeats[0].player_id)?.name} wins!`
            : "Game over";
  const top = teams ? winTeams[0] : winnersSeats[0];
  const confetti = !lost && item.data.settings.confetti && !prefersReducedMotion();
  const colors = [...winnersSeats.map((s) => players.get(s.player_id)?.color ?? "#C2557A"), "#F2B705", "#C2557A", "#3B7DD8", "#4E9F5B"];
  const order = teams
    ? [...play.teams].sort((a, b) => (a.place ?? 99) - (b.place ?? 99))
    : [...play.seats].sort((a, b) => (a.place ?? 99) - (b.place ?? 99));
  const firstTimers = play.seats.filter((s) => s.first_play && s.winner);

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={headline} className="fixed inset-0 z-[80] flex items-center justify-center bg-[color-mix(in_srgb,var(--bg)_92%,transparent)] p-4 backdrop-blur-sm animate-[fadeIn_160ms_ease-out]">
      <Confetti on={confetti} colors={colors} />
      <div className="relative flex w-full max-w-md flex-col items-center gap-4 rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 text-center shadow-[var(--shadow-lg)]">
        <button type="button" aria-label="Close" onClick={onClose} className="absolute right-3 top-3 flex h-10 w-10 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)]">
          <X className="h-4 w-4" />
        </button>
        <div className={cn("flex h-20 w-20 items-center justify-center rounded-full", lost ? "bg-[var(--surface-2)]" : "bg-[color-mix(in_srgb,#F2B705_22%,transparent)]")}>
          {lost ? <span className="text-4xl">🎲</span> : win === "coop" ? <PartyPopper className="h-10 w-10 text-[#C98F00]" /> : <Trophy className="h-10 w-10 text-[#C98F00] item-pop" />}
        </div>
        <div aria-live="assertive">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{game?.name}</p>
          <h2 className="mt-1 text-2xl font-bold text-[var(--text)]">{headline}</h2>
          {top && top.score !== null && win !== "coop" && <p className="mt-1 text-sm text-[var(--text-muted)]">with {fmtScore(top.score)} points</p>}
          {firstTimers.length > 0 && <p className="mt-1 text-sm text-[var(--item-accent)]">Beginner's luck — first time playing! ✨</p>}
          {play.tiebreak_note && <p className="mt-1 text-xs text-[var(--text-muted)]">{play.tiebreak_note}</p>}
        </div>
        {win !== "coop" && (
          <ol className="flex w-full flex-col gap-1.5">
            {order.map((e) => {
              const isTeam = "id" in e && teams;
              const name = isTeam ? (e as Team).name : (players.get((e as Seat).player_id)?.name ?? "?");
              return (
                <li key={isTeam ? (e as Team).id : (e as Seat).player_id} className={cn("flex items-center gap-2 rounded-2xl px-3 py-2", e.winner ? "bg-[color-mix(in_srgb,var(--item-accent)_12%,transparent)]" : "bg-[var(--surface-2)]")}>
                  <span className="w-8 text-left text-sm font-bold tabular-nums text-[var(--text-muted)]">{e.place ? ordinal(e.place) : ""}</span>
                  {isTeam ? <TeamBadge team={e as Team} size={28} /> : <PlayerBadge player={players.get((e as Seat).player_id)} size={28} crown={e.winner} />}
                  <span className="min-w-0 flex-1 truncate text-left text-sm font-medium text-[var(--text)]">{name}</span>
                  {e.score !== null && <span className="font-bold tabular-nums text-[var(--text)]">{fmtScore(e.score)}</span>}
                </li>
              );
            })}
          </ol>
        )}
        <div className="flex w-full gap-2">
          <ItemButton className="flex-1" icon={<RotateCcw className="h-4 w-4" />} onClick={() => onRematch(play.id)} disabled={!item.canEdit}>
            Rematch
          </ItemButton>
          <ItemButton variant="primary" className="flex-1" onClick={onClose}>
            Done
          </ItemButton>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Start a rematch of ``playId``; returns the new play's id. */
export function startRematch(item: ItemHandle<Data>, playId: string): string | null {
  const prev = item.data.plays.find((p) => p.id === playId);
  const game = prev ? item.data.games.find((g) => g.id === prev.game_id) : undefined;
  if (!prev || !game) return null;
  const next = rematchOf(item.data, prev, game);
  item.update((d) => {
    d.plays.push(next);
  });
  return next.id;
}
