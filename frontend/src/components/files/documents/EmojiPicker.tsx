import { useEffect, useMemo, useRef, useState } from "react";
import emojiData from "unicode-emoji-json";

/**
 * Self-contained emoji picker for the document toolbar.
 *
 * Opens as a small floating panel anchored beneath the toolbar
 * button. Shows the most-common Unicode glyphs (from the MIT
 * ``unicode-emoji-json`` dataset) and filters on a name query —
 * e.g. typing "smile" narrows to grinning / beaming-face / etc.
 *
 * Selecting an emoji inserts the Unicode glyph into the editor
 * as plain text. Plain-text insertion keeps the CRDT simple (no
 * custom node type needed for serialisation) and the final HTML
 * snapshot round-trips cleanly through the backend's bleach
 * allowlist.
 */
interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  /** Optional anchor rect so the panel positions near the trigger. */
  anchor?: DOMRect | null;
}

interface EmojiEntry {
  glyph: string;
  name: string;
  slug: string;
}

// Build a flat, searchable list once per module load. The dataset
// has a stable glyph → {name, slug} map; we normalise it so we can
// filter by name in one pass.
const ALL_EMOJI: EmojiEntry[] = Object.entries(
  emojiData as Record<string, { name: string; slug: string }>
).map(([glyph, meta]) => ({
  glyph,
  name: meta.name ?? glyph,
  slug: meta.slug ?? glyph,
}));

export function EmojiPicker({ onSelect, onClose, anchor }: EmojiPickerProps) {
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLDivElement | null>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return ALL_EMOJI.slice(0, 180);
    }
    const matches: EmojiEntry[] = [];
    for (const entry of ALL_EMOJI) {
      if (entry.name.toLowerCase().includes(q) || entry.slug.includes(q)) {
        matches.push(entry);
        if (matches.length >= 180) break;
      }
    }
    return matches;
  }, [query]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!panelRef.current) return;
      if (!panelRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", handler);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", handler);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const style: React.CSSProperties = anchor
    ? {
        position: "fixed",
        top: Math.min(anchor.bottom + 6, window.innerHeight - 320),
        left: Math.min(anchor.left, window.innerWidth - 340),
      }
    : {};

  return (
    <div
      ref={panelRef}
      style={style}
      className="z-[60] w-80 max-w-[95vw] rounded-lg border border-black/10 bg-white p-3 shadow-xl dark:border-white/10 dark:bg-neutral-900"
      role="dialog"
      aria-label="Emoji picker"
    >
      <input
        type="text"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search emoji"
        className="mb-2 w-full rounded-md border border-black/10 bg-transparent px-2 py-1 text-sm outline-none focus:border-[#D97757] dark:border-white/20"
      />
      <div className="grid max-h-64 grid-cols-8 gap-1 overflow-y-auto">
        {results.map((entry) => (
          <button
            key={entry.glyph + entry.slug}
            type="button"
            title={entry.name}
            onClick={() => {
              onSelect(entry.glyph);
              onClose();
            }}
            className="flex h-8 w-8 items-center justify-center rounded text-lg hover:bg-black/5 dark:hover:bg-white/10"
          >
            {entry.glyph}
          </button>
        ))}
        {results.length === 0 && (
          <div className="col-span-8 py-6 text-center text-xs text-neutral-500">
            No emoji matches "{query}".
          </div>
        )}
      </div>
    </div>
  );
}
