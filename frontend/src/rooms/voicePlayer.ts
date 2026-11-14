/**
 * The one player for voice messages. It lives outside the message list, so a
 * recording keeps playing while you scroll (the list drops rows that are far
 * off screen) and starting another stops the one before. Cards read it with
 * ``useVoicePlayer``.
 *
 * Which messages you've played is kept on this device, per person: an
 * unplayed one shows a dot.
 */
import { useSyncExternalStore } from "react";

export const SPEEDS = [1, 1.5, 2] as const;
const PLAYED_PREFIX = "promptly:rooms:voice-played:";
const PLAYED_MAX = 600;

export interface PlayerState {
  /** The message that's loaded (playing or paused part-way), if any. */
  id: string | null;
  playing: boolean;
  /** Seconds. */
  pos: number;
  duration: number;
  speed: number;
  /** The loaded recording couldn't be played here. */
  failed: boolean;
}

let state: PlayerState = { id: null, playing: false, pos: 0, duration: 0, speed: 1, failed: false };
let audio: HTMLAudioElement | null = null;
let loadedSrc: string | null = null;
const listeners = new Set<() => void>();

function set(patch: Partial<PlayerState>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function element(): HTMLAudioElement {
  if (audio) return audio;
  const a = new Audio();
  a.preload = "metadata";
  a.addEventListener("play", () => set({ playing: true, failed: false }));
  a.addEventListener("pause", () => set({ playing: false }));
  a.addEventListener("timeupdate", () => set({ pos: a.currentTime }));
  a.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(a.duration)) set({ duration: a.duration });
  });
  a.addEventListener("ended", () => set({ playing: false, pos: 0, id: null }));
  a.addEventListener("error", () => {
    if (state.id) set({ playing: false, failed: true });
  });
  audio = a;
  return a;
}

export const voicePlayer = {
  /** Play this message from ``at`` seconds (default: where it was, or the start). */
  play(id: string, src: string, at?: number) {
    const a = element();
    if (state.id !== id || loadedSrc !== src) {
      const keep = state.id === id ? a.currentTime : 0;
      a.src = src;
      loadedSrc = src;
      set({ id, pos: at ?? keep, duration: 0, failed: false });
      const start = at ?? keep;
      if (start > 0) {
        a.addEventListener(
          "loadedmetadata",
          () => {
            try {
              a.currentTime = start;
            } catch {
              /* starts from the beginning */
            }
          },
          { once: true },
        );
      }
    } else if (at !== undefined) {
      a.currentTime = at;
      set({ pos: at });
    }
    a.playbackRate = state.speed;
    void a.play().catch(() => set({ playing: false, failed: true }));
  },
  pause() {
    audio?.pause();
  },
  toggle(id: string, src: string) {
    if (state.id === id && state.playing) this.pause();
    else this.play(id, src);
  },
  /** Move within the loaded message (paused or playing). */
  seek(sec: number) {
    if (!audio || !state.id) return;
    audio.currentTime = Math.max(0, sec);
    set({ pos: audio.currentTime });
  },
  nextSpeed() {
    const speed = SPEEDS[(SPEEDS.indexOf(state.speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length];
    if (audio) audio.playbackRate = speed;
    set({ speed });
  },
  /** Stop and let go (the message was deleted, or you signed out). */
  stop(id?: string) {
    if (id && state.id !== id) return;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    loadedSrc = null;
    set({ id: null, playing: false, pos: 0, duration: 0, failed: false });
  },
};

export function useVoicePlayer(): PlayerState {
  return useSyncExternalStore(subscribe, () => state);
}

// ---- played / unplayed

const played = new Map<string, Set<string>>();

function playedSet(meId: string): Set<string> {
  let s = played.get(meId);
  if (s) return s;
  s = new Set<string>();
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PLAYED_PREFIX + meId) ?? "[]");
    if (Array.isArray(raw)) for (const x of raw) if (typeof x === "string") s.add(x);
  } catch {
    /* in memory only */
  }
  played.set(meId, s);
  return s;
}

export function isPlayed(meId: string, messageId: string): boolean {
  return playedSet(meId).has(messageId);
}

export function markPlayed(meId: string, messageId: string) {
  const s = playedSet(meId);
  if (s.has(messageId)) return;
  s.add(messageId);
  try {
    localStorage.setItem(PLAYED_PREFIX + meId, JSON.stringify([...s].slice(-PLAYED_MAX)));
  } catch {
    /* in memory only */
  }
  listeners.forEach((fn) => fn());
}

/** 0:42, 12:05. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
