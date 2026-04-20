import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { studyApi } from "@/api/study";
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
 * Why we load via ``src=`` instead of ``srcDoc=``:
 *   - ``srcdoc`` iframes inherit the embedder's CSP. The SPA enforces
 *     ``script-src 'self'``, so every inline ``<script>`` the AI
 *     generates in the exercise body (Sortable init,
 *     ``window.collectAnswers``, quiz wiring, etc.) would be blocked
 *     and the exercise would appear dead — items wouldn't drop,
 *     submit would post an empty payload, etc.
 *   - By loading from ``/api/study/exercise-frame/<id>?t=<token>``,
 *     we get a dedicated CSP (set by nginx for that path) that
 *     allows inline scripts. Safe because the iframe is still
 *     ``sandbox="allow-scripts"`` WITHOUT ``allow-same-origin``, so
 *     it runs on a null origin with no access to parent cookies,
 *     storage, or the authenticated API session.
 *
 * Parent↔iframe communication is still strictly ``postMessage`` with
 * a typed protocol via the shim at ``/exercise-shim.js`` (injected
 * into the page server-side).
 */
export const ExerciseRenderer = forwardRef<
  ExerciseRendererHandle,
  ExerciseRendererProps
>(function ExerciseRenderer({ exercise, onSubmit, className }, ref) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({
    requestSubmit: () => {
      const win = iframeRef.current?.contentWindow;
      if (!win) {
        console.warn("[promptly] requestSubmit: iframe contentWindow is null");
        return;
      }
      console.log("[promptly] posting REQUEST_SUBMIT to iframe");
      win.postMessage({ type: "REQUEST_SUBMIT" }, "*");
    },
  }));

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      // We previously gated on ``event.source === iframeRef.current.contentWindow``
      // but that comparison is fragile across srcDoc reloads / sandboxed
      // null-origin frames in some browsers — the handler never fired,
      // which looked exactly like "the submit button does nothing". Since
      // this listener is only installed while an exercise is open, and
      // every other plausible message sender uses a different ``type``
      // string, we dispatch based on the payload shape instead.
      if (data.type === "EXERCISE_SUBMIT") {
        console.log("[promptly] parent got EXERCISE_SUBMIT", data.payload);
        onSubmit(data.payload);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onSubmit]);

  // Fetch a fresh signed URL each time the exercise id changes. Tokens
  // are short-lived (2 min) by design; we only need one valid long
  // enough for the initial iframe load.
  useEffect(() => {
    let cancelled = false;
    setFrameUrl(null);
    setFrameError(null);
    studyApi
      .createExerciseFrameUrl(exercise.id)
      .then((url) => {
        if (!cancelled) setFrameUrl(url);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[promptly] frame-token fetch failed", msg);
        setFrameError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [exercise.id]);

  if (frameError) {
    return (
      <div
        className={
          className ??
          "flex h-full w-full items-center justify-center bg-[var(--surface)] p-6 text-sm text-[var(--text-muted)]"
        }
      >
        Couldn&apos;t load this exercise ({frameError}). Try refreshing.
      </div>
    );
  }

  if (!frameUrl) {
    return (
      <div
        className={
          className ??
          "flex h-full w-full items-center justify-center bg-[var(--surface)] p-6 text-sm text-[var(--text-muted)]"
        }
      >
        Loading exercise…
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      key={exercise.id}
      title={exercise.title ?? "Whiteboard exercise"}
      src={frameUrl}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className={className ?? "h-full w-full border-0 bg-[var(--surface)]"}
    />
  );
});
