/**
 * Developer harness for the voice engine (Calls WP-V3): join a voice
 * channel and exercise everything the engine does, without the real voice
 * UI (that's WP-V4). Routed at /dev/voice only in a dev build, or when
 * localStorage "promptly.dev" is "voice" (the e2e suite sets it).
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { roomsApi, type Bootstrap } from "@/api/rooms";
import type { StreamQuality } from "@/api/voiceChannels";
import { useMediaDevices } from "@/rtc/devices";
import { fallbackWords } from "@/rtc/audio/engines";
import { voice, voiceEngine } from "@/rtc/voice/actions";
import { allowedQualities, qualityWords, type StreamHint } from "@/rtc/voice/goLive";
import { useMicTest, useVoice, useVoiceLevel, useVoiceLive, useVoiceSettings } from "@/rtc/voice/hooks";
import { seedVoiceChannels } from "@/rtc/voice/liveEvents";
import { ME, useVoiceStore } from "@/rtc/voice/store";
import { personPercent } from "@/rtc/voice/volume";
import { VideoTrackView } from "@/rtc/voice/VideoTrackView";

function Meter({ label, value }: { label: string; value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 w-40 rounded bg-neutral-200 dark:bg-neutral-700">
      <div className="h-2 rounded bg-emerald-500 transition-[width] duration-75" style={{ width: `${pct}%` }} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

const btn = "rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800";

export default function VoiceHarnessPage() {
  useVoiceLive();
  const { data: boot } = useQuery<Bootstrap>({ queryKey: ["dev-voice-bootstrap"], queryFn: () => roomsApi.bootstrap() });
  useEffect(() => {
    if (!boot) return;
    const ids = boot.spaces.flatMap((s) => s.rooms.filter((r) => r.kind === "voice").map((r) => r.id));
    seedVoiceChannels(boot.voice, ids);
  }, [boot]);
  // For the e2e: the engine's debug readings.
  useEffect(() => {
    (window as unknown as { __voice: unknown }).__voice = { store: useVoiceStore, engine: voiceEngine };
  }, []);

  const s = useVoice((v) => ({
    status: v.status,
    roomId: v.roomId,
    session: v.session,
    muted: v.muted,
    deafened: v.deafened,
    serverMuted: v.serverMuted,
    serverDeafened: v.serverDeafened,
    speaking: v.speaking,
    talkingWhileMuted: v.talkingWhileMuted,
    quiet: v.quiet,
    pttActive: v.pttActive,
    canVideo: v.canVideo,
    camera: v.camera,
    cameraTrack: v.cameraTrack,
    live: v.live,
    liveAudio: v.liveAudio,
    liveQuality: v.liveQuality,
    liveTrack: v.liveTrack,
    watching: v.watching,
    streamVolume: v.streamVolume,
    maxStream: v.maxStream,
    peers: v.peers,
    members: v.members,
    noise: v.noise,
    connection: v.connection,
    problem: v.problem,
    notice: v.notice,
    stillThere: v.stillThere,
    channels: v.channels,
    speakingIn: v.speakingIn,
    quality: v.quality,
    bitrate: v.bitrate,
  }));
  const settings = useVoiceSettings();
  const p = settings.prefs;
  const myLevel = useVoiceLevel(ME);
  const devices = useMediaDevices();
  const test = useMicTest();
  const [quality, setQuality] = useState<StreamQuality>(p.stream_quality);
  const [hint, setHint] = useState<StreamHint>(p.stream_hint);
  const name = (uid: string) => boot?.users[uid]?.username ?? uid.slice(0, 8);
  const voiceRooms = boot?.spaces.flatMap((sp) => sp.rooms.filter((r) => r.kind === "voice").map((r) => ({ ...r, space: sp.name }))) ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 text-neutral-900 dark:text-neutral-100">
      <header>
        <h1 className="text-lg font-semibold">Voice engine harness</h1>
        <p className="text-sm text-neutral-500">Developer page for the voice engine. The real voice UI lives in Rooms.</p>
      </header>

      {boot && boot.voice_available === false && <p role="alert">Voice is off for you on this server.</p>}

      <Section title="Channels">
        {voiceRooms.length === 0 && <p className="text-sm text-neutral-500">No voice channels in your spaces.</p>}
        <ul className="space-y-2">
          {voiceRooms.map((r) => {
            const here = s.channels[r.id] ?? [];
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <button type="button" className={btn} onMouseEnter={() => void voice.prepare()} onClick={() => void voice.join(r.id)} aria-label={`Join ${r.name}`}>
                  Join {r.name}
                </button>
                <span className="text-xs text-neutral-500">{r.space}</span>
                <span data-testid={`occupants-${r.name}`} className="text-sm">
                  {here.map((m) => `${name(m.user_id)}${s.speakingIn[r.id]?.[m.user_id] ? " (speaking)" : ""}${m.muted ? " (muted)" : ""}${m.deafened ? " (deafened)" : ""}${m.live ? " (LIVE)" : ""}`).join(", ") || "empty"}
                </span>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Connection">
        <dl className="grid grid-cols-[10rem_1fr] gap-1 text-sm">
          <dt>Status</dt>
          <dd data-testid="voice-status">{s.status}</dd>
          <dt>Channel</dt>
          <dd data-testid="voice-room">{voiceRooms.find((r) => r.id === s.roomId)?.name ?? s.roomId ?? "—"}</dd>
          <dt>Quality</dt>
          <dd>
            {s.quality ?? "—"} {s.bitrate ? `${s.bitrate} kbps` : ""}
          </dd>
          <dt>Noise suppression</dt>
          <dd data-testid="voice-noise">
            {s.noise.pref} → {s.noise.engine}
            {s.noise.load !== null ? ` · ${(s.noise.load * 100).toFixed(1)}% of a core` : ""}
            {s.noise.reason ? ` · ${fallbackWords(s.noise.reason)}` : ""}
          </dd>
          <dt>Network</dt>
          <dd>
            {s.connection.quality} · {s.connection.protocol ?? "?"} · {s.connection.rttMs ?? "?"} ms · loss {s.connection.lossPct ?? "?"}%
          </dd>
        </dl>
        {s.problem && (
          <p role="alert" className="mt-2 text-sm text-red-600">
            {s.problem.kind}: {s.problem.message}{" "}
            <button type="button" className="underline" onClick={() => void voice.dismissProblem()}>
              Dismiss
            </button>
          </p>
        )}
        {s.notice && (
          <p role="status" data-testid="voice-notice" className="mt-2 text-sm">
            {s.notice.kind === "ended" ? `Ended: ${s.notice.reason}` : s.notice.kind === "moved" ? `Moved to ${s.notice.toRoomId}` : `Noise: ${fallbackWords(s.notice.reason)}`}{" "}
            <button type="button" className="underline" onClick={() => void voice.dismissNotice()}>
              OK
            </button>
          </p>
        )}
        {s.stillThere && (
          <p role="alert" className="mt-2 text-sm">
            Still there?{" "}
            <button type="button" className={btn} onClick={() => void voice.answerStillHere()}>
              I'm here
            </button>
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={btn} disabled={s.status === "idle"} onClick={() => void voice.leave()}>
            Leave
          </button>
          {s.status === "lost" && (
            <button type="button" className={btn} onClick={() => void voice.rejoin()}>
              Rejoin
            </button>
          )}
        </div>
      </Section>

      <Section title="You">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={btn} aria-pressed={s.muted} onClick={() => void voice.toggleMute()}>
            {s.muted ? "Unmute" : "Mute"}
          </button>
          <button type="button" className={btn} aria-pressed={s.deafened} onClick={() => void voice.toggleDeafen()}>
            {s.deafened ? "Undeafen" : "Deafen"}
          </button>
          <button
            type="button"
            className={btn}
            aria-pressed={s.pttActive}
            onPointerDown={() => void voice.pushToTalk(true)}
            onPointerUp={() => void voice.pushToTalk(false)}
            onPointerLeave={() => void voice.pushToTalk(false)}
          >
            Hold to talk
          </button>
          <Meter label="My level" value={myLevel} />
          <span data-testid="me-speaking" className="text-sm">
            {s.speaking ? "speaking" : "quiet"}
          </span>
          {s.serverMuted && <span className="text-sm text-red-600">An admin muted you</span>}
          {s.serverDeafened && <span className="text-sm text-red-600">An admin deafened you</span>}
          {s.talkingWhileMuted && <span className="text-sm">You're muted</span>}
          {s.quiet && <span className="text-sm">You might be too quiet</span>}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={btn} disabled={!s.canVideo || s.status !== "connected"} onClick={() => void voice.setCamera(!s.camera)}>
            {s.camera ? "Camera off" : "Camera on"}
          </button>
          <label className="text-sm">
            Stream quality{" "}
            <select value={quality} onChange={(e) => setQuality(e.target.value as StreamQuality)} className="rounded border px-1 dark:bg-neutral-800">
              {allowedQualities(s.maxStream).map((q) => (
                <option key={q} value={q}>
                  {qualityWords(q)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Optimise for{" "}
            <select value={hint} onChange={(e) => setHint(e.target.value as StreamHint)} className="rounded border px-1 dark:bg-neutral-800">
              <option value="motion">Smoother motion</option>
              <option value="detail">Better for text</option>
            </select>
          </label>
          {s.live ? (
            <button type="button" className={btn} onClick={() => void voice.stopLive()}>
              Stop streaming
            </button>
          ) : (
            <button type="button" className={btn} disabled={!s.canVideo || s.status !== "connected"} onClick={() => void voice.startLive({ quality, hint })}>
              Go Live
            </button>
          )}
          {s.live && (
            <span data-testid="live-info" className="text-sm">
              LIVE {s.liveQuality} · {s.liveAudio ? "with sound" : "no sound"}
            </span>
          )}
        </div>
        {(s.cameraTrack || s.liveTrack) && (
          <div className="mt-3 flex gap-2">
            {s.cameraTrack && <VideoTrackView track={s.cameraTrack} label="Your camera" mirror className="h-32 w-48 rounded bg-black" fit="cover" />}
            {s.liveTrack && <VideoTrackView track={s.liveTrack} label="Your stream" className="h-32 w-56 rounded bg-black" />}
          </div>
        )}
      </Section>

      <Section title="People">
        {Object.values(s.peers).length === 0 && <p className="text-sm text-neutral-500">Nobody else is connected.</p>}
        <ul className="space-y-3">
          {Object.values(s.peers).map((peer) => (
            <Peer key={peer.userId} userId={peer.userId} name={name(peer.userId)} />
          ))}
        </ul>
        <h3 className="mt-4 text-xs font-semibold uppercase text-neutral-500">Server's view</h3>
        <ul className="text-sm" data-testid="members">
          {s.members.map((m) => (
            <li key={m.user_id} data-testid={`member-${name(m.user_id)}`}>
              {name(m.user_id)}: {[m.muted && "muted", m.deafened && "deafened", m.server_muted && "server-muted", m.server_deafened && "server-deafened", m.video && "camera", m.live && "LIVE", m.watching && `watching ${name(m.watching)}`].filter(Boolean).join(", ") || "—"}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Settings">
        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <label>
            Input mode{" "}
            <select value={p.input_mode} onChange={(e) => void voice.updatePrefs({ input_mode: e.target.value as "vad" | "ptt" })} className="rounded border px-1 dark:bg-neutral-800">
              <option value="vad">Voice activity</option>
              <option value="ptt">Push to talk</option>
            </select>
          </label>
          <label>
            <input type="checkbox" checked={p.auto_sensitivity} onChange={(e) => void voice.updatePrefs({ auto_sensitivity: e.target.checked })} /> Automatic sensitivity
          </label>
          <label>
            Sensitivity {p.sensitivity_db} dB{" "}
            <input type="range" min={-100} max={0} value={p.sensitivity_db} onChange={(e) => void voice.updatePrefs({ sensitivity_db: Number(e.target.value) })} />
          </label>
          <label>
            Push-to-talk key{" "}
            <input
              readOnly
              value={p.ptt_key}
              className="w-28 rounded border px-1 dark:bg-neutral-800"
              aria-label="Push-to-talk key"
              onKeyDown={(e) => {
                e.preventDefault();
                void voice.updatePrefs({ ptt_key: e.code });
              }}
            />
          </label>
          <label>
            Release delay {p.ptt_release_ms} ms{" "}
            <input type="range" min={0} max={1000} step={10} value={p.ptt_release_ms} onChange={(e) => void voice.updatePrefs({ ptt_release_ms: Number(e.target.value) })} />
          </label>
          <label>
            Noise suppression{" "}
            <select value={p.noise} onChange={(e) => void voice.updatePrefs({ noise: e.target.value as "off" | "standard" | "enhanced" })} className="rounded border px-1 dark:bg-neutral-800" aria-label="Noise suppression">
              <option value="off">Off</option>
              <option value="standard">Standard</option>
              <option value="enhanced">Enhanced</option>
            </select>
          </label>
          <label>
            <input type="checkbox" checked={p.echo} onChange={(e) => void voice.updatePrefs({ echo: e.target.checked })} /> Echo cancellation
          </label>
          <label>
            <input type="checkbox" checked={p.agc} onChange={(e) => void voice.updatePrefs({ agc: e.target.checked })} /> Automatic gain
          </label>
          <label>
            Input volume {p.input_volume}%{" "}
            <input type="range" min={0} max={200} value={p.input_volume} onChange={(e) => void voice.updatePrefs({ input_volume: Number(e.target.value) })} />
          </label>
          <label>
            Output volume {p.output_volume}%{" "}
            <input type="range" min={0} max={200} value={p.output_volume} onChange={(e) => void voice.updatePrefs({ output_volume: Number(e.target.value) })} />
          </label>
          <label>
            <input type="checkbox" checked={p.data_saver} onChange={(e) => void voice.updatePrefs({ data_saver: e.target.checked })} /> Data saver
          </label>
          <label>
            <input type="checkbox" checked={p.sounds} onChange={(e) => void voice.updatePrefs({ sounds: e.target.checked })} /> Sounds
          </label>
          <label>
            Microphone{" "}
            <select onChange={(e) => void voice.setInputDevice(e.target.value)} className="max-w-[14rem] rounded border px-1 dark:bg-neutral-800">
              <option value="">Default</option>
              {devices.mics.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || "Microphone"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Speaker{" "}
            <select onChange={(e) => void voice.setOutputDevice(e.target.value)} className="max-w-[14rem] rounded border px-1 dark:bg-neutral-800">
              <option value="">Default</option>
              {devices.speakers.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || "Speaker"}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Section>

      <Section title="Mic test">
        <div className="flex flex-wrap items-center gap-2">
          {test.running ? (
            <button type="button" className={btn} onClick={test.stop}>
              Stop test
            </button>
          ) : (
            <button type="button" className={btn} disabled={test.starting} onClick={() => void test.start({ loopback: false })}>
              Let's check
            </button>
          )}
          <label className="text-sm">
            <input type="checkbox" checked={test.loopback} disabled={!test.running} onChange={(e) => test.setLoopback(e.target.checked)} /> Hear myself
          </label>
          <Meter label="Mic test level" value={test.reading?.level ?? 0} />
          <span className="text-sm" data-testid="mic-test-engine">
            {test.choice ? test.choice.engine : ""}
            {test.reading ? ` · ${test.reading.open ? "sending" : "gated"} · ${test.reading.db.toFixed(0)} dB` : ""}
          </span>
          {test.error && (
            <span role="alert" className="text-sm text-red-600">
              {test.errorKind}: {test.error}
            </span>
          )}
        </div>
      </Section>
    </div>
  );
}

function Peer({ userId, name }: { userId: string; name: string }) {
  const peer = useVoice((v) => v.peers[userId]);
  const watching = useVoice((v) => v.watching);
  const streamVolume = useVoice((v) => v.streamVolume);
  const level = useVoiceLevel(userId);
  const settings = useVoiceSettings();
  if (!peer) return null;
  const pct = personPercent(userId, settings);
  const mutedForMe = settings.localMutes.includes(userId);
  return (
    <li className="space-y-1" data-testid={`peer-${name}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{name}</span>
        <span>{peer.speaking ? "speaking" : ""}</span>
        <Meter label={`Level of ${name}`} value={level} />
        <label>
          Volume {pct}%{" "}
          <input type="range" min={0} max={200} value={pct} aria-label={`Volume of ${name}`} onChange={(e) => void voice.setPersonVolume(userId, Number(e.target.value))} />
        </label>
        <label>
          <input type="checkbox" checked={mutedForMe} onChange={(e) => void voice.setLocalMute(userId, e.target.checked)} /> Mute for me
        </label>
        {peer.live &&
          (watching === userId ? (
            <button type="button" className={btn} onClick={() => void voice.watch(null)}>
              Stop watching
            </button>
          ) : (
            <button type="button" className={btn} onClick={() => void voice.watch(userId)} aria-label={`Watch ${name}`}>
              Watch
            </button>
          ))}
      </div>
      {watching === userId && (
        <div className="space-y-1">
          {peer.screen ? <VideoTrackView track={peer.screen} label={`${name}'s stream`} className="h-48 w-80 rounded bg-black" /> : <p className="text-sm">Loading stream…</p>}
          <label className="text-sm">
            Stream volume {streamVolume}%{" "}
            <input type="range" min={0} max={200} value={streamVolume} onChange={(e) => void voice.setStreamVolume(Number(e.target.value))} />
          </label>
        </div>
      )}
      {peer.camera && <VideoTrackView track={peer.camera} label={`${name}'s camera`} className="h-24 w-36 rounded bg-black" fit="cover" />}
    </li>
  );
}
