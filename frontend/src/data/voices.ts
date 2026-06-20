/** Catalogue of the Kokoro TTS voices exposed in the account voice
 *  picker (read-aloud + voice mode).
 *
 * Scoped to the English voices Kokoro ships — American (``af``/``am``)
 * and British (``bf``/``bm``). Kokoro's other-language voices exist in
 * the model but mispronounce English (the worker synthesises with
 * ``lang="en-us"``), so we deliberately don't surface them here.
 *
 * ``calm`` flags the smoother, more relaxed voices in each group so a
 * user after "a calm, smooth voice" can find one quickly. Kept in sync
 * with the ids the backend ``/api/voice/tts`` accepts.
 */

export interface VoiceOption {
  /** Kokoro voice id, e.g. ``"af_heart"``. */
  id: string;
  /** Friendly display name. */
  name: string;
  /** A relaxed, smooth-sounding voice. */
  calm?: boolean;
}

export interface VoiceGroup {
  label: string;
  voices: VoiceOption[];
}

/** Server default — matches ``TTS_VOICE`` in docker-compose / the TTS
 *  worker. Shown with a "Default" badge and used when the user hasn't
 *  picked a voice. */
export const DEFAULT_VOICE_ID = "af_heart";

export const VOICE_GROUPS: VoiceGroup[] = [
  {
    label: "American · Female",
    voices: [
      { id: "af_heart", name: "Heart", calm: true },
      { id: "af_nicole", name: "Nicole", calm: true },
      { id: "af_bella", name: "Bella" },
      { id: "af_sarah", name: "Sarah" },
      { id: "af_aoede", name: "Aoede" },
      { id: "af_kore", name: "Kore" },
      { id: "af_nova", name: "Nova" },
      { id: "af_sky", name: "Sky" },
      { id: "af_alloy", name: "Alloy" },
      { id: "af_jessica", name: "Jessica" },
      { id: "af_river", name: "River" },
    ],
  },
  {
    label: "American · Male",
    voices: [
      { id: "am_michael", name: "Michael", calm: true },
      { id: "am_onyx", name: "Onyx", calm: true },
      { id: "am_liam", name: "Liam" },
      { id: "am_fenrir", name: "Fenrir" },
      { id: "am_puck", name: "Puck" },
      { id: "am_adam", name: "Adam" },
      { id: "am_echo", name: "Echo" },
      { id: "am_eric", name: "Eric" },
      { id: "am_santa", name: "Santa" },
    ],
  },
  {
    label: "British · Female",
    voices: [
      { id: "bf_emma", name: "Emma", calm: true },
      { id: "bf_lily", name: "Lily", calm: true },
      { id: "bf_isabella", name: "Isabella" },
      { id: "bf_alice", name: "Alice" },
    ],
  },
  {
    label: "British · Male",
    voices: [
      { id: "bm_george", name: "George", calm: true },
      { id: "bm_lewis", name: "Lewis", calm: true },
      { id: "bm_fable", name: "Fable" },
      { id: "bm_daniel", name: "Daniel" },
    ],
  },
];

/** Flat id → display lookup (e.g. for showing the current selection). */
export const VOICE_BY_ID: Record<string, VoiceOption> = Object.fromEntries(
  VOICE_GROUPS.flatMap((g) => g.voices).map((v) => [v.id, v])
);
