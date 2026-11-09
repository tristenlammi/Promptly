/**
 * Call tones, synthesized (no audio files):
 *
 *  - the ringtone for a call ringing you: a soft rising three-note phrase,
 *    twice, then a pause, over and over, with a vibration on phones;
 *  - the ringback while your call rings the others: the familiar long
 *    low tone, two seconds on, four off;
 *  - the hold tone while the other person has put the call on hold (their
 *    phone took a call): two soft short beeps every four seconds.
 *
 * One tone at a time per tab. When several Promptly tabs are open, only
 * one rings out loud (a Web Lock picks it, preferring a tab you can see);
 * the others show the incoming call quietly.
 */

type Tone = "ring" | "ringback" | "hold";

let ctx: AudioContext | null = null;
let playing: { tone: Tone; stop: () => void } | null = null;

function context(): AudioContext | null {
  try {
    if (!ctx || ctx.state === "closed") ctx = new AudioContext({ latencyHint: "playback" });
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    return ctx;
  } catch {
    return null;
  }
}

/** The tab may only make sound after you've clicked something in it. */
export function tonesAllowed(): boolean {
  const c = context();
  return !!c && c.state === "running";
}

function note(c: AudioContext, out: AudioNode, freq: number, at: number, len: number, peak: number, type: OscillatorType = "sine"): void {
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const env = c.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(peak, at + 0.02);
  env.gain.setValueAtTime(peak, at + Math.max(0.03, len - 0.08));
  env.gain.exponentialRampToValueAtTime(0.0008, at + len);
  osc.connect(env).connect(out);
  osc.start(at);
  osc.stop(at + len + 0.05);
}

/** One cycle of a tone, starting at ``t0``; returns its length in seconds. */
function cycle(c: AudioContext, out: AudioNode, tone: Tone, t0: number): number {
  if (tone === "ringback") {
    note(c, out, 440, t0, 2, 0.12);
    note(c, out, 480, t0, 2, 0.12);
    return 6;
  }
  if (tone === "hold") {
    note(c, out, 620, t0, 0.14, 0.07);
    note(c, out, 620, t0 + 0.3, 0.14, 0.07);
    return 4;
  }
  // E5 G#5 B5, twice, then a pause.
  const phrase: [number, number][] = [
    [659.25, 0],
    [830.61, 0.16],
    [987.77, 0.32],
  ];
  for (const rep of [0, 0.75]) {
    for (const [f, dt] of phrase) {
      note(c, out, f, t0 + rep + dt, 0.3, 0.22, "triangle");
      note(c, out, f * 2, t0 + rep + dt, 0.18, 0.04);
    }
  }
  return 3;
}

function start(tone: Tone, volume: number): () => void {
  const c = context();
  if (!c) return () => undefined;
  const out = c.createGain();
  out.gain.value = Math.max(0, Math.min(1.5, volume));
  out.connect(c.destination);
  let next = c.currentTime + 0.05;
  let stopped = false;
  const schedule = () => {
    // Keep a cycle or two queued ahead.
    while (!stopped && next < c.currentTime + 6.5) next += cycle(c, out, tone, next);
  };
  schedule();
  const timer = window.setInterval(schedule, 1000);
  const buzz = tone === "ring" && typeof navigator.vibrate === "function";
  const vib = buzz ? window.setInterval(() => navigator.vibrate?.([400, 200, 400]), 3000) : 0;
  if (buzz) navigator.vibrate?.([400, 200, 400]);
  return () => {
    stopped = true;
    window.clearInterval(timer);
    if (vib) window.clearInterval(vib);
    if (buzz) navigator.vibrate?.(0);
    const now = c.currentTime;
    out.gain.cancelScheduledValues(now);
    out.gain.setValueAtTime(out.gain.value, now);
    out.gain.linearRampToValueAtTime(0, now + 0.08);
    window.setTimeout(() => out.disconnect(), 200);
  };
}

/** Play a tone until the returned function is called. With ``exclusive``,
 *  only one Promptly tab plays it (see above). */
export function playTone(tone: Tone, opts: { volume?: number; exclusive?: string } = {}): () => void {
  stopTone();
  const volume = opts.volume ?? 1;
  let stop: (() => void) | null = null;
  let done = false;
  let release: (() => void) | null = null;
  const begin = () => {
    if (done) return;
    stop = start(tone, volume);
  };
  const finish = () => {
    if (done) return;
    done = true;
    stop?.();
    release?.();
    if (playing?.stop === finish) playing = null;
  };
  playing = { tone, stop: finish };
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (opts.exclusive && locks?.request) {
    // A tab you can see asks first; a hidden one waits a moment.
    const ask = () => {
      if (done) return;
      void locks
        .request(`promptly-tone:${opts.exclusive}`, { ifAvailable: true }, (lock) => {
          if (!lock || done) return undefined;
          begin();
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        })
        .catch(() => begin());
    };
    if (document.visibilityState === "visible") ask();
    else window.setTimeout(ask, 400);
  } else {
    begin();
  }
  return finish;
}

export function stopTone(): void {
  playing?.stop();
  playing = null;
}
