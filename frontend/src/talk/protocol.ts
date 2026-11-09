/**
 * The ``/api/talk/ws`` protocol as the web sees it (WP-T4). The server's
 * side, and the full description, is ``backend/app/talk/protocol.py``.
 */

export type TalkState = "listening" | "thinking" | "speaking" | "muted";
export type TurnMode = "hands_free" | "tap";
export type InterruptMode = "talk" | "tap";

export interface TalkConfig {
  protocol: number;
  enabled: boolean;
  reason: string | null;
  voice_model_set: boolean;
  prefs: {
    voice: string | null;
    speed: number;
    save: "chat" | "temporary";
    turn_mode: TurnMode;
    interrupt: InterruptMode;
    captions: boolean;
  };
  limits: {
    live_slots: number;
    talking_now: number;
    resume_s: number;
    idle_s: number;
    frame_ms: number;
    mic_sample_rate: number;
    speech_sample_rate: number;
  };
}

/** Something worth seeing from a tool (``talk/tools.py::card_of``). */
export interface TalkCardMeta {
  url?: string;
  summary?: string;
  title?: string;
  map_card?: Record<string, unknown>;
  map?: boolean;
  photos?: { total?: number | null; set_id?: string | null };
  count?: number;
}

export type ServerEvent =
  | {
      type: "ready";
      session_id: string;
      conversation_id: string | null;
      title: string | null;
      resumed: boolean;
      turn_mode: TurnMode;
      interrupt_mode: InterruptMode;
      audio: { format: string; sample_rate: number; frame_ms: number };
      limits: { resume_s: number; idle_s: number };
      /** Where answers are worked out (WP-T6), for the header's note. */
      answers?: { provider: string; hosted: boolean } | null;
    }
  | { type: "state"; state: TalkState; muted: boolean }
  | { type: "partial"; text: string }
  | { type: "heard"; text: string; message_id: string | null }
  | { type: "reply"; text: string; message_id?: string | null; done?: boolean }
  | { type: "spoken"; chars: number }
  | { type: "tool"; label: string; name: string }
  | { type: "card"; kind: string; message_id: string | null; meta: TalkCardMeta }
  | {
      type: "ask";
      question: string;
      approval_id: string;
      message_id?: string | null;
      call_id?: string | null;
      expires_in: number;
    }
  | {
      type: "ask_done";
      approval_id: string;
      outcome: "approved" | "declined" | "failed" | "expired";
      message_id?: string | null;
    }
  | { type: "action"; action: { type: string } & Record<string, unknown> }
  | { type: "stop_audio" }
  | { type: "error"; code: string; say: string | null; show: string | null }
  | { type: "bye"; reason: string }
  | { type: "pong"; t: number };

export const CLOSE = {
  badHello: 4400,
  unauthorized: 4401,
  forbidden: 4403,
  notFound: 4404,
  busy: 4429,
  unavailable: 4503,
} as const;

/** The 4-byte big-endian sequence number in front of every audio frame. */
export function withSeq(seq: number, pcm: Int16Array): ArrayBuffer {
  const out = new ArrayBuffer(4 + pcm.byteLength);
  new DataView(out).setUint32(0, seq >>> 0, false);
  new Int16Array(out, 4).set(pcm);
  return out;
}

export function withoutSeq(data: ArrayBuffer): Int16Array | null {
  if (data.byteLength < 4 || (data.byteLength - 4) % 2 !== 0) return null;
  return new Int16Array(data.slice(4));
}
