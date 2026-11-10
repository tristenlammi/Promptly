import { ListChecks, Mic } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { PhotoItem } from "@/api/photos";

import { closeDraft, newDraft, notesActions, useNote } from "../store";
import { uuid, type NoteKind, type NoteLabel } from "../types";
import { addFiles } from "../uploads";
import { AddImageButton } from "./AddImage";
import { escapeTaken, takeEscape } from "./BodyEditor";
import { NoteEditor } from "./NoteEditor";

/** Pictures from Photos into a note (referenced, not copied). */
export function attachPhotos(noteId: string, items: PhotoItem[]): void {
  for (const p of items)
    notesActions.attach(noteId, {
      id: uuid(),
      kind: "image",
      file_id: p.id,
      filename: p.filename,
      width: p.width,
      height: p.height,
      urls: { original: null, thumb: p.thumb, preview: p.thumb, play: null },
    });
}

/**
 * "Take a note…": click in and it grows into a title and a body (or a
 * list). Click outside or press Escape and it's saved — there's no Save
 * button. An empty one just goes away. Beside it: a new list, a voice
 * note, and a note with pictures.
 */
/** ``label``: on a label's page, new notes start with that label. */
export function Composer({ label }: { label?: NoteLabel | null }) {
  const [draft, setDraft] = useState<{ id: string; kind: NoteKind; record?: boolean } | null>(null);
  const note = useNote(draft?.id);
  const root = useRef<HTMLDivElement>(null);
  const closer = useRef<(() => void) | null>(null);
  const takeRef = useRef<HTMLButtonElement>(null);

  const fresh = (kind: NoteKind) => newDraft(kind, label ? { labels: [label] } : {});
  const start = (kind: NoteKind, record = false) => setDraft({ id: fresh(kind), kind, record });

  useEffect(() => {
    if (!draft) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (root.current?.contains(t) || t.closest("[data-note-pop]") || t.closest("[role=status]") || t.closest("[data-toast]") || t.closest("[role=dialog]")) return;
      closer.current?.();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !escapeTaken(e)) {
        takeEscape(e);
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

  // Opening: the bar grows into the note instead of jumping.
  const expanded = !!(draft && note);
  useLayoutEffect(() => {
    const el = root.current;
    if (!expanded || !el || typeof el.animate !== "function") return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = el.offsetHeight;
    if (to <= 48) return;
    el.style.overflow = "hidden";
    const a = el.animate([{ height: "48px" }, { height: `${to}px` }], { duration: 170, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    const free = () => {
      el.style.overflow = "";
    };
    a.onfinish = free;
    a.oncancel = free;
    return () => a.cancel();
  }, [expanded]);

  const done = () => {
    if (draft) closeDraft(draft.id);
    setDraft(null);
    requestAnimationFrame(() => takeRef.current?.focus({ preventScroll: true }));
  };

  const tool = "flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]";

  return (
    <div ref={root} className="mx-auto w-full max-w-[600px]">
      {draft && note ? (
        <NoteEditor note={note} variant="composer" onClose={done} autoFocus={draft.kind === "list" ? "list" : draft.record ? undefined : "body"} closer={closer} startWith={draft.record ? "record" : undefined} />
      ) : (
        <div className="flex h-12 items-center rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-1 pr-1.5 shadow-[var(--shadow-sm)]">
          <button ref={takeRef} type="button" onClick={() => start("text")} className="h-full min-w-0 flex-1 rounded-lg px-3 text-left text-[15px] font-medium text-[var(--text-muted)] hover:text-[var(--text)]">
            Take a note…
          </button>
          <button type="button" onClick={() => start("list")} aria-label="New list" title="New list" className={tool}>
            <ListChecks className="h-5 w-5" />
          </button>
          <button type="button" onClick={() => start("text", true)} aria-label="New voice note" title="Record a voice note" className={tool}>
            <Mic className="h-5 w-5" />
          </button>
          <AddImageButton
            label="New picture note"
            className={tool}
            iconClassName="h-5 w-5"
            onFiles={(files) => {
              const id = fresh("text");
              addFiles(id, files);
              setDraft({ id, kind: "text" });
            }}
            onPhotos={(items) => {
              const id = fresh("text");
              attachPhotos(id, items);
              setDraft({ id, kind: "text" });
            }}
          />
        </div>
      )}
    </div>
  );
}
