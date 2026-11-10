import { Check, Plus, Tag as TagIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { tagColor } from "@/api/tags";
import { useTagSet } from "@/components/tags/TagPicker";
import { cn } from "@/utils/cn";

import { COLOR_NAMES, NOTE_COLORS, type NoteLabel } from "../types";

/** The twelve note colours, as round swatches. */
export function ColorGrid({ value, onPick }: { value: string | null; onPick: (c: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Note colour" className="grid grid-cols-6 gap-1.5 p-1">
      {NOTE_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={COLOR_NAMES[c]}
          title={COLOR_NAMES[c]}
          onClick={() => onPick(c)}
          data-color={c}
          className={cn(
            "note-c note-swatch relative flex h-9 w-9 items-center justify-center rounded-full border-2",
            value === c ? "border-[var(--accent)]" : "border-[var(--border)] hover:border-[var(--text-muted)]",
          )}
        >
          {c === "default" && <span aria-hidden className="absolute h-[2px] w-5 rotate-45 rounded bg-[var(--text-muted)]" />}
          {value === c && <Check className="relative h-4 w-4" aria-hidden />}
        </button>
      ))}
    </div>
  );
}

/**
 * Your #tags as labels: tick the ones on this note, or type a new one.
 * ``mixed`` (several notes selected) marks labels on only some of them.
 */
export function LabelChooser({
  value,
  onToggle,
  mixed,
  extra,
}: {
  value: NoteLabel[];
  onToggle: (label: NoteLabel, on: boolean) => void;
  mixed?: Set<string>;
  /** Labels already on your notes (so the list works with no connection). */
  extra?: NoteLabel[];
}) {
  const { data: tags } = useTagSet();
  const all = useMemo(() => {
    const byName = new Map<string, NoteLabel>();
    for (const l of [...(extra ?? []), ...value]) if (l.id) byName.set(l.name.toLowerCase(), l);
    for (const t of tags ?? []) byName.set(t.name.toLowerCase(), { id: t.id, name: t.name, color: t.color });
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [tags, extra, value]);
  const [q, setQ] = useState("");
  const have = useMemo(() => new Set(value.map((l) => l.name.toLowerCase())), [value]);
  const term = q.trim().replace(/^#+/, "");
  const shown = useMemo(() => {
    const list = (all ?? []).filter((t) => !term || t.name.toLowerCase().includes(term.toLowerCase()));
    return list.slice(0, 50);
  }, [all, term]);
  const exact = (all ?? []).some((t) => t.name.toLowerCase() === term.toLowerCase()) || have.has(term.toLowerCase());
  return (
    <div className="flex flex-col">
      <p className="px-2 pb-1 pt-1 text-xs font-medium text-[var(--text-muted)]">Labels</p>
      <input
        data-autofocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && term && !exact) {
            e.preventDefault();
            onToggle({ id: "", name: term.slice(0, 40), color: null }, true);
            setQ("");
          }
        }}
        placeholder="Find or make a label"
        aria-label="Find or make a label"
        className="mx-1 mb-1 h-9 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 text-sm outline-none focus:border-[var(--accent)]"
      />
      <ul className="max-h-64 overflow-y-auto">
        {shown.map((t) => {
          const on = have.has(t.name.toLowerCase());
          const some = mixed?.has(t.name.toLowerCase());
          return (
            <li key={t.id}>
              <button
                type="button"
                aria-pressed={some && !on ? "mixed" : on}
                onClick={() => onToggle({ id: t.id, name: t.name, color: t.color }, !on)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-none"
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                    on ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--text-muted)]",
                  )}
                >
                  {on && <Check className="h-3 w-3" />}
                  {some && !on && <span className="h-0.5 w-2 bg-[var(--text-muted)]" />}
                </span>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: tagColor(t) }} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {term && !exact && (
        <button
          type="button"
          onClick={() => {
            onToggle({ id: "", name: term.slice(0, 40), color: null }, true);
            setQ("");
          }}
          className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-[var(--hover)]"
        >
          <Plus className="h-4 w-4" /> Make “{term.slice(0, 40)}”
        </button>
      )}
      {!term && !(all ?? []).length && (
        <p className="flex items-center gap-2 px-2.5 py-2 text-sm text-[var(--text-muted)]">
          <TagIcon className="h-4 w-4" /> Type a name to make your first label.
        </p>
      )}
      <Link to="/tags" className="mt-1 border-t border-[var(--border)] px-2.5 pb-1 pt-2 text-xs text-[var(--text-muted)] hover:text-[var(--text)] hover:underline">
        Edit labels
      </Link>
    </div>
  );
}
