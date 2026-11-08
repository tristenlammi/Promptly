/*
 * Talk's audio worklets (Voice Phase 3, WP-T4). A plain same-origin file:
 * the app's CSP (script-src 'self') rules out blob: worklets, and Vite
 * doesn't touch what's in public/.
 *
 *   talk-capture   microphone -> 20 ms frames of PCM16 mono at 16 kHz, each
 *                  with its RMS level (the meter and the local "duck" VAD)
 *   talk-playback  Talk's speech (PCM16 mono at 24 kHz, 20 ms frames) into a
 *                  ring buffer, played at the context's rate. "flush" drops
 *                  everything not yet played at once (stop_audio / barge-in).
 *
 * Playing through Web Audio, never an <audio> element, is the WP-T0 result:
 * Chrome and Edge cancel Web Audio output from the microphone from the first
 * sound, and leak <audio> completely when it's the first thing a page plays.
 */

const MIC_RATE = 16000;
const FRAME = 320; // 20 ms at 16 kHz
const SPEECH_RATE = 24000;

class TalkCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    // Box-filter decimation: average the input samples that fall into each
    // output sample's period. Enough of a low-pass for speech into Whisper.
    this.ratio = sampleRate / MIC_RATE;
    this.pos = 0;
    this.acc = 0;
    this.accN = 0;
    this.frame = new Int16Array(FRAME);
    this.n = 0;
    this.sumSq = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.accN += 1;
      this.pos += 1;
      if (this.pos < this.ratio) continue;
      this.pos -= this.ratio;
      let s = this.acc / this.accN;
      this.acc = 0;
      this.accN = 0;
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      this.frame[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.sumSq += s * s;
      if (this.n === FRAME) {
        const level = Math.sqrt(this.sumSq / FRAME);
        const buf = this.frame.buffer;
        this.port.postMessage({ pcm: buf, level }, [buf]);
        this.frame = new Int16Array(FRAME);
        this.n = 0;
        this.sumSq = 0;
      }
    }
    return true;
  }
}

class TalkPlayback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = SPEECH_RATE / sampleRate;
    this.cap = SPEECH_RATE * 60; // a minute of speech; it's sent ~300 ms ahead
    this.buf = new Float32Array(this.cap);
    this.written = 0; // samples ever pushed
    this.read = 0; // fractional read position, in pushed samples
    this.playing = false;
    this.sinceReport = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "push") {
        const pcm = new Int16Array(m.pcm);
        for (let i = 0; i < pcm.length; i++) {
          this.buf[this.written % this.cap] = pcm[i] / 32768;
          this.written += 1;
        }
        // Never more than the ring holds: drop the oldest.
        if (this.written - this.read > this.cap - 1) this.read = this.written - (this.cap - 1);
      } else if (m.type === "flush") {
        this.read = this.written;
        this.report(true);
      }
    };
  }

  report(force) {
    this.port.postMessage({ type: "pos", read: Math.floor(this.read), written: this.written, playing: this.playing, force: !!force });
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    if (!left) return true;
    const n = left.length;
    let had = false;
    for (let i = 0; i < n; i++) {
      if (this.written - this.read < 2) {
        left[i] = 0;
        continue;
      }
      had = true;
      const ip = Math.floor(this.read);
      const f = this.read - ip;
      const a = this.buf[ip % this.cap];
      const b = this.buf[(ip + 1) % this.cap];
      left[i] = a + (b - a) * f;
      this.read += this.step;
    }
    if (had && this.written - this.read < 2) {
      // The last sample or so: play it out rather than leave it hanging.
      this.read = this.written;
    }
    for (let c = 1; c < out.length; c++) out[c].set(left);
    if (had !== this.playing) {
      this.playing = had;
      this.report(true);
      this.sinceReport = 0;
    } else {
      this.sinceReport += n;
      if (this.playing && this.sinceReport >= sampleRate * 0.05) {
        this.sinceReport = 0;
        this.report(false);
      }
    }
    return true;
  }
}

registerProcessor("talk-capture", TalkCapture);
registerProcessor("talk-playback", TalkPlayback);
