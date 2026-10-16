import { useEffect, useRef, useState } from "react";
import { FilePlus2, Scissors, Trash2 } from "lucide-react";

import { cn } from "@/utils/cn";

type PDFDocumentProxy = import("pdfjs-dist").PDFDocumentProxy;

export interface PageOps {
  /** 0-based page indices. */
  remove: (indices: number[]) => Promise<void> | void;
  extract: (indices: number[]) => Promise<void> | void;
  /** Add a PDF's pages, or a picture as a page, after page index ``after``. */
  add: (file: File, after: number) => Promise<void> | void;
}

/**
 * The PDF's pages as thumbnails (WP-6.5): click to go there, Ctrl/⌘ or
 * Shift to pick several, then delete them, save them as a new PDF, or add
 * pages from another PDF or a picture after them.
 */
export function PdfPagesRail({
  doc,
  current,
  busy,
  onGo,
  ops,
}: {
  doc: PDFDocumentProxy;
  current: number;
  busy: boolean;
  onGo: (pageNumber: number) => void;
  ops: PageOps;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const anchor = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const count = doc.numPages;

  // A new document (after a page change) — the old picks don't apply.
  useEffect(() => setSelected(new Set()), [doc]);

  const pick = (i: number, e: React.MouseEvent) => {
    if (e.shiftKey && anchor.current !== null) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
      setSelected(new Set(Array.from({ length: b - a + 1 }, (_, k) => a + k)));
    } else if (e.ctrlKey || e.metaKey) {
      setSelected((s) => {
        const next = new Set(s);
        if (next.has(i)) next.delete(i);
        else next.add(i);
        return next;
      });
      anchor.current = i;
    } else {
      setSelected(new Set([i]));
      anchor.current = i;
      onGo(i + 1);
    }
  };

  const picked = [...selected].sort((a, b) => a - b);
  const after = picked.length ? picked[picked.length - 1] : current - 1;
  const btn =
    "inline-flex h-7 flex-1 items-center justify-center gap-1 rounded text-[11px] text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-40";

  return (
    <aside aria-label="Pages" className="flex w-40 shrink-0 flex-col border-r border-white/10 bg-black/30">
      <div className="flex shrink-0 gap-0.5 border-b border-white/10 p-1">
        <button
          type="button"
          className={btn}
          disabled={busy || !picked.length || picked.length >= count}
          onClick={() => void ops.remove(picked)}
          title={picked.length >= count ? "A PDF needs at least one page" : "Delete the selected pages"}
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete
        </button>
        <button
          type="button"
          className={btn}
          disabled={busy || !picked.length}
          onClick={() => void ops.extract(picked)}
          title="Save the selected pages as a new PDF"
        >
          <Scissors className="h-3.5 w-3.5" /> Extract
        </button>
        <button
          type="button"
          className={btn}
          disabled={busy}
          onClick={() => fileInput.current?.click()}
          title="Add pages from a PDF or a picture, after the selected page"
        >
          <FilePlus2 className="h-3.5 w-3.5" /> Add
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf,image/png,image/jpeg,image/webp"
          className="hidden"
          aria-label="Add pages from a file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void ops.add(f, after);
          }}
        />
      </div>
      <p className="shrink-0 px-2 py-1 text-[10px] text-white/45">
        {picked.length ? `${picked.length} selected` : "Ctrl- or Shift-click to pick pages"}
      </p>
      <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {Array.from({ length: count }, (_, i) => (
          <li key={`${doc.fingerprints[0]}-${i}`}>
            <button
              type="button"
              onClick={(e) => pick(i, e)}
              aria-label={`Page ${i + 1}`}
              aria-pressed={selected.has(i)}
              className={cn(
                "block w-full rounded p-1 text-center transition",
                selected.has(i) ? "bg-[var(--accent)]/40 ring-2 ring-[var(--accent)]" : current === i + 1 ? "bg-white/15" : "hover:bg-white/10"
              )}
            >
              <Thumb doc={doc} index={i} />
              <span className="mt-0.5 block text-[10px] text-white/60">{i + 1}</span>
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}

/** One page, drawn small when it scrolls into view. */
function Thumb({ doc, index }: { doc: PDFDocumentProxy; index: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [ratio, setRatio] = useState(1.414);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;
    (async () => {
      try {
        const page = await doc.getPage(index + 1);
        const base = page.getViewport({ scale: 1 });
        if (cancelled) return;
        setRatio(base.height / base.width);
        const canvas = ref.current;
        if (!canvas) return;
        const viewport = page.getViewport({ scale: 220 / base.width });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        task = page.render({ canvas, viewport });
        await task.promise;
      } catch {
        /* a page that won't draw stays blank */
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [visible, doc, index]);

  return (
    <canvas
      ref={ref}
      className="mx-auto block w-full rounded-sm bg-white shadow"
      style={{ aspectRatio: `1 / ${ratio}` }}
      aria-hidden
    />
  );
}
