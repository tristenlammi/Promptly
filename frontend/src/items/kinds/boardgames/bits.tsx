import { Crown, Star } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ItemButton, Sheet, TextArea, nowISO, todayISO, uid } from "@/items/ui";
import { cn } from "@/utils/cn";

import type { Data, Game, Play, Player, Team } from "./types";
import { newSeat } from "./types";

/* Small shared pieces for Game Night. */

export function initials(name: string, max = 2): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (max === 1) return parts[0][0].toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** The width of an element (0 until measured). Layouts switch on the room
 *  the tab actually has — on a desktop the AI panel can take a third of the
 *  window, so the viewport alone says little. */
export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [w, setW] = useState(0);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    ro.current?.disconnect();
    ro.current = null;
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    ro.current = new ResizeObserver((e) => setW(e[0].contentRect.width));
    ro.current.observe(el);
  }, []);
  // No unmount effect: React calls the ref with null on unmount (which
  // disconnects), and a StrictMode effect re-run would kill the observer.
  return [ref, w];
}

/** A grid of stat tiles that only goes 4-across when each tile gets ~150px. */
export function Tiles({ children, width, className }: { children: React.ReactNode; width: number; className?: string }) {
  return <div className={cn("grid gap-3", width >= 600 ? "grid-cols-4" : "grid-cols-2", className)}>{children}</div>;
}

export function PlayerBadge({
  player,
  size = 36,
  className,
  crown,
  ring,
}: {
  player: Pick<Player, "name" | "color"> | undefined;
  size?: number;
  className?: string;
  crown?: boolean;
  ring?: boolean;
}) {
  const name = player?.name ?? "?";
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      <span
        aria-hidden
        className={cn("inline-flex h-full w-full items-center justify-center rounded-full font-semibold text-white", ring && "ring-2 ring-[var(--item-accent)] ring-offset-2 ring-offset-[var(--bg)]")}
        style={{ background: player?.color ?? "var(--text-muted)", fontSize: size < 28 ? Math.max(10, size * 0.48) : Math.max(10, size * 0.38) }}
      >
        {initials(name, size < 28 ? 1 : 2)}
      </span>
      {crown && (
        <Crown aria-hidden className="absolute -right-1 -top-2 h-4 w-4 rotate-12 fill-[#F2B705] text-[#C98F00]" style={{ width: size * 0.45, height: size * 0.45 }} />
      )}
    </span>
  );
}

export function TeamBadge({ team, size = 36 }: { team: Pick<Team, "name" | "color">; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-xl font-semibold text-white"
      style={{ width: size, height: size, background: team.color, fontSize: Math.max(10, size * 0.36) }}
    >
      {initials(team.name)}
    </span>
  );
}

/** A coloured tile with the game's initials (no artwork needed). */
export function GameTile({ game, size = 44 }: { game: Pick<Game, "name"> | undefined; size?: number }) {
  const name = game?.name ?? "?";
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-xl font-bold tracking-tight text-white shadow-[var(--shadow-sm)]"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.34,
        background: `linear-gradient(135deg, hsl(${hue} 55% 52%), hsl(${(hue + 40) % 360} 60% 40%))`,
      }}
    >
      {initials(name)}
    </span>
  );
}

export function FavStar({ on, className }: { on: boolean; className?: string }) {
  return on ? <Star aria-label="Favourite" className={cn("h-3.5 w-3.5 fill-[#F2B705] text-[#C98F00]", className)} /> : null;
}

export function useLookups(data: Data) {
  return useMemo(() => {
    const players = new Map(data.players.map((p) => [p.id, p]));
    const games = new Map(data.games.map((g) => [g.id, g]));
    return { players, games };
  }, [data.players, data.games]);
}

/** Re-render every ``ms`` while ``on``. */
export function useTick(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [on, ms]);
  return now;
}

export function fmtScore(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

const shortFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
/** "3 Jul" — chart labels. */
export function shortDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return y && m && d ? shortFmt.format(new Date(y, m - 1, d)) : day;
}

export function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  return `${Math.round(n * 100)}%`;
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function fmtMinutes(min: number | null | undefined): string {
  if (!min) return "";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** A fresh live play (for ``item.update``). */
export function makePlay(
  data: Data,
  game: Game,
  seats: { player_id: string; team_id?: string | null; faction?: string }[],
  teams: Team[],
  opts: { expansions?: string[]; location?: string; timer?: boolean } = {},
): Play {
  const now = nowISO();
  return {
    id: uid("pl"),
    game_id: game.id,
    status: "active",
    date: todayISO(),
    started_at: now,
    ended_at: null,
    duration_min: null,
    location: opts.location ?? data.settings.default_location ?? "",
    notes: "",
    seats: seats.map((s) => ({ ...newSeat(s.player_id, s.team_id ?? null), faction: s.faction ?? "" })),
    teams,
    expansions: opts.expansions ?? [],
    coop_won: null,
    manual: false,
    round: 0,
    focus: 0,
    timer_started_at: opts.timer === false ? null : now,
    timer_elapsed_s: 0,
    tiebreak_note: "",
    created_at: now,
  };
}

/** Same game, same people, same teams — new pad. */
export function rematchOf(data: Data, prev: Play, game: Game): Play {
  return makePlay(
    data,
    game,
    prev.seats.map((s) => ({ player_id: s.player_id, team_id: s.team_id, faction: s.faction })),
    prev.teams.map((t) => ({ ...t, scores: {}, rounds: [], total: null, tiebreak: null, score: null, place: null, winner: false })),
    { expansions: prev.expansions, location: prev.location },
  );
}

/** Mark first plays on a just-finished play (mutates a draft). */
export function markFirstPlays(data: Data, play: Play) {
  const earlier = new Set<string>();
  for (const p of data.plays) {
    if (p.id === play.id || p.status !== "finished" || p.game_id !== play.game_id) continue;
    if (`${p.date}|${p.ended_at ?? ""}` >= `${play.date}|${play.ended_at ?? ""}`) continue;
    for (const s of p.seats) earlier.add(s.player_id);
  }
  for (const s of play.seats) s.first_play = !earlier.has(s.player_id);
}

/** Lightweight confetti (CSS only). Off with reduced motion or the setting. */
export function Confetti({ on, colors }: { on: boolean; colors: string[] }) {
  const pieces = useMemo(
    () =>
      Array.from({ length: 42 }, (_, i) => ({
        left: (i * 37) % 100,
        delay: (i % 7) * 0.12,
        dur: 2.4 + ((i * 13) % 10) / 10,
        size: 6 + (i % 4) * 2,
        rot: (i * 47) % 360,
        color: colors[i % colors.length],
        round: i % 3 === 0,
      })),
    [colors],
  );
  if (!on) return null;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden gn-confetti">
      <style>{`
        @keyframes gnFall { 0% { transform: translateY(-20px) rotate(0deg); opacity: 1 } 100% { transform: translateY(105vh) rotate(540deg); opacity: .9 } }
        .gn-confetti span { position: absolute; top: -12px; animation-name: gnFall; animation-timing-function: cubic-bezier(.25,.6,.5,1); animation-fill-mode: both; }
        @media (prefers-reduced-motion: reduce) { .gn-confetti { display: none } }
      `}</style>
      {pieces.map((p, i) => (
        <span
          key={i}
          style={{
            left: `${p.left}%`,
            width: p.size,
            height: p.round ? p.size : p.size * 0.45,
            background: p.color,
            borderRadius: p.round ? 999 : 2,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.dur}s`,
            transform: `rotate(${p.rot}deg)`,
          }}
        />
      ))}
    </div>
  );
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** A short label like "2–4 players · 45 min · weight 2.3". */
export function gameMeta(g: Game): string {
  const bits = [g.min_players === g.max_players ? `${g.min_players} players` : `${g.min_players}–${g.max_players} players`];
  if (g.play_minutes) bits.push(`${g.play_minutes} min`);
  if (g.weight) bits.push(`weight ${g.weight.toFixed(1)}`);
  return bits.join(" · ");
}

/** A short prompt box that hands a typed question to the AI panel. */
export function AskSheet({
  open,
  onClose,
  title,
  placeholder,
  prefix,
  ask,
  examples = [],
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  placeholder: string;
  prefix: string;
  ask: (p: string) => void;
  examples?: string[];
}) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (open) setText("");
  }, [open]);
  const send = (t: string) => {
    if (!t.trim()) return;
    onClose();
    ask(`${prefix}${t.trim()}`);
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <ItemButton variant="primary" block disabled={!text.trim()} onClick={() => send(text)}>
          Ask
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-3 pb-2">
        <TextArea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(text);
            }
          }}
          placeholder={placeholder}
          aria-label={title}
        />
        {examples.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {examples.map((x) => (
              <button key={x} type="button" onClick={() => send(x)} className="rounded-full border border-[var(--border)] px-3 py-1.5 text-left text-xs text-[var(--text-muted)] hover:text-[var(--text)]">
                {x}
              </button>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
}
