import { ArrowDown, ArrowUp, Check, Plus, Search, Shuffle, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ItemHandle } from "@/items/useItem";
import { Chip, EmptyState, Field, ItemButton, Select, Sheet, TextInput, Toggle, todayISO, uid } from "@/items/ui";
import { cn } from "@/utils/cn";

import { FavStar, GameTile, PlayerBadge, gameMeta, makePlay } from "./bits";
import type { Data, Team } from "./types";
import { PALETTE, TEAM_COLORS } from "./types";

/*
 * Start a play: pick the game, who's playing (tap in seat order), teams,
 * factions and expansions. Two taps for the usual crowd.
 */

export function StartSheet({
  open,
  onClose,
  item,
  initialGameId,
  onStarted,
  onBrowseGames,
}: {
  open: boolean;
  onClose: () => void;
  item: ItemHandle<Data>;
  initialGameId?: string | null;
  onStarted: (playId: string) => void;
  onBrowseGames: () => void;
}) {
  const data = item.data;
  const [step, setStep] = useState<"game" | "players">("game");
  const [gameId, setGameId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [seats, setSeats] = useState<string[]>([]);
  const [useTeams, setUseTeams] = useState(false);
  const [teamOf, setTeamOf] = useState<Record<string, number>>({});
  const [teamCount, setTeamCount] = useState(2);
  const [factions, setFactions] = useState<Record<string, string>>({});
  const [expansions, setExpansions] = useState<string[]>([]);
  const [newName, setNewName] = useState("");

  const lastPlay = useMemo(() => [...data.plays].filter((p) => p.status === "finished").sort((a, b) => b.date.localeCompare(a.date))[0], [data.plays]);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setNewName("");
    setFactions({});
    setTeamOf({});
    const g = initialGameId ?? null;
    setGameId(g);
    setStep(g ? "players" : "game");
    // The usual crowd: the last play's people, else "me".
    const me = data.settings.me_player_id;
    const base = lastPlay ? lastPlay.seats.map((s) => s.player_id).filter((id) => data.players.some((p) => p.id === id && !p.archived)) : me ? [me] : [];
    setSeats(base);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const game = data.games.find((g) => g.id === gameId);
  useEffect(() => {
    if (!game) return;
    const t = game.scoring.win === "teams";
    setUseTeams(t);
    setExpansions([]);
  }, [game]);

  const playCount = useMemo(() => {
    const m = new Map<string, { n: number; last: string }>();
    for (const p of data.plays) {
      const r = m.get(p.game_id) ?? { n: 0, last: "" };
      r.n++;
      if (p.date > r.last) r.last = p.date;
      m.set(p.game_id, r);
    }
    return m;
  }, [data.plays]);

  const games = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.games
      .filter((g) => !needle || g.name.toLowerCase().includes(needle))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || (playCount.get(b.id)?.last ?? "").localeCompare(playCount.get(a.id)?.last ?? "") || a.name.localeCompare(b.name));
  }, [data.games, q, playCount]);

  const active = data.players.filter((p) => !p.archived).sort((a, b) => Number(b.me) - Number(a.me) || Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
  const toggleSeat = (id: string) => setSeats((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const move = (i: number, by: number) =>
    setSeats((s) => {
      const n = [...s];
      const j = i + by;
      if (j < 0 || j >= n.length) return s;
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  const shuffle = () =>
    setSeats((s) => {
      const n = [...s];
      for (let i = n.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [n[i], n[j]] = [n[j], n[i]];
      }
      return n;
    });

  const addNew = () => {
    const name = newName.trim();
    if (!name) return;
    const existing = data.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (!seats.includes(existing.id)) setSeats((s) => [...s, existing.id]);
      setNewName("");
      return;
    }
    const id = uid("p-");
    const used = new Set(data.players.map((p) => p.color));
    const color = PALETTE.find((c) => !used.has(c)) ?? PALETTE[data.players.length % PALETTE.length];
    item.update((d) => {
      d.players.push({ id, name: name.slice(0, 60), color, favorite: false, archived: false, me: false, bgg_user: "", notes: "", created: todayISO() });
    });
    setSeats((s) => [...s, id]);
    setNewName("");
  };

  const factionList = game ? [...game.scoring.factions, ...game.expansions.filter((e) => expansions.includes(e.id)).flatMap((e) => e.factions)] : [];
  const teamsReady = !useTeams || (seats.every((s) => teamOf[s] !== undefined) && new Set(seats.map((s) => teamOf[s])).size >= 2);
  const countWarn = game && seats.length && (seats.length < game.min_players || seats.length > game.max_players) ? `${game.name} is for ${game.min_players === game.max_players ? game.min_players : `${game.min_players}–${game.max_players}`} players` : "";

  const start = () => {
    if (!game || !seats.length) return;
    let teams: Team[] = [];
    if (useTeams) {
      const used = [...new Set(seats.map((s) => teamOf[s]))].sort();
      teams = used.map((i) => ({
        id: `t${i + 1}`,
        name: ["Red", "Blue", "Green", "Gold", "Purple", "Teal"][i] ?? `Team ${i + 1}`,
        color: TEAM_COLORS[i % TEAM_COLORS.length],
        scores: {},
        rounds: [],
        total: null,
        tiebreak: null,
        score: null,
        place: null,
        winner: false,
      }));
    }
    const play = makePlay(
      data,
      game,
      seats.map((s) => ({ player_id: s, team_id: useTeams ? `t${teamOf[s] + 1}` : null, faction: factions[s] ?? "" })),
      teams,
      { expansions },
    );
    item.update((d) => {
      d.plays.push(play);
    });
    onStarted(play.id);
  };

  const gameStep = (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
        <TextInput autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your games" className="pl-9" aria-label="Search your games" />
      </div>
      {games.length === 0 ? (
        <EmptyState
          title={data.games.length ? "No match" : "Your library is empty"}
          text="Add games from 30+ built-in score sheets, or set up your own."
          action={
            <ItemButton variant="primary" onClick={onBrowseGames}>
              Add games
            </ItemButton>
          }
        />
      ) : (
        <div className="flex flex-col gap-1">
          {games.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => {
                setGameId(g.id);
                setStep("players");
              }}
              className="flex min-h-[56px] items-center gap-3 rounded-2xl px-2 py-1.5 text-left transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
            >
              <GameTile game={g} size={40} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1 truncate text-sm font-medium text-[var(--text)]">
                  {g.name} <FavStar on={g.favorite} />
                </span>
                <span className="block truncate text-xs text-[var(--text-muted)]">
                  {gameMeta(g)}
                  {playCount.get(g.id) ? ` · ${playCount.get(g.id)!.n} play${playCount.get(g.id)!.n === 1 ? "" : "s"}` : ""}
                </span>
              </span>
            </button>
          ))}
          <ItemButton variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={onBrowseGames}>
            Add another game
          </ItemButton>
        </div>
      )}
    </div>
  );

  const playersStep = game && (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={() => setStep("game")} className="flex items-center gap-3 rounded-2xl border border-[var(--border)] p-2 text-left hover:bg-[var(--hover)]">
        <GameTile game={game} size={40} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-[var(--text)]">{game.name}</span>
          <span className="block truncate text-xs text-[var(--text-muted)]">{gameMeta(game)}</span>
        </span>
        <span className="text-xs font-medium text-[var(--item-accent)]">Change</span>
      </button>

      <Field label="Who's playing? Tap in seat order">
        <div className="flex flex-wrap gap-2">
          {active.map((p) => {
            const i = seats.indexOf(p.id);
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={i >= 0}
                onClick={() => toggleSeat(p.id)}
                className={cn(
                  "inline-flex h-11 items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-sm font-medium transition",
                  i >= 0 ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_12%,transparent)] text-[var(--text)]" : "border-[var(--border)] text-[var(--text-muted)]",
                )}
              >
                <PlayerBadge player={p} size={32} />
                {p.name}
                {i >= 0 && <span className="ml-0.5 rounded-full bg-[var(--item-accent)] px-1.5 text-[11px] font-bold text-white tabular-nums">{i + 1}</span>}
              </button>
            );
          })}
        </div>
      </Field>
      <div className="flex gap-2">
        <TextInput value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addNew()} placeholder="Add someone new" aria-label="New player name" />
        <ItemButton onClick={addNew} disabled={!newName.trim()} icon={<Plus className="h-4 w-4" />}>
          Add
        </ItemButton>
      </div>
      {countWarn && <p className="text-xs text-[var(--warning)]">{countWarn} — you can still play.</p>}

      {seats.length > 1 && (
        <Field label="Seat order (first player at the top)">
          <ol className="flex flex-col gap-1.5">
            {seats.map((id, i) => {
              const p = data.players.find((x) => x.id === id);
              return (
                <li key={id} className="flex items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-2 py-1">
                  <span className="w-5 text-center text-xs font-bold tabular-nums text-[var(--text-muted)]">{i + 1}</span>
                  <PlayerBadge player={p} size={28} />
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{p?.name}</span>
                  {factionList.length > 0 && (
                    <Select aria-label={`${p?.name} faction`} value={factions[id] ?? ""} onChange={(e) => setFactions((f) => ({ ...f, [id]: e.target.value }))} className="h-9 w-36 text-xs md:h-9">
                      <option value="">Faction…</option>
                      {factionList.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </Select>
                  )}
                  {useTeams && (
                    <div className="flex gap-1" role="radiogroup" aria-label={`${p?.name}'s team`}>
                      {Array.from({ length: teamCount }, (_, t) => (
                        <button
                          key={t}
                          type="button"
                          role="radio"
                          aria-checked={teamOf[id] === t}
                          aria-label={`Team ${t + 1}`}
                          onClick={() => setTeamOf((m) => ({ ...m, [id]: t }))}
                          className={cn("h-8 w-8 rounded-full border-2 text-xs font-bold text-white transition", teamOf[id] === t ? "scale-110 border-[var(--text)]" : "border-transparent opacity-50")}
                          style={{ background: TEAM_COLORS[t] }}
                        >
                          {t + 1}
                        </button>
                      ))}
                    </div>
                  )}
                  <button type="button" aria-label={`Move ${p?.name} up`} disabled={i === 0} onClick={() => move(i, -1)} className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] disabled:opacity-30">
                    <ArrowUp className="h-4 w-4" />
                  </button>
                  <button type="button" aria-label={`Move ${p?.name} down`} disabled={i === seats.length - 1} onClick={() => move(i, 1)} className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] disabled:opacity-30">
                    <ArrowDown className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ItemButton size="sm" variant="ghost" icon={<Shuffle className="h-3.5 w-3.5" />} onClick={shuffle}>
              Random seats
            </ItemButton>
            <ItemButton
              size="sm"
              variant="ghost"
              icon={<Users className="h-3.5 w-3.5" />}
              onClick={() => {
                const first = seats[Math.floor(Math.random() * seats.length)];
                setSeats((s) => [first, ...s.filter((x) => x !== first)]);
              }}
            >
              Random first player
            </ItemButton>
          </div>
        </Field>
      )}

      <label className="flex items-center justify-between gap-3 text-sm text-[var(--text)]">
        Play in teams
        <Toggle checked={useTeams} onChange={setUseTeams} label="Play in teams" />
      </label>
      {useTeams && (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          Teams:
          {[2, 3, 4].map((n) => (
            <Chip key={n} active={teamCount === n} onClick={() => setTeamCount(n)}>
              {n}
            </Chip>
          ))}
          <ItemButton
            size="sm"
            variant="ghost"
            onClick={() => {
              const order = [...seats].sort(() => Math.random() - 0.5);
              const m: Record<string, number> = {};
              order.forEach((id, i) => (m[id] = i % teamCount));
              setTeamOf(m);
            }}
          >
            Random teams
          </ItemButton>
        </div>
      )}

      {game.expansions.length > 0 && (
        <Field label="Expansions">
          <div className="flex flex-wrap gap-2">
            {game.expansions.map((ex) => (
              <Chip key={ex.id} active={expansions.includes(ex.id)} icon={expansions.includes(ex.id) ? <Check className="h-3 w-3" /> : undefined} onClick={() => setExpansions((e) => (e.includes(ex.id) ? e.filter((x) => x !== ex.id) : [...e, ex.id]))}>
                {ex.name}
              </Chip>
            ))}
          </div>
        </Field>
      )}
    </div>
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={step === "game" ? "What are you playing?" : "Set the table"}
      size="lg"
      footer={
        step === "players" ? (
          <ItemButton variant="primary" size="lg" block disabled={!game || !seats.length || !teamsReady} onClick={start}>
            Start {seats.length ? `· ${seats.length} player${seats.length > 1 ? "s" : ""}` : ""}
          </ItemButton>
        ) : undefined
      }
    >
      {step === "game" ? gameStep : playersStep}
    </Sheet>
  );
}
