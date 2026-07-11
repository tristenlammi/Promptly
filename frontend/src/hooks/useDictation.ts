import { useCallback, useEffect, useRef, useState } from "react";

import { voiceApi } from "@/api/voice";
import { apiErrorMessage } from "@/utils/apiError";

/**
 * Server-side dictation via ``MediaRecorder`` + Whisper.
 *
 * Replaces the old browser-only ``useSpeechRecognition`` (Web Speech API),
 * which only worked in Chrome/Safari, shipped audio to Google, and was a
 * no-op on Firefox/Brave. This records a short clip locally and POSTs it
 * to ``/api/voice/transcribe``, so it works in *every* modern browser and
 * keeps audio on the user's own server.
 *
 * Flow: tap → ``recording`` (red, pulsing) → tap again → ``transcribing``
 * (spinner) → the recognised text is delivered via ``onFinal`` and the
 * hook returns to ``idle``. There's no live interim text — Whisper runs
 * once on the finished clip — so callers show a "Transcribing…" status
 * instead of streaming words.
 *
 * ``supported`` is true whenever ``MediaRecorder`` + ``getUserMedia`` are
 * present (effectively all current browsers in a secure context). Callers
 * should still hide the mic in plainly-insecure contexts where
 * ``getUserMedia`` is missing.
 */

export type DictationStatus = "idle" | "recording" | "transcribing";

interface UseDictationOptions {
  /** Called once with the full transcript when a clip finishes
   *  transcribing. The caller appends it to the composer; the hook never
   *  touches the caller's state directly. */
  onFinal?: (text: string) => void;
  /** BCP-47 language hint. Defaults to ``navigator.language``. */
  lang?: string;
  /** Auto turn-taking: when true, the hook watches the mic level and
   *  stops the recording automatically after a sustained pause once the
   *  user has actually started speaking. Used by voice mode for a
   *  hands-free loop; the composer mic leaves it off (tap to finish). */
  autoStop?: boolean;
  /** Called ~per animation frame while recording with a 0–1 mic level.
   *  Lets the UI animate a live level meter without the hook owning any
   *  React state for it. Works with or without ``autoStop`` — providing
   *  it starts the analyser even when auto turn-taking is off. */
  onLevel?: (level: number) => void;
}

// --- Voice-activity-detection tuning (RMS on the [-1,1] waveform) ---
// Below this is treated as silence.
const VAD_SILENCE_RMS = 0.012;
// Above this counts as speech (hysteresis vs. the silence floor so room
// noise doesn't read as talking).
const VAD_SPEECH_RMS = 0.03;
// Sustained silence after speech that ends the turn. Kept fairly tight so
// voice mode feels responsive — every extra 100ms here is dead air the user
// waits through after they've stopped talking. 800ms still tolerates the
// natural mid-sentence pauses in normal speech without ending the turn early.
const VAD_SILENCE_HOLD_MS = 800;
// Hard cap on a single auto-stop turn, so a stuck-open mic (or a user who
// never speaks) can't record forever.
const VAD_MAX_MS = 20_000;
// Normalises the displayed level — RMS rarely exceeds this for speech.
const VAD_LEVEL_FULLSCALE = 0.15;

interface UseDictationReturn {
  supported: boolean;
  status: DictationStatus;
  /** Convenience flags derived from ``status``. */
  isRecording: boolean;
  /** Recording *or* transcribing — i.e. the mic button should look busy. */
  busy: boolean;
  error: string | null;
  start: () => void | Promise<void>;
  /** Stop and transcribe what was recorded. */
  stop: () => void;
  /** Stop and throw the recording away (no transcription). */
  cancel: () => void;
  /** Start if idle, stop-and-transcribe if recording. No-op while busy. */
  toggle: () => void;
}

/** Pick the best container/codec this browser can record. Whisper (via
 *  PyAV/ffmpeg) decodes all of these; we just need MediaRecorder to
 *  actually produce one. Order is preference, best first. */
function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return undefined;
}

function detectSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

export function useDictation(
  options: UseDictationOptions = {}
): UseDictationReturn {
  const { onFinal, lang, autoStop = false, onLevel } = options;

  const [supported] = useState<boolean>(detectSupported);
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // Set when the user cancels mid-recording so the ``onstop`` handler
  // discards the clip instead of transcribing it.
  const cancelledRef = useRef(false);
  // Guards against a late transcription resolving after the component
  // unmounted (avoids a setState-on-unmounted warning / stale append).
  const mountedRef = useRef(true);

  // VAD plumbing (only used when ``autoStop`` is on).
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const onFinalRef = useRef<typeof onFinal>(onFinal);
  useEffect(() => {
    onFinalRef.current = onFinal;
  }, [onFinal]);
  const onLevelRef = useRef<typeof onLevel>(onLevel);
  useEffect(() => {
    onLevelRef.current = onLevel;
  }, [onLevel]);

  // Tear down the Web Audio analysis graph + rAF loop.
  const stopVad = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx) {
      void ctx.close().catch(() => {});
    }
    onLevelRef.current?.(0);
  }, []);

  // Watch the live mic level. With ``triggerStop`` set, auto-stop after a
  // pause once the user has spoken — it stops the recorder the same way a
  // manual tap would (cancelled stays false → the clip is transcribed).
  // With ``triggerStop`` null this is a pure level meter for ``onLevel``.
  const startVad = useCallback(
    (stream: MediaStream, triggerStop: (() => void) | null) => {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctx) return; // No Web Audio — auto-stop just won't engage.
      let ctx: AudioContext;
      try {
        ctx = new Ctx();
      } catch {
        return;
      }
      audioCtxRef.current = ctx;
      void ctx.resume().catch(() => {});
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      // Source → analyser only (NOT → destination), so we never echo the
      // mic back out the speakers.
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);

      const startedAt = performance.now();
      let hasSpoken = false;
      let lastVoiceAt = startedAt;

      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
        const rms = Math.sqrt(sumSq / buf.length);
        onLevelRef.current?.(Math.min(1, rms / VAD_LEVEL_FULLSCALE));

        const now = performance.now();
        if (rms > VAD_SPEECH_RMS) {
          hasSpoken = true;
          lastVoiceAt = now;
        } else if (rms > VAD_SILENCE_RMS) {
          lastVoiceAt = now;
        }
        if (
          triggerStop &&
          ((hasSpoken && now - lastVoiceAt > VAD_SILENCE_HOLD_MS) ||
            now - startedAt > VAD_MAX_MS)
        ) {
          rafRef.current = null;
          triggerStop();
          return;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    },
    []
  );

  // Release the mic tracks — the OS/browser recording indicator stays
  // lit until every track is stopped.
  const releaseStream = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      streamRef.current = null;
    }
  }, []);

  const transcribe = useCallback(
    async (blob: Blob) => {
      try {
        const language =
          lang ??
          (typeof navigator !== "undefined" ? navigator.language : undefined);
        const result = await voiceApi.transcribe(blob, language);
        if (!mountedRef.current) return;
        const text = (result.text || "").trim();
        if (text) onFinalRef.current?.(text);
        setStatus("idle");
      } catch (err) {
        if (!mountedRef.current) return;
        setError(apiErrorMessage(err, "Couldn't transcribe that. Try again."));
        setStatus("idle");
      }
    },
    [lang]
  );

  const start = useCallback(async () => {
    if (!supported) return;
    if (recorderRef.current) return; // already recording
    setError(null);
    cancelledRef.current = false;

    // A non-secure context (plain HTTP on a non-localhost origin) strips
    // ``getUserMedia`` entirely — catch it early with a clear message
    // rather than a generic "permission denied".
    if (typeof window !== "undefined" && window.isSecureContext === false) {
      setError(
        "Voice needs a secure (HTTPS) connection. Open Promptly over https://."
      );
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // Echo cancellation keeps any TTS bleeding from the speakers out
        // of the recording; noise suppression + AGC clean up dictation
        // and sharpen the VAD silence/speech split.
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setError("No microphone was found.");
      } else if (name === "NotAllowedError" || name === "SecurityError") {
        // Could be a user denial OR the page's Permissions-Policy blocking
        // the mic (in which case no prompt ever appears) — cover both.
        setError(
          "Microphone access is blocked. Allow the mic for this site; if no " +
            "prompt appears, the server's Permissions-Policy may be blocking it."
        );
      } else {
        setError("Couldn't access the microphone. Try again.");
      }
      return;
    }
    streamRef.current = stream;

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined
      );
    } catch {
      releaseStream();
      setError("Recording isn't supported in this browser.");
      return;
    }
    chunksRef.current = [];

    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      stopVad();
      releaseStream();
      recorderRef.current = null;
      const chunks = chunksRef.current;
      chunksRef.current = [];
      if (cancelledRef.current) {
        setStatus("idle");
        return;
      }
      const blob = new Blob(chunks, {
        type: mimeType || "audio/webm",
      });
      if (blob.size === 0) {
        setStatus("idle");
        return;
      }
      setStatus("transcribing");
      void transcribe(blob);
    };

    recorderRef.current = recorder;
    try {
      recorder.start();
      setStatus("recording");
      if (autoStop || onLevelRef.current) {
        startVad(
          stream,
          autoStop
            ? () => {
                // Same path as a manual finish — transcribe the recording.
                try {
                  recorder.stop();
                } catch {
                  /* already stopping */
                }
              }
            : null
        );
      }
    } catch {
      stopVad();
      releaseStream();
      recorderRef.current = null;
      setError("Couldn't start recording.");
    }
  }, [supported, releaseStream, transcribe, autoStop, startVad, stopVad]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    cancelledRef.current = false;
    try {
      recorder.stop();
    } catch {
      // Stopping an already-stopping recorder throws in some engines.
    }
  }, []);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    cancelledRef.current = true;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        /* noop */
      }
    } else {
      stopVad();
      releaseStream();
      setStatus("idle");
    }
  }, [releaseStream, stopVad]);

  const toggle = useCallback(() => {
    if (status === "recording") stop();
    else if (status === "idle") void start();
    // While "transcribing" we ignore taps — there's nothing to toggle.
  }, [status, start, stop]);

  // Tear down on unmount: stop any live recorder and release the mic.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelledRef.current = true;
      // Tear down VAD directly — onstop may not run synchronously on
      // unmount, and we must not leak a rAF loop or AudioContext.
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (audioCtxRef.current) {
        void audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          /* noop */
        }
      }
      const stream = streamRef.current;
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
        streamRef.current = null;
      }
    };
  }, []);

  return {
    supported,
    status,
    isRecording: status === "recording",
    busy: status !== "idle",
    error,
    start,
    stop,
    cancel,
    toggle,
  };
}
