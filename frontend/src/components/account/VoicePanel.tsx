import { useEffect, useState } from "react";
import { AudioLines, Check, Loader2, Sparkle, Volume2 } from "lucide-react";

import { authApi } from "@/api/auth";
import type { BriefingSection } from "@/api/types";
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
          <span className="inline-flex items-center gap-0.5 font-medium text-[var(--accent-text)]">
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
                        ? "border-[var(--accent)] bg-[var(--accent)]/[0.10] text-[var(--accent-text)]"
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
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-[var(--accent)]/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--accent-text)]">
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
      <TalkSettings />
    </section>
  );
}

type TalkKey = "tts_speed" | "talk_turn_mode" | "talk_interrupt" | "talk_captions" | "talk_save" | "talk_bluetooth_locked";

/** How Talk behaves (WP-T4). Saved in ``users.settings`` like the voice,
 *  so it follows you to the phone and every browser. */
function TalkSettings() {
  const settings = useAuthStore((s) => s.user?.settings);
  const patchSettings = useAuthStore((s) => s.patchSettings);
  const setUser = useAuthStore((s) => s.setUser);
  const [busy, setBusy] = useState<TalkKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const storedSpeed = typeof settings?.tts_speed === "number" ? settings.tts_speed : 1;
  const [speed, setSpeed] = useState(storedSpeed);
  useEffect(() => setSpeed(storedSpeed), [storedSpeed]);

  const save = async (key: TalkKey, value: string | number | boolean) => {
    const previous = settings?.[key];
    setError(null);
    setBusy(key);
    patchSettings({ [key]: value });
    try {
      setUser(await authApi.updatePreferences({ [key]: value }));
    } catch (err) {
      patchSettings({ [key]: previous as never });
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const choice = (
    key: TalkKey,
    label: string,
    hint: string,
    options: [string | boolean, string][],
    current: string | boolean
  ) => (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--text)]" id={`talk-${key}`}>
          {label}
        </p>
        <p className="text-xs text-[var(--text-muted)]">{hint}</p>
      </div>
      <div
        role="radiogroup"
        aria-labelledby={`talk-${key}`}
        className="inline-flex shrink-0 self-start rounded-lg border border-[var(--border)] p-0.5 sm:self-auto"
      >
        {options.map(([value, text]) => (
          <button
            key={String(value)}
            type="button"
            role="radio"
            aria-checked={current === value}
            disabled={busy !== null}
            onClick={() => void save(key, value)}
            className={cn(
              "rounded-md px-3 py-1 text-xs font-medium transition",
              current === value ? "bg-[var(--accent)] text-white" : "text-[var(--text)] hover:bg-[var(--hover)]"
            )}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="space-y-4 border-t border-[var(--border)] px-4 py-4">
      <div className="flex items-center gap-2">
        <AudioLines className="h-4 w-4 text-[var(--text-muted)]" />
        <h4 className="text-sm font-semibold">Talk</h4>
        {busy && <Loader2 className="h-3 w-3 animate-spin text-[var(--text-muted)]" />}
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        Talk is a spoken conversation: tap the orb next to the message box and just talk.
      </p>
      <label className="block">
        <span className="flex items-center justify-between text-sm font-medium text-[var(--text)]">
          Speaking speed
          <span className="text-xs font-normal text-[var(--text-muted)]">{speed.toFixed(2).replace(/0$/, "")}×</span>
        </span>
        <input
          type="range"
          min={0.9}
          max={1.3}
          step={0.05}
          value={speed}
          disabled={busy !== null}
          onChange={(e) => setSpeed(Number(e.target.value))}
          onPointerUp={() => void save("tts_speed", speed)}
          onKeyUp={() => void save("tts_speed", speed)}
          className="mt-1 w-full accent-[var(--accent)]"
        />
      </label>
      {choice(
        "talk_turn_mode",
        "How you take turns",
        "Hands-free answers when you pause. Tap to talk is better in noisy places.",
        [
          ["hands_free", "Hands-free"],
          ["tap", "Tap to talk"],
        ],
        settings?.talk_turn_mode === "tap" ? "tap" : "hands_free"
      )}
      {choice(
        "talk_interrupt",
        "Interrupting",
        "Talk over it to stop it, or only stop it with a tap (handy on loud speakers).",
        [
          ["talk", "Talk over it"],
          ["tap", "Tap to interrupt"],
        ],
        settings?.talk_interrupt === "tap" ? "tap" : "talk"
      )}
      {choice(
        "talk_captions",
        "Captions",
        "Your words and its words on screen as they're said.",
        [
          [true, "On"],
          [false, "Off"],
        ],
        settings?.talk_captions !== false
      )}
      {choice(
        "talk_save",
        "Save voice conversations",
        "For Talk started outside a chat. Temporary ones are gone in an hour and never go into memory.",
        [
          ["chat", "Like any chat"],
          ["temporary", "Temporary"],
        ],
        settings?.talk_save === "temporary" ? "temporary" : "chat"
      )}
      {choice(
        "talk_bluetooth_locked",
        "Bluetooth button on a locked phone",
        "Lets a car's or headset's voice button start Talk on the Android app while your phone is locked. Your email, files, photos and timeline still need an unlock.",
        [
          [true, "Allow"],
          [false, "Unlock first"],
        ],
        settings?.talk_bluetooth_locked === true
      )}
      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          Couldn't save that: {error}
        </p>
      )}
      <BriefingSettings />
    </div>
  );
}

const BRIEFING: { key: BriefingSection; label: string }[] = [
  { key: "weather", label: "Weather" },
  { key: "events", label: "Today's events, and when to leave" },
  { key: "tasks", label: "Tasks due and overdue" },
  { key: "bills", label: "Bills due" },
  { key: "birthdays", label: "Birthdays today and tomorrow" },
  { key: "mail", label: "How many unread emails" },
];

/** What "Read me my day" reads (Talk phase 2). Saved in ``users.settings``. */
function BriefingSettings() {
  const settings = useAuthStore((s) => s.user?.settings);
  const setUser = useAuthStore((s) => s.setUser);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = settings?.briefing_sections ?? BRIEFING.map((b) => b.key);
  // Shown at once; put back if saving fails.
  const [shown, setShown] = useState<BriefingSection[]>(saved);
  const savedKey = saved.join(",");
  useEffect(() => setShown(savedKey ? (savedKey.split(",") as BriefingSection[]) : []), [savedKey]);
  const on = new Set<BriefingSection>(shown);

  const flip = async (key: BriefingSection, next: boolean) => {
    const chosen = BRIEFING.map((b) => b.key).filter((k) => (k === key ? next : on.has(k)));
    const before = shown;
    setShown(chosen);
    setBusy(true);
    setError(null);
    try {
      setUser(await authApi.updatePreferences({ briefing_sections: chosen }));
    } catch (err) {
      setShown(before);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="space-y-1.5 border-t border-[var(--border)] pt-4">
      <legend className="text-sm font-medium text-[var(--text)]">Read me my day</legend>
      <p className="text-xs text-[var(--text-muted)]">
        What the "Read me my day" button on Today (or saying "read me my day" in Talk) reads out. In the car it
        leaves out email.
      </p>
      {BRIEFING.map((b) => (
        <label key={b.key} className="flex items-center gap-2 text-sm text-[var(--text)]">
          <input type="checkbox" checked={on.has(b.key)} disabled={busy} onChange={(e) => void flip(b.key, e.target.checked)} />
          {b.label}
        </label>
      ))}
      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          Couldn't save that: {error}
        </p>
      )}
    </fieldset>
  );
}
