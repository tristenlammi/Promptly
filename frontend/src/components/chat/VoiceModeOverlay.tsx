import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Mic, Square, X } from "lucide-react";

import { useDictation } from "@/hooks/useDictation";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";
import { useChatStore } from "@/store/chatStore";
import { cn } from "@/utils/cn";
import { markdownToSpeech, stripInlineCitations } from "@/utils/speechText";

/**
 * Half-duplex voice mode (Voice Phase 2).
 *
 * A hands-free conversational loop layered on top of the existing chat
 * pipeline — no new chat transport, no provider lock-in. One turn:
 *
 *   listening → (tap to finish) → transcribing → thinking → speaking → ↺
 *
 * Speech is captured with ``useDictation`` (Whisper) and sent through the
 * normal ``onSend`` path, so the reply still flows through RAG, tools and
 * the whole prompt stack. When the reply lands we read it back with
 * ``useTextToSpeech`` (Kokoro), then re-open the mic for the next turn.
 *
 * "Half-duplex" = strict turn-taking: the user can *barge in* (tap to
 * interrupt playback and start talking) but the two sides don't talk over
 * each other. True full-duplex (talk-over-the-AI) is Phase 3.
 *
 * Mounted only while open, so mount = enter, unmount = leave; all the
 * teardown lives in the unmount cleanup.
 */

interface VoiceModeOverlayProps {
  onClose: () => void;
  /** Send transcribed user text through the normal chat send path. */
  onSend: (text: string) => void;
  /** Cancel an in-flight reply (used when the user interrupts mid-think). */
  onCancelStream: () => void;
  /** False when no model is configured — we can't run a turn then. */
  modelReady: boolean;
}

type Phase =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

export function VoiceModeOverlay({
  onClose,
  onSend,
  onCancelStream,
  modelReady,
}: VoiceModeOverlayProps) {
  const isStreaming = useChatStore((s) => s.isStreaming);
  const messages = useChatStore((s) => s.messages);
  const streamingContent = useChatStore((s) => s.streamingContent);
  const streamError = useChatStore((s) => s.streamError);

  const [thinking, setThinking] = useState(false);
  const [userText, setUserText] = useState("");
  const [replyText, setReplyText] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Last assistant message id at the moment we sent — lets us tell the
  // new reply apart from the previous one without racing on isStreaming.
  const baselineAssistantIdRef = useRef<string | null>(null);
  const closingRef = useRef(false);

  const tts = useTextToSpeech();
  // Live mic level → drive the orb ring directly via a ref (no React
  // re-render per frame).
  const levelRingRef = useRef<HTMLDivElement>(null);
  const handleLevel = useCallback((level: number) => {
    const el = levelRingRef.current;
    if (el) {
      el.style.transform = `scale(${1 + Math.min(1, level) * 0.5})`;
      el.style.opacity = `${0.25 + Math.min(1, level) * 0.45}`;
    }
  }, []);
  // ``onFinal`` runs inside the dictation hook's closure; route it through
  // a ref so it always sees fresh state without rebuilding the recorder.
  const onFinalRef = useRef<(t: string) => void>(() => {});
  const dictation = useDictation({
    onFinal: (t) => onFinalRef.current(t),
    // Hands-free turn-taking: auto-submit after the user pauses.
    autoStop: true,
    onLevel: handleLevel,
  });
  const {
    start: startDictation,
    stop: stopDictation,
    cancel: cancelDictation,
    status: dictationStatus,
  } = dictation;

  const lastAssistant = useCallback(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i];
    }
    return null;
  }, [messages]);

  const startListening = useCallback(() => {
    if (closingRef.current || !modelReady) return;
    setErrorMsg(null);
    void startDictation();
  }, [startDictation, modelReady]);

  // Wire the transcription result: send it, or re-listen if nothing heard.
  useEffect(() => {
    onFinalRef.current = (text: string) => {
      if (closingRef.current) return;
      const t = text.trim();
      if (!t) {
        // Nothing intelligible (e.g. the auto-stop timed out on silence) —
        // fall back to idle rather than looping the mic. The user taps to
        // try again.
        return;
      }
      setUserText(t);
      setReplyText("");
      baselineAssistantIdRef.current = lastAssistant()?.id ?? null;
      setThinking(true);
      onSend(t);
    };
  }, [startListening, onSend, lastAssistant]);

  // Detect reply completion → read it aloud → re-open the mic.
  useEffect(() => {
    if (!thinking) return;
    if (streamError) {
      setThinking(false);
      setErrorMsg(streamError);
      return;
    }
    if (isStreaming) return;
    const a = lastAssistant();
    if (!a || a.id === baselineAssistantIdRef.current) return; // not in yet
    // Mark it consumed so a re-render can't double-trigger playback.
    baselineAssistantIdRef.current = a.id;
    setThinking(false);
    const plain = markdownToSpeech(stripInlineCitations(a.content || ""));
    setReplyText(plain);
    if (!plain) {
      startListening();
      return;
    }
    void tts.speak(plain, { onDone: () => startListening() });
  }, [thinking, isStreaming, streamError, lastAssistant, startListening, tts]);

  // Surface dictation / TTS errors in the overlay.
  useEffect(() => {
    if (dictation.error) setErrorMsg(dictation.error);
  }, [dictation.error]);
  useEffect(() => {
    if (tts.error) setErrorMsg(tts.error);
  }, [tts.error]);

  // Auto-start the first turn on open; tear everything down on close.
  useEffect(() => {
    closingRef.current = false;
    startListening();
    return () => {
      closingRef.current = true;
      cancelDictation();
      tts.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClose = useCallback(() => {
    closingRef.current = true;
    cancelDictation();
    tts.stop();
    onClose();
  }, [cancelDictation, tts, onClose]);

  // Close on Escape; lock body scroll while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [handleClose]);

  const phase: Phase = errorMsg
    ? "error"
    : tts.speaking
      ? "speaking"
      : thinking
        ? "thinking"
        : dictationStatus === "recording"
          ? "listening"
          : dictationStatus === "transcribing"
            ? "transcribing"
            : "idle";

  const handleOrbTap = () => {
    switch (phase) {
      case "listening":
        stopDictation(); // finish & transcribe this turn
        break;
      case "speaking":
        tts.stop(); // barge-in: skip playback and start talking
        startListening();
        break;
      case "thinking":
        onCancelStream();
        setThinking(false);
        startListening();
        break;
      case "error":
      case "idle":
        startListening();
        break;
      case "transcribing":
        break; // nothing to do while the clip is being transcribed
    }
  };

  const STATUS: Record<Phase, string> = {
    idle: "Tap to talk",
    listening: "Listening… just pause when you're done",
    transcribing: "Transcribing…",
    thinking: "Thinking…",
    speaking: "Speaking… tap to interrupt",
    error: errorMsg ?? "Something went wrong",
  };

  const active = phase === "listening" || phase === "speaking";
  const busy = phase === "transcribing" || phase === "thinking";
  // While thinking, prefer the live streaming text so the user sees the
  // reply forming; otherwise show the last spoken reply.
  const shownReply = thinking ? streamingContent : replyText;

  return createPortal(
    <div className="fixed inset-0 z-[120] flex flex-col bg-[var(--bg)]/95 backdrop-blur-md">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-muted)]">
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              active
                ? "bg-[var(--accent)] animate-pulse"
                : busy
                  ? "bg-amber-500 animate-pulse"
                  : "bg-[var(--border)]"
            )}
          />
          Voice mode
        </div>
        <button
          type="button"
          onClick={handleClose}
          className={cn(
            "inline-flex h-9 w-9 items-center justify-center rounded-full",
            "text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
          )}
          aria-label="Close voice mode"
          title="Close (Esc)"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Center stage */}
      <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6">
        {/* Transcript: last exchange */}
        <div className="flex min-h-[5rem] w-full max-w-xl flex-col items-center gap-3 text-center">
          {userText && (
            <p className="text-sm text-[var(--text-muted)]">
              <span className="opacity-60">You: </span>
              {userText}
            </p>
          )}
          {shownReply && (
            <p className="line-clamp-4 text-base text-[var(--text)]">
              {shownReply}
            </p>
          )}
        </div>

        {/* The orb */}
        <button
          type="button"
          onClick={handleOrbTap}
          disabled={phase === "transcribing"}
          className={cn(
            "relative flex h-40 w-40 items-center justify-center rounded-full transition",
            "disabled:cursor-default",
            phase === "listening"
              ? "bg-red-500/15 text-red-500"
              : phase === "speaking"
                ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                : phase === "error"
                  ? "bg-red-500/15 text-red-500"
                  : "bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/15"
          )}
          aria-label={STATUS[phase]}
        >
          {/* Live mic-level ring — scales with the user's voice while
              listening (driven directly via the ref, no React churn). */}
          {phase === "listening" && (
            <div
              ref={levelRingRef}
              className="absolute inset-0 rounded-full bg-red-500/30"
              style={{ transform: "scale(1)", opacity: 0.25 }}
            />
          )}
          {/* Soft pulsing ring while speaking */}
          {phase === "speaking" && (
            <>
              <span className="absolute inset-0 animate-ping rounded-full bg-[var(--accent)]/20 opacity-60" />
              <span className="absolute inset-4 rounded-full bg-[var(--accent)]/10" />
            </>
          )}
          {busy ? (
            <Loader2 className="h-14 w-14 animate-spin" />
          ) : phase === "speaking" ? (
            <Square className="h-12 w-12 fill-current" />
          ) : (
            <Mic className="relative h-14 w-14" />
          )}
        </button>

        {/* Status line */}
        <p
          className={cn(
            "text-sm font-medium",
            phase === "error" ? "text-red-500" : "text-[var(--text-muted)]"
          )}
          role="status"
        >
          {STATUS[phase]}
        </p>

        {!modelReady && (
          <p className="text-xs text-[var(--text-muted)]">
            Configure a model in the Models tab to use voice mode.
          </p>
        )}
      </div>
    </div>,
    document.body
  );
}
