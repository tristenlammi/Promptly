/**
 * Voice sounds, synthesized (no audio files): you joined / left, someone
 * joined / left, mute / unmute, deafen / undeafen, disconnected. Short,
 * soft, two-note chimes in the voice audio context, so they play through
 * the chosen speaker. Off with Voice & video → Sounds.
 */

export type VoiceSound =
  | "join"
  | "leave"
  | "peer-join"
  | "peer-leave"
  | "mute"
  | "unmute"
  | "deafen"
  | "undeafen"
  | "disconnect"
  | "live";

/** Each sound: notes [frequency Hz, start s, length s], and a loudness. */
const SOUNDS: Record<VoiceSound, { notes: [number, number, number][]; gain: number }> = {
  join: { notes: [[523, 0, 0.12], [784, 0.09, 0.22]], gain: 0.22 },
  leave: { notes: [[784, 0, 0.12], [523, 0.09, 0.22]], gain: 0.2 },
  "peer-join": { notes: [[659, 0, 0.1], [880, 0.08, 0.16]], gain: 0.12 },
  "peer-leave": { notes: [[880, 0, 0.1], [659, 0.08, 0.16]], gain: 0.11 },
  mute: { notes: [[440, 0, 0.09], [330, 0.06, 0.12]], gain: 0.16 },
  unmute: { notes: [[330, 0, 0.09], [440, 0.06, 0.12]], gain: 0.16 },
  deafen: { notes: [[392, 0, 0.1], [262, 0.07, 0.16]], gain: 0.16 },
  undeafen: { notes: [[262, 0, 0.1], [392, 0.07, 0.16]], gain: 0.16 },
  disconnect: { notes: [[523, 0, 0.12], [392, 0.1, 0.12], [262, 0.2, 0.25]], gain: 0.2 },
  live: { notes: [[587, 0, 0.1], [740, 0.08, 0.1], [880, 0.16, 0.18]], gain: 0.14 },
};

export function playVoiceSound(ctx: BaseAudioContext | null, sound: VoiceSound, volume = 1): void {
  if (!ctx || ctx.state === "closed" || volume <= 0) return;
  const spec = SOUNDS[sound];
  const t0 = ctx.currentTime + 0.01;
  const master = ctx.createGain();
  master.gain.value = spec.gain * Math.min(2, volume);
  master.connect(ctx.destination);
  let end = t0;
  for (const [freq, start, len] of spec.notes) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const env = ctx.createGain();
    const a = t0 + start;
    env.gain.setValueAtTime(0, a);
    env.gain.linearRampToValueAtTime(1, a + 0.012);
    env.gain.exponentialRampToValueAtTime(0.001, a + len);
    osc.connect(env).connect(master);
    osc.start(a);
    osc.stop(a + len + 0.02);
    end = Math.max(end, a + len + 0.05);
  }
  window.setTimeout(() => master.disconnect(), Math.ceil((end - ctx.currentTime) * 1000) + 100);
}
