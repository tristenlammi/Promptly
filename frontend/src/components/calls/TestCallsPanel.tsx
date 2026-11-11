import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Headphones, Loader2, Mic, PhoneCall, Video, Volume2, XCircle } from "lucide-react";

import { callsApi } from "@/api/calls";
import { Button } from "@/components/shared/Button";
import { Callout } from "@/components/shared/Callout";
import { saveDevice, savedDevice, testSoundUrl, useLevel, useMediaDevices } from "@/rtc/devices";
import { canChooseSpeaker, connectionWords } from "@/rtc/livekit";
import { startTestCall, type TestCallResult, type TestCallSession, type TestStage } from "@/rtc/testCall";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";

const STAGE_WORDS: Record<TestStage, string> = {
  starting: "Getting ready…",
  connecting: "Connecting to your server's calls service…",
  listening: "Sending your microphone and waiting for it to come back…",
  measuring: "Measuring the connection…",
  speed: "Measuring speed…",
  done: "Done",
};

// Rough per-viewer bitrates (top simulcast layer), as in the admin checklist.
const STREAM_MBPS = { "1080p60": 7, "1080p30": 4.5, "720p30": 2.5 } as const;

function selectClass() {
  return "w-full rounded-input border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
}

/**
 * Account → Voice & video → Test calls. Checks this device's microphone,
 * speaker and camera, then makes a real call to the person's own test room
 * on the calls server and plays them back, and says in plain words how it
 * connected and what to fix if it didn't.
 */
export function TestCallsPanel() {
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");
  const { data: me } = useQuery({ queryKey: ["calls", "me"], queryFn: callsApi.me, staleTime: 30_000 });
  const devices = useMediaDevices();

  const [mic, setMic] = useState(() => savedDevice("mic"));
  const [speaker, setSpeaker] = useState(() => savedDevice("speaker"));
  const [camera, setCamera] = useState(() => savedDevice("camera"));
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [camStream, setCamStream] = useState<MediaStream | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const level = useLevel(micStream);

  const [hearYourself, setHearYourself] = useState(true);
  const [stage, setStage] = useState<TestStage | null>(null);
  const [result, setResult] = useState<TestCallResult | null>(null);
  const [live, setLive] = useState(false);
  const session = useRef<TestCallSession | null>(null);
  const echoEl = useRef<HTMLMediaElement | null>(null);
  const autoStop = useRef<number | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Microphone preview for the level meter.
  const openMic = useCallback(async (deviceId: string) => {
    setMicError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      setMicStream((old) => {
        old?.getTracks().forEach((t) => t.stop());
        return s;
      });
      void devices.refresh();
    } catch (err) {
      const name = (err as { name?: string })?.name;
      setMicError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "denied"
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "missing"
            : "other",
      );
    }
  }, [devices]);

  useEffect(() => () => micStream?.getTracks().forEach((t) => t.stop()), [micStream]);
  useEffect(() => () => camStream?.getTracks().forEach((t) => t.stop()), [camStream]);
  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = camStream;
  }, [camStream]);

  const stopTest = useCallback(async () => {
    if (autoStop.current) window.clearTimeout(autoStop.current);
    autoStop.current = null;
    echoEl.current?.remove();
    echoEl.current = null;
    setLive(false);
    const s = session.current;
    session.current = null;
    await s?.stop();
  }, []);
  useEffect(() => () => void stopTest(), [stopTest]);

  const runTest = async () => {
    await stopTest();
    setResult(null);
    setLive(true);
    const s = startTestCall({
      micDeviceId: mic,
      speakerDeviceId: speaker,
      hearYourself,
      measureSpeed: true,
      onStage: setStage,
      onEcho: (el) => {
        el.setAttribute("aria-hidden", "true");
        document.body.appendChild(el);
        echoEl.current = el;
      },
    });
    session.current = s;
    const r = await s.result;
    setResult(r);
    setStage(null);
    void devices.refresh();
    if (r.ok) {
      // Keep the playback going for a minute so they can listen.
      autoStop.current = window.setTimeout(() => void stopTest(), 60_000);
    } else {
      setLive(false);
    }
  };

  const toggleCamera = async () => {
    if (camStream) {
      setCamStream(null);
      return;
    }
    setCamError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: camera ? { deviceId: { exact: camera } } : true });
      setCamStream(s);
      void devices.refresh();
    } catch (err) {
      const name = (err as { name?: string })?.name;
      setCamError(name === "NotAllowedError" ? "Promptly can't use your camera. Allow it in your browser's site settings." : "No camera found.");
    }
  };

  const playTestSound = async () => {
    const url = testSoundUrl();
    const a = new Audio(url);
    if (speaker && canChooseSpeaker()) {
      try {
        await (a as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> }).setSinkId(speaker);
      } catch {
        /* falls back to the default speaker */
      }
    }
    a.onended = () => URL.revokeObjectURL(url);
    await a.play().catch(() => URL.revokeObjectURL(url));
  };

  // Nothing to test when voice isn't on for this person (admins can test
  // before turning it on).
  if (!me?.can_test) return null;

  const running = stage !== null;

  return (
    <section className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]" aria-labelledby="test-calls-title">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[var(--text-muted)]">
            <PhoneCall className="h-4 w-4" />
          </span>
          <h3 id="test-calls-title" className="text-sm font-semibold">
            Test calls
          </h3>
        </div>
      </header>

      <div className="space-y-5 px-4 py-4">
        <p className="text-xs text-[var(--text-muted)]">
          Check that voice works from this device: your microphone, your speaker, and the connection to your server's calls
          service. Nothing is recorded.
        </p>
        {isAdmin && !me.available && (
          <Callout tone="info" className="text-xs">
            Voice is off for people right now. As an admin you can test it first, then turn it on in{" "}
            <Link to="/admin?tab=calls" className="font-medium text-[var(--accent-text)] underline">
              Admin → Calls
            </Link>
            .
          </Callout>
        )}

        {/* Microphone */}
        <div className="space-y-2">
          <label htmlFor="tc-mic" className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text)]">
            <Mic className="h-3.5 w-3.5" /> Microphone
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 basis-56">
              <select
                id="tc-mic"
                className={selectClass()}
                value={mic}
                onChange={(e) => {
                  setMic(e.target.value);
                  saveDevice("mic", e.target.value);
                  if (micStream) void openMic(e.target.value);
                }}
              >
                <option value="">Default microphone</option>
                {devices.mics
                  .filter((d) => d.deviceId !== "default")
                  .map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Microphone ${i + 1}`}
                    </option>
                  ))}
              </select>
            </div>
            {!micStream && (
              <Button size="sm" variant="secondary" onClick={() => void openMic(mic)}>
                Check my microphone
              </Button>
            )}
          </div>
          {micStream && (
            <div className="flex items-center gap-2">
              <div
                className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--hover)]"
                role="meter"
                aria-label="Microphone level"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(level * 100)}
              >
                <div className="h-full rounded-full bg-[var(--accent-strong)] transition-[width] duration-75" style={{ width: `${Math.round(level * 100)}%` }} />
              </div>
              <span className="w-28 text-right text-[11px] text-[var(--text-muted)]">{level > 0.35 ? "Hearing you" : "Say something"}</span>
            </div>
          )}
          {micError && <MicHelp kind={micError} />}
        </div>

        {/* Speaker */}
        <div className="space-y-2">
          <label htmlFor="tc-speaker" className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text)]">
            <Volume2 className="h-3.5 w-3.5" /> Speaker
          </label>
          <div className="flex flex-wrap items-center gap-2">
            {canChooseSpeaker() && devices.speakers.length > 0 ? (
              <div className="min-w-0 flex-1 basis-56">
                <select
                  id="tc-speaker"
                  className={selectClass()}
                  value={speaker}
                  onChange={(e) => {
                    setSpeaker(e.target.value);
                    saveDevice("speaker", e.target.value);
                  }}
                >
                  <option value="">Default speaker</option>
                  {devices.speakers
                    .filter((d) => d.deviceId !== "default")
                    .map((d, i) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Speaker ${i + 1}`}
                      </option>
                    ))}
                </select>
              </div>
            ) : (
              <span id="tc-speaker" className="flex-1 text-xs text-[var(--text-muted)]">
                This browser plays sound through your device's current speaker.
              </span>
            )}
            <Button size="sm" variant="secondary" onClick={() => void playTestSound()}>
              Play test sound
            </Button>
          </div>
        </div>

        {/* Camera */}
        <div className="space-y-2">
          <label htmlFor="tc-camera" className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text)]">
            <Video className="h-3.5 w-3.5" /> Camera
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 basis-56">
              <select
                id="tc-camera"
                className={selectClass()}
                value={camera}
                onChange={(e) => {
                  setCamera(e.target.value);
                  saveDevice("camera", e.target.value);
                  setCamStream(null);
                }}
              >
                <option value="">Default camera</option>
                {devices.cameras.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Camera ${i + 1}`}
                  </option>
                ))}
              </select>
            </div>
            <Button size="sm" variant="secondary" onClick={() => void toggleCamera()}>
              {camStream ? "Hide preview" : "Show preview"}
            </Button>
          </div>
          {camStream && (
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              aria-label="Camera preview"
              className="aspect-video w-full max-w-xs rounded-card border border-[var(--border)] bg-black object-cover [transform:scaleX(-1)]"
            />
          )}
          {camError && <p className="text-xs text-[var(--danger)]">{camError}</p>}
        </div>

        {/* The call */}
        <div className="space-y-3 rounded-card border border-[var(--border)] p-3">
          <label className="flex items-start gap-2 text-sm text-[var(--text)]">
            <input type="checkbox" className="mt-0.5" checked={hearYourself} onChange={(e) => setHearYourself(e.target.checked)} disabled={running} />
            <span>
              Hear yourself
              <span className="block text-xs text-[var(--text-muted)]">
                <Headphones className="mr-1 inline h-3 w-3" />
                Plays your voice back after it has been to the calls server and back, so you hear what others would. Headphones
                work best.
              </span>
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            {live && !running ? (
              <Button variant="secondary" onClick={() => void stopTest()}>
                Stop
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void runTest()} loading={running} disabled={running} leftIcon={<PhoneCall className="h-4 w-4" />}>
                {result ? "Test again" : "Start test"}
              </Button>
            )}
            {running && stage && (
              <span className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]" role="status">
                <Loader2 className="h-3 w-3 animate-spin" /> {STAGE_WORDS[stage]}
              </span>
            )}
            {live && !running && result?.ok && (
              <span className="text-xs text-[var(--text-muted)]" role="status">
                {hearYourself ? "Talk and listen. Stops by itself after a minute." : "Connected. Stops by itself after a minute."}
              </span>
            )}
          </div>
          {result && <ResultCard result={result} isAdmin={isAdmin} />}
        </div>
      </div>
    </section>
  );
}

function MicHelp({ kind }: { kind: string }) {
  if (kind === "missing")
    return <Callout tone="warning" className="text-xs">No microphone found. Plug one in, or pick another above.</Callout>;
  if (kind === "denied")
    return (
      <Callout tone="warning" className="text-xs">
        Promptly can't use your microphone. Allow it in your browser's site settings: click the icon left of the address
        (a lock or sliders), set Microphone to Allow, then try again. On a phone, also check the browser has microphone
        permission in the phone's settings.
      </Callout>
    );
  return <Callout tone="warning" className="text-xs">Couldn't open the microphone. Another app may be using it.</Callout>;
}

function ResultCard({ result, isAdmin }: { result: TestCallResult; isAdmin: boolean }) {
  const where = result.outside === null ? null : result.outside ? "From outside your home" : "On your home network";
  if (!result.ok) {
    let title = "Couldn't connect from here";
    let fix: React.ReactNode = "Try again in a moment.";
    switch (result.failure) {
      case "mic-denied":
        title = "Promptly can't use your microphone";
        fix = <MicHelp kind="denied" />;
        break;
      case "mic-missing":
        title = "No microphone";
        fix = "Plug one in, or pick another above.";
        break;
      case "not-available":
        title = "Voice isn't on for you";
        fix = "Ask your admin to turn voice on.";
        break;
      case "signal":
        title = "Couldn't reach the calls service";
        fix = isAdmin ? (
          <>
            This site couldn't open a connection to the calls service. Open{" "}
            <Link to="/admin?tab=calls" className="font-medium text-[var(--accent-text)] underline">
              Admin → Calls
            </Link>{" "}
            and check the first items on the list.
          </>
        ) : (
          "This site couldn't open a connection to the calls service. Ask your admin to check Admin → Calls."
        );
        break;
      case "media":
        fix = result.outside
          ? "This device reached the calls service, but sound couldn't get through. Usually the router doesn't forward the calls ports (UDP 7882 and TCP 7881) to the server" +
            (isAdmin ? ". Admin → Calls has the checklist." : "; ask your admin.")
          : "This device reached the calls service, but sound couldn't get through. This network may block the calls ports, or the calls service is advertising the wrong address (LIVEKIT_NODE_IP on Docker Desktop).";
        break;
      default:
        break;
    }
    return (
      <div className="rounded-card border border-[var(--danger-border)] bg-[var(--danger-bg)] p-3 text-sm" role="alert">
        <p className="flex items-center gap-1.5 font-semibold text-[var(--danger)]">
          <XCircle className="h-4 w-4" /> {title}
        </p>
        <div className="mt-1 text-xs text-[var(--text)]">{fix}</div>
        {where && <p className="mt-2 text-[11px] text-[var(--text-muted)]">{where}.</p>}
      </div>
    );
  }
  const words = connectionWords(result.connection);
  const warn = result.connection.protocol === "tcp" || (result.packetLossPct ?? 0) >= 5;
  const facts = [
    result.connection.rttMs !== null ? `Round trip ${result.connection.rttMs} ms` : null,
    result.packetLossPct !== null ? `Packet loss ${result.packetLossPct}%` : null,
    result.connectMs !== null ? `Connected in ${(result.connectMs / 1000).toFixed(1)} s` : null,
  ].filter(Boolean);
  return (
    <div
      className={cn(
        "rounded-card border p-3 text-sm",
        warn ? "border-[var(--warning-border)] bg-[var(--warning-bg)]" : "border-[var(--success-border)] bg-[var(--success-bg)]",
      )}
      role="status"
    >
      <p className={cn("flex items-center gap-1.5 font-semibold", warn ? "text-[var(--warning)]" : "text-[var(--success)]")}>
        {warn ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
        {words.title}
        {where && <span className="font-normal text-[var(--text-muted)]">· {where}</span>}
      </p>
      {words.hint && <p className="mt-1 text-xs text-[var(--text)]">{words.hint}</p>}
      {facts.length > 0 && <p className="mt-1 text-xs text-[var(--text-muted)]">{facts.join(" · ")}</p>}
      {(result.packetLossPct ?? 0) >= 5 && (
        <p className="mt-1 text-xs text-[var(--text)]">Some sound is getting lost on the way. Voices may break up on this network.</p>
      )}
      {result.downloadMbps !== null && result.outside && (
        <p className="mt-2 text-xs text-[var(--text)]">
          Your home's upload is about {Math.round(result.downloadMbps)} Mbps from here: about{" "}
          {Math.floor((result.downloadMbps * 0.8) / STREAM_MBPS["1080p60"])} people can watch a 1080p60 stream at once, or{" "}
          {Math.floor((result.downloadMbps * 0.8) / STREAM_MBPS["720p30"])} at 720p. Voice needs very little.
        </p>
      )}
      {result.downloadMbps !== null && result.outside === false && (
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          Run this test from outside your home (a phone with Wi-Fi off) to check voice works from anywhere and to measure your
          home's upload for streams.
        </p>
      )}
    </div>
  );
}
