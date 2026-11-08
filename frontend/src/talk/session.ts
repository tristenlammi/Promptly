import { create } from "zustand";

import { API_BASE_URL, apiClient } from "@/api/client";

import { createTalkMic, MicError, type TalkMic } from "./mic";
import { TalkPlayer } from "./player";
import {
  CLOSE,
  type InterruptMode,
  type ServerEvent,
  type TalkCardMeta,
  type TalkConfig,
  type TalkState,
  type TurnMode,
  withoutSeq,
  withSeq,
} from "./protocol";

/**
 * Web Talk (Voice Phase 3, WP-T4): one spoken conversation over
 * ``/api/talk/ws``. The socket, the microphone and the speaker live here,
 * outside React, so a re-render or a route change inside the chat (a new
 * chat getting its id) doesn't drop the conversation; the Talk screen reads
 * {@link useTalkStore} and calls {@link talk}.
 *
 * What it does on top of the protocol:
 * - plays speech through Web Audio (``player.ts``), flushing on
 *   ``stop_audio``, and ducks it the instant the local level meter hears
 *   you talking over it;
 * - buffers the first ~2 s of microphone while the socket opens, so you can
 *   start talking straight away;
 * - resumes a dropped connection within the server's 30 s (and after a page
 *   reload, from ``sessionStorage``);
 * - times the connection with ``ping`` and asks the chat page to switch to
 *   the tap-to-talk voice mode (Phase 2) when it's weak;
 * - measures, per answered turn, the time from the end of your speech (local
 *   level meter) to the first sound of the answer.
 */

// ---------------------------------------------------------------- tuning
/** Level (RMS of the 16 kHz frame) that counts as you talking. */
const SPEECH_RMS = 0.03;
/** Talking over it this long (frames of 20 ms) ducks the speaker. */
const DUCK_FRAMES = 3;
/** Unduck after this long without the server stopping it. */
const UNDUCK_MS = 1500;
/** Microphone kept while the socket opens (3 s). */
const EARLY_FRAMES = 150;
const PING_MS = 4000;
const WEAK_RTT_MS = 800;
const WEAK_DROPS = 2;
const DROP_WINDOW_MS = 120_000;
const RESUME_KEY = "promptly.talk.resume";

// ---------------------------------------------------------------- state
export interface Exchange {
  key: number;
  /** Your words: a partial while you talk, then what was heard. */
  you: string;
  youFinal: boolean;
  typed?: boolean;
  messageId: string | null;
  /** Its words so far, cleaned for speech. */
  reply: string;
  /** How much of ``reply`` has started playing. */
  spoken: number;
  replyDone: boolean;
  replyId: string | null;
  interrupted: boolean;
}

export interface TalkAsk {
  question: string;
  approvalId: string;
  messageId: string | null;
  callId: string | null;
  expiresAt: number;
  ttlMs: number;
}

export interface TalkCard {
  key: number;
  kind: string;
  messageId: string | null;
  meta: TalkCardMeta;
}

export type TalkPhase = "off" | "starting" | "live" | "reconnecting" | "ended";

export interface TalkProblem {
  code: string;
  show: string;
  /** The conversation can't go on: offer the tap-to-talk voice mode. */
  fatal: boolean;
  /** Offer the tap-to-talk voice mode instead. */
  fallback?: boolean;
  /** The microphone was refused: show how to allow it. */
  mic?: "denied" | "missing" | "busy" | "unsupported";
}

export interface TalkUi {
  phase: TalkPhase;
  state: TalkState;
  muted: boolean;
  conversationId: string | null;
  title: string | null;
  temporary: boolean;
  exchanges: Exchange[];
  tool: string | null;
  ask: TalkAsk | null;
  lastOutcome: { approvalId: string; outcome: string } | null;
  cards: TalkCard[];
  problem: TalkProblem | null;
  /** A passing message ("Sorry, I didn't catch that."). */
  notice: string | null;
  turnMode: TurnMode;
  interruptMode: InterruptMode;
  /** Tap to talk: the microphone is open for your turn. */
  talking: boolean;
  /** The browser hasn't let audio play yet (a reload without a tap). */
  audioBlocked: boolean;
  weak: boolean;
  rttMs: number | null;
  /** The level meter says you're talking right now. */
  hearing: boolean;
  captions: boolean;
  voice: string | null;
  speed: number;
  /** The chat page should switch to the Phase 2 voice mode. */
  fallback: null | "weak" | "unavailable";
  endReason: string | null;
  /** Ms from the end of your speech to the first sound of each answer. */
  latencies: number[];
  /** Bumped whenever the chat's messages changed on the server. */
  changed: number;
}

const INITIAL: TalkUi = {
  phase: "off",
  state: "listening",
  muted: false,
  conversationId: null,
  title: null,
  temporary: false,
  exchanges: [],
  tool: null,
  ask: null,
  lastOutcome: null,
  cards: [],
  problem: null,
  notice: null,
  turnMode: "hands_free",
  interruptMode: "talk",
  talking: false,
  audioBlocked: false,
  weak: false,
  rttMs: null,
  hearing: false,
  captions: true,
  voice: null,
  speed: 1,
  fallback: null,
  endReason: null,
  latencies: [],
  changed: 0,
};

export const useTalkStore = create<TalkUi>(() => ({ ...INITIAL }));

const set = (patch: Partial<TalkUi> | ((s: TalkUi) => Partial<TalkUi>)) =>
  useTalkStore.setState(patch as Partial<TalkUi>);
const get = () => useTalkStore.getState();

/** The live microphone level (0..1), read by the meter each animation
 *  frame instead of going through React state 50 times a second. */
export const talkLevel = { current: 0 };

// ---------------------------------------------------------------- resume
interface ResumeRecord {
  sessionId: string;
  conversationId: string | null;
  at: number;
}

export function resumeRecord(): ResumeRecord | null {
  try {
    const raw = sessionStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as ResumeRecord;
    // The server keeps a dropped conversation for 30 s.
    if (!r.sessionId || Date.now() - r.at > 25_000) return null;
    return r;
  } catch {
    return null;
  }
}

function saveResume(r: ResumeRecord | null): void {
  try {
    if (r) sessionStorage.setItem(RESUME_KEY, JSON.stringify(r));
    else sessionStorage.removeItem(RESUME_KEY);
  } catch {
    /* private mode: no resume after a reload */
  }
}

// ---------------------------------------------------------------- helpers
function socketUrl(query: URLSearchParams): string {
  const base = API_BASE_URL.replace(/\/$/, "");
  const path = `${base}/talk/ws?${query.toString()}`;
  if (/^https?:\/\//.test(path)) return path.replace(/^http/, "ws");
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

let exchangeKey = 0;
let cardKey = 0;

function patchLast(fn: (e: Exchange) => Partial<Exchange>): void {
  set((s) => {
    if (s.exchanges.length === 0) return {};
    const list = s.exchanges.slice();
    const last = list[list.length - 1];
    list[list.length - 1] = { ...last, ...fn(last) };
    return { exchanges: list };
  });
}

function newExchange(init: Partial<Exchange>): Exchange {
  return {
    key: ++exchangeKey,
    you: "",
    youFinal: false,
    messageId: null,
    reply: "",
    spoken: 0,
    replyDone: false,
    replyId: null,
    interrupted: false,
    ...init,
  };
}

// ---------------------------------------------------------------- the session
export interface StartOptions {
  /** The chat to talk in; null starts a new one. */
  conversationId: string | null;
  /** Makes the new chat (with the composer's model) when there isn't one. */
  createConversation?: (temporary: boolean) => Promise<string>;
  /** Pick up a conversation that dropped (a reload). */
  resumeSessionId?: string;
}

class TalkController {
  private ctx: AudioContext | null = null;
  private mic: TalkMic | null = null;
  private player: TalkPlayer | null = null;
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private seq = 0;
  private early: Int16Array[] = [];
  private ready = false;
  private ending = false;
  private run = 0; // bumps on every start/end, so stale callbacks do nothing
  private pingTimer: number | null = null;
  private pings = new Map<number, number>();
  private rtts: number[] = [];
  private drops: number[] = [];
  private dropAt: number | null = null;
  private retryTimer: number | null = null;
  private resumeS = 30;
  private triedQueryTicket = false;
  private loudFrames = 0;
  private lastVoiceAt = 0;
  private duckedAt: number | null = null;
  /** End of your speech for the turn being answered (local meter). */
  private voiceEnd: number | null = null;
  private awaitingFirstSound = false;
  private lastError: { code: string; show: string | null } | null = null;
  private config: TalkConfig | null = null;
  private speechClip: { stop: () => void } | null = null;

  get live(): boolean {
    return get().phase !== "off" && get().phase !== "ended";
  }

  /** Start talking. Call it straight from a click: the browser only lets
   *  audio start from a user's gesture. */
  async start(opts: StartOptions): Promise<void> {
    if (this.live) return;
    const myRun = ++this.run;
    this.ending = false;
    this.ready = false;
    this.sessionId = opts.resumeSessionId ?? null;
    this.early = [];
    this.seq = 0;
    this.rtts = [];
    this.drops = [];
    this.triedQueryTicket = false;
    this.lastError = null;
    // Synchronously, inside the gesture.
    try {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
      void this.ctx.resume().catch(() => undefined);
    } catch {
      this.ctx = null;
    }
    useTalkStore.setState({
      ...INITIAL,
      phase: "starting",
      conversationId: opts.conversationId,
      latencies: get().latencies,
      changed: get().changed,
    });
    if (!this.ctx) {
      this.fail({ code: "no_audio", show: "This browser can't play Talk's audio.", fatal: true, fallback: true });
      return;
    }

    // What the server says about Talk for you.
    let config: TalkConfig;
    try {
      config = (await apiClient.get<TalkConfig>("/talk/config")).data;
    } catch (e) {
      if (myRun !== this.run) return;
      const status = (e as { response?: { status?: number } })?.response?.status;
      this.fail({
        code: status === 404 ? "no_talk" : "offline",
        show:
          status === 404
            ? "This server doesn't have live Talk yet."
            : "Couldn't reach your server. Check your connection and try again.",
        fatal: true,
        fallback: status === 404,
      });
      return;
    }
    if (myRun !== this.run) return;
    this.config = config;
    this.resumeS = config.limits?.resume_s ?? 30;
    if (!config.enabled) {
      this.fail({ code: "talk_off", show: config.reason || "Talk isn't turned on for your account.", fatal: true, fallback: true });
      return;
    }
    set({
      turnMode: config.prefs.turn_mode,
      interruptMode: config.prefs.interrupt,
      captions: config.prefs.captions,
      voice: config.prefs.voice,
      speed: config.prefs.speed,
    });

    // Speaker, then microphone.
    try {
      this.player = new TalkPlayer(this.ctx);
      await this.player.init();
      this.player.onPlaying = (playing) => this.onPlaying(playing);
    } catch {
      if (myRun !== this.run) return;
      this.fail({ code: "no_audio", show: "This browser can't play Talk's audio.", fatal: true, fallback: true });
      return;
    }
    const mic = createTalkMic();
    this.mic = mic;
    try {
      await mic.open(this.ctx, (pcm, level) => this.onMic(pcm, level));
    } catch (e) {
      mic.close();
      if (myRun !== this.run) return;
      const err = e instanceof MicError ? e : new MicError("unsupported", "Couldn't open your microphone.");
      this.fail({ code: "mic", show: err.message, fatal: true, mic: err.kind });
      return;
    }
    if (myRun !== this.run || !this.ctx) {
      // Closed while the browser was asking for the microphone.
      mic.close();
      return;
    }
    set({ audioBlocked: this.ctx.state !== "running" });
    this.ctx.onstatechange = () => set({ audioBlocked: this.ctx?.state !== "running" });

    // A chat to talk in.
    let conversationId = opts.conversationId;
    if (!conversationId && opts.createConversation) {
      try {
        conversationId = await opts.createConversation(config.prefs.save === "temporary");
      } catch {
        if (myRun !== this.run) return;
        this.fail({ code: "no_chat", show: "Couldn't start a new chat. Check that a model is set up.", fatal: true });
        return;
      }
      if (myRun !== this.run) return;
      set({ conversationId, temporary: config.prefs.save === "temporary" });
    }
    await this.connect(myRun);
  }

  private async connect(myRun: number, queryTicket = false): Promise<void> {
    if (myRun !== this.run || this.ending) return;
    let ticket: string | null = null;
    try {
      ticket = (await apiClient.post<{ ticket: string }>("/talk/ticket")).data.ticket;
    } catch (e) {
      if (myRun !== this.run) return;
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 401 || status === 403) {
        this.fail({ code: "not_signed_in", show: "You've been signed out. Sign in again to talk.", fatal: true });
        return;
      }
      this.dropped(myRun);
      return;
    }
    if (myRun !== this.run) return;
    const q = new URLSearchParams();
    const conv = get().conversationId;
    if (conv) q.set("conversation_id", conv);
    if (this.sessionId) q.set("resume", this.sessionId);
    if (queryTicket && ticket) q.set("ticket", ticket);
    let ws: WebSocket;
    try {
      ws = new WebSocket(socketUrl(q));
    } catch {
      this.dropped(myRun);
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.ready = false;
    ws.onopen = () => {
      if (myRun !== this.run) return;
      const s = get();
      ws.send(
        JSON.stringify({
          type: "hello",
          codec: "pcm16",
          sample_rate: 16000,
          play: "pcm16",
          device: "web",
          caps: [],
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          lang: navigator.language || undefined,
          turn_mode: s.turnMode,
          interrupt_mode: s.interruptMode,
        })
      );
    };
    ws.onmessage = (e) => {
      if (myRun !== this.run || this.ws !== ws) return;
      if (typeof e.data === "string") {
        try {
          this.onEvent(JSON.parse(e.data) as ServerEvent, myRun);
        } catch {
          /* one bad event doesn't end the conversation */
        }
        return;
      }
      const pcm = withoutSeq(e.data as ArrayBuffer);
      if (pcm && this.player) this.player.push(pcm);
    };
    ws.onclose = (e) => {
      if (myRun !== this.run || this.ws !== ws) return;
      this.ws = null;
      this.onClose(e.code, myRun, queryTicket);
    };
  }

  // -------------------------------------------------------------- events
  private onEvent(ev: ServerEvent, myRun: number): void {
    switch (ev.type) {
      case "ready": {
        const resumedFromDrop = this.dropAt !== null;
        this.dropAt = null;
        this.sessionId = ev.session_id;
        this.ready = true;
        this.lastError = null;
        set({
          phase: "live",
          conversationId: ev.conversation_id ?? get().conversationId,
          title: ev.title ?? get().title,
          turnMode: ev.turn_mode,
          interruptMode: ev.interrupt_mode,
          problem: null,
          notice: resumedFromDrop && !ev.resumed ? "Reconnected. Say that again?" : null,
        });
        this.remember();
        this.startPings(myRun);
        // What you said while it connected.
        if (get().turnMode === "hands_free" && !resumedFromDrop) {
          for (const pcm of this.early) this.sendAudio(pcm);
        }
        this.early = [];
        break;
      }
      case "state": {
        const prev = get().state;
        set({ state: ev.state, muted: ev.muted, ...(ev.state === "listening" ? { tool: null } : {}) });
        if (ev.state === "thinking" && prev !== "thinking") this.turnStarted(this.lastVoiceAt);
        if (ev.state === "listening") {
          this.voiceEnd = null;
          this.awaitingFirstSound = false;
          if (get().weak && !get().fallback) set({ fallback: "weak" });
        }
        break;
      }
      case "partial": {
        const s = get();
        const last = s.exchanges[s.exchanges.length - 1];
        if (last && !last.youFinal) patchLast(() => ({ you: ev.text }));
        else set({ exchanges: [...s.exchanges, newExchange({ you: ev.text })] });
        break;
      }
      case "heard": {
        this.turnStarted(this.lastVoiceAt);
        set((s) => {
          let list = s.exchanges.slice();
          const same = ev.message_id ? list.findIndex((x) => x.messageId === ev.message_id) : -1;
          if (same >= 0) {
            // More of the same turn ("…on Thursday [pause] morning"): one
            // turn, one answer, so anything after it is dropped.
            list[same] = { ...list[same], you: ev.text, youFinal: true, reply: "", spoken: 0, replyDone: false };
            list = list.slice(0, same + 1);
          } else {
            const last = list[list.length - 1];
            if (last && !last.youFinal && !last.reply) {
              list[list.length - 1] = { ...last, you: ev.text, youFinal: true, messageId: ev.message_id };
            } else {
              list.push(newExchange({ you: ev.text, youFinal: true, messageId: ev.message_id }));
            }
          }
          return { exchanges: list.slice(-20), notice: null, changed: s.changed + 1 };
        });
        break;
      }
      case "reply": {
        const s = get();
        const last = s.exchanges[s.exchanges.length - 1];
        if (!last || last.replyDone || last.interrupted) {
          // Something said that isn't an answer to new words (what a yes
          // did, a command's reply after a tapped Yes).
          if (last && last.replyDone && !last.interrupted && last.reply === ev.text) break;
          set({
            exchanges: [
              ...s.exchanges,
              newExchange({ youFinal: true, reply: ev.text, replyDone: !!ev.done, replyId: ev.message_id ?? null }),
            ].slice(-20),
          });
        } else {
          patchLast(() => ({
            reply: ev.text,
            replyDone: !!ev.done,
            replyId: ev.message_id ?? last.replyId,
            youFinal: true,
          }));
        }
        if (ev.done) set((x) => ({ changed: x.changed + 1 }));
        break;
      }
      case "spoken":
        patchLast(() => ({ spoken: ev.chars }));
        break;
      case "tool":
        set({ tool: ev.label });
        break;
      case "card":
        set((s) => ({
          cards: [...s.cards, { key: ++cardKey, kind: ev.kind, messageId: ev.message_id, meta: ev.meta }].slice(-6),
        }));
        break;
      case "ask":
        set((s) => ({
          ask: {
            question: ev.question,
            approvalId: ev.approval_id,
            messageId: ev.message_id ?? null,
            callId: ev.call_id ?? null,
            ttlMs: ev.expires_in * 1000,
            // The server's clock starts when the question has been said;
            // give the screen the same window from when it's shown.
            expiresAt: Date.now() + ev.expires_in * 1000 + 3000,
          },
          lastOutcome: null,
          changed: s.changed + 1,
        }));
        break;
      case "ask_done":
        set((s) => ({
          ask: s.ask && s.ask.approvalId === ev.approval_id ? null : s.ask,
          lastOutcome: { approvalId: ev.approval_id, outcome: ev.outcome },
          changed: s.changed + 1,
        }));
        break;
      case "stop_audio": {
        const cut = (this.player?.bufferedMs() ?? 0) > 40;
        this.player?.flush();
        this.awaitingFirstSound = false;
        set((s) => {
          const list = s.exchanges.slice();
          const last = list[list.length - 1];
          if (last && last.reply && !last.interrupted && (cut || !last.replyDone)) {
            list[list.length - 1] = { ...last, interrupted: true, replyDone: true };
          }
          return { exchanges: list, changed: s.changed + 1 };
        });
        // The server cuts the saved reply back to what was heard just after
        // it says stop: look again once that has happened.
        window.setTimeout(() => {
          if (myRun === this.run) set((x) => ({ changed: x.changed + 1 }));
        }, 1500);
        break;
      }
      case "error":
        this.lastError = { code: ev.code, show: ev.show ?? ev.say };
        if (ev.code === "nothing_to_confirm") set({ ask: null });
        set({ notice: ev.show ?? ev.say ?? "Something went wrong." });
        break;
      case "bye":
        void this.finish(ev.reason);
        break;
      case "pong": {
        const sent = this.pings.get(ev.t);
        if (sent !== undefined) {
          this.pings.delete(ev.t);
          this.rtt(performance.now() - sent);
        }
        break;
      }
      case "action":
        // The web lists no device caps, so the server sends none.
        break;
    }
  }

  private onClose(code: number, myRun: number, queryTicket: boolean): void {
    this.stopPings();
    if (this.ending || get().phase === "ended") return;
    const shown = this.lastError?.show ?? null;
    switch (code) {
      case CLOSE.unauthorized:
        if (!queryTicket && !this.triedQueryTicket) {
          // A browser that didn't send the ticket cookie: try the query.
          this.triedQueryTicket = true;
          void this.connect(myRun, true);
          return;
        }
        this.fail({ code: "not_signed_in", show: "You've been signed out. Sign in again to talk.", fatal: true });
        return;
      case CLOSE.forbidden:
        this.fail({ code: "talk_off", show: shown || "Talk isn't turned on for your account.", fatal: true, fallback: true });
        return;
      case CLOSE.notFound:
        this.fail({ code: "not_found", show: "That chat doesn't exist any more.", fatal: true });
        return;
      case CLOSE.busy:
        this.fail({
          code: "busy",
          show: shown || "Too many people are talking right now. Try again in a minute.",
          fatal: true,
          fallback: true,
        });
        return;
      case CLOSE.unavailable:
        this.fail({
          code: this.lastError?.code ?? "speech_unavailable",
          show: shown || "Voice isn't available on this server right now.",
          fatal: true,
          fallback: this.lastError?.code !== "no_model",
        });
        return;
      case CLOSE.badHello:
        this.fail({ code: "bad_hello", show: "Talk couldn't start. Reload the page and try again.", fatal: true });
        return;
      default:
        if (code === 1000 && !this.sessionId) {
          void this.finish("bye");
          return;
        }
        this.dropped(myRun);
    }
  }

  /** The connection dropped: try to pick the conversation up again. */
  private dropped(myRun: number): void {
    if (myRun !== this.run || this.ending) return;
    const now = Date.now();
    if (this.dropAt === null) {
      this.dropAt = now;
      this.drops = [...this.drops.filter((t) => now - t < DROP_WINDOW_MS), now];
    }
    this.ready = false;
    this.player?.flush();
    set({ phase: "reconnecting", talking: false });
    if (this.drops.length >= WEAK_DROPS) this.markWeak();
    if (!this.sessionId || now - this.dropAt > this.resumeS * 1000) {
      // Too late to resume: start afresh in the same chat.
      this.sessionId = null;
      if (now - (this.dropAt ?? now) > (this.resumeS + 30) * 1000) {
        this.fail({ code: "offline", show: "Lost the connection to your server.", fatal: true });
        return;
      }
    }
    const tries = Math.round((now - this.dropAt) / 1000);
    const wait = Math.min(4000, 500 * 2 ** Math.min(3, tries));
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => void this.connect(myRun), wait);
  }

  // -------------------------------------------------------------- audio
  private onMic(pcm: Int16Array, level: number): void {
    talkLevel.current = Math.min(1, level / 0.15);
    const now = performance.now();
    const s = get();
    const loud = level > SPEECH_RMS && !s.muted;
    if (loud) {
      this.lastVoiceAt = now;
      this.loudFrames += 1;
    } else {
      this.loudFrames = 0;
    }
    if (loud !== s.hearing) set({ hearing: loud });

    // Talking over it: duck at once, the server decides whether it stops.
    const p = this.player;
    if (p && p.playing && s.interruptMode === "talk" && s.turnMode === "hands_free") {
      if (this.loudFrames >= DUCK_FRAMES && this.duckedAt === null) {
        p.duck();
        this.duckedAt = now;
      }
    }
    if (this.duckedAt !== null && now - this.lastVoiceAt > UNDUCK_MS) {
      p?.unduck();
      this.duckedAt = null;
    }

    if (s.turnMode === "tap" && !s.talking) return;
    if (s.muted) return;
    if (!this.ready) {
      if (s.phase === "starting") {
        this.early.push(pcm);
        if (this.early.length > EARLY_FRAMES) this.early.shift();
      }
      return;
    }
    this.sendAudio(pcm);
  }

  private sendAudio(pcm: Int16Array): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(withSeq(this.seq, pcm));
    this.seq = (this.seq + 1) >>> 0;
  }

  /** A turn is being answered: time it from ``at`` (the end of your
   *  speech by the level meter, or now) to the answer's first sound. */
  private turnStarted(at: number): void {
    if (this.voiceEnd === null) this.voiceEnd = at || performance.now();
    if (!this.awaitingFirstSound) {
      this.awaitingFirstSound = true;
      this.player?.newReply();
    }
  }

  private onPlaying(playing: boolean): void {
    if (playing && this.awaitingFirstSound) {
      this.awaitingFirstSound = false;
      if (this.voiceEnd !== null) {
        const ms = Math.round(performance.now() - this.voiceEnd);
        this.voiceEnd = null;
        if (ms > 0 && ms < 30_000) {
          set((s) => ({ latencies: [...s.latencies, ms].slice(-50) }));
          const w = window as unknown as { __promptlyTalk?: { latencies: number[] } };
          w.__promptlyTalk = { latencies: get().latencies };
        }
      }
    }
    if (!playing && this.duckedAt !== null) {
      this.player?.unduck();
      this.duckedAt = null;
    }
  }

  // -------------------------------------------------------------- pings
  private startPings(myRun: number): void {
    this.stopPings();
    const tick = () => {
      if (myRun !== this.run || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const t = Math.floor(performance.now());
      // An unanswered ping counts as a slow one.
      for (const [k, sent] of this.pings) {
        if (performance.now() - sent > WEAK_RTT_MS * 4) {
          this.pings.delete(k);
          this.rtt(WEAK_RTT_MS * 4);
        }
      }
      this.pings.set(t, performance.now());
      this.ws.send(JSON.stringify({ type: "ping", t }));
      this.remember();
    };
    tick();
    this.pingTimer = window.setInterval(tick, PING_MS);
  }

  private stopPings(): void {
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.pings.clear();
  }

  private rtt(ms: number): void {
    this.rtts = [...this.rtts, ms].slice(-3);
    set({ rttMs: Math.round(ms) });
    const slow = this.rtts.filter((x) => x > WEAK_RTT_MS).length;
    if (this.rtts.length >= 3 && slow >= 2) this.markWeak();
  }

  private markWeak(): void {
    if (get().weak) return;
    set({ weak: true });
    // Switch at a calm moment: not in the middle of an answer.
    const s = get();
    if (s.state === "listening" || s.phase === "reconnecting") set({ fallback: "weak" });
  }

  private remember(): void {
    if (this.sessionId) saveResume({ sessionId: this.sessionId, conversationId: get().conversationId, at: Date.now() });
  }

  // -------------------------------------------------------------- actions
  private send(data: Record<string, unknown>): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }

  /** Stop it talking (keeps what you heard in the chat). */
  interrupt(): void {
    const played = this.player?.playedMs();
    this.player?.flush();
    this.send({ type: "interrupt", ...(played != null ? { played_ms: played } : {}) });
  }

  /** Stop: interrupts while it talks or thinks, otherwise ends. */
  stop(): void {
    const s = get();
    if (s.state === "speaking" || s.state === "thinking") this.interrupt();
    else void this.end();
  }

  mute(): void {
    this.send({ type: "mute" });
    set({ muted: true, talking: false });
  }

  unmute(): void {
    this.send({ type: "unmute" });
    set({ muted: false });
  }

  /** Tap to talk: your turn starts (Space down, or the orb). */
  pressTalk(): void {
    const s = get();
    if (s.turnMode !== "tap" || s.talking || s.phase !== "live") return;
    if (s.muted) this.unmute();
    if (s.state === "speaking" || s.state === "thinking") this.interrupt();
    set({ talking: true });
  }

  /** Tap to talk: you've finished. */
  releaseTalk(): void {
    if (!get().talking) return;
    set({ talking: false });
    this.turnStarted(this.lastVoiceAt);
    this.send({ type: "end_turn" });
  }

  sendText(words: string): void {
    const text = words.trim();
    if (!text) return;
    set((s) => ({ exchanges: [...s.exchanges, newExchange({ you: text, youFinal: true, typed: true })].slice(-20) }));
    this.voiceEnd = null;
    this.turnStarted(performance.now());
    this.send({ type: "text", words: text });
  }

  confirm(answer: "yes" | "no"): void {
    this.send({ type: "confirm", answer });
    set((s) => ({
      ask: null,
      exchanges: [...s.exchanges, newExchange({ you: answer === "yes" ? "Yes" : "No", youFinal: true, typed: true })].slice(-20),
    }));
    this.voiceEnd = null;
    this.turnStarted(performance.now());
  }

  /** A voice (and speed) picked on the Talk screen: the next thing said uses it. */
  setVoice(voice: string | null, speed?: number): void {
    set({ ...(voice ? { voice } : {}), ...(speed != null ? { speed } : {}) });
    this.send({ type: "prefs", ...(voice ? { voice } : {}), ...(speed != null ? { speed } : {}) });
  }

  setCaptions(on: boolean): void {
    set({ captions: on });
  }

  /** The browser held audio back (a reload with no tap yet): a tap lets it play. */
  async unlockAudio(): Promise<void> {
    try {
      await this.ctx?.resume();
    } catch {
      /* stays blocked */
    }
    set({ audioBlocked: this.ctx?.state !== "running" });
  }

  /** Play a voice sample (the voice picker) through Talk's speaker. */
  async sample(data: ArrayBuffer): Promise<void> {
    this.speechClip?.stop();
    const p = this.player;
    if (!p) return;
    const clip = await p.clip(data);
    this.speechClip = clip;
    await clip.done;
    if (this.speechClip === clip) this.speechClip = null;
  }

  stopSample(): void {
    this.speechClip?.stop();
    this.speechClip = null;
  }

  clearNotice(): void {
    set({ notice: null });
  }

  /** The chat page took the fallback: forget it was asked. */
  clearFallback(): void {
    set({ fallback: null });
  }

  /** End the conversation. */
  async end(reason = "bye"): Promise<void> {
    if (get().phase === "off") return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.ready) {
      this.ending = true;
      this.send({ type: "bye" });
      // The server says bye; don't wait long for it.
      const myRun = this.run;
      window.setTimeout(() => {
        if (myRun === this.run) void this.finish(reason);
      }, 800);
      return;
    }
    await this.finish(reason);
  }

  /** Close everything and leave Talk off (the screen goes away). */
  close(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.send({ type: "bye" });
    this.teardown();
    saveResume(null);
    useTalkStore.setState({ ...INITIAL, latencies: get().latencies, changed: get().changed });
  }

  private async finish(reason: string): Promise<void> {
    if (get().phase === "ended" || get().phase === "off") {
      this.teardown();
      return;
    }
    this.ending = true;
    if (reason === "goodbye" || reason === "idle") this.player?.tone("end");
    saveResume(null);
    set({ phase: "ended", endReason: reason, talking: false, ask: null, tool: null, hearing: false });
    // Let the tone play out before the speaker closes.
    const myRun = this.run;
    window.setTimeout(() => {
      if (myRun === this.run) this.teardown();
    }, reason === "goodbye" || reason === "idle" ? 400 : 0);
  }

  private fail(problem: TalkProblem): void {
    this.ending = true;
    saveResume(null);
    set({ phase: "ended", problem, endReason: "error", talking: false, hearing: false });
    this.teardown();
  }

  private teardown(): void {
    this.stopPings();
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.run += 1; // anything still pending from this conversation does nothing
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      try {
        ws.close(1000);
      } catch {
        /* already closed */
      }
    }
    this.mic?.close();
    this.mic = null;
    this.speechClip?.stop();
    this.speechClip = null;
    this.player?.close();
    this.player = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) {
      ctx.onstatechange = null;
      void ctx.close().catch(() => undefined);
    }
    this.ready = false;
    this.sessionId = null;
    talkLevel.current = 0;
  }

  /** The config the session started with (voices etc.). */
  get serverConfig(): TalkConfig | null {
    return this.config;
  }
}

export const talk = new TalkController();
