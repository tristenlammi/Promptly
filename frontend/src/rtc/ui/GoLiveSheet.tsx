/**
 * Go Live: pick what to share (your whole screen, one window or a browser
 * tab), the quality (up to what the server allows), smoother motion or
 * sharper text, and whether to bring sound — with what browsers can and
 * can't do about sound said plainly.
 */
import { AppWindow, Globe, Monitor, MonitorUp, Volume2, VolumeX } from "lucide-react";
import { useEffect, useState, type ComponentType } from "react";

import type { StreamQuality } from "@/api/voiceChannels";
import { ItemButton, Segmented, Sheet, Toggle } from "@/items/ui";
import { cn } from "@/utils/cn";

import { voice } from "../voice/actions";
import { allowedQualities, capQuality, qualityWords, type StreamHint } from "../voice/goLive";
import { useVoice, useVoiceSettings } from "../voice/hooks";
import { VOICE_ACCENT_STYLE } from "./bits";
import { useVoiceUi } from "./uiStore";

type Surface = "monitor" | "window" | "browser";

const SURFACES: { value: Surface; label: string; hint: string; icon: ComponentType<{ className?: string }> }[] = [
  { value: "monitor", label: "Entire screen", hint: "Everything on one screen", icon: Monitor },
  { value: "window", label: "A window", hint: "One app or game window", icon: AppWindow },
  { value: "browser", label: "A browser tab", hint: "A video, a page, a slideshow", icon: Globe },
];

// Rough upload per viewer at the top layer (the Admin → Calls estimate).
const MBPS: Record<StreamQuality, number> = { "720p30": 2.5, "1080p30": 4.5, "1080p60": 7 };

function browser() {
  const ua = navigator.userAgent;
  const chromium = /Chrome\/|Edg\//.test(ua) && !/OPR\//.test(ua);
  return { chromium, windows: /Windows/.test(ua), mac: /Macintosh|Mac OS X/.test(ua), cros: /CrOS/.test(ua), firefox: /Firefox\//.test(ua) };
}

/** What sound comes with each choice, in this browser. */
export function soundTip(surface: Surface): { works: boolean; text: string } {
  const b = browser();
  if (surface === "browser") {
    if (b.chromium) return { works: true, text: "Tick “Also share tab audio” in the next window to bring the tab's sound." };
    return { works: false, text: "This browser can't share a tab's sound. Chrome or Edge can." };
  }
  if (surface === "monitor") {
    if (b.chromium && (b.windows || b.cros)) return { works: true, text: "Tick “Also share system audio” in the next window to bring your computer's sound." };
    if (b.chromium && b.mac) return { works: false, text: "On a Mac, sound from a whole screen usually can't be shared from a browser. Share a browser tab to bring its sound." };
    return { works: false, text: "This browser can't share your computer's sound with a screen. Chrome or Edge on Windows can." };
  }
  return {
    works: false,
    text: "A single window's sound can't be shared from a browser. For a game with sound, share your entire screen with sound instead (Chrome or Edge on Windows), or share a browser tab.",
  };
}

export function GoLiveSheet() {
  const open = useVoiceUi((s) => s.goLiveOpen);
  const close = useVoiceUi((s) => s.closeGoLive);
  const { maxStream, status, canVideo } = useVoice((s) => ({ maxStream: s.maxStream, status: s.status, canVideo: s.canVideo }));
  const { prefs } = useVoiceSettings();
  const qualities = allowedQualities(maxStream);
  const [surface, setSurface] = useState<Surface>("monitor");
  const [quality, setQuality] = useState<StreamQuality>(() => capQuality(prefs.stream_quality, maxStream));
  const [hint, setHint] = useState<StreamHint>(prefs.stream_hint);
  const [sound, setSound] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuality(capQuality(prefs.stream_quality, maxStream));
    setHint(prefs.stream_hint);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, maxStream]);

  // Left the channel while choosing: nothing to go live in.
  useEffect(() => {
    if (open && (status === "idle" || !canVideo)) close();
  }, [open, status, canVideo, close]);

  const tip = soundTip(surface);
  const start = async () => {
    setBusy(true);
    void voice.updatePrefs({ stream_quality: quality, stream_hint: hint });
    const ok = await voice.startLive({ quality, hint, audio: sound, surface });
    setBusy(false);
    if (ok) close();
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Go Live"
      size="md"
      footer={
        <div className="flex w-full items-center justify-end gap-2" style={VOICE_ACCENT_STYLE}>
          <ItemButton variant="secondary" onClick={close}>
            Cancel
          </ItemButton>
          <ItemButton variant="primary" onClick={() => void start()} disabled={busy} icon={<MonitorUp className="h-4 w-4" />} data-testid="go-live-start">
            {busy ? "Choose in your browser…" : "Go Live"}
          </ItemButton>
        </div>
      }
    >
      <div className="flex flex-col gap-5" style={VOICE_ACCENT_STYLE} data-testid="go-live-sheet">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-xs font-medium text-[var(--text-muted)]">What to share</legend>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="What to share">
            {SURFACES.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={surface === o.value}
                onClick={() => setSurface(o.value)}
                className={cn(
                  "flex flex-col items-center gap-1.5 rounded-xl border p-3 text-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                  surface === o.value
                    ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]"
                    : "border-[var(--border)] hover:bg-[var(--hover)]",
                )}
              >
                <o.icon className="h-6 w-6 text-[var(--text)]" />
                <span className="text-sm font-semibold text-[var(--text)]">{o.label}</span>
                <span className="text-[11px] leading-tight text-[var(--text-muted)]">{o.hint}</span>
              </button>
            ))}
          </div>
          <p className="text-[11px] text-[var(--text-muted)]">Your browser shows its own list next, where you pick the exact screen, window or tab.</p>
        </fieldset>

        <div className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
          {tip.works ? <Volume2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]" /> : <VolumeX className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" />}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-[var(--text)]">{tip.works ? "Sound can come too" : "No sound with this choice"}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]" data-testid="go-live-sound-tip">
              {tip.text}
            </p>
          </div>
          {tip.works && <Toggle label="Share sound" checked={sound} onChange={setSound} />}
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-[var(--text-muted)]">Quality</span>
          <Segmented<StreamQuality>
            className="w-full"
            value={quality}
            onChange={setQuality}
            options={qualities.map((q) => ({ value: q, label: qualityWords(q) }))}
          />
          {qualities.length < 3 && <p className="text-[11px] text-[var(--text-muted)]">Your server's admin allows up to {qualityWords(maxStream)}.</p>}
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-[var(--text-muted)]">Best for</span>
          <Segmented<StreamHint>
            className="w-full"
            value={hint}
            onChange={setHint}
            options={[
              { value: "motion", label: "Smoother motion" },
              { value: "detail", label: "Better for text" },
            ]}
          />
          <p className="text-[11px] text-[var(--text-muted)]">
            {hint === "motion" ? "Games and videos: keeps the picture moving smoothly when the connection is busy." : "Code, documents and slides: keeps text sharp, moving less often if it has to."}
          </p>
        </div>

        <p className="rounded-xl bg-[var(--surface-2)] p-3 text-xs leading-relaxed text-[var(--text-muted)]">
          Viewers press <b className="text-[var(--text)]">Watch</b> to see your stream, so it costs nothing until someone does. Your server sends each
          viewer their own copy, so its upload speed decides how many can watch at full quality: about {MBPS[quality]} Mbps each at {qualityWords(quality)}.
          Anyone it can't keep up with gets a lower quality automatically.
        </p>
      </div>
    </Sheet>
  );
}
