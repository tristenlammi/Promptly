import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { ChevronLeft, ChevronRight, MonitorSpeaker, X } from "lucide-react";

import type { FrameLike } from "./deck";
import { renderSlide } from "./render";

/** Presenting (Stage 12): the slides full-screen, one at a time — → / Space
 *  / click for the next, ← for the one before, Esc to stop. "Presenter
 *  view" opens a second window (for the laptop screen) with the notes, the
 *  next slide and a clock; both windows move together. */
export function PresentMode({
  api,
  slides,
  notes,
  start = 0,
  onClose,
}: {
  api: ExcalidrawImperativeAPI;
  slides: FrameLike[];
  notes: (frameId: string) => string;
  start?: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(Math.min(start, Math.max(slides.length - 1, 0)));
  const [pics, setPics] = useState<Record<string, string>>({});
  const [presenter, setPresenter] = useState<Window | null>(null);
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(Date.now());
  const root = useRef<HTMLDivElement>(null);

  const go = useCallback((d: number) => setIndex((i) => Math.min(Math.max(i + d, 0), slides.length - 1)), [slides.length]);

  // Each slide drawn once, at the screen's size (this one and the next first).
  useEffect(() => {
    let off = false;
    const px = Math.min(Math.round(Math.max(window.screen.width, window.screen.height) * (window.devicePixelRatio || 1)), 2560);
    const want = [index, index + 1, index - 1, ...slides.map((_, i) => i)].filter((i) => i >= 0 && i < slides.length);
    void (async () => {
      for (const i of want) {
        const f = slides[i];
        if (off || pics[f.id]) continue;
        try {
          const url = (await renderSlide(api, f, px)).toDataURL("image/png");
          if (!off) setPics((p) => ({ ...p, [f.id]: url }));
        } catch {
          /* an empty slide */
        }
      }
    })();
    return () => {
      off = true;
    };
  }, [api, index, slides, pics]);

  // Full screen while presenting.
  useEffect(() => {
    void root.current?.requestFullscreen?.().catch(() => {});
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(t);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  const close = useCallback(() => {
    presenter?.close();
    onClose();
  }, [presenter, onClose]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n"].includes(e.key)) go(1);
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p"].includes(e.key)) go(-1);
      else if (e.key === "Home") setIndex(0);
      else if (e.key === "End") setIndex(slides.length - 1);
      else if (e.key === "Escape") close();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    const wins = [window, presenter].filter(Boolean) as Window[];
    wins.forEach((w) => w.addEventListener("keydown", key, true));
    return () => wins.forEach((w) => w.removeEventListener("keydown", key, true));
  }, [go, close, presenter, slides.length]);

  // Leaving full screen (Esc in the browser's own handling) ends it too.
  useEffect(() => {
    const left = () => {
      if (!document.fullscreenElement && !presenter) onClose();
    };
    document.addEventListener("fullscreenchange", left);
    return () => document.removeEventListener("fullscreenchange", left);
  }, [onClose, presenter]);

  const openPresenter = () => {
    const w = window.open("", "promptly-presenter", "width=980,height=640");
    if (!w) return;
    w.document.title = "Presenter view";
    w.document.body.innerHTML = "";
    // The app's styles, so the presenter window looks like the app.
    for (const node of Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))) {
      w.document.head.appendChild(node.cloneNode(true));
    }
    w.document.documentElement.className = document.documentElement.className;
    w.addEventListener("beforeunload", () => setPresenter(null));
    setPresenter(w);
  };

  const current = slides[index];
  const next = slides[index + 1];
  const elapsed = Math.floor((now - started) / 1000);
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

  return (
    <div ref={root} role="dialog" aria-modal="true" aria-label="Presenting" className="fixed inset-0 z-[80] flex items-center justify-center bg-black"
      onClick={(e) => e.target === e.currentTarget || (e.target as HTMLElement).tagName === "IMG" ? go(1) : undefined}>
      {current && pics[current.id] ? (
        <img src={pics[current.id]} alt={`Slide ${index + 1} of ${slides.length}`} className="max-h-full max-w-full object-contain" />
      ) : (
        <p className="text-sm text-white/60">Slide {index + 1}…</p>
      )}
      <div className="group absolute inset-x-0 bottom-0 flex justify-center p-4">
        <div className="flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-white opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
          <button type="button" aria-label="Previous slide" onClick={(e) => { e.stopPropagation(); go(-1); }} className="rounded-full p-1.5 hover:bg-white/10"><ChevronLeft className="h-5 w-5" /></button>
          <span className="px-2 text-xs tabular-nums">{index + 1} / {slides.length}</span>
          <button type="button" aria-label="Next slide" onClick={(e) => { e.stopPropagation(); go(1); }} className="rounded-full p-1.5 hover:bg-white/10"><ChevronRight className="h-5 w-5" /></button>
          <button type="button" aria-label="Presenter view" title="Presenter view — notes, next slide and a clock in a second window" onClick={(e) => { e.stopPropagation(); openPresenter(); }} className="rounded-full p-1.5 hover:bg-white/10"><MonitorSpeaker className="h-5 w-5" /></button>
          <button type="button" aria-label="Stop presenting" onClick={(e) => { e.stopPropagation(); close(); }} className="rounded-full p-1.5 hover:bg-white/10"><X className="h-5 w-5" /></button>
        </div>
      </div>
      {presenter &&
        createPortal(
          <div className="flex h-screen flex-col gap-3 bg-[#111] p-4 text-white">
            <div className="flex items-center gap-3 text-sm">
              <span className="font-semibold">Slide {index + 1} of {slides.length}</span>
              <span className="ml-auto font-mono text-lg tabular-nums" aria-label="Time presenting">{clock}</span>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-[2fr_1fr] gap-3">
              <div className="flex min-h-0 items-center justify-center rounded bg-black">
                {current && pics[current.id] && <img src={pics[current.id]} alt="Current slide" className="max-h-full max-w-full object-contain" />}
              </div>
              <div className="flex min-h-0 flex-col gap-2">
                <p className="text-xs uppercase tracking-wide text-white/50">Next</p>
                <div className="flex aspect-video items-center justify-center rounded bg-black">
                  {next ? (pics[next.id] ? <img src={pics[next.id]} alt="Next slide" className="max-h-full max-w-full object-contain" /> : null) : <span className="text-xs text-white/50">The end</span>}
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => go(-1)} className="flex-1 rounded bg-white/10 py-2 text-sm hover:bg-white/20">← Back</button>
                  <button type="button" onClick={() => go(1)} className="flex-1 rounded bg-white/10 py-2 text-sm hover:bg-white/20">Next →</button>
                </div>
              </div>
            </div>
            <div className="h-1/3 min-h-[6rem] overflow-y-auto whitespace-pre-wrap rounded bg-white/5 p-3 text-lg leading-relaxed" aria-label="Speaker notes">
              {current ? notes(current.id) || <span className="text-white/40">No notes for this slide.</span> : null}
            </div>
          </div>,
          presenter.document.body,
        )}
    </div>
  );
}
