/**
 * Voice & video settings: what follows the person (``user.settings.voice``,
 * ``voice_volumes``, ``voice_local_mutes`` through ``PATCH
 * /api/auth/me/preferences``) with their defaults, and saving them. Device
 * choices are per browser (``rtc/devices.ts``, localStorage).
 */
import { authApi } from "@/api/auth";
import type { UserPreferencesUpdate, UserSettings } from "@/api/types";
import type { StreamQuality } from "@/api/voiceChannels";
import { useAuthStore } from "@/store/authStore";

import { DEFAULT_NOISE, type NoisePref } from "../audio/engines";
import type { InputMode } from "../audio/gate";
import { DEFAULT_STREAM_HINT, DEFAULT_STREAM_QUALITY, type StreamHint } from "./goLive";

export interface VoicePrefs {
  input_mode: InputMode;
  /** ``KeyboardEvent.code`` (e.g. "Backquote"), or "Mouse3"/"Mouse4". */
  ptt_key: string;
  ptt_release_ms: number;
  auto_sensitivity: boolean;
  /** Manual voice-activity threshold, dBFS. */
  sensitivity_db: number;
  noise: NoisePref;
  echo: boolean;
  agc: boolean;
  /** 0..200 (%). */
  input_volume: number;
  /** 0..200 (%). */
  output_volume: number;
  sounds: boolean;
  stream_quality: StreamQuality;
  stream_hint: StreamHint;
  data_saver: boolean;
  tips_seen: boolean;
}

export const VOICE_DEFAULTS: VoicePrefs = {
  input_mode: "vad",
  ptt_key: "Backquote",
  ptt_release_ms: 200,
  auto_sensitivity: true,
  sensitivity_db: -50,
  noise: DEFAULT_NOISE,
  echo: true,
  agc: true,
  input_volume: 100,
  output_volume: 100,
  sounds: true,
  stream_quality: DEFAULT_STREAM_QUALITY,
  stream_hint: DEFAULT_STREAM_HINT,
  data_saver: false,
  tips_seen: false,
};

export interface VoiceSettingsAll {
  prefs: VoicePrefs;
  volumes: Record<string, number>;
  localMutes: string[];
}

export function readVoiceSettings(settings: UserSettings | null | undefined): VoiceSettingsAll {
  const s = (settings ?? {}) as Record<string, unknown>;
  const stored = (s.voice && typeof s.voice === "object" ? s.voice : {}) as Partial<VoicePrefs>;
  const prefs = { ...VOICE_DEFAULTS };
  for (const k of Object.keys(VOICE_DEFAULTS) as (keyof VoicePrefs)[]) {
    const v = stored[k];
    if (v !== undefined && v !== null && typeof v === typeof VOICE_DEFAULTS[k]) (prefs as Record<string, unknown>)[k] = v;
  }
  const volumes = s.voice_volumes && typeof s.voice_volumes === "object" ? { ...(s.voice_volumes as Record<string, number>) } : {};
  const localMutes = Array.isArray(s.voice_local_mutes) ? (s.voice_local_mutes as string[]).filter((x) => typeof x === "string") : [];
  return { prefs, volumes, localMutes };
}

export function currentVoiceSettings(): VoiceSettingsAll {
  return readVoiceSettings(useAuthStore.getState().user?.settings);
}

// Saving: optimistic in the auth store at once, sent to the server shortly
// after (a slider drag is one request, not fifty).
let pending: { voice?: Partial<VoicePrefs>; voice_volumes?: Record<string, number>; voice_local_mutes?: string[] } = {};
let timer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DELAY_MS = 400;

export function saveVoiceSettings(patch: {
  prefs?: Partial<VoicePrefs>;
  volumes?: Record<string, number>;
  localMutes?: string[];
}): void {
  const store = useAuthStore.getState();
  const local: Record<string, unknown> = {};
  if (patch.prefs) {
    local.voice = { ...((store.user?.settings as Record<string, unknown> | undefined)?.voice as object), ...patch.prefs };
    pending.voice = { ...pending.voice, ...patch.prefs };
  }
  if (patch.volumes) {
    local.voice_volumes = patch.volumes;
    pending.voice_volumes = patch.volumes;
  }
  if (patch.localMutes) {
    local.voice_local_mutes = patch.localMutes;
    pending.voice_local_mutes = patch.localMutes;
  }
  store.patchSettings(local);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flushVoiceSettings(), SAVE_DELAY_MS);
}

/** Send what's waiting now (e.g. before the page goes away). */
export async function flushVoiceSettings(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const body = pending;
  pending = {};
  if (!body.voice && !body.voice_volumes && !body.voice_local_mutes) return;
  try {
    await authApi.updatePreferences(body as UserPreferencesUpdate);
  } catch {
    // Keep the local change; the next save carries it again.
    pending = { ...body, ...pending, voice: { ...body.voice, ...pending.voice } };
  }
}
