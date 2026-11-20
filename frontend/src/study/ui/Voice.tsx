import { useQuery } from "@tanstack/react-query";
import { Mic, Square, Volume2 } from "lucide-react";
import { useEffect, useRef } from "react";

import { studyApi, type VoiceSupport } from "@/api/study";
import { useDictation } from "@/hooks/useDictation";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";
import { cn } from "@/utils/cn";

/*
 * Voice in lessons: a step read aloud, a written answer spoken. Both use
 * the app's own voice pieces and both are hidden when this server doesn't
 * run them (GET /study/voice) or the browser can't do it.
 */

const NONE: VoiceSupport = { listen: false, speak: false };

/** What voice this server offers. Nothing while the answer isn't in, or on an error. */
export function useVoiceSupport(): VoiceSupport {
  const q = useQuery({ queryKey: ["study", "voice"], queryFn: studyApi.voice, staleTime: 120_000, retry: false });
  return q.data ?? NONE;
}

const LISTEN_KEY = "promptly.study.listen";

/** "Read steps to me": remembered on this device. */
export function readListenPref(): boolean {
  try {
    return window.localStorage.getItem(LISTEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeListenPref(on: boolean): void {
  try {
    window.localStorage.setItem(LISTEN_KEY, on ? "1" : "0");
  } catch {
    // Private mode: it just isn't remembered.
  }
}

/**
 * The read-aloud button. ``text`` is what it says; when ``auto`` is on, a new
 * ``speakKey`` (a new step) is read without being asked.
 */
export function ReadAloud({ text, speakKey, auto, className }: { text: string; speakKey: string; auto: boolean; className?: string }) {
  const tts = useTextToSpeech();
  const latest = useRef({ text, tts });
  latest.current = { text, tts };
  // A new step: stop the last one, and read this one if they asked for that.
  useEffect(() => {
    const { tts: t, text: say } = latest.current;
    t.stop();
    if (auto && say) void t.speak(say);
    return () => latest.current.tts.stop();
    // Only when the step (or the setting) changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speakKey, auto]);
  if (!tts.supported || !text) return null;
  const on = tts.speaking || tts.loading;
  return (
    <button
      type="button"
      onClick={() => (on ? tts.stop() : void tts.speak(text))}
      aria-pressed={on}
      aria-label={on ? "Stop reading" : "Read this aloud"}
      title={on ? "Stop reading" : "Read this aloud"}
      data-testid="study-read-aloud"
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)]",
        on ? "bg-[var(--st-soft)] text-[var(--st-accent-text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]",
        className
      )}
    >
      {on ? <Square className="h-4 w-4" aria-hidden /> : <Volume2 className="h-5 w-5" aria-hidden />}
    </button>
  );
}

/** The mic on a written answer: tap, speak, tap again; the words are added. */
export function DictateButton({ onText, disabled }: { onText: (spoken: string) => void; disabled?: boolean }) {
  const d = useDictation({ onFinal: onText });
  if (!d.supported) return null;
  const working = d.status === "transcribing";
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        onClick={d.toggle}
        disabled={disabled || working}
        aria-pressed={d.isRecording}
        aria-label={d.isRecording ? "Stop and add what you said" : "Speak your answer"}
        data-testid="study-dictate"
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--st-accent)] disabled:opacity-60",
          d.isRecording ? "border-[var(--st-bad)] bg-[var(--st-bad-bg)] text-[var(--st-bad)]" : "border-[var(--border)] text-[var(--text)] hover:border-[var(--st-accent)]"
        )}
      >
        {d.isRecording ? <Square className="h-3.5 w-3.5" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
        {d.isRecording ? "Stop" : working ? "Writing it down…" : "Speak"}
      </button>
      {d.error && (
        <span role="alert" className="text-xs text-[var(--st-bad)]">
          {d.error}
        </span>
      )}
    </span>
  );
}
