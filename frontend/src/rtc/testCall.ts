/**
 * Test calls: proves the whole path to the calls server from this device.
 *
 * Two connections to the person's own test room (``t_<user id>``): one
 * publishes the microphone, the other only listens, so what you hear back
 * ("Hear yourself") has really gone through the calls server. Reports how
 * it connected (UDP direct / TCP fallback / relay), the round trip, packet
 * loss and, from outside the home, roughly how fast the home's upload is.
 */
import { callsApi, type TestReport } from "@/api/calls";

import { connectionFromStats, loadLiveKit, signalUrl, type ConnectionInfo } from "./livekit";

export type TestStage = "starting" | "connecting" | "listening" | "measuring" | "speed" | "done";

export type TestFailure =
  | "mic-denied"
  | "mic-missing"
  | "not-available"
  | "signal" // couldn't reach the calls service through this site
  | "media" // reached it, but sound couldn't get through
  | "unknown";

export interface TestCallResult {
  ok: boolean;
  failure?: TestFailure;
  message?: string;
  connection: ConnectionInfo;
  connectMs: number | null;
  echoHeard: boolean;
  packetLossPct: number | null;
  downloadMbps: number | null;
  outside: boolean | null;
}

export interface TestCallOptions {
  micDeviceId?: string;
  speakerDeviceId?: string;
  /** Play the echo connection's audio (you hear yourself). */
  hearYourself: boolean;
  measureSpeed: boolean;
  onStage?: (stage: TestStage) => void;
  /** Called once the echo is playing, with its media element. */
  onEcho?: (el: HTMLMediaElement) => void;
}

export interface TestCallSession {
  result: Promise<TestCallResult>;
  /** Hang up both connections (safe to call more than once). */
  stop: () => Promise<void>;
}

function classify(err: unknown): { failure: TestFailure; message: string } {
  const e = err as { name?: string; message?: string; reason?: unknown; response?: { status?: number } };
  const msg = String(e?.message ?? err ?? "");
  if (e?.name === "NotAllowedError" || e?.name === "SecurityError") return { failure: "mic-denied", message: msg };
  if (e?.name === "NotFoundError" || e?.name === "OverconstrainedError") return { failure: "mic-missing", message: msg };
  if (e?.response?.status === 404) return { failure: "not-available", message: msg };
  if (/signal|websocket|could not establish signal|401|unauthorized|failed to fetch/i.test(msg)) return { failure: "signal", message: msg };
  if (/pc connection|ice|peer connection|transport|timed out|timeout/i.test(msg)) return { failure: "media", message: msg };
  return { failure: "unknown", message: msg };
}

export function startTestCall(opts: TestCallOptions): TestCallSession {
  let stopped = false;
  const rooms: { disconnect: () => Promise<void> }[] = [];
  const stop = async () => {
    stopped = true;
    await Promise.all(rooms.splice(0).map((r) => r.disconnect().catch(() => undefined)));
  };

  const run = async (): Promise<TestCallResult> => {
    const base: TestCallResult = {
      ok: false,
      connection: { protocol: null, candidateType: null, serverAddress: null, rttMs: null },
      connectMs: null,
      echoHeard: false,
      packetLossPct: null,
      downloadMbps: null,
      outside: null,
    };
    opts.onStage?.("starting");
    let join;
    let lk;
    try {
      [join, lk] = await Promise.all([callsApi.startTest(), loadLiveKit()]);
    } catch (err) {
      return { ...base, ...classify(err) };
    }
    const { Room, RoomEvent, Track } = lk;
    const url = signalUrl(join.url);
    const capture = {
      deviceId: opts.micDeviceId || undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    const speaker = new Room({ audioCaptureDefaults: capture, disconnectOnPageLeave: true });
    const echo = new Room({ adaptiveStream: false, disconnectOnPageLeave: true });
    rooms.push(speaker, echo);

    try {
      opts.onStage?.("connecting");
      const t0 = performance.now();
      await speaker.connect(url, join.token, { autoSubscribe: false });
      base.connectMs = Math.round(performance.now() - t0);
      if (stopped) return { ...base, failure: "unknown", message: "stopped" };
      await speaker.localParticipant.setMicrophoneEnabled(true, capture);

      opts.onStage?.("listening");
      const heard = new Promise<HTMLMediaElement | null>((resolve) => {
        const timer = window.setTimeout(() => resolve(null), 10_000);
        echo.on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind !== Track.Kind.Audio) return;
          window.clearTimeout(timer);
          const el = track.attach();
          el.muted = !opts.hearYourself;
          if (opts.speakerDeviceId && "setSinkId" in el) {
            (el as HTMLMediaElement & { setSinkId: (id: string) => Promise<void> })
              .setSinkId(opts.speakerDeviceId)
              .catch(() => undefined);
          }
          resolve(el);
        });
      });
      await echo.connect(url, join.echo_token, { autoSubscribe: true });
      const el = await heard;
      base.echoHeard = el !== null;
      if (el) opts.onEcho?.(el);

      opts.onStage?.("measuring");
      // Let the connection settle so the round trip and loss mean something.
      await new Promise((r) => window.setTimeout(r, 2500));
      const mic = speaker.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
      base.connection = connectionFromStats((await mic?.getRTCStatsReport?.()) as never);
      const remote = [...echo.remoteParticipants.values()]
        .flatMap((p) => [...p.trackPublications.values()])
        .find((pub) => pub.track?.kind === Track.Kind.Audio)?.track;
      const inbound = (await remote?.getRTCStatsReport?.()) as RTCStatsReport | undefined;
      inbound?.forEach((s: Record<string, unknown>) => {
        if (s.type === "inbound-rtp" && typeof s.packetsReceived === "number") {
          const lost = Math.max(0, Number(s.packetsLost ?? 0));
          const total = lost + (s.packetsReceived as number);
          base.packetLossPct = total > 0 ? Math.round((lost / total) * 1000) / 10 : 0;
        }
      });
      base.ok = base.echoHeard;
      if (!base.echoHeard) {
        Object.assign(base, { failure: "media" as TestFailure, message: "The test sound never came back from the calls server." });
      }
    } catch (err) {
      Object.assign(base, classify(err));
    }

    if (opts.measureSpeed && !stopped) {
      opts.onStage?.("speed");
      try {
        base.downloadMbps = Math.round((await callsApi.speedtest(8)) * 10) / 10;
      } catch {
        base.downloadMbps = null;
      }
    }

    const report: TestReport = {
      ok: base.ok,
      protocol: base.connection.protocol,
      candidate_type: base.connection.candidateType,
      rtt_ms: base.connection.rttMs,
      packet_loss_pct: base.packetLossPct,
      connect_ms: base.connectMs,
      server_address: base.connection.serverAddress,
      download_mbps: base.downloadMbps,
      error: base.ok ? null : (base.failure ?? "unknown"),
    };
    if (base.failure !== "not-available") {
      try {
        base.outside = (await callsApi.reportTest(report)).outside;
      } catch {
        base.outside = null;
      }
    }
    opts.onStage?.("done");
    if (!base.ok) await stop();
    return base;
  };

  return { result: run(), stop };
}
