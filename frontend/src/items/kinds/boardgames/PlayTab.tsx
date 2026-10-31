import { CalendarClock, Dices, Download, History, MapPin, Pencil, Play as PlayIcon, Plus, RotateCcw, Sparkles, Timer, Trash2, Trophy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import { Card, Chip, EmptyState, Fab, Field, ItemButton, List, ListRow, Page, ScrollRow, Section, Select, Sheet, TextArea, TextInput, fmtDay, fmtDuration } from "@/items/ui";
import { cn } from "@/utils/cn";

import { GameTile, PlayerBadge, TeamBadge, fmtMinutes, fmtScore, ordinal, useLookups, useTick, useWidth } from "./bits";
import { Celebration, FinishSheet, startRematch } from "./Finish";
import { downloadCsv, playsCsv } from "./csv";
import { ScorePad } from "./ScorePad";
import { elapsedSeconds, entryTotal, playCategories, standings, usesTeams } from "./scoring";
import { StartSheet } from "./StartSheet";
import type { Data, Game, Play } from "./types";

/*
 * The Play tab: start or resume a game, rematch, and the plays log. While a
 * play is open the score pad takes over the tab.
 */

const OPEN_KEY = "gn:open-play";

function remembered(fileId: string): string | null {
  try {
    return window.sessionStorage.getItem(`${OPEN_KEY}:${fileId}`);
  } catch {
    return null;
  }
}
function remember(fileId: string, id: string | null) {
  try {
    if (id) window.sessionStorage.setItem(`${OPEN_KEY}:${fileId}`, id);
    else window.sessionStorage.removeItem(`${OPEN_KEY}:${fileId}`);
  } catch {
    /* private mode */
  }
}

// A pending "Start a game" request (from the header button or a game's
// "Play" in the library), held in memory until the Play tab picks it up —
// it may not be mounted yet when the request is made.
let pendingStart: { fileId: string; gameId: string } | null = null;
const START_EVENT = "gn:start";

/** Ask the Play tab to open "Start a game" (with ``gameId``, "" = choose).
 *  Pair it with ``goTo("play")``. */
export function requestStart(fileId: string, gameId: string) {
  pendingStart = { fileId, gameId };
  window.dispatchEvent(new Event(START_EVENT));
}
function takeStartRequest(fileId: string): string | null {
  if (!pendingStart || pendingStart.fileId !== fileId) return null;
  const g = pendingStart.gameId;
  pendingStart = null;
  return g;
}

export function PlayTab({ item, isPhone, ask, goTo }: ItemViewProps<Data>) {
  const data = item.data;
  const { games } = useLookups(data);
  const [boxRef, width] = useWidth<HTMLDivElement>();
  // Two columns only when each gets real room (the AI panel may be open).
  const twoCol = !isPhone && width >= 820;
  const [openId, setOpenIdState] = useState<string | null>(() => remembered(item.fileId));
  const setOpenId = (id: string | null) => {
    setOpenIdState(id);
    remember(item.fileId, id);
  };
  const [starting, setStarting] = useState<{ gameId?: string | null } | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [celebrate, setCelebrate] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  // A start request from another tab ("Play" on a game in the library).
  useEffect(() => {
    const gameId = takeStartRequest(item.fileId);
    if (gameId !== null) setStarting({ gameId: gameId || null });
    const onStart = () => {
      const g = takeStartRequest(item.fileId);
      if (g !== null) {
        setOpenIdState(null);
        setStarting({ gameId: g || null });
      }
    };
    window.addEventListener(START_EVENT, onStart);
    return () => window.removeEventListener(START_EVENT, onStart);
  }, [item.fileId]);

  const live = data.plays.filter((p) => p.status === "active");
  const open = openId ? data.plays.find((p) => p.id === openId && p.status === "active") : undefined;

  if (open && !celebrate) {
    return (
      <>
        <ScorePad item={item} play={open} game={games.get(open.game_id)} isPhone={isPhone} ask={ask} onBack={() => setOpenId(null)} onFinish={() => setFinishing(true)} />
        <FinishSheet
          open={finishing}
          onClose={() => setFinishing(false)}
          item={item}
          play={open}
          game={games.get(open.game_id)}
          onDone={(id) => {
            setFinishing(false);
            setOpenId(null);
            setCelebrate(id);
          }}
        />
      </>
    );
  }

  const finished = [...data.plays].filter((p) => p.status === "finished").sort((a, b) => b.date.localeCompare(a.date) || (b.ended_at ?? "").localeCompare(a.ended_at ?? ""));
  const last = finished[0];

  return (
    <Page wide={!isPhone}>
      <div ref={boxRef} className={cn("grid grid-cols-1 gap-5", twoCol && "grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]")}>
        <div className="flex min-w-0 flex-col gap-5">
          {live.length > 0 && (
            <Section title="In progress" hint={live.length > 1 ? `${live.length} games on the go` : "Saved in the file — pick up on any device"}>
              <div className="flex flex-col gap-2">
                {live.map((p) => (
                  <LiveCard key={p.id} data={data} play={p} game={games.get(p.game_id)} onOpen={() => setOpenId(p.id)} />
                ))}
              </div>
            </Section>
          )}

          <Card className="flex flex-col gap-3 overflow-hidden bg-[linear-gradient(135deg,color-mix(in_srgb,var(--item-accent)_16%,var(--surface)),var(--surface))]">
            <div className="flex items-center gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--item-accent)] text-white shadow-[var(--shadow-sm)]">
                <Dices className="h-6 w-6" />
              </span>
              <div className="min-w-0">
                <h1 className="text-lg font-bold text-[var(--text)]">Game night</h1>
                <p className="text-sm text-[var(--text-muted)]">
                  {finished.length ? `${finished.length} plays logged${last ? ` · last ${fmtDay(last.date)}` : ""}` : "Keep score, crown winners, settle debates."}
                </p>
              </div>
            </div>
            {item.canEdit && (
              <div className="flex flex-wrap gap-2">
                {/* On a phone the "New game" button floats over the page, so
                    the card offers the rematch alone once there is one. */}
                {(!isPhone || !last) && (
                  <ItemButton variant={live.length ? "secondary" : "primary"} size="lg" icon={<PlayIcon className="h-5 w-5" />} onClick={() => setStarting({})} className="min-w-[150px] flex-1 whitespace-nowrap">
                    Start a game
                  </ItemButton>
                )}
                {last && games.get(last.game_id) && (
                  <ItemButton
                    size="lg"
                    className="min-w-0 max-w-full flex-1 basis-[150px]"
                    icon={<RotateCcw className="h-4 w-4 shrink-0" />}
                    onClick={() => {
                      const id = startRematch(item, last.id);
                      if (id) setOpenId(id);
                    }}
                  >
                    <span className="truncate">Rematch {games.get(last.game_id)?.name}</span>
                  </ItemButton>
                )}
              </div>
            )}
          </Card>

          {data.games.length === 0 && item.canEdit && (
            <EmptyState
              icon={Dices}
              title="Add your games"
              text="Pick from 30+ games with their official score sheets — Wingspan, Catan, Ticket to Ride, Yahtzee… — or set up your own."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <ItemButton variant="primary" onClick={() => goTo("games")}>
                    Browse games
                  </ItemButton>
                  <ItemButton icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Help me set up my games library — ask me which games we play, then add them with proper score sheets.")}>
                    Ask the assistant
                  </ItemButton>
                </div>
              }
            />
          )}

          {!isPhone && finished.length > 0 && <QuickStats data={data} />}
        </div>

        <PlaysLog data={data} onOpen={setDetail} ask={ask} />
      </div>

      {isPhone && item.canEdit && !starting && <Fab label="New game" icon={Plus} onClick={() => setStarting({})} />}

      <StartSheet
        open={!!starting}
        onClose={() => setStarting(null)}
        item={item}
        initialGameId={starting?.gameId ?? null}
        onBrowseGames={() => {
          setStarting(null);
          goTo("games");
        }}
        onStarted={(id) => {
          setStarting(null);
          setOpenId(id);
        }}
      />
      {celebrate && (
        <Celebration
          item={item}
          playId={celebrate}
          onClose={() => setCelebrate(null)}
          onRematch={(id) => {
            const n = startRematch(item, id);
            setCelebrate(null);
            if (n) setOpenId(n);
          }}
        />
      )}
      <PlayDetail
        item={item}
        playId={detail}
        onClose={() => setDetail(null)}
        onReopen={(id) => {
          setDetail(null);
          setOpenId(id);
        }}
      />
    </Page>
  );

  function QuickStats({ data }: { data: Data }) {
    const month = new Date().toISOString().slice(0, 7);
    const thisMonth = data.plays.filter((p) => p.status === "finished" && p.date.startsWith(month)).length;
    const me = data.settings.me_player_id;
    const myWins = me ? data.plays.filter((p) => p.status === "finished" && p.seats.some((s) => s.player_id === me && s.winner)).length : 0;
    return (
      <div className="grid grid-cols-2 gap-3">
        <Card onClick={() => goTo("stats")} className="flex flex-col gap-0.5">
          <span className="text-xs text-[var(--text-muted)]">This month</span>
          <span className="text-2xl font-semibold tabular-nums text-[var(--text)]">{thisMonth}</span>
          <span className="text-xs text-[var(--text-muted)]">plays</span>
        </Card>
        {me && (
          <Card onClick={() => goTo("stats")} className="flex flex-col gap-0.5">
            <span className="text-xs text-[var(--text-muted)]">Your wins</span>
            <span className="text-2xl font-semibold tabular-nums text-[var(--text)]">{myWins}</span>
            <span className="text-xs text-[var(--text-muted)]">all time · see stats</span>
          </Card>
        )}
      </div>
    );
  }
}

function LiveCard({ data, play, game, onOpen }: { data: Data; play: Play; game: Game | undefined; onOpen: () => void }) {
  const now = useTick(!!play.timer_started_at, 1000);
  const players = new Map(data.players.map((p) => [p.id, p]));
  const st = standings(game, play);
  const teams = usesTeams(game, play);
  const lead = st[0];
  const leadName = lead ? (teams ? play.teams.find((t) => t.id === lead.key)?.name : players.get(lead.key)?.name) : null;
  const scored = st.some((s) => s.total !== 0);
  return (
    <Card onClick={onOpen} className="flex items-center gap-3 !border-[color-mix(in_srgb,var(--item-accent)_45%,var(--border))] bg-[color-mix(in_srgb,var(--item-accent)_6%,var(--surface))]">
      <GameTile game={game} size={48} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-[var(--text)]">{game?.name ?? "?"}</div>
        <div className="mt-1 flex -space-x-1.5">
          {play.seats.slice(0, 8).map((s) => (
            <PlayerBadge key={s.player_id} player={players.get(s.player_id)} size={22} className="rounded-full ring-2 ring-[var(--surface)]" />
          ))}
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <Timer className="h-3 w-3" />
          <span className="tabular-nums">{fmtDuration(elapsedSeconds(play, now))}</span>
          {scored && leadName && (
            <span className="truncate">
              · {leadName} leads with {fmtScore(lead.total)}
            </span>
          )}
        </div>
      </div>
      <ItemButton variant="primary" size="sm" icon={<PlayIcon className="h-3.5 w-3.5" />}>
        Resume
      </ItemButton>
    </Card>
  );
}

function resultLine(data: Data, play: Play, game: Game | undefined): string {
  const players = new Map(data.players.map((p) => [p.id, p]));
  const win = game?.scoring.win ?? "high";
  if (win === "coop") return play.coop_won ? "Won together" : "Lost together";
  if (usesTeams(game, play)) {
    const t = play.teams.filter((x) => x.winner);
    return t.length ? `${t.map((x) => x.name).join(" & ")} won` : "No winner";
  }
  const w = play.seats.filter((s) => s.winner);
  if (!w.length) return "No winner";
  const names = w.map((s) => players.get(s.player_id)?.name ?? "?").join(" & ");
  const sc = w[0].score;
  return `${names} ${w.length > 1 ? "shared it" : "won"}${sc !== null && (win === "high" || win === "low") ? ` · ${fmtScore(sc)}` : ""}`;
}

function PlaysLog({ data, onOpen, ask }: { data: Data; onOpen: (id: string) => void; ask: (p: string, opts?: { send?: boolean }) => void }) {
  const { players, games } = useLookups(data);
  const [game, setGame] = useState("");
  const [player, setPlayer] = useState("");
  const [range, setRange] = useState<"all" | "30" | "90" | "year">("all");
  const [limit, setLimit] = useState(40);
  const rows = useMemo(() => {
    const since =
      range === "all"
        ? ""
        : range === "year"
          ? `${new Date().getFullYear()}-01-01`
          : new Date(Date.now() - Number(range) * 86_400_000).toISOString().slice(0, 10);
    return data.plays
      .filter((p) => p.status === "finished")
      .filter((p) => !game || p.game_id === game)
      .filter((p) => !player || p.seats.some((s) => s.player_id === player))
      .filter((p) => !since || p.date >= since)
      .sort((a, b) => b.date.localeCompare(a.date) || (b.ended_at ?? "").localeCompare(a.ended_at ?? ""));
  }, [data.plays, game, player, range]);
  const playedGames = useMemo(() => data.games.filter((g) => data.plays.some((p) => p.game_id === g.id)).sort((a, b) => a.name.localeCompare(b.name)), [data.games, data.plays]);
  const total = data.plays.filter((p) => p.status === "finished").length;

  // Group by day.
  const groups: { day: string; plays: Play[] }[] = [];
  for (const p of rows.slice(0, limit)) {
    const g = groups[groups.length - 1];
    if (g && g.day === p.date) g.plays.push(p);
    else groups.push({ day: p.date, plays: [p] });
  }

  return (
    <Section title="Plays log" hint={total ? `${rows.length} of ${total}` : undefined} action={<History className="h-4 w-4 text-[var(--text-muted)]" />}>
      {total > 0 && (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <Select aria-label="Filter by game" value={game} onChange={(e) => setGame(e.target.value)}>
              <option value="">All games</option>
              {playedGames.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
            <Select aria-label="Filter by player" value={player} onChange={(e) => setPlayer(e.target.value)}>
              <option value="">Everyone</option>
              {data.players.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <ScrollRow className="mx-0 min-w-0 flex-1 px-0">
              {(
                [
                  ["all", "All time"],
                  ["30", "30 days"],
                  ["90", "90 days"],
                  ["year", "This year"],
                ] as const
              ).map(([v, l]) => (
                <Chip key={v} active={range === v} onClick={() => setRange(v)}>
                  {l}
                </Chip>
              ))}
            </ScrollRow>
            <ItemButton
              variant="ghost"
              icon={<Download className="h-4 w-4" />}
              disabled={!rows.length}
              aria-label={rows.length === total ? "Export all plays as CSV" : `Export these ${rows.length} plays as CSV`}
              onClick={() => downloadCsv(`game-night-plays-${new Date().toISOString().slice(0, 10)}.csv`, playsCsv(data, rows.map((p) => p.id)))}
            >
              CSV
            </ItemButton>
          </div>
        </div>
      )}
      {total === 0 ? (
        <EmptyState
          icon={Trophy}
          title="No plays yet"
          text="Start a game on the score pad, or tell the assistant what you played — “We played Catan, I won with 10, Sam 8, Jo 7”."
          action={
            <ItemButton icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("We played ", { send: false })}>
              Log a play with AI
            </ItemButton>
          }
        />
      ) : rows.length === 0 ? (
        <p className="px-1 text-sm text-[var(--text-muted)]">No plays match.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((g) => (
            <div key={g.day} className="flex flex-col gap-1.5">
              <h3 className="px-1 text-xs font-semibold text-[var(--text-muted)]">{fmtDay(g.day, { long: true })}</h3>
              <List>
                {g.plays.map((p) => {
                  const gm = games.get(p.game_id);
                  return (
                    <ListRow
                      key={p.id}
                      onClick={() => onOpen(p.id)}
                      leading={<GameTile game={gm} size={40} />}
                      title={gm?.name ?? "?"}
                      subtitle={
                        <span className="flex items-center gap-1.5">
                          <span className="truncate">{resultLine(data, p, gm)}</span>
                          {p.seats.length > 0 && p.seats.every((s) => s.first_play) && (
                            <span title="The first time this table played it" className="shrink-0 rounded-full bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] px-1.5 text-[10px] font-semibold text-[var(--item-accent)]">
                              First play
                            </span>
                          )}
                        </span>
                      }
                      trailing={
                        <span className="flex -space-x-1.5">
                          {p.seats.slice(0, 4).map((s) => (
                            <PlayerBadge key={s.player_id} player={players.get(s.player_id)} size={22} className="rounded-full ring-2 ring-[var(--surface)]" crown={false} />
                          ))}
                          {p.seats.length > 4 && <span className="pl-2 text-xs">+{p.seats.length - 4}</span>}
                        </span>
                      }
                    />
                  );
                })}
              </List>
            </div>
          ))}
          {rows.length > limit && (
            <ItemButton variant="ghost" onClick={() => setLimit((l) => l + 60)}>
              Show more
            </ItemButton>
          )}
        </div>
      )}
    </Section>
  );
}

function PlayDetail({ item, playId, onClose, onReopen }: { item: ItemViewProps<Data>["item"]; playId: string | null; onClose: () => void; onReopen: (id: string) => void }) {
  const play = playId ? item.data.plays.find((p) => p.id === playId) : undefined;
  const { players, games } = useLookups(item.data);
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [playId]);
  if (!play) return null;
  const game = games.get(play.game_id);
  const teams = usesTeams(game, play);
  const cats = playCategories(game, play);
  const mutate = (fn: (p: Play) => void) =>
    item.update((d) => {
      const p = d.plays.find((x) => x.id === play.id);
      if (p) fn(p);
    });
  const order = [...play.seats].sort((a, b) => (a.place ?? 99) - (b.place ?? 99));
  return (
    <Sheet
      open={!!play}
      onClose={onClose}
      title={game?.name ?? "Play"}
      size="lg"
      footer={
        item.canEdit ? (
          <>
            <ItemButton
              variant="ghost"
              icon={<Trash2 className="h-4 w-4" />}
              onClick={() => {
                if (!window.confirm("Delete this play from the log?")) return;
                item.update((d) => {
                  d.plays = d.plays.filter((p) => p.id !== play.id);
                });
                onClose();
              }}
            >
              Delete
            </ItemButton>
            <ItemButton
              className="flex-1"
              icon={<Pencil className="h-4 w-4" />}
              onClick={() => {
                mutate((p) => {
                  p.status = "active";
                  p.timer_started_at = null;
                });
                onReopen(play.id);
              }}
            >
              Edit scores
            </ItemButton>
            <ItemButton variant="primary" className="flex-1" onClick={() => (editing ? setEditing(false) : setEditing(true))}>
              {editing ? "Done" : "Edit details"}
            </ItemButton>
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4 pb-2">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--text-muted)]">
          <span className="inline-flex items-center gap-1">
            <CalendarClock className="h-4 w-4" /> {fmtDay(play.date, { long: true })}
          </span>
          {play.duration_min ? (
            <span className="inline-flex items-center gap-1">
              <Timer className="h-4 w-4" /> {fmtMinutes(play.duration_min)}
            </span>
          ) : null}
          {play.location && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-4 w-4" /> {play.location}
            </span>
          )}
        </div>
        {(game?.scoring.win ?? "high") === "coop" && (
          <p className={cn("rounded-2xl px-3 py-2 text-sm font-semibold", play.coop_won ? "bg-[var(--success-bg)] text-[var(--success)]" : "bg-[var(--surface-2)] text-[var(--text)]")}>
            {play.coop_won ? "The table won together 🎉" : "The game won this time"}
          </p>
        )}
        {teams && (
          <div className="flex flex-col gap-1.5">
            {[...play.teams].sort((a, b) => (a.place ?? 99) - (b.place ?? 99)).map((t) => (
              <div key={t.id} className={cn("flex items-center gap-2 rounded-2xl px-3 py-2", t.winner ? "bg-[color-mix(in_srgb,var(--item-accent)_12%,transparent)]" : "bg-[var(--surface-2)]")}>
                <TeamBadge team={t} size={28} />
                <span className="min-w-0 flex-1 text-sm font-medium text-[var(--text)]">
                  {t.name}
                  <span className="block truncate text-xs font-normal text-[var(--text-muted)]">
                    {play.seats.filter((s) => s.team_id === t.id).map((s) => players.get(s.player_id)?.name).join(", ")}
                  </span>
                </span>
                {t.winner && <Trophy className="h-4 w-4 text-[var(--item-accent)]" />}
                {t.score !== null && <span className="font-bold tabular-nums">{fmtScore(t.score)}</span>}
              </div>
            ))}
          </div>
        )}
        {!teams && (
          <div className="overflow-x-auto rounded-2xl border border-[var(--border)]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-xs text-[var(--text-muted)]">
                  <th className="px-3 py-2 text-left font-medium">Player</th>
                  {cats.map((c) => (
                    <th key={c.id} className="px-2 py-2 text-right font-medium" title={c.name}>
                      <span className="block max-w-[72px] truncate">{c.name}</span>
                    </th>
                  ))}
                  <th className="px-3 py-2 text-right font-medium">Score</th>
                </tr>
              </thead>
              <tbody>
                {order.map((s) => (
                  <tr key={s.player_id} className={cn("border-b border-[var(--border)] last:border-0", s.winner && "bg-[color-mix(in_srgb,var(--item-accent)_8%,transparent)]")}>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        <span className="w-7 text-xs font-bold tabular-nums text-[var(--text-muted)]">{s.place ? ordinal(s.place) : ""}</span>
                        <PlayerBadge player={players.get(s.player_id)} size={26} crown={s.winner} />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-[var(--text)]">{players.get(s.player_id)?.name}</span>
                          {(s.faction || s.first_play) && (
                            <span className="block truncate text-[11px] text-[var(--text-muted)]">
                              {[s.faction, s.first_play ? "first play" : ""].filter(Boolean).join(" · ")}
                            </span>
                          )}
                        </span>
                      </span>
                    </td>
                    {cats.map((c) => (
                      <td key={c.id} className="px-2 py-2 text-right tabular-nums text-[var(--text-muted)]">
                        {s.scores[c.id] ?? ""}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right font-bold tabular-nums text-[var(--text)]">{s.score !== null ? fmtScore(s.score) : s.total !== null ? fmtScore(entryTotal(game, s, cats)) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {play.expansions.length > 0 && (
          <p className="text-xs text-[var(--text-muted)]">
            With {play.expansions.map((id) => game?.expansions.find((e) => e.id === id)?.name ?? id).join(", ")}
          </p>
        )}
        {play.tiebreak_note && <p className="text-xs text-[var(--text-muted)]">{play.tiebreak_note}</p>}
        {!editing && play.notes && <p className="whitespace-pre-wrap rounded-2xl bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text)]">{play.notes}</p>}
        {editing && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date">
              <TextInput type="date" value={play.date} onChange={(e) => /^\d{4}-\d{2}-\d{2}$/.test(e.target.value) && mutate((p) => (p.date = e.target.value))} />
            </Field>
            <Field label="Minutes">
              <TextInput inputMode="numeric" value={play.duration_min ?? ""} onChange={(e) => mutate((p) => (p.duration_min = e.target.value ? Math.max(0, Math.min(10000, parseInt(e.target.value, 10) || 0)) : null))} />
            </Field>
            <Field label="Location" className="col-span-2">
              <TextInput value={play.location} onChange={(e) => mutate((p) => (p.location = e.target.value.slice(0, 80)))} />
            </Field>
            <Field label="Notes" className="col-span-2">
              <TextArea value={play.notes} onChange={(e) => mutate((p) => (p.notes = e.target.value.slice(0, 2000)))} />
            </Field>
          </div>
        )}
      </div>
    </Sheet>
  );
}
