import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { Download, Play, Plus, Sparkles, Trash2 } from "lucide-react";
import type * as Y from "yjs";

import type { DeckSlide } from "@/api/editorAi";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { SLIDE_H, SLIDE_W, deckMap, deckOrder, nextSlidePosition, notesMap, slideKey, slidesOf, type FrameLike } from "./deck";
import { GenerateDeckDialog } from "./GenerateDeckDialog";
import { PresentMode } from "./PresentMode";
import { renderSlide } from "./render";

/** The slide sorter (Stage 12): the deck's slides down the side — click
 *  one to go to it, drag (or Alt+↑/↓) to reorder, + for a new one — the
 *  speaker notes of the current slide, Present, and Export. */
export function SlidesPanel({
  api,
  ydoc,
  readOnly,
  persist,
  title,
  fileId,
  children,
}: {
  api: ExcalidrawImperativeAPI;
  ydoc: Y.Doc;
  readOnly: boolean;
  /** Push a programmatic scene change through the collab binding. */
  persist: () => void;
  title: string;
  /** The presentation's file — turns on "Generate slides from files". */
  fileId?: string;
  /** The canvas — laid out beside the sorter, above the notes. */
  children: React.ReactNode;
}) {
  const [elements, setElements] = useState(() => api.getSceneElementsIncludingDeleted() as unknown as FrameLike[]);
  const [order, setOrder] = useState<string[]>(() => deckOrder(ydoc));
  const [notes, setNotes] = useState<Record<string, string>>(() => notesMap(ydoc).toJSON() as Record<string, string>);
  const [current, setCurrent] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, { key: string; url: string }>>({});
  const [presenting, setPresenting] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [generating, setGenerating] = useState(false);

  // Follow the scene (a beat after it settles) and the deck's maps.
  useEffect(() => {
    let t = 0;
    const off = api.onChange(() => {
      window.clearTimeout(t);
      t = window.setTimeout(() => setElements(api.getSceneElementsIncludingDeleted() as unknown as FrameLike[]), 400);
    });
    return () => {
      window.clearTimeout(t);
      off();
    };
  }, [api]);
  useEffect(() => {
    const deck = deckMap(ydoc);
    const n = notesMap(ydoc);
    const onDeck = () => setOrder(deckOrder(ydoc));
    const onNotes = () => setNotes(n.toJSON() as Record<string, string>);
    deck.observe(onDeck);
    n.observe(onNotes);
    return () => {
      deck.unobserve(onDeck);
      n.unobserve(onNotes);
    };
  }, [ydoc]);

  const slides = useMemo(() => slidesOf(elements, order), [elements, order]);
  const live = useMemo(() => elements.filter((e) => !e.isDeleted), [elements]);
  const currentIndex = Math.max(0, slides.findIndex((s) => s.id === current));

  // Fonts arriving late: draw the pictures again once.
  useEffect(() => {
    void document.fonts?.ready.then(() => window.setTimeout(() => setThumbs({}), 300));
  }, []);

  // Small pictures of the slides, redrawn when one changes.
  useEffect(() => {
    let off = false;
    void (async () => {
      for (const s of slides) {
        const key = slideKey(s, live);
        if (off || thumbs[s.id]?.key === key) continue;
        try {
          const url = (await renderSlide(api, s, 320)).toDataURL("image/png");
          if (!off) setThumbs((t) => ({ ...t, [s.id]: { key, url } }));
        } catch {
          /* nothing drawn yet */
        }
      }
    })();
    return () => {
      off = true;
    };
  }, [api, slides, live, thumbs]);

  const goTo = useCallback(
    (s: FrameLike) => {
      setCurrent(s.id);
      const el = api.getSceneElements().find((e) => e.id === s.id);
      if (el) api.scrollToContent(el, { fitToContent: true, animate: true, duration: 250 });
    },
    [api],
  );

  const writeOrder = (ids: string[]) => {
    ydoc.transact(() => deckMap(ydoc).set("order", ids));
  };

  const addSlide = async () => {
    const { convertToExcalidrawElements } = await import("@excalidraw/excalidraw");
    const { x, y } = nextSlidePosition(slides);
    const [frame] = convertToExcalidrawElements([
      { type: "frame", children: [], name: `Slide ${slides.length + 1}`, x, y, width: SLIDE_W, height: SLIDE_H },
    ]);
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), frame] });
    persist();
    writeOrder([...slides.map((s) => s.id), frame.id]);
    window.setTimeout(() => goTo(frame as unknown as FrameLike), 50);
  };

  // Generated slides (Stage 12): a frame each, a title and bullets in a
  // clean font, the notes with where it came from.
  const addGenerated = async (made: DeckSlide[]) => {
    const { convertToExcalidrawElements } = await import("@excalidraw/excalidraw");
    let at = nextSlidePosition(slides);
    const skeletons: Parameters<typeof convertToExcalidrawElements>[0] = [];
    const ids: string[] = [];
    const notesFor: Record<string, string> = {};
    for (const [n, sl] of made.entries()) {
      const id = `slide-${crypto.randomUUID().slice(0, 12)}`;
      ids.push(id);
      skeletons.push({ type: "frame", id, children: [], name: sl.title.slice(0, 60) || `Slide ${slides.length + n + 1}`, x: at.x, y: at.y, width: SLIDE_W, height: SLIDE_H });
      skeletons.push({ type: "text", x: at.x + 100, y: at.y + 80, text: wrap(sl.title, 34), fontSize: 64, fontFamily: 6, strokeColor: "#1e1e1e", frameId: id });
      if (sl.bullets.length) {
        const body = sl.bullets.map((b) => wrap(`• ${b}`, 62, "   ")).join("\n");
        skeletons.push({ type: "text", x: at.x + 110, y: at.y + 260, text: body, fontSize: 36, fontFamily: 6, strokeColor: "#343a40", frameId: id });
      }
      const cited = sl.sources.map((x) => x.name).filter(Boolean);
      notesFor[id] = [sl.notes.trim(), cited.length ? `Sources: ${[...new Set(cited)].join("; ")}` : ""].filter(Boolean).join("\n\n");
      at = { x: at.x + SLIDE_W + 200, y: at.y };
    }
    const elements = convertToExcalidrawElements(skeletons, { regenerateIds: false });
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...elements] });
    persist();
    ydoc.transact(() => {
      deckMap(ydoc).set("order", [...slides.map((s) => s.id), ...ids]);
      const n = notesMap(ydoc);
      for (const [id, text] of Object.entries(notesFor)) n.set(id, text);
    });
  };

  const deleteSlide = async (s: FrameLike) => {
    const { newElementWith } = await import("@excalidraw/excalidraw");
    // Just what this deletes — Undo brings back only these.
    const gone = new Set(
      api.getSceneElementsIncludingDeleted().filter((e) => !e.isDeleted && (e.id === s.id || e.frameId === s.id)).map((e) => e.id),
    );
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map((e) =>
        e.id === s.id || e.frameId === s.id ? newElementWith(e, { isDeleted: true }) : e,
      ),
    });
    persist();
    writeOrder(slides.filter((x) => x.id !== s.id).map((x) => x.id));
    const before = slides.map((x) => x.id);
    toast.success("Slide deleted.", {
      action: {
        label: "Undo",
        onClick: () => {
          api.updateScene({
            elements: api.getSceneElementsIncludingDeleted().map((e) =>
              gone.has(e.id) && e.isDeleted ? newElementWith(e, { isDeleted: false }) : e,
            ),
          });
          persist();
          writeOrder(before);
        },
      },
    });
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= slides.length || from === to) return;
    const ids = slides.map((s) => s.id);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id);
    writeOrder(ids);
  };
  const dragFrom = useRef<number | null>(null);

  const noteOf = useCallback((id: string) => notes[id] ?? "", [notes]);
  const setNote = (id: string, text: string) => {
    setNotes((n) => ({ ...n, [id]: text }));
    ydoc.transact(() => notesMap(ydoc).set(id, text));
  };

  const doExport = async (what: "pptx" | "pdf") => {
    setMenu(false);
    if (!slides.length) return;
    setBusy("Exporting…");
    try {
      const m = await import("./exportDeck");
      const progress = (d: number, t: number) => setBusy(`Exporting ${d} of ${t}…`);
      if (what === "pptx") await m.exportPptx(api, slides, noteOf, title, progress);
      else await m.exportPdf(api, slides, title, progress);
    } catch (e) {
      toast.error(`Couldn't export: ${e instanceof Error ? e.message : "something went wrong"}`);
    } finally {
      setBusy(null);
    }
  };

  const currentSlide = slides[currentIndex];
  return (
    <div className="flex h-full min-h-0 w-full flex-1">
      <aside aria-label="Slides" className="flex w-44 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] sm:w-52">
        <div className="flex items-center gap-1 border-b border-[var(--border)] p-2">
          <button type="button" disabled={!slides.length} onClick={() => setPresenting(currentIndex)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] px-2 py-1.5 text-xs font-medium text-white disabled:opacity-50">
            <Play className="h-3.5 w-3.5" /> Present
          </button>
          <div className="relative">
            <button type="button" aria-label="Export slides" aria-expanded={menu} disabled={!slides.length || !!busy} onClick={() => setMenu((v) => !v)}
              className="rounded-md p-1.5 text-[var(--text-muted)] hover:bg-[var(--hover)] disabled:opacity-50">
              <Download className="h-4 w-4" />
            </button>
            {menu && (
              <div role="menu" className="absolute right-0 z-30 mt-1 w-48 rounded-md border border-[var(--border)] bg-[var(--surface)] py-1 text-sm shadow-lg">
                <button type="button" role="menuitem" onClick={() => void doExport("pptx")} className="block w-full px-3 py-1.5 text-left hover:bg-[var(--hover)]">PowerPoint (.pptx)</button>
                <button type="button" role="menuitem" onClick={() => void doExport("pdf")} className="block w-full px-3 py-1.5 text-left hover:bg-[var(--hover)]">PDF</button>
              </div>
            )}
          </div>
        </div>
        {busy && <p className="px-2 py-1 text-[11px] text-[var(--text-muted)]" role="status">{busy}</p>}
        {!readOnly && fileId && (
          <button type="button" onClick={() => setGenerating(true)}
            className="mx-2 mt-2 flex items-center justify-center gap-1 rounded-md border border-[var(--border)] py-1 text-xs text-[var(--text)] hover:bg-[var(--hover)]">
            <Sparkles className="h-3.5 w-3.5 text-[var(--accent-text)]" /> Generate slides from files
          </button>
        )}
        <ol aria-label="Slide order" className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          {slides.map((s, i) => (
            <li
              key={s.id}
              draggable={!readOnly}
              onDragStart={() => (dragFrom.current = i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragFrom.current !== null) move(dragFrom.current, i);
                dragFrom.current = null;
              }}
              className="group relative flex gap-1.5"
            >
              <span className="w-4 shrink-0 pt-1 text-right text-[11px] tabular-nums text-[var(--text-muted)]">{i + 1}</span>
              <button
                type="button"
                aria-label={`Slide ${i + 1}${s.name ? `: ${s.name}` : ""}`}
                aria-current={s.id === currentSlide?.id ? "true" : undefined}
                onClick={() => goTo(s)}
                onKeyDown={(e) => {
                  if (!e.altKey || readOnly) return;
                  if (e.key === "ArrowUp") { e.preventDefault(); move(i, i - 1); }
                  if (e.key === "ArrowDown") { e.preventDefault(); move(i, i + 1); }
                }}
                className={cn(
                  "block aspect-video min-w-0 flex-1 overflow-hidden rounded border bg-white",
                  s.id === currentSlide?.id ? "border-[var(--accent)] ring-1 ring-[var(--accent)]" : "border-[var(--border)] hover:border-[var(--text-muted)]",
                )}
              >
                {thumbs[s.id] && <img src={thumbs[s.id].url} alt="" className="h-full w-full object-contain" />}
              </button>
              {!readOnly && (
                <button type="button" aria-label={`Delete slide ${i + 1}`} onClick={() => void deleteSlide(s)}
                  className="absolute right-1 top-1 rounded bg-[var(--surface)]/90 p-0.5 text-[var(--text-muted)] opacity-0 hover:text-[var(--danger)] focus:opacity-100 group-hover:opacity-100">
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </li>
          ))}
        </ol>
        {!readOnly && (
          <button type="button" onClick={() => void addSlide()}
            className="m-2 flex items-center justify-center gap-1 rounded-md border border-dashed border-[var(--border)] py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]">
            <Plus className="h-3.5 w-3.5" /> New slide
          </button>
        )}
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">{children}</div>
      {currentSlide && (
        <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-3 py-2">
          <label className="block text-[11px] font-medium text-[var(--text-muted)]">
            Speaker notes · slide {currentIndex + 1}
            <textarea
              value={noteOf(currentSlide.id)}
              readOnly={readOnly}
              onChange={(e) => setNote(currentSlide.id, e.target.value)}
              rows={2}
              placeholder={readOnly ? "" : "What to say on this slide — only you see these while presenting."}
              className="mt-1 block w-full resize-y rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)]"
            />
          </label>
        </div>
      )}
      </div>
      {generating && fileId && (
        <GenerateDeckDialog fileId={fileId} onClose={() => setGenerating(false)} onDone={addGenerated} />
      )}
      {presenting !== null && (
        <PresentMode api={api} slides={slides} notes={noteOf} start={presenting} onClose={() => setPresenting(null)} />
      )}
    </div>
  );
}

/** Lines of at most ``width`` characters (by words); later lines indented. */
function wrap(text: string, width: number, indent = ""): string {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > width && line) {
      out.push(line);
      line = indent + word;
    } else line = next;
  }
  if (line) out.push(line);
  return out.join("\n");
}
