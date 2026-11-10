import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { askingToDelete } from "../actions";
import { displayTitle, type Note } from "../types";
import { escapeTaken, takeEscape } from "./BodyEditor";
import { NoteEditor } from "./NoteEditor";

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/** A note open over the grid (desktop), so the grid stays where it was.
 *  Escape, the backdrop and Close all save and close it. */
export function NoteDialog({ note, onClose, autoFocus, startWith }: { note: Note; onClose: () => void; autoFocus?: "title" | "body" | "list"; startWith?: "record" }) {
  const box = useRef<HTMLDivElement>(null);
  const closer = useRef<(() => void) | null>(null);
  const back = useRef<HTMLElement | null>(typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null);
  const shade = useRef<HTMLButtonElement>(null);
  const leaving = useRef(false);

  // The note grows out of its card and shrinks back into it. With no card
  // on screen (a link, a new note) it just fades in and out.
  const still = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const frames = (): Keyframe[] | null => {
    const el = box.current;
    if (!el || typeof el.animate !== "function") return null;
    const to = el.getBoundingClientRect();
    const card = document.querySelector<HTMLElement>(`[data-note-card="${note.id}"]`);
    const from = card?.getBoundingClientRect();
    if (from && from.width && from.height && to.width && to.height)
      return [
        { transformOrigin: "top left", transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${Math.min(1, from.height / to.height)})`, opacity: 0.3 },
        { transformOrigin: "top left", transform: "none", opacity: 1 },
      ];
    return [
      { transform: "scale(0.96)", opacity: 0 },
      { transform: "none", opacity: 1 },
    ];
  };
  useLayoutEffect(() => {
    const clear = () => document.querySelectorAll("[data-note-open]").forEach((el) => el.removeAttribute("data-note-open"));
    if (still()) return clear;
    const f = frames();
    if (f) {
      box.current?.animate(f, { duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
      shade.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
      document.querySelector(`[data-note-card="${note.id}"]`)?.setAttribute("data-note-open", "");
    }
    return clear;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const leave = () => {
    if (leaving.current) return;
    leaving.current = true;
    const f = still() ? null : frames();
    if (!f || !box.current) return onClose();
    let gone = false;
    const end = () => {
      if (gone) return;
      gone = true;
      onClose();
    };
    const a = box.current.animate([...f].reverse(), { duration: 160, easing: "ease-in", fill: "forwards" });
    shade.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: "ease-in", fill: "forwards" });
    a.onfinish = end;
    a.oncancel = end;
    window.setTimeout(end, 400);
  };

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const raf = requestAnimationFrame(() => {
      if (!box.current?.contains(document.activeElement) && !(document.activeElement as HTMLElement | null)?.closest("[data-note-pop]")) box.current?.querySelector<HTMLElement>(autoFocus ? FOCUSABLE : '[aria-label="Title"]')?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (askingToDelete()) return; // the question on top has the keyboard
      if (e.key === "Escape") {
        if (escapeTaken(e)) return;
        takeEscape(e);
        closer.current?.();
        return;
      }
      if (e.defaultPrevented) return;
      if (e.key !== "Tab" || !box.current) return;
      if ((document.activeElement as HTMLElement | null)?.closest("[data-note-pop]")) return;
      const els = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !box.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const returnTo = back.current;
    return () => {
      cancelAnimationFrame(raf);
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
      if (returnTo && document.body.contains(returnTo)) returnTo.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-4 pb-8 pt-[8vh]">
      <button type="button" aria-label="Close note" tabIndex={-1} ref={shade} onClick={() => closer.current?.()} className="fixed inset-0 bg-black/45" />
      <div ref={box} role="dialog" aria-modal="true" aria-label={displayTitle(note)} className="relative w-full max-w-[600px] shadow-[var(--shadow-lg)]">
        <NoteEditor note={note} variant="dialog" onClose={leave} autoFocus={autoFocus} closer={closer} startWith={startWith} />
      </div>
    </div>,
    document.body,
  );
}
