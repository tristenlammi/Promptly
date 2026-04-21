import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Thin wrapper over the browser's ``SpeechRecognition`` / Web Speech API.
 *
 * Why this hook exists as a layer on top of the raw API:
 *
 *   * ``SpeechRecognition`` isn't in the standard DOM typings (it's on the
 *     ``WICG`` track) and the prefix drift between Chrome's ``webkit``-
 *     namespaced version and the unprefixed spec is annoying to handle at
 *     every call site.
 *   * The raw API delivers results as ``SpeechRecognitionEvent`` payloads
 *     whose ``results`` list is *cumulative across the session* (not a
 *     delta), so naive listeners double-count every committed chunk.
 *     This hook computes the delta for you and only fires ``onFinal``
 *     once per finalised segment.
 *   * Browsers silently end the recognition session after a pause even
 *     with ``continuous: true`` — we surface that through ``isListening``
 *     so the UI badge flips off correctly.
 *
 * Browser support (April 2026):
 *   * Chromium (desktop + Android)  ✅ prefixed as ``webkitSpeechRecognition``
 *   * Safari (desktop + iOS)         ✅ prefixed
 *   * Firefox                        ❌ not implemented; ``supported`` → false
 *
 * Callers should hide the mic UI entirely when ``supported === false``
 * rather than show a disabled button; Firefox users don't need to be
 * told their browser lacks an API they didn't ask for.
 *
 * We intentionally do NOT fall back to a server-side STT (e.g. Whisper).
 * It'd mean extra provider cost and ~10 s of extra latency per utterance
 * for < 5% of the traffic.
 */

interface UseSpeechRecognitionOptions {
  /** Called once per finalised chunk with just that chunk's text.
   *  The InputBar appends it to its textarea; the hook never touches
   *  the caller's state directly. */
  onFinal?: (text: string) => void;
  /** BCP-47 language tag. Defaults to ``navigator.language`` so the
   *  browser picks the user's system locale — no UI lever today. */
  lang?: string;
}

interface UseSpeechRecognitionReturn {
  /** ``true`` when the browser exposes a SpeechRecognition implementation.
   *  When ``false`` the rest of the API is still present but the
   *  ``start`` call is a no-op — callers should hide their UI instead. */
  supported: boolean;
  /** Mirrors the session: flipped ``true`` on ``onstart`` and ``false``
   *  on ``onend`` (even if the browser auto-ended on silence). */
  isListening: boolean;
  /** Last non-final transcript — displayed live as a preview while the
   *  user is mid-sentence. Cleared on every ``stop`` and whenever a
   *  chunk is finalised. */
  interimText: string;
  /** Human-readable description of the last recognition error, or
   *  ``null`` if everything's fine / we haven't tried yet. */
  error: string | null;
  start: () => void | Promise<void>;
  stop: () => void;
  toggle: () => void;
}

type SpeechAlternative = { transcript: string };
type SpeechResult = {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechAlternative;
};
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechResult;
  };
}
interface SpeechRecognitionErrorEventLike {
  error?: string;
  message?: string;
}
interface SpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: ((ev: Event) => void) | null;
  onend: ((ev: Event) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEventLike) => void) | null;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

/** Some Chromium *forks* expose ``webkitSpeechRecognition`` (inherited
 *  from upstream) but strip the actual speech-recognition backend
 *  because it phones home to Google. Calling ``start()`` on those
 *  builds fires an immediate ``not-allowed`` error, which we'd
 *  otherwise surface as "mic permission denied" — very confusing
 *  when the user knows they granted mic access.
 *
 *  Currently blocklisted:
 *   * Vivaldi    — removed the Google endpoint by policy
 *   * Brave      — same reason; toggleable behind a flag, but off
 *                  for the vast majority of installs
 *
 *  We keep this list small and conservative; new entries go in only
 *  after a confirmed "button does nothing" report. */
function isBlocklistedFork(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/Vivaldi/i.test(ua)) return true;
  // Brave sets ``navigator.brave`` *and* scrubs its UA, so sniff the
  // runtime hook instead.
  const nav = navigator as unknown as { brave?: { isBrave?: () => unknown } };
  if (typeof nav.brave?.isBrave === "function") return true;
  return false;
}

function resolveCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  if (isBlocklistedFork()) return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Map raw ``event.error`` codes to user-facing sentences.
 *
 *  We never show ``"aborted"`` / ``"no-speech"`` — the first is our own
 *  ``stop()`` call and the second fires when the user just sat there
 *  silently. Both are noise, not errors. */
function describeError(code: string | undefined): string | null {
  switch (code) {
    case "not-allowed":
      return "Microphone permission was denied. Enable it in your browser's site settings.";
    case "service-not-allowed":
      // Distinct from ``not-allowed``: the mic itself is fine but the
      // *speech recognition backend* is blocked. Most common in
      // Brave / Chromium forks that strip Google's speech endpoint,
      // and in enterprise-managed Chrome with a policy restriction.
      return "Voice input is blocked by your browser or network. Try Chrome / Edge on this device.";
    case "audio-capture":
      return "No microphone was detected.";
    case "network":
      return "Voice recognition needs an internet connection.";
    case "language-not-supported":
      return "Your browser doesn't support this language for voice input.";
    case "aborted":
    case "no-speech":
      return null;
    default:
      return code ? `Voice input failed (${code}).` : "Voice input failed.";
  }
}

/** Ensure the page actually holds mic permission before we hand the
 *  browser's SpeechRecognition implementation the baton.
 *
 *  Why we need this: Chromium's ``SpeechRecognition`` doesn't trigger
 *  its own permission prompt. If the page has never asked for the
 *  mic via ``getUserMedia`` — even if the *user* flipped the site
 *  setting to "Allow" by hand — the first ``start()`` call fires an
 *  ``error: "not-allowed"`` event and the session dies. Grabbing a
 *  short-lived audio track first forces the browser to either surface
 *  its own prompt or confirm existing consent, after which SR works.
 *
 *  We immediately stop the track so we don't keep the mic indicator
 *  lit while SR does its own acquisition. */
async function ensureMicPermission(): Promise<boolean> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getUserMedia
  ) {
    // No getUserMedia (very old browser or insecure context). Fall
    // through and let SR surface whatever error it would normally
    // produce — we can't do better.
    return true;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return true;
  } catch {
    return false;
  }
}

export function useSpeechRecognition(
  options: UseSpeechRecognitionOptions = {}
): UseSpeechRecognitionReturn {
  const { onFinal, lang } = options;

  const [supported] = useState<boolean>(() => resolveCtor() !== null);
  const [isListening, setIsListening] = useState(false);
  const [interimText, setInterimText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recRef = useRef<SpeechRecognitionInstance | null>(null);
  // Tracks whether ``ensureMicPermission`` succeeded this session. If
  // ``rec.onerror`` then fires ``not-allowed`` we know the mic wasn't
  // the problem (the recognition backend is blocked), so we can
  // correct the error message rather than blaming the user.
  const micGrantedRef = useRef(false);
  // Callback ref keeps the recognition instance's closures fresh without
  // having to rebuild the recognizer every time the parent rerenders.
  const onFinalRef = useRef<typeof onFinal>(onFinal);
  useEffect(() => {
    onFinalRef.current = onFinal;
  }, [onFinal]);

  const start = useCallback(async () => {
    if (!supported) return;
    if (recRef.current) {
      // Already started — safe to ignore. Starting twice throws
      // ``InvalidStateError`` in Chromium.
      return;
    }
    const Ctor = resolveCtor();
    if (!Ctor) return;

    // Pre-warm the mic permission — see ``ensureMicPermission`` for
    // why this has to happen before we touch SpeechRecognition.
    const granted = await ensureMicPermission();
    micGrantedRef.current = granted;
    if (!granted) {
      setError(
        "Microphone permission was denied. Enable it in your browser's site settings."
      );
      return;
    }

    const rec = new Ctor();
    rec.lang =
      lang ??
      (typeof navigator !== "undefined" && navigator.language
        ? navigator.language
        : "en-US");
    rec.continuous = true;
    rec.interimResults = true;

    rec.onstart = () => {
      setIsListening(true);
      setError(null);
    };
    rec.onend = () => {
      setIsListening(false);
      setInterimText("");
      recRef.current = null;
    };
    rec.onerror = (ev) => {
      // When we already confirmed mic permission via ``getUserMedia``
      // but SR still fires ``not-allowed``, the mic itself isn't the
      // problem — the recognition backend is blocked (Brave, Vivaldi,
      // enterprise policies, etc.). Rewrite the code so we don't
      // mislead the user into fiddling with site settings that are
      // already correct.
      let code = ev.error;
      if (code === "not-allowed" && micGrantedRef.current) {
        code = "service-not-allowed";
      }
      const msg = describeError(code);
      if (msg) setError(msg);
    };
    rec.onresult = (ev) => {
      // Walk only the *new* results — ``resultIndex`` points at the
      // first one that changed since the last event. Older indices
      // are already-committed finals we fired ``onFinal`` for.
      let nextInterim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const text = r[0]?.transcript ?? "";
        if (r.isFinal) {
          const trimmed = text.trim();
          if (trimmed.length > 0) onFinalRef.current?.(trimmed);
        } else {
          nextInterim += text;
        }
      }
      setInterimText(nextInterim);
    };

    recRef.current = rec;
    try {
      rec.start();
    } catch {
      // Swallow: some browsers (notably iOS) throw if ``start`` is
      // called in rapid succession. The ``onerror`` handler will
      // surface anything the user cares about.
      recRef.current = null;
      setIsListening(false);
    }
  }, [supported, lang]);

  const stop = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    try {
      rec.stop();
    } catch {
      // Stopping an already-stopping recognizer throws in some
      // engines; we don't care either way.
    }
  }, []);

  const toggle = useCallback(() => {
    if (recRef.current) stop();
    else start();
  }, [start, stop]);

  // Abort on unmount so a lingering session doesn't keep the mic hot
  // after the composer unmounts (e.g. navigating away mid-dictation).
  useEffect(() => {
    return () => {
      const rec = recRef.current;
      if (!rec) return;
      try {
        rec.abort();
      } catch {
        // noop
      }
    };
  }, []);

  return {
    supported,
    isListening,
    interimText,
    error,
    start,
    stop,
    toggle,
  };
}
