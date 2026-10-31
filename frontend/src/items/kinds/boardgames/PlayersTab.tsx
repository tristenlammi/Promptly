import { Archive, Check, Flame, GitMerge, Pencil, Plus, Star, Trash2, Trophy, UserRound, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ItemViewProps } from "@/items/types";
import type { ItemHandle } from "@/items/useItem";
import { Card, Chip, EmptyState, Fab, Field, IconButton, ItemButton, List, ListRow, Page, Section, Select, Sheet, Stat, TextInput, Toggle, fmtDay, todayISO, uid } from "@/items/ui";
import { TrendChart } from "@/items/ui/charts";
import { cn } from "@/utils/cn";

import { FavStar, GameTile, PlayerBadge, Tiles, fmtPct, fmtScore, ordinal, shortDay, useWidth } from "./bits";
import { leaderboard, playerStats } from "./stats";
import type { Data, Player } from "./types";
import { PALETTE } from "./types";

/* Players: the people at your table, their records and rivalries. */

export function PlayersTab({ item, isPhone, ask }: ItemViewProps<Data>) {
  const data = item.data;
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const split = !isPhone && width >= 820;
  const elo = useMemo(() => new Map(leaderboard(data).map((r) => [r.player.id, r.elo])), [data]);
  const [showArchived, setShowArchived] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);

  const counts = useMemo(() => {
    const m = new Map<string, { plays: number; wins: number }>();
    for (const p of data.plays) {
      if (p.status !== "finished") continue;
      for (const s of p.seats) {
        const r = m.get(s.player_id) ?? { plays: 0, wins: 0 };
        r.plays++;
        if (s.winner) r.wins++;
        m.set(s.player_id, r);
      }
    }
    return m;
  }, [data.plays]);

  const list = data.players
    .filter((p) => showArchived || !p.archived)
    .sort((a, b) => Number(b.me) - Number(a.me) || Number(b.favorite) - Number(a.favorite) || (counts.get(b.id)?.plays ?? 0) - (counts.get(a.id)?.plays ?? 0) || a.name.localeCompare(b.name));
  const selected = data.players.find((p) => p.id === sel) ?? (split ? list[0] : undefined);
  const archivedCount = data.players.filter((p) => p.archived).length;

  const detail = selected && <PlayerDetail item={item} player={selected} onEdit={() => setEditing({ id: selected.id })} ask={ask} onGone={() => setSel(null)} />;

  return (
    <Page wide={!isPhone}>
      <div ref={boxRef} className={cn("grid grid-cols-1 gap-5", split && "grid-cols-[minmax(0,340px)_minmax(0,1fr)]")}>
        <div className="flex min-w-0 flex-col gap-3">
          <Section
            title={`${list.length} player${list.length === 1 ? "" : "s"}`}
            action={
              item.canEdit && !isPhone ? (
                <ItemButton size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ id: null })}>
                  Player
                </ItemButton>
              ) : undefined
            }
          >
            {data.players.length === 0 ? (
              <EmptyState
                icon={Users}
                title="Who's at your table?"
                text="Add yourself and the friends you play with. New names you type when starting a game are added too."
                action={
                  item.canEdit && (
                    <ItemButton variant="primary" onClick={() => setEditing({ id: null })}>
                      Add a player
                    </ItemButton>
                  )
                }
              />
            ) : (
              <List>
                {list.map((p) => {
                  const c = counts.get(p.id);
                  return (
                    <ListRow
                      key={p.id}
                      selected={split && selected?.id === p.id}
                      onClick={() => setSel(p.id)}
                      leading={<PlayerBadge player={p} size={36} />}
                      title={
                        <span className="flex items-center gap-1">
                          <span className="truncate">{p.name}</span>
                          {p.me && <span className="rounded-full bg-[var(--surface-2)] px-1.5 text-[10px] font-semibold text-[var(--text-muted)]">ME</span>}
                          <FavStar on={p.favorite} />
                          {p.archived && <Archive className="h-3.5 w-3.5 text-[var(--text-muted)]" aria-label="Archived" />}
                        </span>
                      }
                      subtitle={c ? `${c.plays} plays · ${c.wins} wins` : "No plays yet"}
                      trailing={
                        c && c.plays > 0 ? (
                          <span className="flex flex-col items-end leading-tight">
                            <span className="text-sm font-semibold tabular-nums text-[var(--text)]">{fmtPct(c.wins / c.plays)}</span>
                            {elo.has(p.id) && <span className="text-[11px] tabular-nums text-[var(--text-muted)]">Elo {elo.get(p.id)}</span>}
                          </span>
                        ) : undefined
                      }
                    />
                  );
                })}
              </List>
            )}
          </Section>
          {archivedCount > 0 && (
            <Chip active={showArchived} onClick={() => setShowArchived((v) => !v)} className="self-start">
              {showArchived ? "Hide" : "Show"} {archivedCount} archived
            </Chip>
          )}
        </div>
        {split && <div className="min-w-0">{detail ?? <EmptyState icon={UserRound} title="Pick a player" />}</div>}
      </div>
      {!split && (
        <Sheet open={!!sel && !!selected} onClose={() => setSel(null)} title={selected?.name} size="lg">
          {detail}
        </Sheet>
      )}
      {isPhone && item.canEdit && !sel && <Fab label="Player" icon={Plus} onClick={() => setEditing({ id: null })} />}
      <PlayerEditor open={!!editing} onClose={() => setEditing(null)} item={item} playerId={editing?.id ?? null} onSaved={(id) => setSel(id)} />
    </Page>
  );
}

function PlayerDetail({ item, player, onEdit, ask, onGone }: { item: ItemHandle<Data>; player: Player; onEdit: () => void; ask: (p: string) => void; onGone: () => void }) {
  const data = item.data;
  const st = useMemo(() => playerStats(data, player.id), [data, player.id]);
  const [merging, setMerging] = useState(false);
  const pmap = new Map(data.players.map((p) => [p.id, p]));
  const games = new Map(data.games.map((g) => [g.id, g]));
  const hasPlays = st.plays > 0;
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const remove = () => {
    if (!window.confirm(`Remove ${player.name}?`)) return;
    item.update((d) => {
      d.players = d.players.filter((p) => p.id !== player.id);
      if (d.settings.me_player_id === player.id) d.settings.me_player_id = null;
    });
    onGone();
  };
  return (
    <div ref={boxRef} className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <PlayerBadge player={player} size={64} />
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 text-lg font-bold text-[var(--text)]">
            {player.name} <FavStar on={player.favorite} className="h-4 w-4" />
          </h2>
          <p className="text-sm text-[var(--text-muted)]">
            {player.me ? "That's you · " : ""}
            {st.lastPlayed ? `last played ${fmtDay(st.lastPlayed)}` : "no plays yet"}
          </p>
        </div>
        {item.canEdit && (
          <div className="flex">
            <IconButton label="Edit player" icon={Pencil} onClick={onEdit} />
            {hasPlays ? (
              <IconButton label="Merge into another player" icon={GitMerge} onClick={() => setMerging(true)} />
            ) : (
              <IconButton label="Remove player" icon={Trash2} onClick={remove} />
            )}
          </div>
        )}
      </div>

      {!hasPlays ? (
        <p className="text-sm text-[var(--text-muted)]">Their record starts with the first game.</p>
      ) : (
        <>
          <Tiles width={width}>
            <Stat label="Win rate" value={fmtPct(st.winRate)} delta={`${st.wins} of ${st.competitive} competitive`} tone="accent" icon={Trophy} />
            <Stat label="Elo" value={st.elo} delta="overall rating" />
            <Stat label="Avg placement" value={st.avgPlace !== null ? st.avgPlace.toFixed(2) : "–"} delta={`${st.plays} plays`} />
            <Stat label="Win streak" value={st.streak.curWin} delta={`best ${st.streak.longest}`} icon={Flame} />
          </Tiles>
          {st.coop.plays > 0 && (
            <p className="text-sm text-[var(--text-muted)]">
              Co-op: {st.coop.wins} wins in {st.coop.plays} ({fmtPct(st.coop.wins / st.coop.plays)})
            </p>
          )}
          {st.eloHistory.length > 1 && (
            <Section title="Rating over time">
              <Card>
                <TrendChart data={st.eloHistory.map((h) => ({ x: shortDay(h.date), y: h.elo }))} />
              </Card>
            </Section>
          )}
          <Section title="By game">
            <List>
              {st.games.slice(0, 15).map((r) => (
                <ListRow
                  key={r.gameId}
                  leading={<GameTile game={r.game} size={36} />}
                  title={r.game?.name ?? "?"}
                  subtitle={`${r.wins}/${r.plays} wins${r.avgPlace ? ` · avg ${r.avgPlace.toFixed(1)}` : ""}${r.best !== null ? ` · best ${fmtScore(r.best)}` : ""}`}
                  trailing={r.elo !== null ? <span className="tabular-nums">{r.elo}</span> : null}
                />
              ))}
            </List>
          </Section>
          {st.h2h.length > 0 && (
            <Section title="Rivals" hint="Head-to-head finishing record">
              <List>
                {st.h2h.slice(0, 10).map(([pid, r]) => (
                  <ListRow
                    key={pid}
                    leading={<PlayerBadge player={pmap.get(pid)} size={32} />}
                    title={pmap.get(pid)?.name ?? "?"}
                    subtitle={`${r.played} games${r.ties ? ` · ${r.ties} tied` : ""}`}
                    trailing={
                      <span className={cn("font-semibold tabular-nums", r.wins > r.losses ? "text-[var(--success)]" : r.wins < r.losses ? "text-[var(--danger)]" : "text-[var(--text)]")}>
                        {r.wins}–{r.losses}
                      </span>
                    }
                  />
                ))}
              </List>
            </Section>
          )}
          <Section title="Recent">
            <div className="flex flex-wrap gap-1.5">
              {st.recent.map((r) => (
                <span
                  key={r.play.id}
                  title={`${games.get(r.play.game_id)?.name} · ${r.play.date}`}
                  className={cn("inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs", r.won ? "bg-[color-mix(in_srgb,var(--item-accent)_16%,transparent)] text-[var(--text)]" : "bg-[var(--surface-2)] text-[var(--text-muted)]")}
                >
                  {r.won ? <Trophy className="h-3 w-3" /> : null}
                  {games.get(r.play.game_id)?.name}
                  {r.place && !r.won ? ` · ${ordinal(r.place)}` : ""}
                </span>
              ))}
            </div>
          </Section>
          <ItemButton variant="ghost" onClick={() => ask(`How is ${player.name} doing lately? Strengths, rivals and a game they'd crush.`)}>
            Ask for a scouting report
          </ItemButton>
        </>
      )}
      <MergeSheet open={merging} onClose={() => setMerging(false)} item={item} from={player} onMerged={onGone} />
    </div>
  );
}

function MergeSheet({ open, onClose, item, from, onMerged }: { open: boolean; onClose: () => void; item: ItemHandle<Data>; from: Player; onMerged: () => void }) {
  const [into, setInto] = useState("");
  const others = item.data.players.filter((p) => p.id !== from.id);
  const clash = into ? item.data.plays.find((pl) => pl.seats.some((s) => s.player_id === from.id) && pl.seats.some((s) => s.player_id === into)) : undefined;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Merge ${from.name}`}
      size="sm"
      footer={
        <ItemButton
          variant="primary"
          block
          disabled={!into || !!clash}
          onClick={() => {
            item.update((d) => {
              for (const pl of d.plays) for (const s of pl.seats) if (s.player_id === from.id) s.player_id = into;
              const keep = d.players.find((p) => p.id === into);
              if (keep && (from.me || d.settings.me_player_id === from.id)) {
                keep.me = true;
                d.settings.me_player_id = into;
              }
              d.players = d.players.filter((p) => p.id !== from.id);
            });
            onClose();
            onMerged();
          }}
        >
          Merge
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-3 pb-2">
        <p className="text-sm text-[var(--text-muted)]">All of {from.name}'s plays move to the player you pick, and {from.name} is removed. Use this for duplicates (“Sam” and “Samuel”).</p>
        <Field label="Merge into">
          <Select value={into} onChange={(e) => setInto(e.target.value)}>
            <option value="">Choose…</option>
            {others.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        {clash && <p className="text-sm text-[var(--danger)]">They both played on {clash.date} — they're different people.</p>}
      </div>
    </Sheet>
  );
}

export function PlayerEditor({ open, onClose, item, playerId, onSaved }: { open: boolean; onClose: () => void; item: ItemHandle<Data>; playerId: string | null; onSaved?: (id: string) => void }) {
  const existing = playerId ? item.data.players.find((p) => p.id === playerId) : undefined;
  const [name, setName] = useState("");
  const [color, setColor] = useState(PALETTE[0]);
  const [fav, setFav] = useState(false);
  const [me, setMe] = useState(false);
  const [archived, setArchived] = useState(false);
  const opened = useRef<{ name: string; color: string; favorite: boolean; archived: boolean } | null>(null);
  useEffect(() => {
    if (!open) return;
    opened.current = existing ? { name: existing.name, color: existing.color, favorite: existing.favorite, archived: existing.archived } : null;
    const used = new Set(item.data.players.map((p) => p.color));
    setName(existing?.name ?? "");
    setColor(existing?.color ?? PALETTE.find((c) => !used.has(c)) ?? PALETTE[0]);
    setFav(existing?.favorite ?? false);
    setMe(existing?.me ?? (!item.data.settings.me_player_id && item.data.players.length === 0));
    setArchived(existing?.archived ?? false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, playerId]);
  const dupe = item.data.players.some((p) => p.id !== playerId && p.name.trim().toLowerCase() === name.trim().toLowerCase());
  const save = () => {
    const id = existing?.id ?? uid("p-");
    // Write back only what this sheet changed (another device may have
    // edited the player meanwhile).
    const was = opened.current;
    item.update((d) => {
      let p = d.players.find((x) => x.id === id);
      const fresh = !p;
      if (!p) {
        p = { id, name: "", color, favorite: false, archived: false, me: false, bgg_user: "", notes: "", created: todayISO() };
        d.players.push(p);
      }
      const nm = name.trim().slice(0, 60);
      if (fresh || !was || nm !== was.name) p.name = nm;
      if (fresh || !was || color !== was.color) p.color = color;
      if (fresh || !was || fav !== was.favorite) p.favorite = fav;
      if (fresh || !was || archived !== was.archived) p.archived = archived;
      if (me) {
        for (const o of d.players) o.me = o.id === id;
        d.settings.me_player_id = id;
      } else if (p.me || d.settings.me_player_id === id) {
        p.me = false;
        d.settings.me_player_id = null;
      }
    });
    onSaved?.(id);
    onClose();
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={existing ? `Edit ${existing.name}` : "New player"}
      size="sm"
      footer={
        <ItemButton variant="primary" block disabled={!name.trim() || dupe} onClick={save}>
          Save
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-4 pb-2">
        <div className="flex items-center gap-3">
          <PlayerBadge player={{ name: name || "?", color }} size={56} />
          <Field label="Name" className="flex-1">
            <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && !dupe && save()} />
          </Field>
        </div>
        {dupe && <p className="text-xs text-[var(--danger)]">There's already a player with that name.</p>}
        <Field label="Colour">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Colour">
            {PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={c}
                onClick={() => setColor(c)}
                className={cn("flex h-10 w-10 items-center justify-center rounded-full transition", color === c && "ring-2 ring-[var(--text)] ring-offset-2 ring-offset-[var(--bg)]")}
                style={{ background: c }}
              >
                {color === c && <Check className="h-4 w-4 text-white" />}
              </button>
            ))}
          </div>
        </Field>
        <label className="flex items-center justify-between text-sm text-[var(--text)]">
          <span className="flex items-center gap-2">
            <UserRound className="h-4 w-4 text-[var(--text-muted)]" /> This is me
          </span>
          <Toggle checked={me} onChange={setMe} label="This is me" />
        </label>
        <label className="flex items-center justify-between text-sm text-[var(--text)]">
          <span className="flex items-center gap-2">
            <Star className="h-4 w-4 text-[var(--text-muted)]" /> Favourite
          </span>
          <Toggle checked={fav} onChange={setFav} label="Favourite" />
        </label>
        {existing && (
          <label className="flex items-center justify-between text-sm text-[var(--text)]">
            <span className="flex items-center gap-2">
              <Archive className="h-4 w-4 text-[var(--text-muted)]" /> Archived (hidden from pickers; stats kept)
            </span>
            <Toggle checked={archived} onChange={setArchived} label="Archived" />
          </label>
        )}
      </div>
    </Sheet>
  );
}
