/**
 * Editor chrome extras (S-tier 7.4): word count + outline rail.
 *
 * Both subscribe to the TipTap instance's ``update`` event (debounced —
 * collab docs can stream remote edits) and read straight off the
 * ProseMirror doc, so they work identically for Drive documents and
 * workspace notes.
 */
import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { List } from "lucide-react";

import { cn } from "@/utils/cn";

interface HeadingEntry {
  level: number;
  text: string;
  pos: number;
}

function readHeadings(editor: Editor): HeadingEntry[] {
  const out: HeadingEntry[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      const text = node.textContent.trim();
      if (text) out.push({ level: node.attrs.level ?? 1, text, pos });
      return false; // headings hold no nested blocks worth walking
    }
    return true;
  });
  return out;
}

function useDebouncedDocVersion(editor: Editor | null): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!editor) return;
    let t: number | undefined;
    const bump = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => setVersion((v) => v + 1), 300);
    };
    editor.on("update", bump);
    bump(); // initial content (collab docs load async)
    return () => {
      editor.off("update", bump);
      window.clearTimeout(t);
    };
  }, [editor]);
  return version;
}

/** Subtle "1,234 words" pill for the editor's bottom corner. */
export function WordCountPill({ editor }: { editor: Editor | null }) {
  const version = useDebouncedDocVersion(editor);
  const [stats, setStats] = useState<{ words: number; chars: number }>({
    words: 0,
    chars: 0,
  });
  useEffect(() => {
    if (!editor) return;
    const text = editor.state.doc.textBetween(
      0,
      editor.state.doc.content.size,
      " ",
      " "
    );
    const words = (text.match(/\S+/g) ?? []).length;
    setStats({ words, chars: text.replace(/\s/g, "").length });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, version]);
  if (!editor || stats.words === 0) return null;
  return (
    <div
      title={`${stats.words.toLocaleString()} words · ${stats.chars.toLocaleString()} characters`}
      className="pointer-events-none absolute bottom-2 right-6 z-10 rounded-full border border-[var(--border)] bg-[var(--surface)]/90 px-2 py-0.5 text-[10px] tabular-nums text-[var(--text-muted)] shadow-sm backdrop-blur print:hidden"
    >
      {stats.words.toLocaleString()} words
    </div>
  );
}

/**
 * Floating outline rail — Notion-style. Collapsed it's a stack of faint
 * bars (one per heading, width by level); hovering expands it into a
 * clickable table of contents. Hidden when the doc has fewer than two
 * headings or the pane is narrow (split view / small screens).
 */
export function DocumentOutline({ editor }: { editor: Editor | null }) {
  const version = useDebouncedDocVersion(editor);
  const [headings, setHeadings] = useState<HeadingEntry[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!editor) return;
    setHeadings(readHeadings(editor));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, version]);

  if (!editor || headings.length < 2) return null;

  const jumpTo = (pos: number) => {
    try {
      const dom = editor.view.domAtPos(pos + 1).node;
      const el =
        dom instanceof HTMLElement ? dom : (dom.parentElement as HTMLElement);
      el
        ?.closest("h1, h2, h3, h4, h5, h6")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch {
      // Stale pos after a concurrent edit — the next update refreshes it.
    }
  };

  return (
    <div
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      className="absolute right-1.5 top-1/2 z-10 hidden max-h-[70%] -translate-y-1/2 lg:block print:hidden"
    >
      {open ? (
        <nav
          aria-label="Document outline"
          className="max-h-[60vh] w-56 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg)] py-2 shadow-lg"
        >
          <div className="flex items-center gap-1.5 px-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            <List className="h-3 w-3" />
            Outline
          </div>
          {headings.map((h, i) => (
            <button
              key={`${h.pos}-${i}`}
              type="button"
              onClick={() => jumpTo(h.pos)}
              className={cn(
                "block w-full truncate px-3 py-1 text-left text-xs text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]",
                h.level === 1 && "font-medium text-[var(--text)]"
              )}
              style={{ paddingLeft: 12 + (Math.min(h.level, 4) - 1) * 12 }}
            >
              {h.text}
            </button>
          ))}
        </nav>
      ) : (
        <div className="flex flex-col items-end gap-1.5 py-1 pr-1">
          {headings.slice(0, 24).map((h, i) => (
            <div
              key={`${h.pos}-${i}`}
              className="h-0.5 rounded-full bg-[var(--text-muted)]/40"
              style={{ width: 22 - (Math.min(h.level, 4) - 1) * 5 }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
