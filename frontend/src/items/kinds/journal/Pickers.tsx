import { Plus, X, Zap } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@/utils/cn";

import { EMOTION_FAMILIES, ENERGY, FAMILY_OF, MOODS, moodInfo } from "./constants";
import { normTag } from "./lib";

/* Mood, energy, emotions and tags — quick, thumb-sized pickers. */

/** A drawn face: the mouth curves with the mood. */
export function MoodFace({ mood, size = 28, muted }: { mood: number | null; size?: number; muted?: boolean }) {
  const info = moodInfo(mood);
  const color = info?.color ?? "var(--text-muted)";
  const curve = mood ? (mood - 3) * 3.2 : 0; // −6.4 … +6.4
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <circle
        cx="16"
        cy="16"
        r="14"
        fill={info && !muted ? `color-mix(in srgb, ${color} 26%, var(--surface))` : "var(--surface-2)"}
        stroke={info && !muted ? color : "var(--border)"}
        strokeWidth="1.6"
      />
      <circle cx="11.2" cy="13" r="1.7" fill={info && !muted ? color : "var(--text-muted)"} />
      <circle cx="20.8" cy="13" r="1.7" fill={info && !muted ? color : "var(--text-muted)"} />
      <path
        d={`M10.5 ${20.5 - curve / 2} Q16 ${20.5 + curve} 21.5 ${20.5 - curve / 2}`}
        fill="none"
        stroke={info && !muted ? color : "var(--text-muted)"}
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function MoodPicker({
  value,
  onChange,
  size = "md",
  showLabels = true,
  compact,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  size?: "md" | "lg";
  showLabels?: boolean;
  /** One slim row (no labels, smaller faces) — the phone writing room. */
  compact?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Mood" className="flex w-full justify-between gap-1">
      {MOODS.map((m) => {
        const on = value === m.value;
        return (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={m.label}
            onClick={() => onChange(on ? null : m.value)}
            className={cn(
              "flex min-h-[44px] flex-1 flex-col items-center justify-center gap-1 rounded-2xl transition",
              compact ? "py-1" : "py-1.5",
              " focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
              on ? "bg-[color-mix(in_srgb,var(--item-accent)_10%,transparent)]" : "hover:bg-[var(--hover)]",
            )}
          >
            <span className={cn("transition", on && "item-pop scale-110")}>
              <MoodFace mood={m.value} size={size === "lg" ? 42 : compact ? 30 : 32} muted={value !== null && !on} />
            </span>
            {showLabels && (
              <span className={cn("text-[11px] font-medium", on ? "text-[var(--text)]" : "text-[var(--text-muted)]")}>{m.label}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function EnergyPicker({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <div className="flex items-center gap-3">
      <div role="radiogroup" aria-label="Energy" className="flex items-end gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => {
          const on = value !== null && n <= value;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={value === n}
              aria-label={`Energy ${n} of 5: ${ENERGY[n - 1]}`}
              onClick={() => onChange(value === n ? null : n)}
              className="flex h-11 w-9 items-end justify-center rounded-lg pb-1.5 hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
            >
              <span
                className="w-4 rounded-[4px] transition-all"
                style={{
                  height: 8 + n * 5,
                  background: on ? "var(--item-accent)" : "var(--surface-2)",
                }}
              />
            </button>
          );
        })}
      </div>
      <span className="flex items-center gap-1 text-sm text-[var(--text-muted)]">
        <Zap className="h-3.5 w-3.5" />
        {value ? ENERGY[value - 1] : "Energy"}
      </span>
    </div>
  );
}

export function EmotionChip({ word, onRemove, active, onClick }: { word: string; onRemove?: () => void; active?: boolean; onClick?: () => void }) {
  const fam = FAMILY_OF[word];
  const color = fam?.color ?? "var(--text-muted)";
  const inner = (
    <>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
      {word}
      {onRemove && <X className="h-3 w-3 opacity-60" />}
    </>
  );
  const cls = cn(
    "inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-medium transition",
    active || onRemove
      ? "border-transparent text-[var(--text)]"
      : "border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]",
  );
  const style = active || onRemove ? { background: `color-mix(in srgb, ${color} 20%, var(--surface))` } : undefined;
  if (onRemove)
    return (
      <button type="button" className={cls} style={style} onClick={onRemove} aria-label={`Remove ${word}`}>
        {inner}
      </button>
    );
  if (onClick)
    return (
      <button type="button" className={cls} style={style} onClick={onClick} aria-pressed={active}>
        {inner}
      </button>
    );
  return (
    <span className={cls} style={style}>
      {inner}
    </span>
  );
}

/** The feelings wheel, one family at a time. */
export function EmotionPicker({ value, onChange, mood }: { value: string[]; onChange: (v: string[]) => void; mood: number | null }) {
  // Open on the families that fit the mood picked.
  const suggested = mood ? (mood >= 4 ? "joyful" : mood === 3 ? "calm" : "sad") : "joyful";
  const [fam, setFam] = useState(suggested);
  const [custom, setCustom] = useState("");
  const family = EMOTION_FAMILIES.find((f) => f.id === fam) ?? EMOTION_FAMILIES[0];
  const toggle = (w: string) => onChange(value.includes(w) ? value.filter((x) => x !== w) : value.length < 12 ? [...value, w] : value);
  const add = () => {
    const w = custom.trim().toLowerCase().slice(0, 30);
    if (w && !value.includes(w) && value.length < 12) onChange([...value, w]);
    setCustom("");
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none]" role="tablist" aria-label="Emotion families">
        {EMOTION_FAMILIES.map((f) => {
          const n = value.filter((w) => FAMILY_OF[w]?.id === f.id).length;
          return (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={f.id === fam}
              onClick={() => setFam(f.id)}
              className={cn(
                "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition",
                f.id === fam ? "text-[var(--text)]" : "text-[var(--text-muted)] hover:text-[var(--text)]",
              )}
              style={f.id === fam ? { background: `color-mix(in srgb, ${f.color} 22%, var(--surface))` } : undefined}
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: f.color }} aria-hidden />
              {f.label}
              {n > 0 && <span className="tabular-nums opacity-70">{n}</span>}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        {family.words.map((w) => (
          <EmotionChip key={w} word={w} active={value.includes(w)} onClick={() => toggle(w)} />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Another word…"
          aria-label="Add your own emotion word"
          className="h-10 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-base text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--item-accent)] md:text-sm"
        />
        <button
          type="button"
          onClick={add}
          disabled={!custom.trim()}
          aria-label="Add emotion"
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--hover)] disabled:opacity-40"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Chosen emotions">
          {value.map((w) => (
            <EmotionChip key={w} word={w} onRemove={() => toggle(w)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Tags with suggestions from the journal's own tags. */
export function TagInput({ value, onChange, known }: { value: string[]; onChange: (v: string[]) => void; known: string[] }) {
  const [text, setText] = useState("");
  const q = normTag(text);
  const suggestions = useMemo(
    () => known.filter((t) => !value.includes(t) && (!q || t.includes(q))).slice(0, 10),
    [known, value, q],
  );
  const add = (t: string) => {
    const n = normTag(t);
    if (n && !value.includes(n) && value.length < 30) onChange([...value, n]);
    setText("");
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5 focus-within:border-[var(--item-accent)]">
        {value.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onChange(value.filter((x) => x !== t))}
            aria-label={`Remove tag ${t}`}
            className="inline-flex h-8 items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--item-accent)_14%,transparent)] px-2.5 text-xs font-medium text-[var(--text)]"
          >
            #{t}
            <X className="h-3 w-3 opacity-60" />
          </button>
        ))}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === "," || e.key === " ") && text.trim()) {
              e.preventDefault();
              add(text);
            } else if (e.key === "Backspace" && !text && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => text.trim() && add(text)}
          placeholder={value.length ? "" : "Add a tag…"}
          aria-label="Add a tag"
          className="h-8 min-w-[6rem] flex-1 bg-transparent px-1.5 text-base text-[var(--text)] outline-none placeholder:text-[var(--text-muted)] md:text-sm"
        />
      </div>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => add(t)}
              className="inline-flex h-8 items-center rounded-full border border-[var(--border)] px-2.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
            >
              #{t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
