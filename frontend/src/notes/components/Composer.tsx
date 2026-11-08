import { ListChecks } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { closeDraft, newDraft, useNote } from "../store";
import type { NoteKind, NoteLabel } from "../types";
import { NoteEditor } from "./NoteEditor";

/**
 * "Take a note…": click in and it grows into a title and a body (or a
 * list). Click outside or press Escape and it's saved — there's no Save
 * button. An empty one just goes away.
 */
/** ``label``: on a label's page, new notes start with that label. */
export function Composer({ label }: { label?: NoteLabel | null }) {
  const [draft, setDraft] = useState<{ id: string; kind: NoteKind } | null>(null);
  const note = useNote(draft?.id);
  const root = useRef<HTMLDivElement>(null);
  const closer = useRef<(() => void) | null>(null);
  const takeRef = useRef<HTMLButtonElement>(null);

  const start = (kind: NoteKind) => setDraft({ id: newDraft(kind, label ? { labels: [label] } : {}), kind });

  useEffect(() => {
    if (!draft) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (root.current?.contains(t) || t.closest("[data-note-pop]") || t.closest("[role=status]") || t.closest("[data-toast]")) return;
      closer.current?.();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        closer.current?.();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [draft]);

  const done = () => {
    if (draft) closeDraft(draft.id);
    setDraft(null);
    requestAnimationFrame(() => takeRef.current?.focus({ preventScroll: true }));
  };

  return (
    <div ref={root} className="mx-auto w-full max-w-[600px]">
      {draft && note ? (
        <NoteEditor note={note} variant="composer" onClose={done} autoFocus={draft.kind === "list" ? "list" : "body"} closer={closer} />
      ) : (
        <div className="flex h-12 items-center rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-1 pr-1.5 shadow-[var(--shadow-sm)]">
          <button ref={takeRef} type="button" onClick={() => start("text")} className="h-full min-w-0 flex-1 rounded-lg px-3 text-left text-[15px] font-medium text-[var(--text-muted)] hover:text-[var(--text)]">
            Take a note…
          </button>
          <button type="button" onClick={() => start("list")} aria-label="New list" title="New list" className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]">
            <ListChecks className="h-5 w-5" />
          </button>
        </div>
      )}
    </div>
  );
}
