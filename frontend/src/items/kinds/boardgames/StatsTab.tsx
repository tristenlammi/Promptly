import { BarChart3, Clock, Coins, Crown, Dices, Flame, Hash, Sparkles, Swords } from "lucide-react";
import { useMemo, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import { Card, EmptyState, ItemButton, List, ListRow, Page, Section, Select, Stat } from "@/items/ui";
import { Bars } from "@/items/ui/charts";
import { cn } from "@/utils/cn";

import { GameTile, PlayerBadge, Tiles, fmtPct, useWidth } from "./bits";
import { headToHead, lastNMonths, leaderboard, overall, superlatives } from "./stats";
import type { Data } from "./types";

/* Stats: the table's leaderboard, collection metrics and bragging rights. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function StatsTab({ item, isPhone, ask, goTo }: ItemViewProps<Data>) {
  const data = item.data;
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const twoCol = !isPhone && width >= 860;
  const colW = twoCol ? (width - 24) / 2 : width;
  const ov = useMemo(() => overall(data), [data]);
  const fun = useMemo(() => superlatives(data), [data]);
  const [boardGame, setBoardGame] = useState("");
  const board = useMemo(() => leaderboard(data, boardGame || undefined), [data, boardGame]);
  // From the first month with a play (at least 6, at most 12 bars).
  const months = useMemo(() => {
    const all = lastNMonths(12);
    const first = all.findIndex((m) => (ov.perMonth.get(m) ?? 0) > 0);
    return first < 0 ? all.slice(-6) : all.slice(Math.min(first, 6));
  }, [ov]);
  const active = data.players.filter((p) => !p.archived);
  const me = data.settings.me_player_id;
  const [a, setA] = useState<string>(me ?? active[0]?.id ?? "");
  const [b, setB] = useState<string>(active.find((p) => p.id !== (me ?? active[0]?.id))?.id ?? "");
  const h2h = useMemo(() => (a && b && a !== b ? headToHead(data, a, b) : null), [data, a, b]);
  const pn = (id: string) => data.players.find((p) => p.id === id);
  const playedGames = data.games.filter((g) => data.plays.some((p) => p.game_id === g.id && p.status === "finished"));

  if (ov.plays === 0)
    return (
      <Page>
        <EmptyState
          icon={BarChart3}
          title="Stats appear after your first play"
          text="Win rates, Elo ratings, head-to-head records, streaks, your H-index and more — all from the plays you log."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <ItemButton variant="primary" onClick={() => goTo("play")}>
                Start a game
              </ItemButton>
              <ItemButton icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("We played ", { send: false })}>
                Log a past play
              </ItemButton>
            </div>
          }
        />
      </Page>
    );

  const coins = [
    { label: "Nickels", hint: "5+ plays", list: ov.nickels },
    { label: "Dimes", hint: "10+", list: ov.dimes },
    { label: "Quarters", hint: "25+", list: ov.quarters },
    { label: "Dollars", hint: "100+", list: ov.dollars },
  ];

  const leftCol = (
    <>
      <Tiles width={colW}>
        <Stat label="Plays" value={ov.plays} icon={Dices} tone="accent" />
        <Stat label="Hours" value={Math.round(ov.hours * 10) / 10} icon={Clock} />
        <Stat label="Games played" value={ov.gamesPlayed} delta={`of ${data.games.length} in library`} icon={Hash} />
        <Stat label="H-index" value={ov.hIndex} delta={`${ov.hIndex} games × ${ov.hIndex}+ plays`} icon={BarChart3} />
      </Tiles>

      <Section title="Plays per month">
        <Card>
          <Bars data={months.map((m) => ({ x: MONTHS[Number(m.slice(5)) - 1], y: ov.perMonth.get(m) ?? 0 }))} unit="plays" />
        </Card>
      </Section>

      <Section title="Leaderboard" hint="Multiplayer Elo — everyone starts at 1500">
        <Select aria-label="Leaderboard game" value={boardGame} onChange={(e) => setBoardGame(e.target.value)}>
          <option value="">All games</option>
          {playedGames.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </Select>
        {board.length === 0 ? (
          <p className="px-1 text-sm text-[var(--text-muted)]">No competitive plays yet.</p>
        ) : (
          <List>
            {board.slice(0, 12).map((r, i) => (
              <ListRow
                key={r.player.id}
                onClick={() => goTo("players")}
                leading={
                  <span className="flex items-center gap-2">
                    <span className={cn("w-5 text-right text-sm font-bold tabular-nums", i === 0 ? "text-[#C98F00]" : "text-[var(--text-muted)]")}>{i + 1}</span>
                    <PlayerBadge player={r.player} size={32} crown={i === 0} />
                  </span>
                }
                title={r.player.name}
                subtitle={
                  <span className="flex items-center gap-2">
                    <span className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-[var(--surface-2)]" aria-hidden>
                      <span className="block h-full rounded-full bg-[var(--item-accent-fill)]" style={{ width: `${Math.round((r.wins / Math.max(1, r.plays)) * 100)}%` }} />
                    </span>
                    <span className="truncate">
                      {fmtPct(r.wins / Math.max(1, r.plays))} · {r.wins} of {r.plays}
                    </span>
                  </span>
                }
                trailing={
                  <span className="flex flex-col items-end leading-tight">
                    <span className="text-base font-semibold tabular-nums text-[var(--text)]">{r.elo}</span>
                    <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">Elo</span>
                  </span>
                }
              />
            ))}
          </List>
        )}
      </Section>
    </>
  );

  const rightCol = (
    <>
      {fun.length > 0 && (
        <Section title="Hall of fame">
          <Card padded={false} className={cn("grid divide-[var(--border)]", colW >= 560 ? "grid-cols-2" : "grid-cols-1 divide-y")}>
            {fun.map((f, i) => (
              <div key={f.title} className={cn("flex items-start gap-3 px-4 py-3", colW >= 560 && i >= 2 && "border-t border-[var(--border)]", colW >= 560 && i % 2 === 1 && "border-l border-[var(--border)]")}>
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] text-[var(--item-accent)]">
                  {f.title.includes("fire") ? <Flame className="h-4 w-4" /> : f.title.includes("nemesis") || f.title.includes("victim") ? <Swords className="h-4 w-4" /> : <Crown className="h-4 w-4" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{f.title}</span>
                  <span className="block text-sm leading-snug text-[var(--text)]">{f.text}</span>
                </span>
              </div>
            ))}
          </Card>
        </Section>
      )}

      {active.length >= 2 && (
        <Section title="Head to head">
          <Card className="flex flex-col gap-3">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <Select aria-label="First player" value={a} onChange={(e) => setA(e.target.value)}>
                {active.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
              <span className="text-xs font-semibold text-[var(--text-muted)]">vs</span>
              <Select aria-label="Second player" value={b} onChange={(e) => setB(e.target.value)}>
                {active.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
            {h2h && h2h.played > 0 ? (
              <>
                <div className="flex items-center justify-around">
                  <div className="flex flex-col items-center gap-1">
                    <PlayerBadge player={pn(a)} size={44} crown={h2h.a > h2h.b} />
                    <span className="text-3xl font-bold tabular-nums text-[var(--text)]">{h2h.a}</span>
                  </div>
                  <span className="text-sm text-[var(--text-muted)]">{h2h.ties ? `${h2h.ties} tied` : `${h2h.played} games`}</span>
                  <div className="flex flex-col items-center gap-1">
                    <PlayerBadge player={pn(b)} size={44} crown={h2h.b > h2h.a} />
                    <span className="text-3xl font-bold tabular-nums text-[var(--text)]">{h2h.b}</span>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  {[...h2h.byGame.entries()]
                    .sort((x, y) => y[1].played - x[1].played)
                    .slice(0, 8)
                    .map(([gid, r]) => (
                      <div key={gid} className="flex items-center gap-2 text-sm">
                        <span className="min-w-0 flex-1 truncate text-[var(--text-muted)]">{data.games.find((g) => g.id === gid)?.name}</span>
                        <span className="tabular-nums text-[var(--text)]">
                          {r.a}–{r.b}
                        </span>
                      </div>
                    ))}
                </div>
              </>
            ) : (
              <p className="text-sm text-[var(--text-muted)]">{a === b ? "Pick two different players." : "They haven't faced each other yet."}</p>
            )}
          </Card>
        </Section>
      )}

      <Section title="Nickels & dimes" hint="Games you keep coming back to">
        <Card className="flex flex-col gap-3">
          {coins.filter((c, i) => c.list.length || i === 0).map((c) => (
            <div key={c.label} className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-muted)]">
                <Coins className="h-3.5 w-3.5" /> {c.label} <span className="font-normal">({c.hint})</span> · {c.list.length}
              </div>
              {c.list.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {c.list.map((x) => (
                    <span key={x.game?.id} className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] py-0.5 pl-0.5 pr-2 text-xs text-[var(--text)]">
                      <GameTile game={x.game} size={20} /> {x.game?.name} <span className="tabular-nums text-[var(--text-muted)]">{x.n}</span>
                    </span>
                  ))}
                </div>
              ) : (
                <span className="text-xs text-[var(--text-muted)]">None yet</span>
              )}
            </div>
          ))}
          {(() => {
            const next = coins.find((c, i) => i > 0 && !c.list.length);
            return next ? (
              <p className="text-xs text-[var(--text-muted)]">
                Next up: {next.label.toLowerCase()} at {next.hint.replace("+", "")} plays of a game.
              </p>
            ) : null;
          })()}
        </Card>
      </Section>

      <Section title="Most played">
        <List>
          {ov.mostPlayed.map((r) => (
            <ListRow
              key={r.game?.id}
              leading={<GameTile game={r.game} size={36} />}
              title={r.game?.name ?? "?"}
              subtitle={
                <span className="block h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]" aria-hidden>
                  <span className="block h-full rounded-full bg-[var(--item-accent-fill)]" style={{ width: `${Math.round((r.n / Math.max(1, ov.mostPlayed[0]?.n ?? 1)) * 100)}%` }} />
                </span>
              }
              trailing={<span className="inline-block w-9 text-right font-semibold tabular-nums text-[var(--text)]">{r.n}×</span>}
            />
          ))}
        </List>
      </Section>

      {ov.unplayed.length > 0 && (
        <Section title="Shelf of shame" hint="Owned, never played">
          <div className="flex flex-wrap gap-1.5">
            {ov.unplayed.slice(0, 20).map((g) => (
              <span key={g.id} className="rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-xs text-[var(--text)]">
                {g.name}
              </span>
            ))}
          </div>
        </Section>
      )}

      <ItemButton variant="secondary" icon={<Sparkles className="h-4 w-4 text-[var(--item-accent)]" />} onClick={() => ask("Review our last month of game nights — highlights, rivalries and what we should play next")}>
        Review our month with AI
      </ItemButton>
    </>
  );

  return (
    <Page wide={!isPhone}>
      <div ref={boxRef} className={cn("grid grid-cols-1 gap-5", twoCol && "grid-cols-2 gap-6")}>
        {twoCol ? (
          <>
            <div className="flex min-w-0 flex-col gap-5">{leftCol}</div>
            <div className="flex min-w-0 flex-col gap-5">{rightCol}</div>
          </>
        ) : (
          <div className="flex min-w-0 flex-col gap-5">
            {leftCol}
            {rightCol}
          </div>
        )}
      </div>
    </Page>
  );
}
