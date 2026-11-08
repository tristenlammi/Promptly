import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { displayTitle, type Note } from "../types";
import { NoteEditor } from "./NoteEditor";

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/** A note open over the grid (desktop), so the grid stays where it was.
 *  Escape, the backdrop and Close all save and close it. */
export function NoteDialog({ note, onClose, autoFocus }: { note: Note; onClose: () => void; autoFocus?: "title" | "body" | "list" }) {
  const box = useRef<HTMLDivElement>(null);
  const closer = useRef<(() => void) | null>(null);
  const back = useRef<HTMLElement | null>(typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const raf = requestAnimationFrame(() => {
      if (!box.current?.contains(document.activeElement)) box.current?.querySelector<HTMLElement>(autoFocus ? FOCUSABLE : '[aria-label="Title"]')?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closer.current?.();
        return;
      }
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
      <button type="button" aria-label="Close note" tabIndex={-1} onClick={() => closer.current?.()} className="fixed inset-0 bg-black/45" />
      <div ref={box} role="dialog" aria-modal="true" aria-label={displayTitle(note)} className="relative w-full max-w-[600px] shadow-[var(--shadow-lg)]">
        <NoteEditor note={note} variant="dialog" onClose={onClose} autoFocus={autoFocus} closer={closer} />
      </div>
    </div>,
    document.body,
  );
}
