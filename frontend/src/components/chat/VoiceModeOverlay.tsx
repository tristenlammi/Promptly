import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Mic, Square, X } from "lucide-react";

import { VoiceWaveform } from "@/components/voice/VoiceWaveform";
import { commandsApi, type Command as VoiceCommand } from "@/api/commands";
import { useDictation } from "@/hooks/useDictation";
import { apiErrorMessage } from "@/utils/apiError";
import { useTextToSpeech, type TtsStream } from "@/hooks/useTextToSpeech";
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
  // A matched command is running — distinct from "thinking" because no
  // model is involved and it should feel (and look) instant.
  | "running"
  // Waiting on a spoken yes/no for a command that asked first.
  | "confirming"
  | "thinking"
  | "speaking"
  | "error";

/** What counts as "yes" out loud. Anything else cancels: the safe
 *  reading of an ambiguous answer to "shall I open the garage door?" is
 *  no, so this stays a small closed list rather than a fuzzy guess. */
const AFFIRMATIVE = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|confirm|affirmative)/i;

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
  // Active streaming-TTS controller for the in-flight reply (null between
  // turns). Fed sentence-by-sentence as the reply streams so speech starts
  // on sentence 1 instead of waiting for the whole reply.
  const streamCtlRef = useRef<TtsStream | null>(null);

  const tts = useTextToSpeech();
  // A command awaiting a spoken yes/no. Mirrored into a ref because the
  // dictation callback runs inside a stale closure.
  const [pendingCommand, setPendingCommand] = useState<{
    command: VoiceCommand;
    slots: Record<string, string>;
  } | null>(null);
  const pendingRef = useRef<{
    command: VoiceCommand;
    slots: Record<string, string>;
  } | null>(null);
  const [runningCommand, setRunningCommand] = useState(false);
  // Live mic level → drive the orb halo + waveform directly via refs (no
  // React re-render per frame). The halo follows a fast-attack /
  // slow-release envelope of the raw RMS, so it swells with speech and
  // glides back down instead of flickering frame-to-frame.
  const levelRingRef = useRef<HTMLDivElement>(null);
  const rawLevelRef = useRef(0);
  const levelEnvRef = useRef(0);
  const handleLevel = useCallback((level: number) => {
    const raw = Math.min(1, level);
    rawLevelRef.current = raw;
    const env = levelEnvRef.current;
    const next = env + (raw - env) * (raw > env ? 0.3 : 0.06);
    levelEnvRef.current = next;
    const el = levelRingRef.current;
    if (el) {
      el.style.transform = `scale(${1 + next * 0.32})`;
      el.style.opacity = `${0.18 + next * 0.4}`;
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
    // Fresh turn — don't let a stale envelope make the halo jump.
    rawLevelRef.current = 0;
    levelEnvRef.current = 0;
    void startDictation();
  }, [startDictation, modelReady]);

  /** Speak one line, then re-open the mic for the next turn. */
  const say = useCallback(
    (line: string) => {
      void tts.speak(line, { onDone: () => startListening() });
    },
    [tts, startListening]
  );

  /** Run a matched command and say what happened.
   *
   * Deliberately speaks the failure too. Across the room you can't see a
   * toast, and a voice turn that goes quiet is indistinguishable from
   * one that didn't hear you. */
  const runMatched = useCallback(
    async (command: VoiceCommand, slots: Record<string, string>) => {
      setRunningCommand(true);
      try {
        const result = await commandsApi.run(command.id, {
          slots,
          confirmed: true,
        });
        say(
          result.spoken ||
            (result.output ? result.output.slice(0, 200) : `${command.name} done.`)
        );
      } catch (e) {
        say(apiErrorMessage(e, `${command.name} didn't work.`));
      } finally {
        setRunningCommand(false);
      }
    },
    [say]
  );

  // Wire the transcription result: answer a pending confirmation, run a
  // command, or fall through to the model.
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

      // Waiting on a yes/no? Then this turn is the answer, not a new
      // instruction. Anything that isn't clearly affirmative cancels —
      // the safe reading of an ambiguous answer to "shall I open the
      // garage door?" is no.
      const pending = pendingRef.current;
      if (pending) {
        pendingRef.current = null;
        setPendingCommand(null);
        if (AFFIRMATIVE.test(t)) {
          void runMatched(pending.command, pending.slots);
        } else {
          say("Cancelled.");
        }
        return;
      }

      setUserText(t);
      setReplyText("");
      // Drop any stale controller from a barged-in previous turn.
      streamCtlRef.current = null;

      void (async () => {
        // THE FAST PATH. Ask the command library first, and only fall
        // through to the model when nothing matches. A matched command
        // never leaves this network: Whisper transcribed it locally, the
        // matcher is local, the action is a LAN call, and Kokoro speaks
        // the reply — no model, no cloud round trip, no token cost.
        //
        // Failing open is deliberate: if the match call itself errors we
        // carry on to the model rather than dropping the turn, because a
        // voice turn that silently does nothing is the worst outcome
        // when you're across the room and can't see a screen.
        try {
          const found = await commandsApi.match(t);
          if (found.matched && found.command) {
            const command = found.command;
            if (found.needs_confirmation) {
              // Per-command and off by default. Asked out loud, because
              // a dialog is no use to someone across the room.
              pendingRef.current = { command, slots: found.slots };
              setPendingCommand({ command, slots: found.slots });
              say(`${command.name}? Say yes to run it.`);
              return;
            }
            void runMatched(command, found.slots);
            return;
          }
        } catch {
          // Fall through to the model.
        }

        baselineAssistantIdRef.current = lastAssistant()?.id ?? null;
        setThinking(true);
        onSend(t);
      })();
    };
  }, [startListening, onSend, lastAssistant, runMatched, say]);

  // Feed the reply into streaming TTS as it arrives: open a controller on
  // the first tokens, then push the growing text so complete sentences are
  // spoken while the model is still generating the rest.
  useEffect(() => {
    if (!thinking || !streamingContent) return;
    if (!streamCtlRef.current) {
      streamCtlRef.current = tts.speakStream({
        onDone: () => startListening(),
      });
    }
    streamCtlRef.current.push(
      markdownToSpeech(stripInlineCitations(streamingContent))
    );
  }, [thinking, streamingContent, tts, startListening]);

  // Reply finished (or errored) → flush the final text and stop "thinking".
  // The controller's onDone re-opens the mic once playback drains.
  useEffect(() => {
    if (!thinking) return;
    if (streamError) {
      streamCtlRef.current = null;
      tts.stop();
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
    const ctl = streamCtlRef.current;
    streamCtlRef.current = null;
    if (ctl) {
      // Flush whatever hasn't been spoken yet; onDone fires when it drains.
      ctl.end(plain);
    } else {
      // No tokens ever streamed (instant/empty reply) — one-shot fallback.
      if (!plain) {
        startListening();
        return;
      }
      void tts.speak(plain, { onDone: () => startListening() });
    }
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
      streamCtlRef.current = null;
      cancelDictation();
      tts.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClose = useCallback(() => {
    closingRef.current = true;
    streamCtlRef.current = null;
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

  // "speaking" means audio is actually playing. While the first chunk is
  // still being synthesised (tts.loading) we're effectively still thinking,
  // so don't flip the orb to the talking state prematurely.
  const audioPlaying = tts.speaking && !tts.loading;
  const phase: Phase = errorMsg
    ? "error"
    : audioPlaying
      ? "speaking"
      : runningCommand
        ? "running"
        : pendingCommand && dictationStatus !== "recording"
          ? "confirming"
          : thinking || tts.loading
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
        // Barge-in: stop playback, cancel any still-generating reply, talk.
        tts.stop();
        streamCtlRef.current = null;
        onCancelStream();
        setThinking(false);
        startListening();
        break;
      case "thinking":
        onCancelStream();
        streamCtlRef.current = null;
        tts.stop();
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
    // Named for what's happening, not for a spinner. A command run is a
    // different thing from the model thinking, and it should read that
    // way when it takes a fraction of the time.
    running: pendingCommand
      ? `Running ${pendingCommand.command.name}…`
      : "Running…",
    confirming: "Say yes to run it",
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

        {/* The orb — warm gradient like the marketing site's voice demo.
            State reads through the halo/rings/waveform rather than harsh
            colour swaps: a level-following halo while listening, soft
            expanding rings while either side is talking. */}
        <button
          type="button"
          onClick={handleOrbTap}
          disabled={phase === "transcribing"}
          className={cn(
            "promptly-voice-orb relative flex h-36 w-36 items-center justify-center rounded-full text-white",
            "transition-[transform,opacity,box-shadow] duration-300 hover:scale-[1.03]",
            "disabled:cursor-default",
            busy && "opacity-80",
            phase === "idle" && "opacity-90",
            phase === "error" && "ring-4 ring-red-500/30"
          )}
          aria-label={STATUS[phase]}
        >
          {/* Live mic-level halo — swells with the (envelope-smoothed)
              voice while listening; driven via the ref, no React churn. */}
          {phase === "listening" && (
            <div
              ref={levelRingRef}
              className="absolute -inset-1.5 rounded-full bg-[var(--accent)]/25"
              style={{ transform: "scale(1)", opacity: 0.18 }}
            />
          )}
          {/* Soft expanding halo rings while either side is talking. */}
          {active && (
            <>
              <span className="promptly-orb-ring" />
              <span className="promptly-orb-ring promptly-orb-ring--late" />
            </>
          )}
          {busy ? (
            <Loader2 className="relative h-12 w-12 animate-spin" />
          ) : phase === "speaking" ? (
            <Square className="relative h-10 w-10 fill-current" />
          ) : (
            <Mic className="relative h-12 w-12" />
          )}
        </button>

        {/* Live waveform — mic-driven while listening, a gentle synthetic
            swell while the reply is being read aloud, settled otherwise. */}
        <VoiceWaveform
          mode={
            phase === "listening"
              ? "live"
              : phase === "speaking"
                ? "ambient"
                : "idle"
          }
          levelRef={rawLevelRef}
          bars={26}
          className="h-10 w-56"
          barClassName="w-[4px] rounded-full bg-[var(--accent)] opacity-90"
        />

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
