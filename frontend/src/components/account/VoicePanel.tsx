import { useEffect, useState } from "react";
import { Check, Loader2, Sparkle, Volume2 } from "lucide-react";

import { authApi } from "@/api/auth";
import { Button } from "@/components/shared/Button";
import { useTextToSpeech } from "@/hooks/useTextToSpeech";
import { useAuthStore } from "@/store/authStore";
import {
  DEFAULT_VOICE_ID,
  VOICE_BY_ID,
  VOICE_GROUPS,
} from "@/data/voices";
import { cn } from "@/utils/cn";

/** Account panel: pick the Kokoro voice used for read-aloud + voice mode.
 *
 * Clicking a voice selects it (persisted to ``users.settings.tts_voice``
 * via ``PATCH /auth/me/preferences``, so it follows the user across
 * devices) AND plays a short sample so they can audition before settling.
 * Optimistic with rollback, matching ``ChatPreferencesPanel``.
 */
export function VoicePanel() {
  const user = useAuthStore((s) => s.user);
  const patchSettings = useAuthStore((s) => s.patchSettings);
  const setUser = useAuthStore((s) => s.setUser);

  const stored =
    typeof user?.settings?.tts_voice === "string" && user.settings.tts_voice
      ? user.settings.tts_voice
      : DEFAULT_VOICE_ID;
  const [selected, setSelected] = useState(stored);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The voice id currently auditioning (drives a per-chip spinner).
  const [previewing, setPreviewing] = useState<string | null>(null);

  const tts = useTextToSpeech();

  // Re-sync the highlighted chip if the cached user changes (another tab,
  // late load).
  useEffect(() => {
    setSelected(stored);
  }, [stored]);

  // Clear the preview indicator once playback ends / stops / fails.
  useEffect(() => {
    if (!tts.speaking && !tts.loading) setPreviewing(null);
  }, [tts.speaking, tts.loading]);

  const handlePick = async (id: string) => {
    setError(null);
    setSelected(id);
    // Audition immediately in the chosen voice.
    setPreviewing(id);
    const name = VOICE_BY_ID[id]?.name ?? "Promptly";
    void tts.speak(
      `Hi, I'm ${name}. This is how I'll sound reading your messages.`,
      { voice: id }
    );

    // Persist (optimistic + rollback).
    const previous = user?.settings?.tts_voice;
    setSaving(true);
    patchSettings({ tts_voice: id });
    try {
      const fresh = await authApi.updatePreferences({ tts_voice: id });
      setUser(fresh);
    } catch (err) {
      patchSettings({ tts_voice: previous as string | undefined });
      setSelected(
        typeof previous === "string" && previous ? previous : DEFAULT_VOICE_ID
      );
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[var(--text-muted)]">
            <Volume2 className="h-4 w-4" />
          </span>
          <h3 className="text-sm font-semibold">Voice</h3>
        </div>
        {(saving || tts.speaking || tts.loading) && (
          <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
            <Loader2 className="h-3 w-3 animate-spin" />
            {saving ? "Saving" : "Playing"}
          </span>
        )}
      </header>

      <div className="space-y-5 px-4 py-4">
        <p className="text-xs text-[var(--text-muted)]">
          The voice Promptly uses when it reads replies aloud and in voice
          mode. Click a voice to select it and hear a sample — your choice is
          saved to your account and follows you across devices. Look for the{" "}
          <span className="inline-flex items-center gap-0.5 font-medium text-[var(--accent)]">
            <Sparkle className="h-3 w-3" /> Calm
          </span>{" "}
          tag for the smoothest, most relaxed voices.
        </p>

        {VOICE_GROUPS.map((group) => (
          <div key={group.label}>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              {group.label}
            </p>
            <div className="flex flex-wrap gap-2">
              {group.voices.map((voice) => {
                const isSelected = selected === voice.id;
                const isPreviewing = previewing === voice.id;
                return (
                  <button
                    key={voice.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => void handlePick(voice.id)}
                    className={cn(
                      "group inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition",
                      isSelected
                        ? "border-[var(--accent)] bg-[var(--accent)]/[0.10] text-[var(--accent)]"
                        : "border-[var(--border)] text-[var(--text)] hover:border-[var(--accent)]/50"
                    )}
                  >
                    {isPreviewing ? (
                      <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                    ) : isSelected ? (
                      <Check className="h-3 w-3 shrink-0" />
                    ) : (
                      <Volume2 className="h-3 w-3 shrink-0 opacity-50 group-hover:opacity-100" />
                    )}
                    <span className="font-medium">{voice.name}</span>
                    {voice.id === DEFAULT_VOICE_ID && (
                      <span className="rounded-full bg-[var(--text-muted)]/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                        Default
                      </span>
                    )}
                    {voice.calm && (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-[var(--accent)]/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--accent)]">
                        <Sparkle className="h-2.5 w-2.5" />
                        Calm
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {error && (
          <div
            role="alert"
            className="rounded-input border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
          >
            Couldn't save your voice: {error}
            <Button
              size="sm"
              variant="ghost"
              className="ml-2"
              onClick={() => setError(null)}
            >
              Dismiss
            </Button>
          </div>
        )}

        <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
          Only English voices are listed — Kokoro's other-language voices
          mispronounce English. All run on your own server.
        </p>
      </div>
    </section>
  );
}
