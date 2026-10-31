import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Flag,
  Grid3x3,
  Minus,
  MoreHorizontal,
  Pause,
  Play as PlayIcon,
  Plus,
  Sparkles,
  Timer,
  Trash2,
  Undo2,
  User,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ItemHandle } from "@/items/useItem";
import { Card, Chip, Field, IconButton, ItemButton, Segmented, Sheet, TextArea, TextInput, fmtDuration, nowISO } from "@/items/ui";
import { cn } from "@/utils/cn";

import { AskSheet, PlayerBadge, TeamBadge, fmtScore, ordinal, useLookups, useTick, useWidth } from "./bits";
import { NumPad, type PadChange } from "./NumPad";
import { bonusStates, categoryPoints, elapsedSeconds, entryTotal, orphanCategories, playCategories, scoresMatter, standings, usesTeams } from "./scoring";
import type { Data, Entry, Game, Play, ScoreCategory, Seat, Team } from "./types";
import { WIN_LABELS } from "./types";

/*
 * The live score pad — the heart of Game Night. Phone: one player (or one
 * round) at a time with big ± buttons and a number pad, totals always in
 * view, "Next player" to pass the phone. Desktop: the whole sheet as a wide
 * table you can type straight into.
 */

interface Row {
  key: string;
  name: string;
  color: string;
  isTeam: boolean;
  entry: Entry;
  seat?: Seat;
  team?: Team;
}

type Target =
  | { kind: "cat"; row: string; cat: string }
  | { kind: "round"; row: string; round: number }
  | { kind: "total"; row: string };

export function ScorePad({
  item,
  play,
  game,
  isPhone,
  onFinish,
  onBack,
  ask,
}: {
  item: ItemHandle<Data>;
  play: Play;
  game: Game | undefined;
  isPhone: boolean;
  onFinish: () => void;
  onBack: () => void;
  ask: (p: string, opts?: { send?: boolean }) => void;
}) {
  const { players } = useLookups(item.data);
  const teams = usesTeams(game, play);
  const cats = useMemo(() => playCategories(game, play), [game, play]);
  const pad = game?.scoring.pad ?? "total";
  const win = game?.scoring.win ?? "high";
  const showScores = !(win === "winlose" || win === "coop") || pad !== "total" || cats.length > 0;
  const readOnly = !item.canEdit;
  const [boxRef, width] = useWidth<HTMLDivElement>();
  const topRef = useRef<HTMLDivElement | null>(null);
  // The table + standings side panel need ~900px; with the AI panel open a
  // desktop tab has less, so it stacks (totals on top, table full width).
  const sidePanel = !isPhone && width >= 900;

  const rows: Row[] = useMemo(
    () =>
      teams
        ? play.teams.map((t) => ({ key: t.id, name: t.name, color: t.color, isTeam: true, entry: t, team: t }))
        : play.seats.map((s) => {
            const p = players.get(s.player_id);
            return { key: s.player_id, name: p?.name ?? "?", color: p?.color ?? "var(--text-muted)", isTeam: false, entry: s, seat: s };
          }),
    [teams, play, players],
  );
  const totals = useMemo(() => new Map(rows.map((r) => [r.key, entryTotal(game, r.entry, cats)])), [rows, game, cats]);
  const stand = useMemo(() => standings(game, play), [game, play]);
  const anyScore = [...totals.values()].some((v) => v !== 0);
  const leaders = new Set(anyScore && scoresMatter(game) && win !== "ranked" ? stand.filter((s) => s.place === 1).map((s) => s.key) : []);
  const leaderText = leaders.size ? `${rows.filter((r) => leaders.has(r.key)).map((r) => r.name).join(" & ")} ${leaders.size > 1 ? "tied" : "leading"} with ${fmtScore(totals.get([...leaders][0]))}` : "";
  const target = game?.scoring.target_score ?? null;
  const reached = target !== null ? rows.filter((r) => win !== "low" && (totals.get(r.key) ?? 0) >= target) : [];

  // ---- mutations (on the play inside the file)
  const mutate = (fn: (p: Play) => void) =>
    item.update((d) => {
      const p = d.plays.find((x) => x.id === play.id);
      if (p) fn(p);
    });
  const entryIn = (p: Play, key: string): Entry | undefined => (teams ? p.teams.find((t) => t.id === key) : p.seats.find((s) => s.player_id === key));
  const catOf = (t: Target): ScoreCategory | undefined => (t.kind === "cat" ? cats.find((c) => c.id === t.cat) : undefined);
  const clamp = (v: number, cat?: ScoreCategory): number => {
    let n = Math.round(v * 10000) / 10000;
    if (cat?.min !== null && cat?.min !== undefined) n = Math.max(cat.min, n);
    if (cat?.max !== null && cat?.max !== undefined) n = Math.min(cat.max, n);
    return n;
  };
  const valueOf = (t: Target): number | null => {
    const r = rows.find((x) => x.key === t.row);
    if (!r) return null;
    if (t.kind === "cat") return r.entry.scores[t.cat] ?? null;
    if (t.kind === "round") return r.entry.rounds[t.round] ?? null;
    return r.entry.total;
  };
  /** Set a box, or add to it. An add is worked out inside the mutator from
   *  the file as it is when the change lands (another phone may have added
   *  meanwhile), never from the number on this screen. */
  const apply = (t: Target, change: PadChange) => {
    if (change.mode === "add" && change.value === 0) return;
    const cat = catOf(t);
    // Say so when a value is outside the box's range (predicted from what's
    // on screen; the mutator clamps the real thing).
    if (change.value !== null) {
      const want = Math.round((change.mode === "add" ? (valueOf(t) ?? 0) + change.value : change.value) * 10000) / 10000;
      const got = clamp(want, cat);
      if (got !== want)
        void import("@/store/toastStore").then(({ toast }) =>
          toast.warning(`${cat?.name ?? "That box"} only goes from ${cat?.min ?? "–"} to ${cat?.max ?? "–"}, so it's ${fmtScore(got)} (not ${fmtScore(want)}).`),
        );
    }
    mutate((p) => {
      const e = entryIn(p, t.row);
      if (!e) return;
      const cur = t.kind === "cat" ? (e.scores[t.cat] ?? null) : t.kind === "round" ? (e.rounds[t.round] ?? null) : e.total;
      const v = change.value === null ? null : clamp(change.mode === "add" ? (cur ?? 0) + change.value : change.value, cat);
      if (t.kind === "cat") {
        if (v === null) delete e.scores[t.cat];
        else e.scores[t.cat] = v;
        e.total = null;
      } else if (t.kind === "round") {
        while (e.rounds.length <= t.round) e.rounds.push(null);
        e.rounds[t.round] = v;
        while (e.rounds.length && e.rounds[e.rounds.length - 1] === null) e.rounds.pop();
        e.total = null;
      } else e.total = v;
    });
  };
  const bump = (t: Target, by: number) => apply(t, { mode: "add", value: by });
  // Values typed for categories that were since removed from the sheet.
  const orphans = useMemo(() => orphanCategories(game, play), [game, play]);

  // ---- the pad's own position (kept in the file so another device resumes it)
  const round = play.round;
  // Whose sheet is showing is this device's business (it isn't saved, so it doesn't clutter Undo).
  const [focusState, setFocusState] = useState(play.focus);
  const focus = Math.min(focusState, Math.max(0, rows.length - 1));
  const setRound = (r: number) => mutate((p) => (p.round = Math.max(0, Math.min(99, r))));
  const setFocus = (i: number) => setFocusState(((i % rows.length) + rows.length) % rows.length);
  const maxRounds = Math.max(game?.scoring.rounds ?? 0, ...rows.map((r) => r.entry.rounds.length), round + 1);

  // ---- timer
  const running = !!play.timer_started_at;
  const now = useTick(running, 1000);
  const elapsed = elapsedSeconds(play, now);
  // The clock is read here, not in the mutator (it may be replayed later),
  // and the target (pause / run) is what this screen showed.
  const toggleTimer = () => {
    const pause = running;
    const at = Date.now();
    const iso = nowISO();
    mutate((p) => {
      if (pause && p.timer_started_at) {
        p.timer_elapsed_s = elapsedSeconds(p, at);
        p.timer_started_at = null;
      } else if (!pause && !p.timer_started_at) p.timer_started_at = iso;
    });
  };

  // ---- keep the screen awake at the table
  const wake = useRef<{ release: () => Promise<void> } | null>(null);
  useEffect(() => {
    if (!item.data.settings.keep_screen_on) return;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
    let cancelled = false;
    const get = () =>
      nav.wakeLock
        ?.request("screen")
        .then((l) => {
          if (cancelled) void l.release();
          else wake.current = l;
        })
        .catch(() => {});
    void get();
    const onVis = () => {
      if (!document.hidden) void get();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      void wake.current?.release().catch(() => {});
      wake.current = null;
    };
  }, [item.data.settings.keep_screen_on]);

  // ---- number pad
  const [numpad, setNumpad] = useState<Target | null>(null);
  const [view, setView] = useState<"player" | "grid">("player");
  const [menu, setMenu] = useState(false);
  const catById = useMemo(() => new Map(cats.map((c) => [c.id, c])), [cats]);
  const padTitle = (t: Target) => {
    const r = rows.find((x) => x.key === t.row);
    if (t.kind === "cat") return `${r?.name ?? ""} · ${catById.get(t.cat)?.name ?? ""}`;
    if (t.kind === "round") return `${r?.name ?? ""} · Round ${t.round + 1}`;
    return `${r?.name ?? ""} · Score`;
  };
  const nextTarget = (t: Target): Target | null => {
    const idx = rows.findIndex((r) => r.key === t.row);
    if (t.kind === "cat") {
      if (isPhone && view === "player") {
        const ci = cats.findIndex((c) => c.id === t.cat);
        if (ci < cats.length - 1) return { ...t, cat: cats[ci + 1].id };
        return null;
      }
      if (idx < rows.length - 1) return { ...t, row: rows[idx + 1].key };
      const ci = cats.findIndex((c) => c.id === t.cat);
      return ci < cats.length - 1 ? { kind: "cat", row: rows[0].key, cat: cats[ci + 1].id } : null;
    }
    if (idx < rows.length - 1) return { ...t, row: rows[idx + 1].key };
    return null;
  };
  const npNext = numpad ? nextTarget(numpad) : null;
  const npNextLabel = numpad && npNext ? (npNext.row !== numpad.row ? `Next: ${rows.find((r) => r.key === npNext.row)?.name}` : `Next: ${npNext.kind === "cat" ? catById.get(npNext.cat)?.name : ""}`) : undefined;

  const [notes, setNotes] = useState(false);
  const [rules, setRules] = useState(false);

  // ---- pieces
  const header = (
    <div className="flex items-center gap-2">
      <IconButton label="Back to Play" icon={ArrowLeft} onClick={onBack} />
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-semibold text-[var(--text)]">{game?.name ?? "Game"}</h1>
        <p className="truncate text-xs text-[var(--text-muted)]">
          {WIN_LABELS[win]}
          {target !== null && ` · first to ${target}`}
          {pad === "rounds" && ` · round ${round + 1}${game?.scoring.rounds ? ` of ${game.scoring.rounds}` : ""}`}
        </p>
      </div>
      <button
        type="button"
        onClick={toggleTimer}
        disabled={readOnly}
        aria-label={running ? "Pause the timer" : "Start the timer"}
        className={cn(
          "inline-flex h-10 items-center gap-1.5 rounded-xl border px-3 text-sm font-semibold tabular-nums",
          running ? "border-[var(--item-accent)] text-[var(--text)]" : "border-[var(--border)] text-[var(--text-muted)]",
        )}
      >
        {running ? <Pause className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
        <span role="timer">{fmtDuration(elapsed)}</span>
      </button>
      {!readOnly && <IconButton label="Undo" icon={Undo2} onClick={item.undo} disabled={!item.canUndo} />}
      {!readOnly && <IconButton label="More" icon={MoreHorizontal} onClick={() => setMenu(true)} />}
    </div>
  );

  const placeOf = new Map(stand.map((s) => [s.key, s.place]));
  const ranked = anyScore && scoresMatter(game) && win !== "ranked";
  const totalsStrip = (
    <div
      className={cn(rows.length <= 5 ? "grid gap-2" : "-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]")}
      style={rows.length <= 5 ? { gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` } : undefined}
    >
      {/* Seat order, so a tile never jumps while you're tapping it; the
          place shows on the tile instead. */}
      {rows.map((r, i) => {
        const lead = leaders.has(r.key);
        const sel = pad === "categories" && isPhone && view === "player" && i === focus;
        const place = ranked ? placeOf.get(r.key) : undefined;
        return (
          <button
            key={r.key}
            type="button"
            onClick={() => (pad === "categories" && isPhone ? (setView("player"), setFocus(i)) : undefined)}
            aria-pressed={pad === "categories" && isPhone ? sel : undefined}
            aria-label={`${r.name}: ${fmtScore(totals.get(r.key))}${place ? `, ${ordinal(place)}` : ""}`}
            className={cn(
              "relative flex min-w-0 flex-col items-center gap-1 rounded-2xl border px-1.5 pb-2 pt-2.5 transition",
              rows.length > 5 && "w-[76px] shrink-0",
              lead ? "border-[var(--item-accent)] bg-[color-mix(in_srgb,var(--item-accent)_12%,var(--surface))]" : "border-[var(--border)] bg-[var(--surface)]",
              sel && "ring-2 ring-[var(--item-accent)] ring-offset-2 ring-offset-[var(--bg)]",
            )}
          >
            {place !== undefined && place !== null && (
              <span className={cn("absolute left-1.5 top-1 text-[10px] font-bold tabular-nums", lead ? "text-[var(--item-accent)]" : "text-[var(--text-muted)]")}>{ordinal(place)}</span>
            )}
            {r.isTeam ? <TeamBadge team={r} size={28} /> : <PlayerBadge player={r} size={28} crown={lead} />}
            <span className="w-full truncate text-center text-[11px] font-medium text-[var(--text-muted)]">{r.name}</span>
            {showScores && <span className="text-xl font-bold leading-none tabular-nums text-[var(--text)]">{fmtScore(totals.get(r.key))}</span>}
          </button>
        );
      })}
    </div>
  );

  const banner = (
    <>
      <p aria-live="polite" className="sr-only">
        {leaderText}
      </p>
      {orphans.length > 0 && (
        <p className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--text-muted)]">
          Some scores were typed into {orphans.length === 1 ? "a category" : `${orphans.length} categories`} no longer on this game's sheet (removed, or an expansion switched off) — they don't count.
        </p>
      )}
      {reached.length > 0 && (
        <div className="flex items-center gap-2 rounded-2xl border border-[var(--warning-border)] bg-[var(--warning-bg)] px-3 py-2 text-sm text-[var(--text)]">
          <Flag className="h-4 w-4 shrink-0 text-[var(--warning)]" />
          <span className="min-w-0 flex-1">
            {reached.map((r) => r.name).join(" & ")} reached {target} — that ends the game.
          </span>
          {!readOnly && (
            <ItemButton size="sm" variant="primary" onClick={onFinish}>
              Finish
            </ItemButton>
          )}
        </div>
      )}
    </>
  );

  // A big −/value/+ control.
  const bigControl = ({ t, cat, label, sub }: { t: Target; cat?: ScoreCategory; label: string; sub?: string }) => {
    const v = valueOf(t);
    const step = cat?.step || 1;
    return (
      <div className="flex items-center gap-2 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-[var(--text)]">{label}</div>
          {sub && <div className="line-clamp-2 text-xs text-[var(--text-muted)]">{sub}</div>}
        </div>
        {!readOnly && (
          <button
            type="button"
            aria-label={`Minus ${step}`}
            onClick={() => bump(t, -step)}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] active:scale-95 active:bg-[var(--hover-strong)]"
          >
            <Minus className="h-5 w-5" />
          </button>
        )}
        <button
          type="button"
          disabled={readOnly}
          onClick={() => setNumpad(t)}
          aria-label={`${label}: ${v ?? "empty"}. Tap to type`}
          className={cn(
            "flex h-12 w-[72px] shrink-0 items-center justify-center rounded-2xl px-1 text-2xl font-bold tabular-nums",
            v === null ? "border border-dashed border-[var(--border)] text-[var(--text-muted)]" : "bg-[var(--surface-2)] text-[var(--text)]",
          )}
        >
          {v === null ? "–" : fmtScore(v)}
        </button>
        {!readOnly && (
          <button
            type="button"
            aria-label={`Plus ${step}`}
            onClick={() => bump(t, step)}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[var(--item-accent)] text-white shadow-[var(--shadow-sm)] active:scale-95"
          >
            <Plus className="h-5 w-5" />
          </button>
        )}
      </div>
    );
  };

  const catSub = (c: ScoreCategory, v: number | null, scores: Record<string, number>) => {
    const bits: string[] = [];
    if (c.hint) bits.push(c.hint);
    if (c.requires && v !== null && !scores[c.requires]) bits.push(`doesn't count until ${catById.get(c.requires)?.name ?? 'its box'} scores`);
    else if ((c.multiplier !== 1 || c.subtract) && v !== null) bits.push(`= ${fmtScore(categoryPoints(c, v, scores))} pts`);
    return bits.join(" · ");
  };

  // ---- phone: one player's categories
  const playerCats = () => {
    const r = rows[focus];
    if (!r) return null;
    const bonus = bonusStates(game, r.entry, cats);
    let lastSection = "";
    return (
      <Card padded={false} className="px-3 py-1">
        <div className="flex items-center gap-2 border-b border-[var(--border)] py-2">
          {r.isTeam ? <TeamBadge team={r} size={32} /> : <PlayerBadge player={r} size={32} crown={leaders.has(r.key)} />}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-[var(--text)]">{r.name}</div>
            <div className="truncate text-xs text-[var(--text-muted)]">
              {[r.seat?.faction, `${cats.filter((c) => r.entry.scores[c.id] !== undefined).length} of ${cats.length} scored`].filter(Boolean).join(" · ")}
            </div>
          </div>
          <span className="text-2xl font-bold tabular-nums text-[var(--item-accent)]">{fmtScore(totals.get(r.key))}</span>
        </div>
        <div className="divide-y divide-[var(--border)]">
          {cats.map((c) => {
            const head = c.section && c.section !== lastSection ? c.section : "";
            lastSection = c.section || lastSection;
            const t: Target = { kind: "cat", row: r.key, cat: c.id };
            return (
              <div key={c.id}>
                {head && <div className="pt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{head}</div>}
                {bigControl({ t, cat: c, label: c.name + (c.multiplier !== 1 ? ` ×${c.multiplier}` : "") + (c.subtract ? " (−)" : ""), sub: catSub(c, r.entry.scores[c.id] ?? null, r.entry.scores) })}
              </div>
            );
          })}
        </div>
        {bonus.map((b) => (
          <div key={b.id} className="flex items-center justify-between border-t border-[var(--border)] py-2.5 text-sm">
            <span className="text-[var(--text-muted)]">
              {b.name} <span className="tabular-nums">({fmtScore(b.progress)}/{fmtScore(b.threshold)})</span>
            </span>
            <span className={cn("font-semibold tabular-nums", b.earned ? "text-[var(--success)]" : "text-[var(--text-muted)]")}>{b.earned ? `+${b.points}` : `${fmtScore(b.threshold - b.progress)} to go`}</span>
          </div>
        ))}
      </Card>
    );
  };

  // ---- the grid (desktop table; phone "grid" view)
  const cellInput = (t: Target) => {
    const v = valueOf(t);
    if (isPhone)
      return (
        <button
          type="button"
          disabled={readOnly}
          onClick={() => setNumpad(t)}
          className={cn("h-10 w-full min-w-[52px] rounded-lg text-base font-semibold tabular-nums", v === null ? "text-[var(--text-muted)]" : "bg-[var(--surface-2)] text-[var(--text)]")}
        >
          {v === null ? "–" : fmtScore(v)}
        </button>
      );
    return (
      <GridInput
        value={v}
        disabled={readOnly}
        label={padTitle(t)}
        onCommit={(c) => apply(t, c)}
        onOpenPad={() => setNumpad(t)}
      />
    );
  };

  const grid = () => {
    const lines: { key: string; label: React.ReactNode; target: (r: Row) => Target; cat?: ScoreCategory; section?: string }[] = [];
    if (pad === "categories" || cats.length)
      for (const c of cats) lines.push({ key: c.id, label: c.name + (c.multiplier !== 1 ? ` ×${c.multiplier}` : "") + (c.subtract ? " (−)" : ""), cat: c, section: c.section, target: (r) => ({ kind: "cat", row: r.key, cat: c.id }) });
    if (pad === "rounds") for (let i = 0; i < maxRounds; i++) lines.push({ key: `r${i}`, label: `Round ${i + 1}`, target: (r) => ({ kind: "round", row: r.key, round: i }) });
    if (pad === "total" && !cats.length) lines.push({ key: "total", label: "Score", target: (r) => ({ kind: "total", row: r.key }) });
    let lastSection = "";
    return (
      <div className="overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="sticky left-0 z-10 bg-[var(--surface)] px-3 py-2 text-left text-xs font-medium text-[var(--text-muted)]">{pad === "rounds" ? "Round" : "Category"}</th>
              {rows.map((r) => (
                <th key={r.key} scope="col" className={cn("px-2 py-2 text-center", leaders.has(r.key) && "bg-[color-mix(in_srgb,var(--item-accent)_10%,transparent)]")}>
                  <div className="flex flex-col items-center gap-1">
                    {r.isTeam ? <TeamBadge team={r} size={28} /> : <PlayerBadge player={r} size={28} crown={leaders.has(r.key)} />}
                    <span className="max-w-[96px] truncate text-xs font-semibold text-[var(--text)]">{r.name}</span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const head = l.section && l.section !== lastSection ? l.section : "";
              lastSection = l.section || lastSection;
              return [
                head ? (
                  <tr key={`${l.key}-h`}>
                    <td colSpan={rows.length + 1} className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                      {head}
                    </td>
                  </tr>
                ) : null,
                <tr key={l.key} className={cn("border-b border-[var(--border)] last:border-0", pad === "rounds" && l.key === `r${round}` && "bg-[var(--hover)]")}>
                  <th scope="row" className="sticky left-0 z-10 max-w-[180px] bg-[var(--surface)] px-3 py-1.5 text-left font-medium text-[var(--text)]">
                    <span className="block truncate" title={l.cat?.hint || undefined}>
                      {l.label}
                    </span>
                    {l.cat?.hint && !isPhone && <span className="block truncate text-[11px] font-normal text-[var(--text-muted)]">{l.cat.hint}</span>}
                  </th>
                  {rows.map((r) => (
                    <td key={r.key} className={cn("px-1.5 py-1 text-center", leaders.has(r.key) && "bg-[color-mix(in_srgb,var(--item-accent)_6%,transparent)]")}>
                      {cellInput(l.target(r))}
                    </td>
                  ))}
                </tr>,
              ];
            })}
            {(game?.scoring.bonuses ?? []).map((b) => (
              <tr key={b.id} className="border-b border-[var(--border)]">
                <th scope="row" className="sticky left-0 bg-[var(--surface)] px-3 py-2 text-left font-medium text-[var(--text-muted)]">
                  {b.name} <span className="text-[11px]">({b.threshold}+ → {b.points})</span>
                </th>
                {rows.map((r) => {
                  const s = bonusStates(game, r.entry, cats).find((x) => x.id === b.id);
                  return (
                    <td key={r.key} className={cn("px-2 py-2 text-center tabular-nums", s?.earned ? "font-semibold text-[var(--success)]" : "text-[var(--text-muted)]")}>
                      {s?.earned ? `+${b.points}` : `${fmtScore(s?.progress ?? 0)}`}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-[var(--border)]">
              <th scope="row" className="sticky left-0 bg-[var(--surface)] px-3 py-2.5 text-left font-semibold text-[var(--text)]">
                Total
              </th>
              {rows.map((r) => (
                <td key={r.key} className={cn("px-2 py-2.5 text-center text-lg font-bold tabular-nums", leaders.has(r.key) ? "text-[var(--item-accent)]" : "text-[var(--text)]")}>
                  {fmtScore(totals.get(r.key))}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    );
  };

  // ---- phone: this round / plain totals with big buttons
  const bigRows = (kind: "round" | "total") => (
    <Card padded={false} className="divide-y divide-[var(--border)] px-3">
      {rows.map((r) => {
        const t: Target = kind === "round" ? { kind: "round", row: r.key, round } : { kind: "total", row: r.key };
        return (
          <div key={r.key} className="flex items-center gap-2">
            {r.isTeam ? <TeamBadge team={r} size={32} /> : <PlayerBadge player={r} size={32} crown={leaders.has(r.key)} />}
            <div className="min-w-0 flex-1">
              {bigControl({ t, label: r.name, sub: kind === "round" ? `Total ${fmtScore(totals.get(r.key))}` : r.seat?.faction || undefined })}
            </div>
          </div>
        );
      })}
    </Card>
  );

  const roundNav = pad === "rounds" && (
    <div className="flex items-center justify-between gap-2">
      <IconButton label="Previous round" icon={ChevronLeft} onClick={() => setRound(round - 1)} disabled={round === 0 || readOnly} />
      <div className="text-center">
        <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Round</div>
        <div className="text-2xl font-bold tabular-nums text-[var(--text)]" aria-live="polite">
          {round + 1}
          {game?.scoring.rounds ? <span className="text-base font-medium text-[var(--text-muted)]"> / {game.scoring.rounds}</span> : null}
        </div>
      </div>
      <IconButton label="Next round" icon={ChevronRight} onClick={() => setRound(round + 1)} disabled={readOnly} />
    </div>
  );

  const finishBar = !readOnly && (
    <ItemButton variant="primary" size="lg" block icon={<Flag className="h-5 w-5" />} onClick={onFinish}>
      Finish game
    </ItemButton>
  );

  // Phone: the next step is always under the thumb: pass the phone on,
  // move to the next round, or finish.
  const toTop = () => topRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  const nextStep: { label: React.ReactNode; onClick: () => void } | null =
    readOnly || !showScores
      ? null
      : pad === "categories" && cats.length && view === "player" && rows.length > 1
        ? { label: <>Next: {rows[(focus + 1) % rows.length]?.name}</>, onClick: () => (setFocus(focus + 1), toTop()) }
        : pad === "rounds"
          ? { label: <>Round {round + 2}</>, onClick: () => setRound(round + 1) }
          : null;
  const phoneBar = !readOnly && (
    <div className="sticky bottom-0 z-20 -mx-4 mt-auto border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_92%,transparent)] px-4 pb-3 pt-3 backdrop-blur">
      {nextStep ? (
        <div className="flex gap-2">
          <ItemButton size="lg" icon={<Flag className="h-5 w-5" />} onClick={onFinish} className="shrink-0">
            Finish
          </ItemButton>
          <ItemButton variant="primary" size="lg" className="min-w-0 flex-1" onClick={nextStep.onClick}>
            <span className="truncate">{nextStep.label}</span>
            <ChevronRight className="h-5 w-5 shrink-0" />
          </ItemButton>
        </div>
      ) : (
        finishBar
      )}
    </div>
  );

  const noScorePad = !showScores && (
    <Card className="flex flex-col gap-3">
      <p className="text-sm text-[var(--text-muted)]">
        {win === "coop" ? "Co-operative — everyone wins or loses together. Hit Finish when the game is decided." : "No points to track — pick the winner when you finish."}
      </p>
      <div className="flex flex-wrap gap-2">
        {rows.map((r) => (
          <span key={r.key} className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] py-1 pl-1 pr-3 text-sm">
            {r.isTeam ? <TeamBadge team={r} size={26} /> : <PlayerBadge player={r} size={26} />}
            {r.name}
            {r.seat?.faction && <span className="text-xs text-[var(--text-muted)]">· {r.seat.faction}</span>}
          </span>
        ))}
      </div>
    </Card>
  );

  const body = () => {
    if (!showScores) return noScorePad;
    if (!isPhone) return grid();
    if (pad === "categories" && cats.length) {
      return (
        <>
          <div className="flex items-center justify-between">
            <Segmented
              size="sm"
              value={view}
              onChange={setView}
              options={[
                { value: "player", label: <span className="inline-flex items-center gap-1"><User className="h-3.5 w-3.5" /> One player</span> },
                { value: "grid", label: <span className="inline-flex items-center gap-1"><Grid3x3 className="h-3.5 w-3.5" /> Sheet</span> },
              ]}
            />
            {view === "player" && rows.length > 1 && (
              <span className="text-xs tabular-nums text-[var(--text-muted)]">
                Player {focus + 1} of {rows.length}
              </span>
            )}
          </div>
          {view === "player" ? playerCats() : grid()}
        </>
      );
    }
    if (pad === "rounds")
      return (
        <>
          {roundNav}
          {bigRows("round")}
          {cats.length > 0 && (
            <Card padded={false} className="px-3 py-1">
              <h2 className="pt-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">End-of-game scoring</h2>
              <div className="divide-y divide-[var(--border)]">
                {cats.flatMap((c) =>
                  rows.map((r) => (
                    <div key={`${c.id}-${r.key}`}>{bigControl({ t: { kind: "cat", row: r.key, cat: c.id }, cat: c, label: `${r.name} · ${c.name}`, sub: c.hint || undefined })}</div>
                  )),
                )}
              </div>
            </Card>
          )}
          {round > 0 && (
            <details className="rounded-2xl">
              <summary className="cursor-pointer px-1 text-sm font-medium text-[var(--text-muted)]">All rounds</summary>
              <div className="mt-2">{grid()}</div>
            </details>
          )}
        </>
      );
    return bigRows("total");
  };

  return (
    <div
      ref={(el) => {
        boxRef(el);
        topRef.current = el;
      }}
      className={cn("mx-auto flex w-full scroll-mt-4 flex-col gap-4 px-4 md:px-6 md:py-5", isPhone ? "min-h-full max-w-3xl pt-3" : "max-w-6xl py-3")}
    >
      {header}
      {isPhone ? (
        <>
          {/* Totals stay pinned while you scroll a long score sheet. */}
          {showScores && <div className="sticky top-0 z-20 -mx-4 bg-[color-mix(in_srgb,var(--bg)_92%,transparent)] px-4 py-2 backdrop-blur">{totalsStrip}</div>}
          {banner}
          {body()}
          {phoneBar}
        </>
      ) : !sidePanel ? (
        <>
          {showScores && totalsStrip}
          {banner}
          {pad === "rounds" && showScores && roundNav}
          {body()}
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-[200px] flex-1">{finishBar}</div>
            <ItemButton variant="ghost" icon={<Sparkles className="h-4 w-4 text-[var(--item-accent)]" />} onClick={() => setRules(true)}>
              Rules question
            </ItemButton>
          </div>
          {game?.scoring.tiebreaker && (
            <p className="text-xs text-[var(--text-muted)]">
              <span className="font-semibold text-[var(--text)]">Tiebreaker: </span>
              {game.scoring.tiebreaker}
            </p>
          )}
        </>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_280px] gap-5">
          <div className="flex min-w-0 flex-col gap-3">
            {banner}
            {pad === "rounds" && showScores && (
              <div className="flex items-center gap-3">
                {roundNav}
                <span className="text-xs text-[var(--text-muted)]">Type in any cell · Tab to move · double-click for the number pad</span>
              </div>
            )}
            {body()}
          </div>
          <aside className="flex flex-col gap-3">
            <Card className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold text-[var(--text)]">Standings</h2>
              <ol className="flex flex-col gap-1.5">
                {(showScores && scoresMatter(game) ? stand.map((s) => rows.find((r) => r.key === s.key)!) : rows).map((r, i) => (
                  <li key={r.key} className="flex items-center gap-2">
                    <span className="w-5 text-right text-xs tabular-nums text-[var(--text-muted)]">{showScores ? (stand.find((s) => s.key === r.key)?.place ?? i + 1) : i + 1}</span>
                    {r.isTeam ? <TeamBadge team={r} size={26} /> : <PlayerBadge player={r} size={26} crown={leaders.has(r.key)} />}
                    <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">
                      {r.name}
                      {r.seat?.faction && <span className="text-xs text-[var(--text-muted)]"> · {r.seat.faction}</span>}
                    </span>
                    {showScores && <span className="text-sm font-semibold tabular-nums text-[var(--text)]">{fmtScore(totals.get(r.key))}</span>}
                  </li>
                ))}
              </ol>
            </Card>
            {game?.scoring.tiebreaker && (
              <Card className="text-xs text-[var(--text-muted)]">
                <span className="font-semibold text-[var(--text)]">Tiebreaker: </span>
                {game.scoring.tiebreaker}
              </Card>
            )}
            {game?.scoring.notes && <Card className="text-xs text-[var(--text-muted)]">{game.scoring.notes}</Card>}
            {finishBar}
            <ItemButton variant="ghost" icon={<Sparkles className="h-4 w-4 text-[var(--item-accent)]" />} onClick={() => setRules(true)}>
              Rules question
            </ItemButton>
          </aside>
        </div>
      )}

      <NumPad
        open={!!numpad}
        onClose={() => setNumpad(null)}
        title={numpad ? padTitle(numpad) : ""}
        subtitle={numpad?.kind === "cat" ? catById.get(numpad.cat)?.hint : undefined}
        current={numpad ? valueOf(numpad) : null}
        options={numpad?.kind === "cat" ? catById.get(numpad.cat)?.options : undefined}
        nextLabel={npNextLabel}
        onSave={(change, next) => {
          if (!numpad) return;
          apply(numpad, change);
          setNumpad(next ? npNext : null);
        }}
      />

      <Sheet open={menu} onClose={() => setMenu(false)} title="This game" size="sm">
        <div className="flex flex-col gap-2 pb-2">
          <ItemButton block icon={<Timer className="h-4 w-4" />} onClick={() => (toggleTimer(), setMenu(false))}>
            {running ? "Pause timer" : "Resume timer"}
          </ItemButton>
          <ItemButton block onClick={() => (setNotes(true), setMenu(false))}>
            Notes & location
          </ItemButton>
          <ItemButton block icon={<Sparkles className="h-4 w-4 text-[var(--item-accent)]" />} onClick={() => (setMenu(false), setRules(true))}>
            Ask a rules question
          </ItemButton>
          {game?.scoring.tiebreaker && <p className="px-1 text-xs text-[var(--text-muted)]">Tiebreaker: {game.scoring.tiebreaker}</p>}
          <ItemButton
            block
            variant="danger"
            icon={<Trash2 className="h-4 w-4" />}
            onClick={() => {
              if (!window.confirm("Throw this game away without logging it?")) return;
              item.update((d) => {
                d.plays = d.plays.filter((p) => p.id !== play.id);
              });
              setMenu(false);
              onBack();
            }}
          >
            Discard game
          </ItemButton>
        </div>
      </Sheet>

      <AskSheet
        open={rules}
        onClose={() => setRules(false)}
        ask={ask}
        title="Rules question"
        prefix={`Rules question — we're playing ${game?.name ?? "a game"}: `}
        placeholder="Can I… / What happens when…"
        examples={game?.scoring.tiebreaker ? ["How does the tiebreaker work?", "How does end-game scoring work?"] : ["How does end-game scoring work?"]}
      />

      <Sheet open={notes} onClose={() => setNotes(false)} title="Notes & location" footer={<ItemButton variant="primary" block onClick={() => setNotes(false)}>Done</ItemButton>}>
        <div className="flex flex-col gap-3">
          <Field label="Location">
            <TextInput value={play.location} onChange={(e) => mutate((p) => (p.location = e.target.value.slice(0, 80)))} placeholder="Home, the café…" />
          </Field>
          <Field label="Notes">
            <TextArea value={play.notes} onChange={(e) => mutate((p) => (p.notes = e.target.value.slice(0, 2000)))} placeholder="House rules, memorable moments…" />
          </Field>
          {(game?.expansions.length ?? 0) > 0 && (
            <Field label="Expansions in play">
              <div className="flex flex-wrap gap-2">
                {game!.expansions.map((ex) => (
                  <Chip
                    key={ex.id}
                    active={play.expansions.includes(ex.id)}
                    onClick={() => {
                      const on = !play.expansions.includes(ex.id); // decided from what's on screen
                      mutate((p) => {
                        if (on && !p.expansions.includes(ex.id)) p.expansions.push(ex.id);
                        if (!on) p.expansions = p.expansions.filter((x) => x !== ex.id);
                      });
                    }}
                  >
                    {ex.name}
                  </Chip>
                ))}
              </div>
            </Field>
          )}
        </div>
      </Sheet>
    </div>
  );
}

/** A table cell you type into (desktop): commits on blur / Enter. "+5"
 *  adds 5 to whatever is in the file when it saves. */
function GridInput({
  value,
  onCommit,
  disabled,
  label,
  onOpenPad,
}: {
  value: number | null;
  onCommit: (c: PadChange) => void;
  disabled?: boolean;
  label: string;
  onOpenPad: () => void;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const focused = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value === null ? "" : String(value));
  }, [value]);
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      setText(value === null ? "" : String(value));
      return;
    }
    const t = text.trim().replace(",", ".");
    // Show what's in the file; the save updates it (clamping with a message).
    setText(value === null ? "" : String(value));
    if (t === "") {
      if (value !== null) onCommit({ mode: "set", value: null });
      return;
    }
    const add = t.startsWith("+");
    const n = Number(add ? t.slice(1) : t);
    if (!Number.isFinite(n)) return;
    if (add) onCommit({ mode: "add", value: n });
    else if (n !== value) onCommit({ mode: "set", value: n });
  };
  return (
    <input
      inputMode="decimal"
      aria-label={label}
      disabled={disabled}
      value={text}
      placeholder="–"
      onFocus={(e) => {
        focused.current = true;
        e.currentTarget.select();
      }}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onDoubleClick={onOpenPad}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
      onChange={(e) => setText(e.target.value)}
      className="h-9 w-full min-w-[56px] rounded-lg border border-transparent bg-[var(--surface-2)] px-1 text-center text-base font-semibold tabular-nums text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] hover:border-[var(--border)] focus:border-[var(--item-accent)] focus:bg-[var(--surface)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--item-accent)_25%,transparent)]"
    />
  );
}
