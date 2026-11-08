/**
 * Microphones, speakers and cameras, and the person's choice of each.
 * Choices live in localStorage: device ids belong to one browser, so they
 * mustn't follow the person to another device (Calls plan, Voice & video).
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type DeviceKind = "mic" | "speaker" | "camera";

const STORE: Record<DeviceKind, string> = {
  mic: "promptly.voice.mic",
  speaker: "promptly.voice.speaker",
  camera: "promptly.voice.camera",
};

export function savedDevice(kind: DeviceKind): string {
  try {
    return window.localStorage.getItem(STORE[kind]) ?? "";
  } catch {
    return "";
  }
}

export function saveDevice(kind: DeviceKind, id: string): void {
  try {
    if (id) window.localStorage.setItem(STORE[kind], id);
    else window.localStorage.removeItem(STORE[kind]);
  } catch {
    /* private window: the choice lasts for this page only */
  }
}

export interface DeviceLists {
  mics: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
  /** Labels are hidden until the person has allowed the mic or camera. */
  labelled: boolean;
  refresh: () => Promise<void>;
}

export function useMediaDevices(): DeviceLists {
  const [all, setAll] = useState<MediaDeviceInfo[]>([]);
  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      setAll(await navigator.mediaDevices.enumerateDevices());
    } catch {
      setAll([]);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const md = navigator.mediaDevices;
    md?.addEventListener?.("devicechange", refresh);
    return () => md?.removeEventListener?.("devicechange", refresh);
  }, [refresh]);
  return {
    mics: all.filter((d) => d.kind === "audioinput" && d.deviceId),
    speakers: all.filter((d) => d.kind === "audiooutput" && d.deviceId),
    cameras: all.filter((d) => d.kind === "videoinput" && d.deviceId),
    labelled: all.some((d) => d.label),
    refresh,
  };
}

/** Live input level (0–1) of a stream's first audio track. */
export function useLevel(stream: MediaStream | null): number {
  const [level, setLevel] = useState(0);
  const raf = useRef(0);
  useEffect(() => {
    if (!stream || !stream.getAudioTracks().length) {
      setLevel(0);
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    let last = 0;
    const tick = (t: number) => {
      raf.current = requestAnimationFrame(tick);
      if (t - last < 50) return;
      last = t;
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      // dBFS -60..0 mapped to 0..1, which reads like a level meter.
      const db = 20 * Math.log10(rms + 1e-8);
      setLevel(Math.max(0, Math.min(1, (db + 60) / 60)));
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf.current);
      src.disconnect();
      void ctx.close();
    };
  }, [stream]);
  return level;
}

/** A short two-note chime as a WAV blob URL, for "Play test sound". */
export function testSoundUrl(): string {
  const sr = 24000;
  const n = Math.floor(sr * 0.9);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = t < 0.4 ? 660 : 880;
    const local = t < 0.4 ? t : t - 0.4;
    const env = Math.exp(-local * 6) * Math.min(1, local * 80);
    pcm[i] = Math.round(Math.sin(2 * Math.PI * f * t) * env * 0.35 * 32767);
  }
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  return URL.createObjectURL(new Blob([header, pcm.buffer], { type: "audio/wav" }));
}
