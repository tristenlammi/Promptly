import { useState } from "react";
import { Loader2, Square, Volume2, X } from "lucide-react";

import { todayApi, type Briefing } from "@/api/today";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";
import { useAuthStore } from "@/store/authStore";
import { apiErrorMessage } from "@/utils/apiError";

/**
 * "Read me my day" (Talk phase 2, WP-T12): a button next to Today's Talk button.
 * It asks the server for the briefing (written from Today's own sections, no AI
 * call), reads it out in your Talk voice, and shows it as captions while it
 * plays. Nothing plays unless you press it.
 */
export function ReadMyDayButton() {
  const tts = useTextToSpeech();
  const settings = useAuthStore((s) => s.user?.settings);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const playing = tts.speaking || tts.loading;

  const start = async () => {
    if (playing || fetching) {
      tts.stop();
      return;
    }
    setError(null);
    setFetching(true);
    try {
      const b = await todayApi.briefing();
      setBriefing(b);
      const speed = typeof settings?.tts_speed === "number" ? settings.tts_speed : undefined;
      void tts.speak(b.script, { speed });
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't read your day just now."));
    } finally {
      setFetching(false);
    }
  };

  const close = () => {
    tts.stop();
    setBriefing(null);
    setError(null);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void start()}
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 text-xs font-semibold text-[var(--text)] transition hover:bg-[var(--hover)]"
        aria-label={playing ? "Stop reading your day" : "Read me my day"}
        data-testid="read-my-day"
      >
        {fetching ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : playing ? (
          <Square className="h-3 w-3" />
        ) : (
          <Volume2 className="h-3.5 w-3.5" />
        )}
        <span className="hidden sm:inline">{playing ? "Stop" : "Read me my day"}</span>
      </button>
      {(briefing || error) && (
        <div
          role="region"
          aria-label="Your day, read out"
          aria-live="polite"
          data-testid="read-my-day-captions"
          className="fixed inset-x-4 bottom-4 z-40 mx-auto max-w-lg rounded-card border border-[var(--border)] bg-[var(--surface)] p-4 shadow-lg md:bottom-6"
        >
          <div className="mb-2 flex items-center gap-2">
            <Volume2 className="h-4 w-4 text-[var(--accent-text)]" />
            <p className="flex-1 text-sm font-semibold text-[var(--text)]">
              {error ? "Read me my day" : playing ? "Reading your day" : "Your day"}
            </p>
            {playing && (
              <button type="button" onClick={() => tts.stop()} className="rounded-md px-2 py-1 text-xs font-medium text-[var(--text)] hover:bg-[var(--hover)]">
                Stop
              </button>
            )}
            <button type="button" onClick={close} aria-label="Close" className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--hover)]">
              <X className="h-4 w-4" />
            </button>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-[var(--danger)]">
              {error}
            </p>
          ) : briefing ? (
            <div className="space-y-1.5 text-sm text-[var(--text)]">
              <p className="text-[var(--text-muted)]">{briefing.greeting}.</p>
              {briefing.sections.length ? (
                briefing.sections.map((s) => <p key={s.key}>{s.text}</p>)
              ) : (
                <p>There's nothing on today.</p>
              )}
              {tts.error && <p className="text-xs text-[var(--danger)]">{tts.error}</p>}
              {briefing.sections.some((s) => s.key === "weather") && (
                <p className="pt-1 text-[11px] text-[var(--text-muted)]">
                  Weather from{" "}
                  <a href="https://open-meteo.com/" target="_blank" rel="noreferrer" className="underline">
                    Open-Meteo
                  </a>
                </p>
              )}
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}
