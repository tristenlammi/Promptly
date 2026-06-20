import { useCallback, useEffect, useRef, useState } from "react";

import { voiceApi } from "@/api/voice";

/**
 * Server-side text-to-speech playback via Kokoro (``/api/voice/tts``).
 *
 * Replaces the browser's ``speechSynthesis`` for read-aloud + powers
 * voice mode. Browser TTS voices are robotic and vary wildly by OS;
 * Kokoro sounds natural and is identical everywhere because it runs on
 * the user's own server.
 *
 * Latency strategy: long replies are split into sentence-ish chunks and
 * synthesised one at a time. Playback of chunk *n* starts as soon as its
 * audio arrives, while chunk *n+1* is prefetched in the background — so
 * the user hears the first sentence in ~1s instead of waiting for the
 * whole reply to render. This also gives voice mode natural barge-in
 * points (``stop()`` between sentences is instant).
 */

interface SpeakOptions {
  voice?: string | null;
  speed?: number;
  /** Fired once the final chunk finishes playing (not on manual stop). */
  onDone?: () => void;
}

interface UseTextToSpeechReturn {
  /** Whether playback is possible (Audio element available). */
  supported: boolean;
  /** True from the moment ``speak`` is called until playback ends/stops. */
  speaking: boolean;
  /** True while the first chunk is being fetched (before any audio plays). */
  loading: boolean;
  error: string | null;
  speak: (text: string, opts?: SpeakOptions) => Promise<void>;
  stop: () => void;
}

/** Split text into speak-able chunks at sentence boundaries, coalescing
 *  to a target size so we neither make a TTS call per comma nor wait on
 *  one giant synthesis. Keeps abbreviations from over-splitting by only
 *  breaking after sentence punctuation followed by whitespace. */
export function splitIntoSpeechChunks(text: string, target = 240): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  // Break after . ! ? … (optionally followed by a closing quote/bracket)
  // when whitespace follows. The lookbehind keeps the punctuation with
  // its sentence.
  const sentences = clean.split(/(?<=[.!?…][)"'”’\]]?)\s+/);
  const chunks: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (!buf) {
      buf = s;
    } else if (buf.length + 1 + s.length <= target) {
      buf += " " + s;
    } else {
      chunks.push(buf);
      buf = s;
    }
    // A single very long "sentence" (no punctuation) — hard-flush so we
    // don't send a 4k blob.
    if (buf.length >= target * 2) {
      chunks.push(buf);
      buf = "";
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function detectSupported(): boolean {
  return typeof window !== "undefined" && typeof Audio !== "undefined";
}

// --- Global single-playback coordination ---
// Only one utterance plays across the whole app at a time. Each hook
// instance (every message bubble's read-aloud + voice mode) is otherwise
// independent, so without this two of them could talk over each other —
// the old browser ``speechSynthesis.cancel()`` was implicitly global and
// we want to preserve that. ``ttsCounter`` hands each instance a stable
// id; ``activeStopper`` stops whoever is currently speaking.
let ttsCounter = 0;
let activeTtsId = 0;
let activeStopper: (() => void) | null = null;

export function useTextToSpeech(): UseTextToSpeechReturn {
  const [supported] = useState<boolean>(detectSupported);
  const [speaking, setSpeaking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Stable per-instance id for the global single-playback registry.
  const idRef = useRef(0);
  if (idRef.current === 0) idRef.current = ++ttsCounter;
  // Monotonic token: every ``speak``/``stop`` bumps it, invalidating any
  // in-flight fetch or queued playback from a previous run.
  const runRef = useRef(0);
  // Object URLs we've created this run, so we can revoke them on cleanup.
  const urlsRef = useRef<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const cleanupUrls = useCallback(() => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];
  }, []);

  const stop = useCallback(() => {
    runRef.current += 1; // invalidate the current run
    abortRef.current?.abort();
    abortRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.src = "";
    }
    cleanupUrls();
    if (activeTtsId === idRef.current) {
      activeTtsId = 0;
      activeStopper = null;
    }
    setSpeaking(false);
    setLoading(false);
  }, [cleanupUrls]);

  const speak = useCallback(
    async (text: string, opts?: SpeakOptions) => {
      if (!supported) return;
      // Cancel this instance's own prior playback first.
      stop();
      // Then stop any *other* instance that's speaking, and claim the
      // single global playback slot — one voice at a time, app-wide.
      if (activeStopper && activeTtsId !== idRef.current) activeStopper();
      activeTtsId = idRef.current;
      activeStopper = stop;
      const run = (runRef.current += 1);
      const chunks = splitIntoSpeechChunks(text);
      if (chunks.length === 0) return;

      setError(null);
      setSpeaking(true);
      setLoading(true);

      const ac = new AbortController();
      abortRef.current = ac;

      // Fetch one chunk to an object URL. Returns null if this run was
      // superseded or the fetch failed.
      const fetchChunk = async (i: number): Promise<string | null> => {
        try {
          const blob = await voiceApi.synthesize(chunks[i], {
            voice: opts?.voice ?? null,
            speed: opts?.speed ?? 1.0,
            signal: ac.signal,
          });
          if (run !== runRef.current) return null;
          const url = URL.createObjectURL(blob);
          urlsRef.current.push(url);
          return url;
        } catch (err) {
          if (run !== runRef.current) return null;
          // Aborts are expected on stop() — don't surface them.
          if ((err as { code?: string })?.code === "ERR_CANCELED") return null;
          const detail =
            (err as { response?: { data?: { detail?: string } } })?.response
              ?.data?.detail ?? "Couldn't play that. Try again.";
          setError(detail);
          return null;
        }
      };

      // Kick off the first fetch; prefetch the next while each plays.
      let nextPromise: Promise<string | null> = fetchChunk(0);

      for (let i = 0; i < chunks.length; i++) {
        const url = await nextPromise;
        if (run !== runRef.current) return; // superseded
        if (i === 0) setLoading(false);
        if (!url) {
          // Fetch failed/aborted — stop the whole run.
          if (run === runRef.current) {
            setSpeaking(false);
            setLoading(false);
          }
          return;
        }
        // Start prefetching the next chunk before we play this one.
        nextPromise =
          i + 1 < chunks.length
            ? fetchChunk(i + 1)
            : Promise.resolve<string | null>(null);

        // Play this chunk and wait for it to finish.
        const finished = await new Promise<boolean>((resolve) => {
          const audio = new Audio(url);
          audioRef.current = audio;
          audio.onended = () => resolve(true);
          audio.onerror = () => resolve(false);
          void audio.play().catch(() => resolve(false));
        });
        if (run !== runRef.current) return;
        if (!finished) {
          setSpeaking(false);
          return;
        }
      }

      // All chunks played to completion.
      if (run === runRef.current) {
        setSpeaking(false);
        setLoading(false);
        cleanupUrls();
        if (activeTtsId === idRef.current) {
          activeTtsId = 0;
          activeStopper = null;
        }
        opts?.onDone?.();
      }
    },
    [supported, stop, cleanupUrls]
  );

  // Stop + free everything on unmount.
  useEffect(() => {
    return () => {
      runRef.current += 1;
      abortRef.current?.abort();
      const audio = audioRef.current;
      if (audio) {
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio.src = "";
      }
      for (const url of urlsRef.current) URL.revokeObjectURL(url);
      urlsRef.current = [];
      if (activeTtsId === idRef.current) {
        activeTtsId = 0;
        activeStopper = null;
      }
    };
  }, []);

  return { supported, speaking, loading, error, speak, stop };
}
