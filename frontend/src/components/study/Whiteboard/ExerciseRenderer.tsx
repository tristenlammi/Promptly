import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import type { WhiteboardExerciseDetail } from "@/api/types";

export interface ExerciseRendererHandle {
  /** Request the sandboxed page to run its own submit handler. The iframe is
   *  expected to reply with a ``postMessage`` containing the answer payload. */
  requestSubmit: () => void;
}

interface ExerciseRendererProps {
  exercise: WhiteboardExerciseDetail;
  /** Fired when the iframe posts ``{ type: 'EXERCISE_SUBMIT', payload }``. */
  onSubmit: (payload: unknown) => void;
  /** Pulls focus/height out of the renderer into the parent so the parent
   *  owns the overall panel chrome. */
  className?: string;
}

/**
 * Renders AI-authored exercise HTML inside a hardened sandboxed iframe.
 *
 * Security posture:
 *   - ``sandbox="allow-scripts"`` — the page can run JS but is stripped of
 *     same-origin, forms, popups, top-navigation, storage, modals.
 *   - Rendered via ``srcDoc``, which keeps it on a ``null`` origin so it
 *     cannot touch the parent cookies, localStorage, or IndexedDB.
 *   - Parent↔iframe communication is strictly ``postMessage`` with a typed
 *     protocol. We trust the content because *we* decided to render it,
 *     not because we verified the origin.
 */
export const ExerciseRenderer = forwardRef<
  ExerciseRendererHandle,
  ExerciseRendererProps
>(function ExerciseRenderer({ exercise, onSubmit, className }, ref) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useImperativeHandle(ref, () => ({
    requestSubmit: () => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      win.postMessage({ type: "REQUEST_SUBMIT" }, "*");
    },
  }));

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      // Only accept messages coming from THIS exercise's iframe. Since the
      // sandbox gives it a `null` origin we identify by source reference.
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "EXERCISE_SUBMIT") {
        onSubmit(data.payload);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onSubmit]);

  return (
    <iframe
      ref={iframeRef}
      key={exercise.id}
      title={exercise.title ?? "Whiteboard exercise"}
      srcDoc={exercise.html}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className={className ?? "h-full w-full border-0 bg-[var(--surface)]"}
    />
  );
});
