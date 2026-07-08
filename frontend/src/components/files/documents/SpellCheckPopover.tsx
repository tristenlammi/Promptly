import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { BookPlus, EyeOff, Loader2 } from "lucide-react";

import { loadSpell } from "./spellDictionaries";
import type { SpellCheckWordClick } from "./SpellCheckExtension";

/**
 * Suggestion popover for a clicked misspelling. Loads (cached) suggestions
 * from the active dictionary and lets the user replace the word, add it to
 * their personal dictionary, or ignore it for this note.
 */
export function SpellCheckPopover({
  editor,
  target,
  lang,
  onAddWord,
  onIgnore,
  onClose,
}: {
  editor: Editor;
  target: SpellCheckWordClick;
  lang: string;
  onAddWord: (word: string) => void;
  onIgnore: (word: string) => void;
  onClose: () => void;
}) {
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  // Load suggestions for the current word. Cancels on target change so a
  // slow load for a previous word can't overwrite a newer one.
  useEffect(() => {
    let cancelled = false;
    setSuggestions(null);
    void loadSpell(lang).then((spell) => {
      if (cancelled) return;
      setSuggestions(spell.suggest(target.word).slice(0, 7));
    });
    return () => {
      cancelled = true;
    };
  }, [lang, target.word]);

  // Dismiss on outside pointer / Escape / any doc edit (positions would drift).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // Defer so the click that opened us doesn't immediately close it.
    const t = window.setTimeout(
      () => window.addEventListener("pointerdown", onPointer),
      0
    );
    editor.on("update", onClose);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
      editor.off("update", onClose);
    };
  }, [editor, onClose]);

  const replace = (word: string) => {
    // Guard against drift: only replace if the range still holds the word.
    const current = editor.state.doc
      .textBetween(target.from, target.to)
      .replace(/^['’]+|['’]+$/g, "");
    if (current.toLowerCase() !== target.word.toLowerCase()) {
      onClose();
      return;
    }
    editor
      .chain()
      .focus()
      .insertContentAt({ from: target.from, to: target.to }, word)
      .run();
    onClose();
  };

  return createPortal(
    <div
      ref={ref}
      style={{
        position: "fixed",
        top: Math.min(target.y + 12, window.innerHeight - 300),
        left: Math.max(8, Math.min(target.x - 20, window.innerWidth - 236)),
        zIndex: 90,
      }}
      className="w-56 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] py-1 shadow-xl"
      onMouseDown={(e) => e.preventDefault()}
    >
      {suggestions === null ? (
        <div className="flex items-center gap-2 px-3 py-2 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…
        </div>
      ) : suggestions.length === 0 ? (
        <div className="px-3 py-2 text-sm text-[var(--text-muted)]">
          No suggestions
        </div>
      ) : (
        suggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => replace(s)}
            className="block w-full px-3 py-1.5 text-left text-sm text-[var(--text)] transition hover:bg-[var(--accent)]/10"
          >
            {s}
          </button>
        ))
      )}

      <div className="my-1 h-px bg-[var(--border)]" />

      <button
        type="button"
        onClick={() => {
          onAddWord(target.word);
          onClose();
        }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--muted)] transition hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/10"
      >
        <BookPlus className="h-3.5 w-3.5" /> Add to dictionary
      </button>
      <button
        type="button"
        onClick={() => {
          onIgnore(target.word);
          onClose();
        }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--muted)] transition hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/10"
      >
        <EyeOff className="h-3.5 w-3.5" /> Ignore in this note
      </button>
    </div>,
    document.body
  );
}
