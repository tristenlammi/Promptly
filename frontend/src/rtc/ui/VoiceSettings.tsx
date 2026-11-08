/**
 * Voice & video settings (Account → Voice & video, and ⚙ in the voice
 * panel): devices, "Let's check" with a meter and hearing yourself, input
 * mode (voice activity or push to talk), noise suppression, echo and
 * gain, cameras and Go Live defaults, data saver and sounds. Device
 * choices stay on this browser; everything else follows you.
 */
import { Gamepad2, Headphones, Keyboard, Loader2, Mic, MonitorUp, Play, Square, Video, Volume2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ItemButton, Segmented, Select, Sheet, Toggle } from "@/items/ui";
import { cn } from "@/utils/cn";

import { fallbackWords, type NoisePref } from "../audio/engines";
import { savedDevice, testSoundUrl, useMediaDevices } from "../devices";
import { canChooseSpeaker } from "../livekit";
import { voice } from "../voice/actions";
import { allowedQualities, qualityWords, type StreamHint } from "../voice/goLive";
import { useMicTest, useVoice, useVoiceLevel, useVoiceSettings } from "../voice/hooks";
import type { VoicePrefs } from "../voice/prefs";
import { ACCENT, VOICE_ACCENT_STYLE } from "./bits";
import { useVoiceUi } from "./uiStore";
import { keyName, permissionSteps, SHORTCUTS } from "./words";

const NOISE: { value: NoisePref; label: string; text: string }[] = [
  { value: "enhanced", label: "Enhanced", text: "Removes keyboards, dogs, fans and background noise on your device. Recommended." },
  { value: "standard", label: "Standard", text: "Your browser's own filter: good on steady hum and fans, less so on clicks and barks." },
  { value: "off", label: "Off", text: "Nothing filtered. For a studio mic or music." },
];

function Row({ title, text, children }: { title: ReactNode; text?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[var(--text)]">{title}</p>
        {text && <p className="mt-0.5 text-xs leading-relaxed text-[var(--text-muted)]">{text}</p>}
      </div>
      {children}
    </div>
  );
}

function Group({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3" aria-label={title}>
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
        <span className="text-[var(--text-muted)]">{icon}</span>
        {title}
      </h3>
      <div className="divide-y divide-[var(--border)]">{children}</div>
    </section>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 py-2.5">
      <span className="flex justify-between text-sm">
        <span className="font-medium text-[var(--text)]">{label}</span>
        <span className="tabular-nums text-[var(--text-muted)]">
          {value}
          {unit}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-valuetext={`${value}${unit}`}
        className="w-full"
        style={{ accentColor: ACCENT }}
      />
    </label>
  );
}

/** A meter (-60..0 dB) with the voice-activity threshold drawn on it. */
function Meter({ db, thresholdDb, open, label }: { db: number | null; thresholdDb?: number | null; open?: boolean; label: string }) {
  const pct = db === null ? 0 : Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  const th = thresholdDb === null || thresholdDb === undefined ? null : Math.max(0, Math.min(100, ((thresholdDb + 60) / 60) * 100));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className="relative h-2.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)]"
    >
      <div className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-75" style={{ width: `${pct}%`, background: open === false ? "var(--warning)" : "var(--success)" }} />
      {th !== null && <div className="absolute inset-y-0 w-0.5 bg-[var(--text)]" style={{ left: `${th}%` }} aria-hidden />}
    </div>
  );
}

function KeybindButton({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  const [listening, setListening] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!listening) return;
    const key = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setListening(false);
        return;
      }
      onChange(e.code);
      setListening(false);
    };
    const mouse = (e: MouseEvent) => {
      // Side buttons only: a left / right click is just a click.
      if (e.button >= 3) {
        e.preventDefault();
        onChange(`Mouse${e.button}`);
        setListening(false);
      } else if (e.target !== btn.current) setListening(false);
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("mousedown", mouse, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("mousedown", mouse, true);
    };
  }, [listening, onChange]);
  return (
    <button
      ref={btn}
      type="button"
      onClick={() => setListening((v) => !v)}
      aria-label={listening ? "Press the key to use for push to talk (Escape to cancel)" : `Push to talk key: ${keyName(value)}. Change`}
      className={cn(
        "inline-flex h-10 min-w-[9rem] items-center justify-center gap-2 rounded-xl border px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        listening ? "border-[var(--danger)] text-[var(--danger)]" : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)]",
      )}
      data-testid="ptt-keybind"
    >
      <Keyboard className="h-4 w-4" />
      {listening ? "Press a key…" : <kbd className="font-mono">{keyName(value)}</kbd>}
    </button>
  );
}

export function VoiceSettings() {
  const { prefs } = useVoiceSettings();
  const devices = useMediaDevices();
  const s = useVoice((v) => ({ noise: v.noise, status: v.status, maxStream: v.maxStream, speaking: v.speaking }));
  const inVoice = s.status === "connected";
  const myLevel = useVoiceLevel("me");
  const test = useMicTest();
  const [mic, setMic] = useState(() => savedDevice("mic"));
  const [speaker, setSpeaker] = useState(() => savedDevice("speaker"));
  const [camera, setCamera] = useState(() => savedDevice("camera"));
  const [hear, setHear] = useState(false);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);

  const set = (patch: Partial<VoicePrefs>) => void voice.updatePrefs(patch);

  useEffect(() => {
    if (video.current) video.current.srcObject = preview;
  }, [preview]);
  useEffect(() => () => preview?.getTracks().forEach((t) => t.stop()), [preview]);
  // Labels come once a device was allowed.
  useEffect(() => {
    if (test.running) void devices.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [test.running]);

  const reading = test.reading;
  const meterDb = reading ? reading.db : inVoice ? myLevel * 60 - 60 : null;
  const thresholdDb = prefs.input_mode === "vad" ? (prefs.auto_sensitivity ? (reading?.thresholdDb ?? null) : prefs.sensitivity_db) : null;
  const noiseReason = s.noise.pref === "enhanced" && s.noise.reason ? s.noise.reason : test.choice?.reason ?? null;
  const maxStream = inVoice ? s.maxStream : "1080p60";

  const togglePreview = async () => {
    if (preview) {
      setPreview(null);
      return;
    }
    setPreviewErr(null);
    try {
      setPreview(await navigator.mediaDevices.getUserMedia({ video: { deviceId: camera ? { exact: camera } : undefined } }));
      void devices.refresh();
    } catch (err) {
      const name = (err as { name?: string })?.name;
      setPreviewErr(name === "NotAllowedError" ? `Your browser blocked the camera. ${permissionSteps()}` : "No camera could be started.");
    }
  };

  return (
    <div className="flex flex-col gap-4" style={VOICE_ACCENT_STYLE} data-testid="voice-settings">
      <Group title="Microphone and speaker" icon={<Mic className="h-4 w-4" />}>
        <div className="grid gap-3 py-2.5 md:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-[var(--text-muted)]">Microphone</span>
            <Select
              value={mic}
              onChange={(e) => {
                setMic(e.target.value);
                void voice.setInputDevice(e.target.value);
                if (test.running) void test.start({ loopback: hear, micId: e.target.value });
              }}
            >
              <option value="">Default microphone</option>
              {devices.mics.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone ${i + 1}`}
                </option>
              ))}
            </Select>
          </label>
          {canChooseSpeaker() ? (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-[var(--text-muted)]">Speaker</span>
              <Select
                value={speaker}
                onChange={(e) => {
                  setSpeaker(e.target.value);
                  void voice.setOutputDevice(e.target.value);
                }}
              >
                <option value="">Default speaker</option>
                {devices.speakers.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Speaker ${i + 1}`}
                  </option>
                ))}
              </Select>
            </label>
          ) : (
            <p className="self-end text-xs text-[var(--text-muted)]">This browser plays through your device's current speaker.</p>
          )}
        </div>
        {!devices.labelled && devices.mics.length > 0 && (
          <p className="pb-2 text-[11px] text-[var(--text-muted)]">Device names show once you've allowed the microphone (press Let's check).</p>
        )}
        <Slider label="Input volume" value={prefs.input_volume} min={0} max={200} step={5} unit="%" onChange={(v) => set({ input_volume: v })} />
        <Slider label="Output volume" value={prefs.output_volume} min={0} max={200} step={5} unit="%" onChange={(v) => set({ output_volume: v })} />
        <div className="flex flex-col gap-2 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <ItemButton
              variant={test.running ? "secondary" : "primary"}
              size="sm"
              icon={test.starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : test.running ? <Square className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
              onClick={() => (test.running ? test.stop() : void test.start({ loopback: hear, micId: mic, speakerId: speaker }))}
            >
              {test.running ? "Stop checking" : "Let's check"}
            </ItemButton>
            <label className="inline-flex items-center gap-2 text-xs text-[var(--text)]">
              <input
                type="checkbox"
                checked={hear}
                onChange={(e) => {
                  setHear(e.target.checked);
                  if (test.running) test.setLoopback(e.target.checked);
                }}
                style={{ accentColor: ACCENT }}
              />
              <Headphones className="h-3.5 w-3.5 text-[var(--text-muted)]" /> Hear yourself
            </label>
            <ItemButton
              variant="ghost"
              size="sm"
              icon={<Play className="h-3.5 w-3.5" />}
              onClick={() => {
                const a = new Audio(testSoundUrl()) as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
                a.volume = Math.min(1, prefs.output_volume / 100);
                if (speaker && a.setSinkId) void a.setSinkId(speaker).catch(() => undefined);
                void a.play().catch(() => undefined);
              }}
            >
              Play test sound
            </ItemButton>
          </div>
          <Meter db={meterDb} thresholdDb={thresholdDb} open={reading?.open} label="Your microphone level" />
          <p className="text-[11px] text-[var(--text-muted)]">
            {test.running
              ? hear
                ? "This is how you sound to others, after noise suppression. Use headphones, or you'll hear an echo."
                : "Talk normally: the bar should move past the line when you speak."
              : test.errorKind === "mic-denied"
                ? `Your browser blocked the microphone. ${permissionSteps()}`
                : test.errorKind === "mic-missing"
                  ? "No microphone found. Plug one in and try again."
                  : test.errorKind
                    ? "Your microphone didn't start. Another app may be using it."
                    : inVoice
                      ? "This is your microphone in the channel now."
                      : "Press Let's check to see and hear your microphone."}
          </p>
        </div>
      </Group>

      <Group title="Input mode" icon={<Volume2 className="h-4 w-4" />}>
        <div className="py-2.5">
          <Segmented<"vad" | "ptt">
            className="w-full"
            value={prefs.input_mode}
            onChange={(v) => set({ input_mode: v })}
            options={[
              { value: "vad", label: "Voice activity" },
              { value: "ptt", label: "Push to talk" },
            ]}
          />
        </div>
        {prefs.input_mode === "vad" ? (
          <>
            <Row title="Automatically set sensitivity" text="Sends your voice when you talk and ignores keyboards and background noise.">
              <Toggle label="Automatically set sensitivity" checked={prefs.auto_sensitivity} onChange={(v) => set({ auto_sensitivity: v })} />
            </Row>
            {!prefs.auto_sensitivity && (
              <div className="py-2.5">
                <Slider label="Input sensitivity" value={prefs.sensitivity_db} min={-60} max={0} unit=" dB" onChange={(v) => set({ sensitivity_db: v })} />
                <p className="text-[11px] text-[var(--text-muted)]">
                  Your voice is sent when the meter above passes the line. If you're cut off, move it left; if background noise gets through, move it right.
                </p>
              </div>
            )}
          </>
        ) : (
          <>
            <Row title="Push to talk key" text="Hold it to talk. Works while a Promptly window is focused: browsers can't hear keys pressed in other apps.">
              <KeybindButton value={prefs.ptt_key} onChange={(code) => set({ ptt_key: code })} />
            </Row>
            <div className="flex items-start gap-2 py-2.5 text-xs leading-relaxed text-[var(--text-muted)]" data-testid="ptt-game-tip">
              <Gamepad2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <p>
                Playing a game or working in another app? Voice activity keeps working there, and Enhanced noise suppression filters
                out most keyboard and mouse clicks.{" "}
                <button
                  type="button"
                  onClick={() => set({ input_mode: "vad" })}
                  className="rounded font-medium text-[var(--accent-text)] underline underline-offset-2 hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  data-testid="use-voice-activity"
                >
                  Use voice activity instead
                </button>
              </p>
            </div>
            <Slider label="Release delay" value={prefs.ptt_release_ms} min={0} max={1000} step={20} unit=" ms" onChange={(v) => set({ ptt_release_ms: v })} />
          </>
        )}
      </Group>

      <Group title="Noise and echo" icon={<Headphones className="h-4 w-4" />}>
        <div className="flex flex-col gap-2 py-2.5" role="radiogroup" aria-label="Noise suppression">
          <p className="text-sm font-medium text-[var(--text)]">Noise suppression</p>
          {NOISE.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={prefs.noise === o.value}
              onClick={() => set({ noise: o.value })}
              className={cn(
                "flex items-start gap-3 rounded-xl border px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                prefs.noise === o.value ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]" : "border-[var(--border)] hover:bg-[var(--hover)]",
              )}
            >
              <span
                className={cn("mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2", prefs.noise === o.value ? "border-[var(--accent)] bg-[var(--accent)]" : "border-[var(--border)]")}
                aria-hidden
              />
              <span>
                <span className="block text-sm font-medium text-[var(--text)]">{o.label}</span>
                <span className="block text-xs text-[var(--text-muted)]">{o.text}</span>
              </span>
            </button>
          ))}
          {prefs.noise === "enhanced" && noiseReason && (
            <p className="text-xs text-[var(--warning)]" data-testid="noise-fallback">
              {fallbackWords(noiseReason)}
            </p>
          )}
        </div>
        <Row title="Echo cancellation" text="Stops others hearing themselves through your speakers. Turn it off only if you use headphones.">
          <Toggle label="Echo cancellation" checked={prefs.echo} onChange={(v) => set({ echo: v })} />
        </Row>
        <Row title="Automatic gain control" text="Evens out your volume when you lean in or away.">
          <Toggle label="Automatic gain control" checked={prefs.agc} onChange={(v) => set({ agc: v })} />
        </Row>
      </Group>

      <Group title="Camera and Go Live" icon={<Video className="h-4 w-4" />}>
        <div className="flex flex-col gap-2 py-2.5">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-[var(--text-muted)]">Camera</span>
            <Select
              value={camera}
              onChange={(e) => {
                setCamera(e.target.value);
                void voice.setCameraDevice(e.target.value);
                if (preview) setPreview(null);
              }}
            >
              <option value="">Default camera</option>
              {devices.cameras.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Camera ${i + 1}`}
                </option>
              ))}
            </Select>
          </label>
          <div className="flex items-center gap-3">
            <ItemButton variant="secondary" size="sm" icon={<Video className="h-3.5 w-3.5" />} onClick={() => void togglePreview()}>
              {preview ? "Stop preview" : "Preview camera"}
            </ItemButton>
            {previewErr && <span className="text-xs text-[var(--danger)]">{previewErr}</span>}
          </div>
          {preview && <video ref={video} autoPlay playsInline muted className="aspect-video w-full max-w-sm rounded-xl bg-black object-cover" style={{ transform: "scaleX(-1)" }} aria-label="Camera preview" />}
        </div>
        <div className="flex flex-col gap-2 py-2.5">
          <span className="flex items-center gap-2 text-sm font-medium text-[var(--text)]">
            <MonitorUp className="h-4 w-4 text-[var(--text-muted)]" /> Go Live quality
          </span>
          <Segmented
            className="w-full"
            value={prefs.stream_quality}
            onChange={(v) => set({ stream_quality: v })}
            options={allowedQualities(maxStream).map((q) => ({ value: q, label: qualityWords(q) }))}
          />
          <Segmented<StreamHint>
            className="w-full"
            value={prefs.stream_hint}
            onChange={(v) => set({ stream_hint: v })}
            options={[
              { value: "motion", label: "Smoother motion" },
              { value: "detail", label: "Better for text" },
            ]}
          />
        </div>
        <Row title="Data saver" text="No cameras, and streams only when you press Watch, at a lower quality. Good on mobile data or a weak connection.">
          <Toggle label="Data saver" checked={prefs.data_saver} onChange={(v) => set({ data_saver: v })} />
        </Row>
      </Group>

      <Group title="Sounds and shortcuts" icon={<Keyboard className="h-4 w-4" />}>
        <Row title="Voice sounds" text="A soft chime when you or others join or leave, and when you mute, deafen or go live.">
          <Toggle label="Voice sounds" checked={prefs.sounds} onChange={(v) => set({ sounds: v })} />
        </Row>
        <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 py-2.5 text-sm">
          <dt className="text-[var(--text-muted)]">Mute / unmute</dt>
          <dd>
            <kbd className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-1.5 font-mono text-xs">{SHORTCUTS.mute}</kbd>
          </dd>
          <dt className="text-[var(--text-muted)]">Deafen / undeafen</dt>
          <dd>
            <kbd className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-1.5 font-mono text-xs">{SHORTCUTS.deafen}</kbd>
          </dd>
          {prefs.input_mode === "ptt" && (
            <>
              <dt className="text-[var(--text-muted)]">Push to talk</dt>
              <dd>
                <kbd className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-1.5 font-mono text-xs">{keyName(prefs.ptt_key)}</kbd>
              </dd>
            </>
          )}
        </dl>
      </Group>
    </div>
  );
}

/** Voice & video settings over any page (⚙ in the voice panel). */
export function VoiceSettingsSheet() {
  const open = useVoiceUi((s) => s.settingsOpen);
  const close = useVoiceUi((s) => s.closeSettings);
  return (
    <Sheet open={open} onClose={close} title="Voice & video settings" size="lg">
      {open && <VoiceSettings />}
    </Sheet>
  );
}

/** Account → Voice & video. */
export function VoiceSettingsPanel() {
  return (
    <section className="space-y-3">
      <header>
        <h2 className="text-base font-semibold text-[var(--text)]">Voice channels</h2>
        <p className="text-xs text-[var(--text-muted)]">How you sound and what you hear in Rooms voice channels. Your choices follow you to every device; microphone, speaker and camera are per device.</p>
      </header>
      <VoiceSettings />
    </section>
  );
}
