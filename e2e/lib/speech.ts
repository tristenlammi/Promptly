// A speech-like test signal, made in code (no audio files in the repo):
// voiced syllables (a glottal pulse train through vowel formants, with a
// little pitch movement) separated by short gaps. Noise suppressors keep it
// as speech, where Chrome's default fake microphone (a beep) is removed as
// noise. Written as a WAV for Chrome's --use-file-for-fake-audio-capture.
import fs from "node:fs";

const VOWELS: [number, number, number][] = [
  [730, 1090, 2440], // a
  [270, 2290, 3010], // i
  [300, 870, 2240], // u
  [530, 1840, 2480], // e
  [570, 840, 2410], // o
];

/** Two-pole resonator coefficients for a formant. */
function resonator(freq: number, bw: number, sr: number) {
  const r = Math.exp((-Math.PI * bw) / sr);
  const a1 = 2 * r * Math.cos((2 * Math.PI * freq) / sr);
  const a2 = -r * r;
  const g = 1 - r;
  return { a1, a2, g };
}

export function syntheticSpeech(sr: number, seconds: number): Float32Array {
  const n = Math.floor(sr * seconds);
  const out = new Float32Array(n);
  const syll = Math.floor(sr * 0.26);
  const gap = Math.floor(sr * 0.12);
  let phase = 0;
  let pos = 0;
  let k = 0;
  while (pos < n) {
    const [f1, f2, f3] = VOWELS[k % VOWELS.length];
    const rs = [resonator(f1, 90, sr), resonator(f2, 110, sr), resonator(f3, 170, sr)];
    const st = rs.map(() => [0, 0]);
    const f0base = 110 + 25 * Math.sin(k * 1.3);
    for (let i = 0; i < syll && pos + i < n; i++) {
      const t = i / syll;
      const f0 = f0base * (1 + 0.08 * Math.sin(Math.PI * t));
      phase += f0 / sr;
      let src = 0;
      if (phase >= 1) {
        phase -= 1;
        src = 1;
      }
      // A little breath noise.
      src += (Math.random() * 2 - 1) * 0.02;
      let y = 0;
      rs.forEach((r, j) => {
        const v = r.g * src + r.a1 * st[j][0] + r.a2 * st[j][1];
        st[j][1] = st[j][0];
        st[j][0] = v;
        y += v * (j === 0 ? 1 : j === 1 ? 0.7 : 0.4);
      });
      const env = Math.sin(Math.PI * t) ** 0.6;
      out[pos + i] = y * env;
    }
    pos += syll + gap;
    k++;
  }
  // Normalise to a talking level (peaks around -6 dBFS).
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const g = peak ? 0.5 / peak : 1;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

/** Write ``seconds`` of synthetic speech as a 16-bit mono WAV. */
export function writeSpeechWav(file: string, seconds = 20, sr = 48000): string {
  const pcm = syntheticSpeech(sr, seconds);
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + pcm.length * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
  fs.writeFileSync(file, buf);
  return file;
}
