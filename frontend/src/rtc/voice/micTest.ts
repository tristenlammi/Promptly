/**
 * "Let's check" (Voice & video settings): your microphone through the same
 * pipeline as a call (noise suppression, gain, the gate), with a live
 * meter and, optionally, played back to you so you hear yourself exactly
 * as others will. Doesn't need the calls server.
 */
import { savedDevice } from "../devices";
import { captureProcessing, chooseEngine, rememberedOverloads, type EngineChoice } from "../audio/engines";
import { audioCaps, createVoiceContext, MicPipeline } from "../audio/pipeline";
import type { VoicePrefs } from "./prefs";

export interface MicTest {
  pipeline: MicPipeline | null;
  choice: EngineChoice;
  /** Hear yourself (use headphones, or it feeds back). */
  setLoopback(on: boolean): void;
  stop(): void;
}

export async function startMicTest(prefs: VoicePrefs, opts: { loopback: boolean; micId?: string; speakerId?: string }): Promise<MicTest> {
  const ctx = createVoiceContext();
  if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
  const choice = chooseEngine(prefs.noise, audioCaps(ctx), rememberedOverloads());
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: (opts.micId ?? savedDevice("mic")) || undefined,
        channelCount: 1,
        ...captureProcessing(choice.engine, { echo: prefs.echo, agc: prefs.agc }),
      },
    });
  } catch (err) {
    void ctx.close();
    throw err;
  }
  const track = stream.getAudioTracks()[0];
  let pipeline: MicPipeline | null = null;
  let monitorEl: HTMLAudioElement | null = null;
  try {
    pipeline = await MicPipeline.create(ctx, {
      engine: choice.engine,
      // Push to talk: the test plays everything (there's no key held).
      gate:
        prefs.input_mode === "ptt"
          ? { mode: "vad", auto: false, thresholdDb: -100, releaseMs: 0 }
          : { mode: "vad", auto: prefs.auto_sensitivity, thresholdDb: prefs.sensitivity_db, releaseMs: prefs.ptt_release_ms },
      agc: choice.engine === "gtcrn" || choice.engine === "rnnoise" ? prefs.agc : false,
      inputGain: prefs.input_volume / 100,
    });
    pipeline.connect(track);
  } catch {
    pipeline = null; // no AudioWorklet: the meter and loopback use the raw mic
  }
  const speakerId = opts.speakerId ?? savedDevice("speaker");
  const setLoopback = (on: boolean) => {
    if (pipeline) {
      const sink = (ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
      if (on && speakerId && sink) void sink.call(ctx, speakerId).catch(() => undefined);
      pipeline.monitor(on);
      return;
    }
    if (on && !monitorEl) {
      monitorEl = new Audio();
      monitorEl.srcObject = stream;
      const el = monitorEl as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (speakerId && el.setSinkId) void el.setSinkId(speakerId).catch(() => undefined);
      void monitorEl.play().catch(() => undefined);
    } else if (!on && monitorEl) {
      monitorEl.pause();
      monitorEl.srcObject = null;
      monitorEl = null;
    }
  };
  setLoopback(opts.loopback);
  return {
    pipeline,
    choice,
    setLoopback,
    stop() {
      setLoopback(false);
      pipeline?.destroy();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => undefined);
    },
  };
}
