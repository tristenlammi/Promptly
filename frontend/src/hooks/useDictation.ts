import { useCallback, useEffect, useRef, useState } from "react";

import { voiceApi } from "@/api/voice";

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
}

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
  const { onFinal, lang } = options;

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

  const onFinalRef = useRef<typeof onFinal>(onFinal);
  useEffect(() => {
    onFinalRef.current = onFinal;
  }, [onFinal]);

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
        const detail =
          (err as { response?: { data?: { detail?: string } } })?.response?.data
            ?.detail ?? "Couldn't transcribe that. Try again.";
        setError(detail);
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

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError(
        "Microphone permission was denied. Enable it in your browser's site settings."
      );
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
    } catch {
      releaseStream();
      recorderRef.current = null;
      setError("Couldn't start recording.");
    }
  }, [supported, releaseStream, transcribe]);

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
      releaseStream();
      setStatus("idle");
    }
  }, [releaseStream]);

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
