/**
 * Talk's microphone (WP-T4), behind one small interface.
 *
 * Talk only needs "20 ms frames of PCM16 mono at 16 kHz, with a level".
 * Today that comes from the browser's own echo cancellation / noise
 * suppression / gain control and the ``talk-capture`` worklet. The Calls
 * feature builds a shared mic pipeline (``frontend/src/rtc/audio/``, GTCRN
 * noise suppression) on its own branch; when both are merged, swap
 * {@link createTalkMic} for an adapter over that pipeline. Nothing else in
 * Talk touches ``getUserMedia``.
 */

export const MIC_SAMPLE_RATE = 16_000;
export const MIC_FRAME_SAMPLES = 320; // 20 ms

/** One 20 ms frame (PCM16 mono, 16 kHz) and its RMS level (0..1). */
export type MicFrameSink = (pcm: Int16Array, level: number) => void;

export interface TalkMic {
  /** Ask for the microphone and start delivering frames. Rejects with a
   *  {@link MicError}. ``ctx`` is Talk's AudioContext (one per session, so
   *  capture and playback share a clock). */
  open(ctx: AudioContext, onFrame: MicFrameSink): Promise<void>;
  /** Stop and release the microphone (the browser's mic light goes off). */
  close(): void;
}

export type MicErrorKind = "denied" | "missing" | "busy" | "unsupported";

export class MicError extends Error {
  constructor(
    public kind: MicErrorKind,
    message: string
  ) {
    super(message);
  }
}

/** Where the worklets live (``public/talk-worklets.js``). */
export const WORKLETS_URL = "/talk-worklets.js";

const loaded = new WeakSet<AudioContext>();

export async function loadWorklets(ctx: AudioContext): Promise<void> {
  if (loaded.has(ctx)) return;
  await ctx.audioWorklet.addModule(WORKLETS_URL);
  loaded.add(ctx);
}

function micError(e: unknown): MicError {
  const name = (e as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return new MicError("denied", "Promptly isn't allowed to use your microphone.");
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return new MicError("missing", "No microphone was found.");
  if (name === "NotReadableError" || name === "AbortError")
    return new MicError("busy", "Your microphone is being used by something else.");
  return new MicError("unsupported", "This browser can't share its microphone here.");
}

/** The browser's microphone with its own echo cancellation, through the
 *  ``talk-capture`` worklet. */
export function createTalkMic(): TalkMic {
  let stream: MediaStream | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let node: AudioWorkletNode | null = null;
  let sink: GainNode | null = null;

  return {
    async open(ctx, onFrame) {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new MicError("unsupported", "This browser can't share its microphone here.");
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
      } catch (e) {
        throw micError(e);
      }
      await loadWorklets(ctx);
      source = ctx.createMediaStreamSource(stream);
      node = new AudioWorkletNode(ctx, "talk-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: "explicit",
      });
      node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
        onFrame(new Int16Array(e.data.pcm), e.data.level);
      };
      // A silent path to the speakers keeps the node pulled in every browser.
      sink = ctx.createGain();
      sink.gain.value = 0;
      source.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);
    },
    close() {
      try {
        source?.disconnect();
        node?.disconnect();
        sink?.disconnect();
      } catch {
        /* already gone */
      }
      if (node) node.port.onmessage = null;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      source = null;
      node = null;
      sink = null;
    },
  };
}
