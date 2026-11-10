import { BookOpen, Check, ExternalLink, Library, Pencil, Play as PlayIcon, Plus, Search, Sparkles, Star, Trash2, Trophy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import type { ItemHandle } from "@/items/useItem";
import { Card, Chip, EmptyState, Fab, IconButton, ItemButton, List, ListRow, Page, ScrollRow, Section, Sheet, Stat, TextInput, fmtDay } from "@/items/ui";
import { TrendChart } from "@/items/ui/charts";
import { cn } from "@/utils/cn";

import { AskSheet, FavStar, GameTile, PlayerBadge, Tiles, fmtMinutes, fmtPct, fmtScore, gameMeta, shortDay, useWidth } from "./bits";
import { GameEditor } from "./GameEditor";
import { requestStart } from "./PlayTab";
import { gameStats } from "./stats";
import type { Data, Game } from "./types";
import { PAD_LABELS, WIN_LABELS } from "./types";
import { SkeletonRows } from "@/components/shared/Skeleton";

/* The Games tab: your library (with real scoring setups) and the built-in templates. */

interface TemplateRow {
  id: string;
  name: string;
  year: number;
  players: string;
  minutes: number;
  weight: number;
  tags: string[];
  bgg_id: number | null;
  win: keyof typeof WIN_LABELS;
  pad: keyof typeof PAD_LABELS;
  score_categories: string[];
  expansions: string[];
  in_library: boolean;
}

let templateCache: TemplateRow[] | null = null;

function useTemplates(item: ItemHandle<Data>, want: boolean) {
  const [rows, setRows] = useState<TemplateRow[] | null>(templateCache);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!want || templateCache) return;
    let alive = true;
    item
      .runAction<TemplateRow[]>("list_templates", { query: "" })
      .then((r) => {
        templateCache = r.result;
        if (alive) setRows(r.result);
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want]);
  return { rows, error };
}

export function GamesTab({ item, isPhone, ask, goTo }: ItemViewProps<Data>) {
  const [boxRef, width] = useWidth<HTMLDivElement>();
  // List + detail side by side only with room for both (the AI panel may be open).
  const split = !isPhone && width >= 820;
  const data = item.data;
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "fav" | "unplayed" | "wishlist">("all");
  const [sel, setSel] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [browsing, setBrowsing] = useState(false);

  const counts = useMemo(() => {
    const m = new Map<string, { n: number; last: string }>();
    for (const p of data.plays) {
      if (p.status !== "finished") continue;
      const r = m.get(p.game_id) ?? { n: 0, last: "" };
      r.n++;
      if (p.date > r.last) r.last = p.date;
      m.set(p.game_id, r);
    }
    return m;
  }, [data.plays]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.games
      .filter((g) => !needle || g.name.toLowerCase().includes(needle) || g.categories.some((c) => c.toLowerCase().includes(needle)))
      .filter((g) => (filter === "fav" ? g.favorite : filter === "unplayed" ? !counts.has(g.id) && g.owned : filter === "wishlist" ? !g.owned : true))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || (counts.get(b.id)?.n ?? 0) - (counts.get(a.id)?.n ?? 0) || a.name.localeCompare(b.name));
  }, [data.games, q, filter, counts]);

  const selected = data.games.find((g) => g.id === sel) ?? (split ? list[0] : undefined);
  const play = (g: Game) => {
    requestStart(item.fileId, g.id);
    goTo("play");
  };

  const detail = selected && (
    <GameDetail
      item={item}
      game={selected}
      onPlay={() => play(selected)}
      onEdit={() => setEditing({ id: selected.id })}
      ask={ask}
      onDeleted={() => setSel(null)}
    />
  );

  return (
    <Page wide={!isPhone}>
      <div ref={boxRef} className={cn("grid grid-cols-1 gap-5", split && "grid-cols-[minmax(0,360px)_minmax(0,1fr)]")}>
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
              <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search games" aria-label="Search games" className="pl-9" />
            </div>
            {item.canEdit && !isPhone && (
              <ItemButton icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ id: null })}>
                New
              </ItemButton>
            )}
          </div>
          <ScrollRow>
            {(
              [
                ["all", `All ${data.games.length}`],
                ["fav", "Favourites"],
                ["unplayed", "Unplayed"],
                ["wishlist", "Wishlist"],
              ] as const
            ).map(([v, l]) => (
              <Chip key={v} active={filter === v} onClick={() => setFilter(v)}>
                {l}
              </Chip>
            ))}
          </ScrollRow>
          {item.canEdit && (
            <Card onClick={() => setBrowsing(true)} className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] text-[var(--item-accent)]">
                <Library className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-[var(--text)]">Add from 30+ templates</span>
                <span className="block truncate text-xs text-[var(--text-muted)]">Official score sheets: Wingspan, Catan, Yahtzee…</span>
              </span>
            </Card>
          )}
          {data.games.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title="No games yet"
              text="Add from the templates, set one up yourself, or ask the assistant to build the score sheet for any game."
              action={
                item.canEdit && (
                  <ItemButton icon={<Sparkles className="h-4 w-4" />} onClick={() => ask("Help me set up the score sheet for a game that isn't in the templates — ask me which game.")}>
                    Ask the assistant
                  </ItemButton>
                )
              }
            />
          ) : list.length === 0 ? (
            <p className="px-1 text-sm text-[var(--text-muted)]">No games match.</p>
          ) : (
            <List>
              {list.map((g) => (
                <ListRow
                  key={g.id}
                  selected={split && selected?.id === g.id}
                  onClick={() => setSel(g.id)}
                  leading={<GameTile game={g} size={40} />}
                  title={
                    <span className="flex items-center gap-1">
                      <span className="truncate">{g.name}</span>
                      <FavStar on={g.favorite} />
                    </span>
                  }
                  subtitle={`${gameMeta(g)}${g.owned ? "" : " · wishlist"}`}
                  trailing={counts.get(g.id) ? <span className="tabular-nums">{counts.get(g.id)!.n}×</span> : null}
                />
              ))}
            </List>
          )}
        </div>
        {split && <div className="min-w-0">{detail ?? <EmptyState icon={BookOpen} title="Pick a game" />}</div>}
      </div>

      {!split && (
        <Sheet open={!!sel && !!selected} onClose={() => setSel(null)} title={selected?.name} size="lg">
          {detail}
        </Sheet>
      )}
      {isPhone && item.canEdit && !sel && <Fab label="New game" icon={Plus} onClick={() => setEditing({ id: null })} />}

      <GameEditor open={!!editing} onClose={() => setEditing(null)} item={item} gameId={editing?.id ?? null} ask={ask} onSaved={(id) => setSel(id)} />
      <TemplatesSheet open={browsing} onClose={() => setBrowsing(false)} item={item} onAdded={(id) => setSel(id)} />
    </Page>
  );
}

function GameDetail({ item, game, onPlay, onEdit, ask, onDeleted }: { item: ItemHandle<Data>; game: Game; onPlay: () => void; onEdit: () => void; ask: (p: string) => void; onDeleted: () => void }) {
  const st = useMemo(() => gameStats(item.data, game.id), [item.data, game.id]);
  const [rules, setRules] = useState(false);
  const players = new Map(item.data.players.map((p) => [p.id, p]));
  const sc = game.scoring;
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const toggleFav = () => {
    const fav = !game.favorite; // the target, decided from what's on screen
    item.update((d) => {
      const g = d.games.find((x) => x.id === game.id);
      if (g) g.favorite = fav;
    });
  };
  const remove = () => {
    const n = item.data.plays.filter((p) => p.game_id === game.id).length;
    if (!window.confirm(n ? `Delete ${game.name} and its ${n} logged plays?` : `Delete ${game.name}?`)) return;
    item.update((d) => {
      d.plays = d.plays.filter((p) => p.game_id !== game.id);
      d.games = d.games.filter((g) => g.id !== game.id);
    });
    onDeleted();
  };
  return (
    <div ref={boxRef} className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <GameTile game={game} size={64} />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold text-[var(--text)]">
            {game.name} {game.year ? <span className="text-sm font-normal text-[var(--text-muted)]">({game.year})</span> : null}
          </h2>
          <p className="text-sm text-[var(--text-muted)]">{gameMeta(game)}</p>
          {game.categories.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {game.categories.map((c) => (
                <span key={c} className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]">
                  {c}
                </span>
              ))}
            </div>
          )}
        </div>
        {item.canEdit && (
          <div className="flex">
            <IconButton label={game.favorite ? "Unfavourite" : "Favourite"} icon={Star} active={game.favorite} onClick={toggleFav} />
            <IconButton label="Edit game" icon={Pencil} onClick={onEdit} />
            <IconButton label="Delete game" icon={Trash2} onClick={remove} />
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {item.canEdit && (
          <ItemButton variant="primary" icon={<PlayIcon className="h-4 w-4" />} onClick={onPlay}>
            Play {game.name}
          </ItemButton>
        )}
        <ItemButton icon={<Sparkles className="h-4 w-4 text-[var(--item-accent)]" />} onClick={() => setRules(true)}>
          Rules question
        </ItemButton>
        {game.bgg_id && (
          <a
            href={`https://boardgamegeek.com/boardgame/${game.bgg_id}`}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-[var(--text-muted)] hover:bg-[var(--hover)] md:h-10"
          >
            BGG <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>

      <Card className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-[var(--text)]">Scoring</h3>
        <p className="text-sm text-[var(--text)]">
          {WIN_LABELS[sc.win]} · {PAD_LABELS[sc.pad].toLowerCase()}
          {sc.rounds ? ` · ${sc.rounds} rounds` : ""}
          {sc.target_score !== null ? ` · first to ${sc.target_score}` : ""}
        </p>
        {sc.categories.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {sc.categories.map((c) => (
              <span key={c.id} title={c.hint || undefined} className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs text-[var(--text)]">
                {c.name}
                {c.multiplier !== 1 && <span className="text-[var(--text-muted)]"> ×{c.multiplier}</span>}
                {c.subtract && <span className="text-[var(--danger)]"> −</span>}
              </span>
            ))}
          </div>
        )}
        {sc.bonuses.map((b) => (
          <p key={b.id} className="text-xs text-[var(--text-muted)]">
            {b.name}: +{b.points} at {b.threshold}+
          </p>
        ))}
        {sc.tiebreaker && (
          <p className="text-xs text-[var(--text-muted)]">
            <span className="font-semibold text-[var(--text)]">Tiebreaker:</span> {sc.tiebreaker}
          </p>
        )}
        {sc.notes && <p className="text-xs text-[var(--text-muted)]">{sc.notes}</p>}
        {game.expansions.length > 0 && <p className="text-xs text-[var(--text-muted)]">Expansions: {game.expansions.map((e) => e.name).join(", ")}</p>}
        {sc.factions.length > 0 && <p className="text-xs text-[var(--text-muted)]">Factions: {sc.factions.join(", ")}</p>}
      </Card>

      {st.plays === 0 ? (
        <p className="px-1 text-sm text-[var(--text-muted)]">Not played yet — the stats appear after the first game.</p>
      ) : (
        <>
          {/* Score tiles only for games that keep score (not Codenames / Pandemic). */}
          <Tiles width={width}>
            <Stat label="Plays" value={st.plays} delta={st.last ? `last ${fmtDay(st.last)}` : undefined} />
            {st.coop ? (
              <Stat label="Table win rate" value={fmtPct(st.coop.wins / Math.max(1, st.coop.plays))} delta={`${st.coop.wins} of ${st.coop.plays}`} tone="accent" />
            ) : st.high ? (
              <Stat label="High score" value={fmtScore(st.high.score)} delta={players.get(st.high.pid)?.name} tone="accent" />
            ) : null}
            {st.avgWinning !== null && (
              <Stat label="Avg winner" value={fmtScore(Math.round(st.avgWinning * 10) / 10)} delta={st.avg !== null ? `table avg ${fmtScore(Math.round(st.avg * 10) / 10)}` : undefined} />
            )}
            <Stat label="Avg length" value={st.avgMinutes ? fmtMinutes(Math.round(st.avgMinutes)) : "–"} />
          </Tiles>
          {st.over.length > 1 && (
            <Section title="Scores over time" hint="Winning score (line) and table average (dashed)">
              <Card>
                <TrendChart data={st.over.map((o) => ({ x: shortDay(o.date), y: o.winning, y2: Math.round(o.avg * 10) / 10 }))} area={false} />
              </Card>
            </Section>
          )}
          {st.leaderboard.length > 0 && (
            <Section title="Leaderboard" hint={st.best ? `Best: ${st.best.player?.name} (${fmtPct(st.best.rate)} of ${st.best.plays})` : "Elo for this game"}>
              <List>
                {st.leaderboard.slice(0, 8).map((r, i) => (
                  <ListRow
                    key={r.player?.id ?? i}
                    leading={
                      <span className="flex items-center gap-2">
                        <span className="w-4 text-right text-xs font-bold tabular-nums text-[var(--text-muted)]">{i + 1}</span>
                        <PlayerBadge player={r.player} size={30} crown={i === 0} />
                      </span>
                    }
                    title={r.player?.name ?? "?"}
                    subtitle={`${r.wins} wins in ${r.plays}`}
                    trailing={<span className="font-semibold tabular-nums text-[var(--text)]">{r.elo}</span>}
                  />
                ))}
              </List>
            </Section>
          )}
          {st.categoryAvg.length > 0 && (
            <Section title="Where the points come from" hint="Average per player">
              <Card className="flex flex-col gap-2">
                {(() => {
                  const max = Math.max(...st.categoryAvg.map((c) => Math.abs(c.avg)), 1);
                  return st.categoryAvg.map((c) => (
                    <div key={c.name} className="flex items-center gap-2 text-sm">
                      <span className="w-32 shrink-0 truncate text-[var(--text-muted)]">{c.name}</span>
                      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
                        <div className="h-full rounded-full" style={{ width: `${(Math.abs(c.avg) / max) * 100}%`, background: c.avg < 0 ? "var(--danger)" : "var(--item-accent)" }} />
                      </div>
                      <span className="w-10 text-right font-semibold tabular-nums text-[var(--text)]">{fmtScore(Math.round(c.avg * 10) / 10)}</span>
                    </div>
                  ));
                })()}
              </Card>
            </Section>
          )}
          {st.seatWins.length > 1 && (
            <Section title="Seat advantage" hint="Win rate by seat (1 = first player)">
              <div className="flex flex-wrap gap-2">
                {st.seatWins.map((s) => (
                  <div key={s.seat} className="flex min-w-[64px] flex-col items-center rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
                    <span className="text-[11px] text-[var(--text-muted)]">Seat {s.seat}</span>
                    <span className="text-base font-semibold tabular-nums text-[var(--text)]">{fmtPct(s.wins / Math.max(1, s.plays))}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </>
      )}
      {game.notes && <p className="whitespace-pre-wrap text-sm text-[var(--text-muted)]">{game.notes}</p>}
      <AskSheet
        open={rules}
        onClose={() => setRules(false)}
        ask={ask}
        title={`${game.name} rules`}
        prefix={`Rules question about ${game.name}: `}
        placeholder="Ask anything about the rules or scoring"
        examples={["Explain how scoring works", "Any common rules mistakes?", "Best strategy tips for a first game"]}
      />
    </div>
  );
}

function TemplatesSheet({ open, onClose, item, onAdded }: { open: boolean; onClose: () => void; item: ItemHandle<Data>; onAdded: (id: string) => void }) {
  const { rows, error } = useTemplates(item, open);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const have = new Set(item.data.games.map((g) => g.template_id).filter(Boolean));
  const list = (rows ?? []).filter((t) => !q.trim() || t.name.toLowerCase().includes(q.trim().toLowerCase()) || t.tags.some((x) => x.toLowerCase().includes(q.trim().toLowerCase())));
  const real = list.filter((t) => !t.id.startsWith("generic"));
  const generic = list.filter((t) => t.id.startsWith("generic"));
  const add = async (t: TemplateRow) => {
    const generic = t.id.startsWith("generic");
    const name = generic ? window.prompt("What's the game called?")?.trim().slice(0, 100) : null;
    if (generic && !name) return;
    setBusy(t.id);
    try {
      const r = await item.runAction<{ added: { game_id: string }[] }>("add_from_template", { templates: [t.id] });
      const { toast } = await import("@/store/toastStore");
      const added = r.result.added[0];
      if (added && name) {
        item.update((d) => {
          const g = d.games.find((x) => x.id === added.game_id);
          if (g) g.name = name;
        });
      }
      toast.success(name ? `Added ${name}` : r.summary);
      if (added) onAdded(added.game_id);
    } catch {
      const { toast } = await import("@/store/toastStore");
      toast.error("Couldn't add that game.");
    } finally {
      setBusy(null);
    }
  };
  const row = (t: TemplateRow) => {
    const inLib = have.has(t.id) && !t.id.startsWith("generic");
    return (
      <div key={t.id} className="flex items-center gap-3 px-3 py-2.5">
        <GameTile game={t} size={40} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-[var(--text)]">
            {t.name} {!t.id.startsWith("generic") && <span className="text-xs font-normal text-[var(--text-muted)]">({t.year})</span>}
          </div>
          <div className="truncate text-xs text-[var(--text-muted)]">
            {t.id.startsWith("generic") ? WIN_LABELS[t.win] + " · " + PAD_LABELS[t.pad].toLowerCase() : `${t.players} · ${t.minutes} min · ${t.score_categories.length ? t.score_categories.join(", ") : WIN_LABELS[t.win]}`}
          </div>
        </div>
        {inLib ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--success)]">
            <Check className="h-3.5 w-3.5" /> Added
          </span>
        ) : (
          <ItemButton size="sm" onClick={() => void add(t)} disabled={busy === t.id || !item.canEdit} aria-label={`Add ${t.name}`}>
            {busy === t.id ? "Adding…" : "Add"}
          </ItemButton>
        )}
      </div>
    );
  };
  return (
    <Sheet open={open} onClose={onClose} title="Game templates" size="lg">
      <div className="flex flex-col gap-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
          <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates" aria-label="Search templates" className="pl-9" />
        </div>
        {error && <p className="text-sm text-[var(--danger)]">Couldn't load the templates — check your connection.</p>}
        {!rows && !error && <SkeletonRows count={3} label="Loading" />}
        {real.length > 0 && <div className="divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">{real.map(row)}</div>}
        {generic.length > 0 && (
          <>
            <h3 className="px-1 pt-2 text-xs font-semibold text-[var(--text-muted)]">Generic sheets (for anything else)</h3>
            <div className="divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">{generic.map(row)}</div>
          </>
        )}
        <p className="flex items-center gap-1.5 px-1 text-xs text-[var(--text-muted)]">
          <Trophy className="h-3.5 w-3.5" /> Not here? Ask the assistant — it can set up the scoring for any game and check the rulebook.
        </p>
      </div>
    </Sheet>
  );
}
