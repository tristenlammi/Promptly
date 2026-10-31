import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useIsMobile } from "@/hooks/useIsMobile";

import { Chip, Field, ItemButton, ScrollRow, Select, Sheet, TextInput, Toggle } from "@/items/ui";
import { cn } from "@/utils/cn";

import type { Library } from "./catalog";
import { isAvailable } from "./science";
import { ExerciseBadge, muscleLine } from "./shared";
import type { CustomExercise, Exercise, LogType, Settings } from "./types";

const MUSCLE_FILTERS = ["chest", "lats", "upper_back", "side_delts", "front_delts", "rear_delts", "biceps", "triceps", "quads", "hamstrings", "glutes", "calves", "abs"];

const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** How well an exercise matches the typed words: 0 = the name starts with
 *  the query ("plank" → Plank before Copenhagen Plank), 1 = a name word
 *  starts with it, 2 = in the name, 3 = only aliases / muscles. -1 = no. */
function matchScore(e: Exercise, q: string, muscleLabels: string): number {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 3;
  const name = e.name.toLowerCase();
  const hay = [name, ...e.aliases, muscleLabels].join(" ").toLowerCase();
  const hayS = squash(hay);
  if (!words.every((w) => hay.includes(w) || hayS.includes(squash(w)))) return -1;
  const qs = squash(q);
  const bare = squash(name.replace(/\(.*?\)/g, ""));
  if (bare === qs) return 0;
  if (squash(name).startsWith(qs)) return 0.5;
  const nameWords = name.split(/[^a-z0-9]+/).filter(Boolean);
  // Same words in any order ("dumbbell curl" → "Curl (Dumbbell)").
  const qw = words.map(squash).filter(Boolean);
  if (qw.length === new Set(nameWords).size && qw.every((w) => nameWords.includes(w))) return 0.25;
  if (words.every((w) => nameWords.some((nw) => nw.startsWith(squash(w))))) return 1;
  if (words.every((w) => squash(name).includes(squash(w)))) return 2;
  return 3;
}

/** Search the library (built-in + custom), filtered to the person's kit.
 *  ``onPick`` gets one exercise (or several with ``multi``). ``recent`` (ids,
 *  most recent first) floats what they actually do to the top. */
export function ExercisePicker({
  open,
  onClose,
  lib,
  settings,
  onPick,
  title = "Add exercise",
  multi = false,
  onCreate,
  hint,
  recent = [],
}: {
  recent?: string[];
  open: boolean;
  onClose: () => void;
  lib: Library;
  settings: Settings;
  onPick: (ex: Exercise[]) => void;
  title?: string;
  multi?: boolean;
  onCreate?: (c: CustomExercise) => void;
  hint?: string;
}) {
  const [q, setQ] = useState("");
  const [muscle, setMuscle] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const isPhone = useIsMobile();
  const recentRank = useMemo(() => new Map(recent.map((id, i) => [id, i])), [recent]);

  const rows = useMemo(() => {
    const scored: { e: Exercise; score: number; r: number }[] = [];
    for (const e of lib.list) {
      if (e.archived) continue;
      // What they've done always shows (even if their kit list changed since).
      if (!all && !isAvailable(e, settings) && !recentRank.has(e.id)) continue;
      if (muscle && !e.primary.includes(muscle)) continue;
      const score = matchScore(e, q, e.primary.map((m) => lib.catalog.muscles[m]?.label ?? m).join(" "));
      if (score < 0) continue;
      scored.push({ e, score, r: recentRank.get(e.id) ?? Infinity });
    }
    // Best match first; among equals, the ones they do (most recent first), then A–Z (lib.list order).
    // While searching, the shorter (more basic) name wins a tie: "Curl (Dumbbell)" before "Concentration Curl".
    scored.sort((a, b) => a.score - b.score || a.r - b.r || (q.trim() ? a.e.name.length - b.e.name.length : 0));
    return scored.map((x) => x.e);
  }, [lib, q, muscle, all, settings, recentRank]);

  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => 60, overscan: 8 });

  const close = () => {
    setPicked([]);
    setQ("");
    onClose();
  };
  const choose = (e: Exercise) => {
    if (!multi) {
      onPick([e]);
      close();
      return;
    }
    setPicked((p) => (p.includes(e.id) ? p.filter((x) => x !== e.id) : [...p, e.id]));
  };

  return (
    <>
      <Sheet
        open={open && !creating}
        onClose={close}
        title={title}
        size="lg"
        footer={
          multi || onCreate ? (
            <>
              {onCreate && (
                <ItemButton icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
                  Custom
                </ItemButton>
              )}
              {multi && (
                <ItemButton
                  variant="primary"
                  block
                  disabled={!picked.length}
                  onClick={() => {
                    onPick(picked.map((id) => lib.get(id)));
                    close();
                  }}
                >
                  Add {picked.length || ""} exercise{picked.length === 1 ? "" : "s"}
                </ItemButton>
              )}
            </>
          ) : undefined
        }
      >
        {/* Phone: the sheet opens on this (no keyboard covering half the list). */}
        <div tabIndex={-1} data-autofocus={isPhone ? "" : undefined} className="sticky top-0 z-10 flex flex-col gap-2 bg-[var(--bg)] pb-2 outline-none">
          {hint && <p className="text-xs text-[var(--text-muted)]">{hint}</p>}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
            <TextInput autoFocus={!isPhone} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search 170+ exercises" className="pl-9" aria-label="Search exercises" />
          </div>
          <ScrollRow>
            <Chip active={!muscle} onClick={() => setMuscle(null)}>
              All
            </Chip>
            {MUSCLE_FILTERS.map((m) => (
              <Chip key={m} active={muscle === m} onClick={() => setMuscle(muscle === m ? null : m)}>
                {lib.catalog.muscles[m]?.label ?? m}
              </Chip>
            ))}
          </ScrollRow>
          <label className="flex items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
            <span>
              {rows.length} exercise{rows.length === 1 ? "" : "s"}
              {!all && " for your equipment"}
            </span>
            <span className="flex items-center gap-2">
              Show all
              <Toggle checked={all} onChange={setAll} label="Show exercises for all equipment" />
            </span>
          </label>
        </div>
        <div ref={scroller} className="h-[min(60vh,520px)] overflow-y-auto" role="listbox" aria-label="Exercises" aria-multiselectable={multi}>
          <div style={{ height: virt.getTotalSize(), position: "relative" }}>
            {virt.getVirtualItems().map((v) => {
              const e = rows[v.index];
              const on = picked.includes(e.id);
              return (
                <button
                  key={e.id}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => choose(e)}
                  style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${v.start}px)`, height: v.size }}
                  className={cn(
                    "flex items-center gap-3 rounded-xl px-2 text-left transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]",
                    on && "bg-[color-mix(in_srgb,var(--item-accent)_10%,transparent)]",
                  )}
                >
                  <ExerciseBadge ex={e} lib={lib} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-[var(--text)]">{e.name}</span>
                    <span className="block truncate text-xs text-[var(--text-muted)]">
                      {muscleLine(e, lib)}
                      {e.custom && " · custom"}
                      {recentRank.has(e.id) && <span className="text-[var(--item-accent)]"> · done before</span>}
                    </span>
                  </span>
                  {on && <Check className="h-4 w-4 text-[var(--item-accent)]" />}
                </button>
              );
            })}
          </div>
          {!rows.length && (
            <p className="py-8 text-center text-sm text-[var(--text-muted)]">
              Nothing matches.{onCreate ? " Add it as a custom exercise." : ""}
            </p>
          )}
        </div>
      </Sheet>
      {onCreate && (
        <CustomExerciseSheet
          open={creating}
          initialName={q}
          lib={lib}
          onClose={() => setCreating(false)}
          onSave={(c) => {
            onCreate(c);
            setCreating(false);
            if (multi) {
              // Keep what's already ticked: the new one joins the selection.
              setPicked((p) => (p.includes(c.id) ? p : [...p, c.id]));
              setQ("");
              return;
            }
            onPick([{ ...c, needs: [[c.equipment]], start: null, aliases: [], custom: true }]);
            close();
          }}
        />
      )}
    </>
  );
}

const LOG_TYPES: { value: LogType; label: string }[] = [
  { value: "weight_reps", label: "Weight × reps" },
  { value: "bodyweight_reps", label: "Bodyweight reps (+ added load)" },
  { value: "assisted", label: "Assisted (− assistance)" },
  { value: "duration", label: "Time" },
  { value: "distance", label: "Distance" },
];

/** A sensible movement pattern for a muscle (the first one picked) — a
 *  starting guess the person can change. */
const PATTERN_FOR: Record<string, string> = {
  chest: "push_h", front_delts: "push_v", side_delts: "raise", rear_delts: "fly", triceps: "extension", biceps: "curl",
  forearms: "curl", lats: "pull_v", upper_back: "pull_h", traps: "shrug", lower_back: "hinge", abs: "core", obliques: "core",
  glutes: "hip", quads: "squat", hamstrings: "knee_flex", adductors: "hip", abductors: "hip", calves: "calf",
};
const COMPOUND_PATTERNS = new Set(["squat", "hinge", "lunge", "push_h", "push_v", "pull_h", "pull_v", "carry", "olympic"]);

export function CustomExerciseSheet({
  open,
  onClose,
  onSave,
  lib,
  initialName = "",
}: {
  open: boolean;
  onClose: () => void;
  onSave: (c: CustomExercise) => void;
  lib: Library;
  initialName?: string;
}) {
  const [name, setName] = useState(initialName);
  // Opened from a search with no hit: start from what they typed.
  useEffect(() => {
    if (open) setName(initialName);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const [primary, setPrimary] = useState<string[]>([]);
  const [equipment, setEquipment] = useState<CustomExercise["equipment"]>("dumbbell");
  const [log, setLog] = useState<LogType>("weight_reps");
  const [compound, setCompound] = useState(false);
  const [pattern, setPattern] = useState<string | null>(null); // null = follow the muscles
  const [touchedCompound, setTouchedCompound] = useState(false);
  const shownPattern = pattern ?? PATTERN_FOR[primary[0] ?? ""] ?? "core";
  const isCompound = touchedCompound ? compound : COMPOUND_PATTERNS.has(shownPattern);
  const exists = lib.list.some((e) => e.name.toLowerCase() === name.trim().toLowerCase());
  const id = "c_" + name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
  const muscles = Object.entries(lib.catalog.muscles);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Custom exercise"
      footer={
        <ItemButton
          variant="primary"
          block
          disabled={!name.trim() || exists || !primary.length}
          onClick={() => {
            let cid = id || "c_exercise";
            let n = 2;
            while (lib.byId[cid]) cid = `${id}_${n++}`;
            onSave({ id: cid, name: name.trim(), primary, secondary: [], equipment, pattern: shownPattern, log, compound: isCompound, notes: "", archived: false });
            setName("");
            setPrimary([]);
            setPattern(null);
            setTouchedCompound(false);
          }}
        >
          Add exercise
        </ItemButton>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" hint={exists ? "That name is already in the library." : undefined}>
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sandbag clean" />
        </Field>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-[var(--text-muted)]">Main muscles (the first one counts most)</span>
          <div className="flex flex-wrap gap-1.5">
            {muscles.map(([m, info]) => (
              <Chip key={m} active={primary.includes(m)} onClick={() => setPrimary((p) => (p.includes(m) ? p.filter((x) => x !== m) : [...p, m].slice(0, 6)))}>
                {info.label}
              </Chip>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Equipment">
            <Select value={equipment} onChange={(e) => setEquipment(e.target.value as CustomExercise["equipment"])}>
              {Object.entries(lib.catalog.equipment)
                .filter(([k]) => k !== "full_gym")
                .map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Movement" hint="Used for warm-ups, rest and swaps">
            <Select value={shownPattern} onChange={(e) => setPattern(e.target.value)}>
              {Object.entries(lib.catalog.patterns).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Log as">
            <Select value={log} onChange={(e) => setLog(e.target.value as LogType)}>
              {LOG_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <label className="flex items-center justify-between gap-3 text-sm text-[var(--text)]">
          <span>
            Compound lift
            <span className="block text-xs text-[var(--text-muted)]">Longer rests and warm-up sets</span>
          </span>
          <Toggle checked={isCompound} onChange={(v) => { setTouchedCompound(true); setCompound(v); }} label="Compound lift" />
        </label>
      </div>
    </Sheet>
  );
}
