import { ArrowDown, ArrowUp, Plus, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ItemHandle } from "@/items/useItem";
import { Field, IconButton, ItemButton, Segmented, Select, Sheet, TextArea, TextInput, Toggle, todayISO, uid } from "@/items/ui";

import type { Data, Game, PadKind, ScoreCategory, WinCondition } from "./types";
import { PAD_LABELS, WIN_LABELS, newCategory, newGame } from "./types";

/*
 * The full scoring setup for a game: win condition, pad type, score
 * categories (multipliers, penalties, quick values), bonuses, rounds,
 * target, tiebreaker, factions and expansions.
 */

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "c";

function uniqueId(base: string, taken: Set<string>): string {
  let id = slug(base);
  let n = 2;
  while (taken.has(id)) id = `${slug(base)}-${n++}`;
  taken.add(id);
  return id;
}

const nums = (s: string) =>
  s
    .split(/[,\s]+/)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n))
    .slice(0, 12);

const optNum = (s: string): number | null => {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export function GameEditor({
  open,
  onClose,
  item,
  gameId,
  ask,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  item: ItemHandle<Data>;
  gameId: string | null; // null = new
  ask: (p: string) => void;
  onSaved?: (id: string) => void;
}) {
  const [g, setG] = useState<Game>(() => newGame("", "", todayISO()));
  const [tags, setTags] = useState("");
  const [factions, setFactions] = useState("");
  // The game as the sheet opened it: Save writes back only what changed.
  const orig = useRef<Game | null>(null);

  useEffect(() => {
    if (!open) return;
    const existing = gameId ? item.data.games.find((x) => x.id === gameId) : undefined;
    const base = existing ? (JSON.parse(JSON.stringify(existing)) as Game) : newGame(uid("g-"), "", todayISO());
    orig.current = existing ? (JSON.parse(JSON.stringify(existing)) as Game) : null;
    setG(base);
    setTags(base.categories.join(", "));
    setFactions(base.scoring.factions.join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, gameId]);

  const set = <K extends keyof Game>(k: K, v: Game[K]) => setG((x) => ({ ...x, [k]: v }));
  const setScoring = <K extends keyof Game["scoring"]>(k: K, v: Game["scoring"][K]) => setG((x) => ({ ...x, scoring: { ...x.scoring, [k]: v } }));
  const setCat = (i: number, patch: Partial<ScoreCategory>) =>
    setG((x) => ({ ...x, scoring: { ...x.scoring, categories: x.scoring.categories.map((c, j) => (j === i ? { ...c, ...patch } : c)) } }));
  const addCat = () =>
    setG((x) => {
      const taken = new Set(x.scoring.categories.map((c) => c.id));
      const name = `Category ${x.scoring.categories.length + 1}`;
      return { ...x, scoring: { ...x.scoring, categories: [...x.scoring.categories, newCategory(uniqueId(name, taken), name)] } };
    });
  const moveCat = (i: number, by: number) =>
    setG((x) => {
      const c = [...x.scoring.categories];
      const j = i + by;
      if (j < 0 || j >= c.length) return x;
      [c[i], c[j]] = [c[j], c[i]];
      return { ...x, scoring: { ...x.scoring, categories: c } };
    });
  const removeCat = (i: number) =>
    setG((x) => {
      const id = x.scoring.categories[i].id;
      return {
        ...x,
        scoring: {
          ...x.scoring,
          categories: x.scoring.categories.filter((_, j) => j !== i),
          bonuses: x.scoring.bonuses.map((b) => ({ ...b, categories: b.categories.filter((c) => c !== id) })),
        },
      };
    });

  const valid = g.name.trim().length > 0;
  const save = () => {
    const clean: Game = {
      ...g,
      name: g.name.trim().slice(0, 100),
      max_players: Math.max(g.min_players, g.max_players),
      categories: tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 12),
      scoring: {
        ...g.scoring,
        factions: factions.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 40),
        pad: g.scoring.pad === "categories" && !g.scoring.categories.length ? "total" : g.scoring.pad,
        categories: g.scoring.categories.map((c) => ({ ...c, name: c.name.trim() || "Points" })),
      },
    };
    const before = orig.current;
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    item.update((d) => {
      const cur = d.games.find((x) => x.id === clean.id);
      if (!cur) {
        d.games.push(clean);
        return;
      }
      // Only the fields this sheet changed (someone may have edited others,
      // e.g. favourited it, meanwhile). Category ids never change here, so
      // typed scores stay attached through renames.
      const target = cur as unknown as Record<string, unknown>;
      const src = clean as unknown as Record<string, unknown>;
      const was = (before ?? {}) as unknown as Record<string, unknown>;
      for (const k of Object.keys(src)) {
        if (k === "scoring") continue;
        if (!before || !same(src[k], was[k])) target[k] = src[k];
      }
      const ts = cur.scoring as unknown as Record<string, unknown>;
      const ss = clean.scoring as unknown as Record<string, unknown>;
      const ws = (before?.scoring ?? {}) as unknown as Record<string, unknown>;
      for (const k of Object.keys(ss)) if (!before || !same(ss[k], ws[k])) ts[k] = ss[k];
    });
    onSaved?.(clean.id);
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={gameId ? `Edit ${g.name || "game"}` : "New game"}
      size="lg"
      footer={
        <ItemButton variant="primary" block disabled={!valid} onClick={save}>
          Save
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-5 pb-2">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label="Name" className="col-span-2">
            <TextInput autoFocus value={g.name} onChange={(e) => set("name", e.target.value)} placeholder="Game name" />
          </Field>
          <Field label="Year">
            <TextInput inputMode="numeric" value={g.year ?? ""} onChange={(e) => set("year", optNum(e.target.value))} />
          </Field>
          <Field label="BGG id" hint="boardgamegeek.com/boardgame/…">
            <TextInput inputMode="numeric" value={g.bgg_id ?? ""} onChange={(e) => set("bgg_id", optNum(e.target.value))} />
          </Field>
          <Field label="Min players">
            <TextInput inputMode="numeric" value={g.min_players} onChange={(e) => set("min_players", Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
          </Field>
          <Field label="Max players">
            <TextInput inputMode="numeric" value={g.max_players} onChange={(e) => set("max_players", Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
          </Field>
          <Field label="Play time (min)">
            <TextInput inputMode="numeric" value={g.play_minutes ?? ""} onChange={(e) => set("play_minutes", optNum(e.target.value))} />
          </Field>
          <Field label="Weight (1–5)">
            <TextInput inputMode="decimal" value={g.weight ?? ""} onChange={(e) => { const n = optNum(e.target.value); set("weight", n === null ? null : Math.max(1, Math.min(5, n))); }} />
          </Field>
          <Field label="Tags" className="col-span-2 md:col-span-4" hint="Comma separated: Engine building, Party…">
            <TextInput value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-6 text-sm text-[var(--text)]">
          <label className="flex items-center gap-2">
            <Toggle checked={g.owned} onChange={(v) => set("owned", v)} label="In my collection" /> In my collection
          </label>
          <label className="flex items-center gap-2">
            <Toggle checked={g.favorite} onChange={(v) => set("favorite", v)} label="Favourite" /> Favourite
          </label>
        </div>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--text)]">Scoring</h3>
            <ItemButton
              size="sm"
              variant="ghost"
              icon={<Sparkles className="h-3.5 w-3.5 text-[var(--item-accent)]" />}
              onClick={() => {
                onClose();
                ask(`Set up the official scoring sheet for ${g.name || "this game"}${gameId ? " (update the existing game)" : ""}`);
              }}
            >
              Set up with AI
            </ItemButton>
          </div>
          <Field label="Who wins?">
            <Select value={g.scoring.win} onChange={(e) => setScoring("win", e.target.value as WinCondition)}>
              {(Object.keys(WIN_LABELS) as WinCondition[]).map((w) => (
                <option key={w} value={w}>
                  {WIN_LABELS[w]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Score pad">
            <Segmented
              value={g.scoring.pad}
              onChange={(v) => setScoring("pad", v as PadKind)}
              options={(Object.keys(PAD_LABELS) as PadKind[]).map((p) => ({ value: p, label: PAD_LABELS[p] }))}
              className="w-full"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Rounds" hint="Leave empty if it varies">
              <TextInput inputMode="numeric" value={g.scoring.rounds ?? ""} onChange={(e) => { const n = optNum(e.target.value); setScoring("rounds", n === null ? null : Math.max(1, Math.min(100, Math.round(n)))); }} />
            </Field>
            <Field label="Target score" hint="Ends the game (Catan 10)">
              <TextInput inputMode="numeric" value={g.scoring.target_score ?? ""} onChange={(e) => setScoring("target_score", optNum(e.target.value))} />
            </Field>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[var(--text-muted)]">Score categories {g.scoring.pad === "rounds" ? "(added to the rounds)" : ""}</span>
              <ItemButton size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={addCat}>
                Category
              </ItemButton>
            </div>
            {g.scoring.categories.map((c, i) => (
              <div key={c.id} className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3">
                <div className="flex items-center gap-1">
                  <TextInput aria-label="Category name" value={c.name} onChange={(e) => setCat(i, { name: e.target.value.slice(0, 60) })} className="flex-1" />
                  <IconButton label="Move up" icon={ArrowUp} onClick={() => moveCat(i, -1)} disabled={i === 0} />
                  <IconButton label="Move down" icon={ArrowDown} onClick={() => moveCat(i, 1)} disabled={i === g.scoring.categories.length - 1} />
                  <IconButton label={`Remove ${c.name}`} icon={Trash2} onClick={() => removeCat(i)} />
                </div>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <Field label="Hint">
                    <TextInput value={c.hint} onChange={(e) => setCat(i, { hint: e.target.value.slice(0, 160) })} placeholder="How to count it" />
                  </Field>
                  <Field label="× points each">
                    <TextInput inputMode="decimal" value={c.multiplier} onChange={(e) => setCat(i, { multiplier: optNum(e.target.value) ?? 1 })} />
                  </Field>
                  <Field label="Quick values">
                    <TextInput value={c.options.join(", ")} onChange={(e) => setCat(i, { options: nums(e.target.value) })} placeholder="0, 25" />
                  </Field>
                  <Field label="Section">
                    <TextInput value={c.section} onChange={(e) => setCat(i, { section: e.target.value.slice(0, 40) })} placeholder="Upper" />
                  </Field>
                </div>
                <label className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                  <Toggle checked={c.subtract} onChange={(v) => setCat(i, { subtract: v })} label="Penalty (subtracted)" /> Penalty — typed as a positive number, subtracted
                </label>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[var(--text-muted)]">Bonuses (e.g. 35 for 63+ in Yahtzee's upper section)</span>
              <ItemButton
                size="sm"
                icon={<Plus className="h-3.5 w-3.5" />}
                disabled={!g.scoring.categories.length || g.scoring.bonuses.length >= 10}
                onClick={() => setScoring("bonuses", [...g.scoring.bonuses, { id: uid("b"), name: "Bonus", categories: [], threshold: 0, points: 0 }])}
              >
                Bonus
              </ItemButton>
            </div>
            {g.scoring.bonuses.map((b, i) => (
              <div key={b.id} className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] p-3">
                <div className="grid grid-cols-3 gap-2">
                  <Field label="Name">
                    <TextInput value={b.name} onChange={(e) => setScoring("bonuses", g.scoring.bonuses.map((x, j) => (j === i ? { ...x, name: e.target.value.slice(0, 60) } : x)))} />
                  </Field>
                  <Field label="When at least">
                    <TextInput inputMode="numeric" value={b.threshold} onChange={(e) => setScoring("bonuses", g.scoring.bonuses.map((x, j) => (j === i ? { ...x, threshold: optNum(e.target.value) ?? 0 } : x)))} />
                  </Field>
                  <Field label="Scores">
                    <TextInput inputMode="numeric" value={b.points} onChange={(e) => setScoring("bonuses", g.scoring.bonuses.map((x, j) => (j === i ? { ...x, points: optNum(e.target.value) ?? 0 } : x)))} />
                  </Field>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <span className="text-xs text-[var(--text-muted)]">Counts:</span>
                  {g.scoring.categories.map((c) => {
                    const on = b.categories.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setScoring("bonuses", g.scoring.bonuses.map((x, j) => (j === i ? { ...x, categories: on ? x.categories.filter((y) => y !== c.id) : [...x.categories, c.id] } : x)))}
                        className={`h-7 rounded-full border px-2.5 text-xs ${on ? "border-[var(--item-accent)] text-[var(--text)]" : "border-[var(--border)] text-[var(--text-muted)]"}`}
                      >
                        {c.name}
                      </button>
                    );
                  })}
                  <button type="button" className="ml-auto text-xs text-[var(--danger)]" onClick={() => setScoring("bonuses", g.scoring.bonuses.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>

          <Field label="Tiebreaker">
            <TextArea value={g.scoring.tiebreaker} onChange={(e) => setScoring("tiebreaker", e.target.value.slice(0, 400))} placeholder="e.g. Most unused food tokens wins" className="min-h-[64px]" />
          </Field>
          <Field label="Rules notes" hint="End conditions, quirks">
            <TextArea value={g.scoring.notes} onChange={(e) => setScoring("notes", e.target.value.slice(0, 600))} className="min-h-[64px]" />
          </Field>
          <Field label="Factions / roles" hint="Comma separated — picked per player when you start">
            <TextInput value={factions} onChange={(e) => setFactions(e.target.value)} />
          </Field>
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--text)]">Expansions</h3>
            <ItemButton size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => set("expansions", [...g.expansions, { id: uid("x"), name: "Expansion", categories: [], factions: [] }])}>
              Expansion
            </ItemButton>
          </div>
          {g.expansions.map((ex, i) => (
            <div key={ex.id} className="grid grid-cols-[1fr_auto] items-end gap-2 rounded-2xl border border-[var(--border)] p-3">
              <Field label="Name">
                <TextInput value={ex.name} onChange={(e) => set("expansions", g.expansions.map((x, j) => (j === i ? { ...x, name: e.target.value.slice(0, 80) } : x)))} />
              </Field>
              <IconButton label={`Remove ${ex.name}`} icon={Trash2} onClick={() => set("expansions", g.expansions.filter((_, j) => j !== i))} />
              <Field label="Extra score categories" hint="Comma separated" className="col-span-2">
                <TextInput
                  defaultValue={ex.categories.map((c) => c.name).join(", ")}
                  onBlur={(e) => {
                    const names = e.target.value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20);
                    const taken = new Set(g.scoring.categories.map((c) => c.id));
                    const cats = names.map((n) => ex.categories.find((c) => c.name === n) ?? newCategory(uniqueId(n, taken), n));
                    set("expansions", g.expansions.map((x, j) => (j === i ? { ...x, categories: cats } : x)));
                  }}
                />
              </Field>
            </div>
          ))}
        </section>

        <Field label="Notes">
          <TextArea value={g.notes} onChange={(e) => set("notes", e.target.value.slice(0, 1000))} />
        </Field>
      </div>
    </Sheet>
  );
}
