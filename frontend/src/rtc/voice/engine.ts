/**
 * The voice engine (web): one LiveKit connection to the voice channel
 * you're in, your microphone through our audio pipeline, everyone else's
 * sound at their own volume, Go Live and watching, and the server's
 * live-state events. Loaded on first use (``actions.ts``); writes
 * ``useVoiceStore``. One instance per tab.
 *
 * The server is the authority on where you are (``backend/app/calls``):
 * joining asks it first (it moves you off any other channel or device),
 * then connects to LiveKit with the token it hands back. Its events on the
 * Rooms stream move you (``voice_moved``), end your session
 * (``voice_disconnected``) or ask "Still there?" (``voice_still_there``).
 */
import type {
  LocalAudioTrack,
  LocalTrackPublication,
  Participant,
  RemoteParticipant,
  RemoteTrack,
  Room,
} from "livekit-client";

import type { RoomEvent as RoomsStreamEvent } from "@/api/rooms";
import { voiceApi, type StreamQuality, type VoiceJoin, type VoiceMember, type VoiceServerEvent } from "@/api/voiceChannels";
import { subscribeRoomsStream } from "@/rooms/stream";
import { useAuthStore } from "@/store/authStore";

import { savedDevice, saveDevice } from "../devices";
import { handoffUrl, hasAndroidVoiceApp, openHandoff } from "./androidApp";
import { connectionFromStats, loadLiveKit, signalUrl, type LiveKit } from "../livekit";
import {
  captureProcessing,
  chooseEngine,
  fallbackWords,
  forgetOverloads,
  rememberedOverloads,
  rememberOverload,
  usesWorkletSuppressor,
  type EngineChoice,
} from "../audio/engines";
import { asLiveKitProcessor, audioCaps, createVoiceContext, engineBytes, MicPipeline } from "../audio/pipeline";
import { streamPlan, type StreamHint } from "./goLive";
import { currentVoiceSettings, flushVoiceSettings, saveVoiceSettings, type VoicePrefs, type VoiceSettingsAll } from "./prefs";
import { applyVoiceListEvent } from "./liveEvents";
import { playVoiceSound, type VoiceSound } from "./sounds";
import { SpeakingReporter } from "./speaking";
import {
  connectionReset,
  EMPTY_CONNECTION,
  ME,
  useVoiceLevels,
  useVoiceStore,
  type VoiceEndKind,
  type VoicePeer,
  type VoiceProblemKind,
  type VoiceStoreState,
} from "./store";
import { personGain, streamGain, withLocalMute, withVolume } from "./volume";

const MICROPHONE_SOURCE = 2; // livekit TrackSource.MICROPHONE
const RECONNECT_GIVE_UP_MS = 30_000;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000];
const STATS_EVERY_MS = 5000;
const LEVELS_EVERY_MS = 100;
const REMOVED_GRACE_MS = 2000;
/** How long the Promptly app has to pick up a hand-off (the first time it
 *  asks for the microphone, so give people time to answer). */
const HANDOFF_WAIT_MS = 45_000;
/** After pressing Mute on the page for the phone: trust our own state over
 *  the server's for a moment, until the phone's report arrives. */
const REMOTE_PENDING_MS = 2500;

const set = (patch: Partial<VoiceStoreState> | ((s: VoiceStoreState) => Partial<VoiceStoreState>)) =>
  useVoiceStore.setState(patch as Partial<VoiceStoreState>);
const get = () => useVoiceStore.getState();

/** The user id in a LiveKit identity ``u:<id>``; null for anything else
 *  (a ``:view`` second connection, a test identity). */
export function userOfIdentity(identity: string): string | null {
  const m = /^u:([0-9a-f-]{36})$/i.exec(identity);
  return m ? m[1].toLowerCase() : null;
}

function statusOf(err: unknown): number | null {
  return (err as { response?: { status?: number } })?.response?.status ?? null;
}

function detailOf(err: unknown): string {
  const e = err as { response?: { data?: { detail?: unknown } }; message?: string; name?: string };
  const d = e?.response?.data?.detail;
  if (typeof d === "string") return d;
  return e?.message ?? String(err);
}

function micProblem(err: unknown): VoiceProblemKind {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "mic-denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "mic-missing";
  return "mic-failed";
}

export class VoiceEngine {
  private lk: LiveKit | null = null;
  private ctx: AudioContext | null = null;
  private room: Room | null = null;
  private join: VoiceJoin | null = null;
  private pipeline: MicPipeline | null = null;
  private choice: EngineChoice | null = null;
  private loadFailures: Partial<Record<"gtcrn" | "rnnoise", "load-failed">> = {};
  private gen = 0;
  private joining = false;
  private leaving = false;
  private settings: VoiceSettingsAll = currentVoiceSettings();
  private speakingReporter: SpeakingReporter | null = null;
  private mutedBeforeDeafen = false;
  private audioEls = new Map<string, HTMLMediaElement[]>();
  private analysers = new Map<string, { node: AnalyserNode; src: MediaStreamAudioSourceNode; buf: Float32Array }>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private unsubs: (() => void)[] = [];
  private reconnectStartedAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private removedTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEnd: { reason: VoiceEndKind; by?: string; session: string | null } | null = null;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private stateDirty = new Set<"muted" | "deafened" | "video" | "live" | "watching">();
  private pttHeld = false;
  private unsubsGlobal: (() => void)[] = [];
  private preparedAt = 0;
  private audioUnblock: (() => void) | null = null;
  /** The Promptly app on this phone holds the audio (WP-V5): this.room is
   *  then the page's listen-only connection, for cameras and streams. */
  private remote = false;
  /** What we just asked the app for, until its report says so (or a
   *  moment passes): the server's older state mustn't flip the button back. */
  private remotePending: { muted: boolean; deafened: boolean; until: number } | null = null;
  private remotePendingTimer: ReturnType<typeof setTimeout> | null = null;
  /** The server's last word on your mute / deafen (the app's reports). */
  private remoteSeen: { muted: boolean; deafened: boolean } | null = null;
  private handoffTimer: ReturnType<typeof setTimeout> | null = null;
  private viewRetry: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    try {
      const v = Number(window.localStorage.getItem("promptly.voice.streamVolume"));
      if (Number.isFinite(v) && v >= 0 && v <= 200 && window.localStorage.getItem("promptly.voice.streamVolume") !== null) set({ streamVolume: v });
    } catch {
      /* default */
    }
    // Voice settings changed anywhere (settings page, another tab's save
    // landing in the auth store): apply them to the live connection.
    this.unsubsGlobal.push(
      useAuthStore.subscribe((s, prev) => {
        if (s.user?.settings === prev.user?.settings) return;
        const next = currentVoiceSettings();
        const before = this.settings;
        this.settings = next;
        this.applySettings(before, next);
      }),
    );
    set({ noise: { ...get().noise, pref: this.settings.prefs.noise } });
  }

  // ================================================================ joining

  /** Warm up before a likely join (hover): the client library, the
   *  suppressor's files and the connection to the calls service. */
  async prepare(): Promise<void> {
    // Hovering along a channel list: once in a while is plenty.
    if (Date.now() - this.preparedAt < 30_000) return;
    this.preparedAt = Date.now();
    try {
      const lk = await this.loadLk();
      const pref = this.settings.prefs.noise;
      const c = chooseEngine(pref, audioCaps(null), { ...rememberedOverloads(), ...this.loadFailures });
      if (usesWorkletSuppressor(c.engine)) void engineBytes(c.engine).catch(() => undefined);
      if (!this.room) {
        const probe = new lk.Room();
        await probe.prepareConnection(signalUrl("/livekit"));
      }
    } catch {
      /* only a warm-up */
    }
  }

  private async loadLk(): Promise<LiveKit> {
    if (!this.lk) this.lk = await loadLiveKit();
    return this.lk;
  }

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === "closed") this.ctx = createVoiceContext();
    // Joining is a click: the context may start.
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => undefined);
    return this.ctx;
  }

  async joinChannel(roomId: string, opts: { moved?: { fromRoomId: string; by: string }; here?: boolean } = {}): Promise<boolean> {
    const s = get();
    // "Use this page instead" of the phone's app: a real join here.
    const takeOver = !!opts.here && this.remote;
    if (s.roomId === roomId && (s.status === "connected" || s.status === "joining") && !opts.moved && !takeOver) return true;
    if (hasAndroidVoiceApp() && !opts.here && !(opts.moved && !this.remote)) return this.joinViaApp(roomId, opts);
    const gen = ++this.gen;
    this.cancelReconnect();
    this.joining = true;
    const wasIdle = s.status === "idle" || s.status === "lost";
    set({
      joiningRoomId: roomId,
      problem: null,
      ...(wasIdle ? { status: "joining" as const, roomId, spaceId: null } : {}),
      ...(opts.moved ? { notice: { kind: "moved" as const, fromRoomId: opts.moved.fromRoomId, toRoomId: roomId, by: opts.moved.by, at: Date.now() } } : {}),
    });
    const ctx = this.ensureContext();
    let join: VoiceJoin;
    let lk: LiveKit;
    try {
      [lk, join] = await Promise.all([this.loadLk(), voiceApi.join(roomId)]);
    } catch (err) {
      this.joining = false;
      if (gen !== this.gen) return false;
      const st = statusOf(err);
      const kind: VoiceProblemKind = st === 409 ? "full" : st === 403 ? "forbidden" : st === 404 ? "unavailable" : "connect-failed";
      set({ problem: { kind, message: detailOf(err) }, joiningRoomId: null, ...(wasIdle ? { status: "idle" as const, roomId: null } : {}) });
      return false;
    }
    if (gen !== this.gen) {
      // Left (or joined elsewhere) while we were asking: undo this one.
      this.joining = false;
      if (!get().roomId || get().status === "idle") void voiceApi.leave(join.session_id).catch(() => undefined);
      return false;
    }
    await this.teardownRoom({ keepPipeline: true });
    this.join = join;
    this.lastEnd = null;
    this.leaveRemote();
    set({
      remote: false,
      status: "joining",
      roomId: join.room_id,
      spaceId: join.space_id,
      session: join.session_id,
      joinedAt: Date.now(),
      quality: join.quality,
      bitrate: join.bitrate,
      canTalk: join.can_talk,
      canVideo: join.can_video,
      maxStream: join.max_stream,
      serverMuted: join.server_muted,
      serverDeafened: join.server_deafened,
      members: join.members,
      peers: {},
      camera: false,
      cameraTrack: null,
      live: false,
      liveAudio: null,
      liveQuality: null,
      liveTrack: null,
      watching: null,
      stillThere: null,
      connection: EMPTY_CONNECTION,
      channels: { ...get().channels, [join.room_id]: join.members },
    });
    const ok = await this.connect(lk, ctx, join, gen);
    this.joining = false;
    if (!ok || gen !== this.gen) return false;
    this.startSession();
    this.sound("join");
    // Mute/deafen carry over between channels (as in Discord).
    if (get().muted || get().deafened) this.reportState(["muted", "deafened"]);
    return true;
  }

  /** Connect to LiveKit and publish the mic. False if it failed (the
   *  problem is in the store and you're out of voice). */
  private async connect(lk: LiveKit, ctx: AudioContext, join: VoiceJoin, gen: number): Promise<boolean> {
    const music = join.quality === "music";
    const room = new lk.Room({
      adaptiveStream: true,
      dynacast: true,
      disconnectOnPageLeave: true,
      webAudioMix: { audioContext: ctx },
      publishDefaults: {
        dtx: !music,
        red: !music,
        forceStereo: music,
        audioPreset: { maxBitrate: join.bitrate * 1000 },
        stopMicTrackOnMute: false,
        videoSimulcastLayers: [lk.VideoPresets.h180, lk.VideoPresets.h360],
      },
    });
    this.room = room;
    this.wireRoom(lk, room, gen);
    try {
      await room.connect(signalUrl(join.url), join.token, { autoSubscribe: false });
    } catch (err) {
      if (gen !== this.gen) return false;
      this.room = null;
      room.removeAllListeners();
      void voiceApi.leave(join.session_id).catch(() => undefined);
      set({ ...connectionReset(), problem: { kind: "connect-failed", message: detailOf(err) } });
      return false;
    }
    if (gen !== this.gen) return false;
    // Puts the room on our audio context before anything is published (the
    // connect only starts that, and the mic's processor needs it) and lets
    // sound play (joining was a click).
    await room.startAudio().catch(() => undefined);
    if (gen !== this.gen) return false;
    set({ status: "connected", joiningRoomId: null, audioBlocked: !room.canPlaybackAudio || ctx.state !== "running" });
    this.watchAudioBlocked(ctx);
    for (const p of room.remoteParticipants.values()) this.addPeer(p);
    this.reconcile();
    await this.syncMic();
    return true;
  }

  // ================================================================ the Promptly app (Android)

  /**
   * Join with the phone's Promptly app holding the audio: ask the server
   * for an Android session, hand it to the app (``promptly://voice``), and
   * keep this page as the remote control, with a listen-only connection for
   * cameras and streams while it's open. The server's live state is the
   * truth for mute and deafen; the app reports what it does.
   */
  private async joinViaApp(roomId: string, opts: { moved?: { fromRoomId: string; by: string } }): Promise<boolean> {
    const s = get();
    const gen = ++this.gen;
    this.cancelReconnect();
    this.joining = true;
    const wasIdle = s.status === "idle" || s.status === "lost";
    set({
      joiningRoomId: roomId,
      problem: null,
      ...(wasIdle ? { status: "joining" as const, roomId, spaceId: null } : {}),
      ...(opts.moved ? { notice: { kind: "moved" as const, fromRoomId: opts.moved.fromRoomId, toRoomId: roomId, by: opts.moved.by, at: Date.now() } } : {}),
    });
    // For the join / leave sounds while the page is in front.
    this.ensureContext();
    let join: VoiceJoin;
    try {
      join = await voiceApi.join(roomId, "android");
    } catch (err) {
      this.joining = false;
      if (gen !== this.gen) return false;
      const st = statusOf(err);
      const kind: VoiceProblemKind = st === 409 ? "full" : st === 403 ? "forbidden" : st === 404 ? "unavailable" : "connect-failed";
      set({ problem: { kind, message: detailOf(err) }, joiningRoomId: null, ...(wasIdle ? { status: "idle" as const, roomId: null } : {}) });
      return false;
    }
    if (gen !== this.gen) {
      this.joining = false;
      if (!get().roomId || get().status === "idle") void voiceApi.leave(join.session_id).catch(() => undefined);
      return false;
    }
    // First, while the tap still counts: Chrome only opens an app from one.
    openHandoff(handoffUrl(join, { channel: join.channel_name || "Voice", space: join.space_name || "" }));
    await this.teardownRoom({ keepPipeline: false });
    this.stopSession();
    this.join = join;
    // (Still "joining" until here: the old session's "replaced" isn't ours.)
    this.joining = false;
    this.lastEnd = null;
    this.remote = true;
    set({
      remote: true,
      status: "joining",
      roomId: join.room_id,
      spaceId: join.space_id,
      joiningRoomId: join.room_id,
      session: join.session_id,
      joinedAt: Date.now(),
      quality: join.quality,
      bitrate: join.bitrate,
      canTalk: join.can_talk,
      // Cameras and Go Live from the phone come with native video (phase 2).
      canVideo: false,
      maxStream: join.max_stream,
      serverMuted: join.server_muted,
      serverDeafened: join.server_deafened,
      members: join.members,
      peers: {},
      speaking: false,
      camera: false,
      cameraTrack: null,
      live: false,
      liveAudio: null,
      liveQuality: null,
      liveTrack: null,
      watching: null,
      stillThere: null,
      connection: EMPTY_CONNECTION,
      channels: { ...get().channels, [join.room_id]: join.members },
    });
    this.startSession();
    this.watchHandoff(gen);
    void this.openView(gen);
    return true;
  }

  /** Pick up a channel the app already holds (this page was opened or
   *  reloaded while you're in voice on this phone). */
  async attachToApp(roomId: string, spaceId: string | null, sessionId: string | null): Promise<void> {
    if (this.room || get().status !== "idle") return;
    const gen = ++this.gen;
    this.remote = true;
    this.join = { room_id: roomId, space_id: spaceId ?? "", session_id: sessionId ?? "" } as VoiceJoin;
    set({
      remote: true,
      status: "joining",
      roomId,
      spaceId,
      session: sessionId,
      joinedAt: Date.now(),
      canVideo: false,
      members: get().channels[roomId] ?? [],
    });
    this.startSession();
    this.watchHandoff(gen);
    await this.openView(gen);
  }

  /** The app has a while to show up in the channel; then say so. */
  private watchHandoff(gen: number): void {
    if (this.handoffTimer) clearTimeout(this.handoffTimer);
    this.handoffTimer = setTimeout(() => {
      this.handoffTimer = null;
      if (gen !== this.gen || !this.remote || get().status !== "joining") return;
      const session = this.join?.session_id;
      if (session) void voiceApi.leave(session).catch(() => undefined);
      void this.end("left", undefined, { quiet: true }).then(() => set({ problem: { kind: "app-failed", message: "" } }));
    }, HANDOFF_WAIT_MS);
  }

  /** The page's own listen-only connection: cameras and streams, and the
   *  sign that the app is in the channel (your own identity is there). */
  private async openView(gen: number): Promise<void> {
    if (this.viewRetry) clearTimeout(this.viewRetry);
    this.viewRetry = null;
    const roomId = get().roomId;
    if (!roomId || !this.remote || gen !== this.gen) return;
    let lk: LiveKit;
    let view: { url: string; token: string };
    try {
      [lk, view] = await Promise.all([this.loadLk(), voiceApi.view(roomId)]);
    } catch (err) {
      if (gen !== this.gen) return;
      // 404: not in the channel yet, or the session ended (the server's
      // event says which). Try again shortly.
      this.viewRetry = setTimeout(() => void this.openView(gen), statusOf(err) === 404 ? 2000 : 5000);
      return;
    }
    if (gen !== this.gen || !this.remote) return;
    const room = new lk.Room({ adaptiveStream: true, dynacast: false, disconnectOnPageLeave: true });
    this.room = room;
    this.wireRoom(lk, room, gen);
    try {
      await room.connect(signalUrl(view.url), view.token, { autoSubscribe: false });
    } catch {
      if (gen !== this.gen) return;
      if (this.room === room) this.room = null;
      room.removeAllListeners();
      this.viewRetry = setTimeout(() => void this.openView(gen), 5000);
      return;
    }
    if (gen !== this.gen || this.room !== room) return;
    for (const p of room.remoteParticipants.values()) this.addPeer(p);
    this.reconcile();
    this.checkApp();
  }

  private isMe(identity: string): boolean {
    const me = useAuthStore.getState().user?.id;
    return !!me && userOfIdentity(identity) === me;
  }

  /** An admin moved you while the app has the audio: the server moved the
   *  app; this page follows, with a new video connection. */
  private followAppMove(fromRoomId: string, toRoomId: string, by: string, sessionId: string): void {
    const gen = ++this.gen;
    if (this.join) this.join = { ...this.join, room_id: toRoomId, session_id: sessionId };
    set({
      roomId: toRoomId,
      session: sessionId,
      status: "joining",
      peers: {},
      watching: null,
      notice: { kind: "moved", fromRoomId, toRoomId, by, at: Date.now() },
      members: get().channels[toRoomId] ?? [],
    });
    void this.teardownRoom({ keepPipeline: false }).then(() => {
      if (gen !== this.gen) return;
      this.watchHandoff(gen);
      void this.openView(gen);
    });
  }

  /** Is the app's connection (your own identity) in the channel? */
  private checkApp(): void {
    const room = this.room;
    const me = useAuthStore.getState().user?.id;
    if (!this.remote || !room || !me) return;
    const here = [...room.remoteParticipants.values()].some((p) => userOfIdentity(p.identity) === me);
    const st = get().status;
    if (here && (st === "joining" || st === "reconnecting")) {
      if (this.handoffTimer) clearTimeout(this.handoffTimer);
      this.handoffTimer = null;
      set({ status: "connected", joiningRoomId: null });
      if (st === "joining") this.sound("join");
    } else if (!here && st === "connected") {
      // The app is reconnecting (or gone, which the server will say).
      set({ status: "reconnecting", speaking: false });
    }
  }

  private leaveRemote(): void {
    this.remote = false;
    this.remotePending = null;
    this.remoteSeen = null;
    if (this.remotePendingTimer) clearTimeout(this.remotePendingTimer);
    this.remotePendingTimer = null;
    if (this.handoffTimer) clearTimeout(this.handoffTimer);
    this.handoffTimer = null;
    if (this.viewRetry) clearTimeout(this.viewRetry);
    this.viewRetry = null;
  }

  /** Mute / deafen the app's connection, through the server. */
  private remoteControl(action: "mute" | "unmute" | "deafen" | "undeafen"): void {
    const s = get();
    this.remotePending = { muted: s.muted, deafened: s.deafened, until: Date.now() + REMOTE_PENDING_MS };
    if (this.remotePendingTimer) clearTimeout(this.remotePendingTimer);
    // If the app never says so, the server's state wins after the moment.
    this.remotePendingTimer = setTimeout(() => {
      this.remotePendingTimer = null;
      this.remotePending = null;
      if (this.remote && this.remoteSeen) set(this.remoteSeen);
    }, REMOTE_PENDING_MS);
    void voiceApi.control(action).catch((err) => {
      if (statusOf(err) === 404) void this.resync();
    });
  }

  private wireRoom(lk: LiveKit, room: Room, gen: number): void {
    const E = lk.RoomEvent;
    const mine = () => gen === this.gen && this.room === room;
    room
      .on(E.ParticipantConnected, (p) => {
        if (!mine()) return;
        if (this.isMe(p.identity)) {
          this.checkApp();
          return;
        }
        this.addPeer(p);
        this.reconcile();
        if (userOfIdentity(p.identity)) this.sound("peer-join");
      })
      .on(E.ParticipantDisconnected, (p) => {
        if (!mine()) return;
        if (this.isMe(p.identity)) {
          this.checkApp();
          return;
        }
        const uid = userOfIdentity(p.identity);
        if (!uid) return;
        this.dropLevel(uid);
        for (const [key, els] of this.audioEls) {
          if (key.startsWith(`${uid}:`)) {
            els.forEach((el) => el.remove());
            this.audioEls.delete(key);
          }
        }
        set((s) => {
          const peers = { ...s.peers };
          delete peers[uid];
          return { peers, watching: s.watching === uid ? null : s.watching };
        });
        this.sound("peer-leave");
      })
      .on(E.TrackPublished, () => mine() && this.reconcile())
      .on(E.TrackUnpublished, (pub, p) => {
        if (!mine()) return;
        this.refreshPeer(p);
        if (pub.source === lk.Track.Source.ScreenShare && get().watching === userOfIdentity(p.identity)) this.setWatching(null);
      })
      .on(E.TrackSubscribed, (track, _pub, p) => mine() && this.onSubscribed(lk, track, p))
      .on(E.TrackUnsubscribed, (track, _pub, p) => mine() && this.onUnsubscribed(track, p))
      .on(E.TrackMuted, (_pub, p) => mine() && p !== room.localParticipant && this.refreshPeer(p as RemoteParticipant))
      .on(E.TrackUnmuted, (_pub, p) => mine() && p !== room.localParticipant && this.refreshPeer(p as RemoteParticipant))
      .on(E.ActiveSpeakersChanged, (speakers: Participant[]) => {
        if (!mine()) return;
        const on = new Set(speakers.map((p) => userOfIdentity(p.identity)).filter(Boolean) as string[]);
        if (this.remote) {
          // The app's connection is you: your ring, from LiveKit itself.
          const me = useAuthStore.getState().user?.id ?? "";
          const talking = on.has(me) && !get().muted && !get().deafened;
          if (get().speaking !== talking) set({ speaking: talking });
        }
        set((s) => {
          const peers: Record<string, VoicePeer> = {};
          for (const [id, peer] of Object.entries(s.peers)) peers[id] = peer.speaking === on.has(id) ? peer : { ...peer, speaking: on.has(id) };
          return { peers };
        });
        if (!this.pipeline && !this.remote) {
          // No worklet here: LiveKit's own speaking flag drives the reports.
          const me = on.has(userOfIdentity(room.localParticipant.identity) ?? "");
          this.onGate(me);
        }
      })
      .on(E.ConnectionQualityChanged, (q, p) => {
        if (!mine()) return;
        const quality = (["excellent", "good", "poor", "lost"].includes(q) ? q : "unknown") as VoicePeer["connectionQuality"];
        if (p === room.localParticipant) set((s) => ({ connection: { ...s.connection, quality } }));
        else {
          const uid = userOfIdentity(p.identity);
          if (uid) set((s) => (s.peers[uid] ? { peers: { ...s.peers, [uid]: { ...s.peers[uid], connectionQuality: quality } } } : {}));
        }
      })
      .on(E.ParticipantPermissionsChanged, (_prev, p) => {
        if (!mine() || p !== room.localParticipant) return;
        // A server-mute lifted (or put on): publish the mic again when allowed.
        void this.syncMic();
        this.reconcile();
      })
      .on(E.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
        if (!mine()) return;
        if (pub.source === lk.Track.Source.ScreenShare) {
          set({ live: false, liveAudio: null, liveQuality: null, liveTrack: null });
          this.reportState(["live"]);
        } else if (pub.source === lk.Track.Source.Camera) {
          set({ camera: false, cameraTrack: null });
          this.reportState(["video"]);
        }
      })
      .on(E.DataReceived, (payload, participant, _kind, topic) => {
        if (!mine() || participant || topic !== "voice.control") return;
        try {
          this.onControl(JSON.parse(new TextDecoder().decode(payload)) as { action?: string });
        } catch {
          /* not for us */
        }
      })
      .on(E.AudioPlaybackStatusChanged, () => {
        if (!mine()) return;
        set({ audioBlocked: !room.canPlaybackAudio || this.ctx?.state !== "running" });
      })
      // (The page's own connection, when the app has the audio: that's
      // just video, and the app's state is what counts.)
      .on(E.Reconnecting, () => mine() && !this.remote && set({ status: "reconnecting" }))
      .on(E.SignalReconnecting, () => mine() && !this.remote && set({ status: "reconnecting" }))
      .on(E.Reconnected, () => {
        if (!mine()) return;
        if (this.remote) this.checkApp();
        else set({ status: "connected" });
        this.reconcile();
      })
      .on(E.Disconnected, (reason) => {
        if (!mine()) return;
        this.onDisconnected(lk, reason);
      });
  }

  // ================================================================ session

  private startSession(): void {
    if (this.unsubs.length) return;
    // The server's voice events, wherever in the app you are.
    this.unsubs.push(subscribeRoomsStream({ onEvent: (ev) => this.onServerEvent(ev), onReconnect: () => void this.resync() }));
    this.unsubs.push(this.installKeys());
    const pagehide = () => void flushVoiceSettings();
    window.addEventListener("pagehide", pagehide);
    this.unsubs.push(() => window.removeEventListener("pagehide", pagehide));
    this.timers.push(setInterval(() => void this.pollStats(), STATS_EVERY_MS));
    this.timers.push(setInterval(() => this.pollLevels(), LEVELS_EVERY_MS));
    // The app reports its own speaking when it has the audio.
    if (!this.remote) this.speakingReporter = new SpeakingReporter((on) => voiceApi.speaking(on));
  }

  private stopSession(): void {
    this.unsubs.splice(0).forEach((u) => u());
    this.audioUnblock?.();
    this.audioUnblock = null;
    this.timers.splice(0).forEach((t) => clearInterval(t));
    this.speakingReporter?.stop();
    this.speakingReporter = null;
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = null;
    this.stateDirty.clear();
  }

  /** The browser held sound back (a join without a click, e.g. after a
   *  reload): any click or key turns it on; this does it from a button. */
  async resumeAudio(): Promise<void> {
    const ctx = this.ctx;
    if (ctx && ctx.state === "suspended") await ctx.resume().catch(() => undefined);
    await this.room?.startAudio().catch(() => undefined);
    set({ audioBlocked: !!this.room && (!this.room.canPlaybackAudio || this.ctx?.state !== "running") });
  }

  private watchAudioBlocked(ctx: AudioContext): void {
    if (ctx.state === "running" && this.room?.canPlaybackAudio !== false) return;
    const onGesture = () => {
      void this.resumeAudio().then(() => {
        if (!get().audioBlocked) off();
      });
    };
    const onState = () => set({ audioBlocked: ctx.state !== "running" || this.room?.canPlaybackAudio === false });
    const off = () => {
      window.removeEventListener("pointerdown", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
      ctx.removeEventListener("statechange", onState);
    };
    window.addEventListener("pointerdown", onGesture, true);
    window.addEventListener("keydown", onGesture, true);
    ctx.addEventListener("statechange", onState);
    this.audioUnblock?.();
    this.audioUnblock = off;
  }

  async leave(): Promise<void> {
    const s = get();
    if (s.status === "idle" && !this.room) return;
    this.gen++;
    this.leaving = true;
    this.cancelReconnect();
    const session = this.join?.session_id;
    this.sound("leave");
    // (With the app holding the audio, the server removes it from the channel.)
    if (session) void voiceApi.leave(session).catch(() => undefined);
    await this.teardownRoom({ keepPipeline: false });
    this.stopSession();
    this.leaveRemote();
    this.join = null;
    this.leaving = false;
    this.closeContextSoon();
    set({ ...connectionReset() });
  }

  private closeContextSoon(): void {
    // Let the leave sound finish.
    const ctx = this.ctx;
    window.setTimeout(() => {
      if (ctx && this.ctx === ctx && !this.room && ctx.state !== "closed") {
        void ctx.close().catch(() => undefined);
        this.ctx = null;
      }
    }, 600);
  }

  private async teardownRoom(opts: { keepPipeline: boolean }): Promise<void> {
    const room = this.room;
    this.room = null;
    if (this.removedTimer) clearTimeout(this.removedTimer);
    this.removedTimer = null;
    for (const els of this.audioEls.values()) for (const el of els) el.remove();
    this.audioEls.clear();
    for (const uid of [...this.analysers.keys()]) this.dropLevel(uid);
    if (room) {
      room.removeAllListeners();
      try {
        await room.disconnect(true);
      } catch {
        /* gone already */
      }
    }
    if (!opts.keepPipeline) {
      this.pipeline?.destroy();
      this.pipeline = null;
      this.choice = null;
    } else {
      this.pipeline?.disconnectSource();
    }
    useVoiceLevels.setState({ levels: {} });
  }

  /** You're out of the channel without having asked (removed, moved off,
   *  joined elsewhere, connection lost). */
  private async end(reason: VoiceEndKind, by?: string, opts: { quiet?: boolean } = {}): Promise<void> {
    const roomId = get().roomId;
    this.gen++;
    this.cancelReconnect();
    this.leaveRemote();
    await this.teardownRoom({ keepPipeline: false });
    this.stopSession();
    this.join = null;
    if (!opts.quiet) this.sound("disconnect");
    this.closeContextSoon();
    set({ ...connectionReset(), notice: roomId && !opts.quiet ? { kind: "ended", reason, roomId, by, at: Date.now() } : null });
  }

  // ================================================================ server events

  onServerEvent(ev: RoomsStreamEvent): void {
    if (!("type" in ev) || !ev.type.startsWith("voice_")) return;
    const e = ev as VoiceServerEvent;
    switch (e.type) {
      case "voice_state":
        applyVoiceListEvent(e);
        this.onVoiceState(e.room_id, e.members);
        return;
      case "voice_speaking":
        applyVoiceListEvent(e);
        return;
      case "voice_moved":
        if (e.handled && this.remote && this.join && e.from_room_id === this.join.room_id) {
          // The server moved the app's connection; follow it with this page.
          this.followAppMove(e.from_room_id, e.to_room_id, e.by, e.session);
          return;
        }
        if (e.handled || !this.join || e.session !== this.join.session_id) return;
        void this.joinChannel(e.to_room_id, { moved: { fromRoomId: e.from_room_id, by: e.by } });
        return;
      case "voice_disconnected": {
        if (!this.join || e.session !== this.join.session_id) return;
        if (this.leaving) return;
        if (this.joining && e.reason === "replaced") return; // our own move
        this.lastEnd = { reason: e.reason, by: e.by, session: e.session };
        void this.end(e.reason, e.by);
        return;
      }
      case "voice_still_there":
        if (get().roomId !== e.room_id) return;
        set({ stillThere: { roomId: e.room_id, deadline: e.deadline, seconds: e.seconds } });
        return;
      case "voice_still_here":
        if (get().stillThere) set({ stillThere: null });
        return;
    }
  }

  /** A ``voice_state`` for any channel (lists), and for yours (icons,
   *  server-mute, who's live and who's watching). */
  onVoiceState(roomId: string, members: VoiceMember[]): void {
    if (get().roomId !== roomId || !this.join) return;
    const uid = useAuthStore.getState().user?.id;
    const me = members.find((m) => m.user_id === uid);
    const patch: Partial<VoiceStoreState> = { members };
    if (me) {
      patch.serverMuted = me.server_muted;
      patch.serverDeafened = me.server_deafened;
      if (this.remote) {
        // The app's own reports are the truth for your mute and deafen,
        // once it has caught up with what this page just asked for.
        this.remoteSeen = { muted: me.muted, deafened: me.deafened };
        const p = this.remotePending;
        const waiting = p && Date.now() < p.until && (p.muted !== me.muted || p.deafened !== me.deafened);
        if (!waiting) {
          this.remotePending = null;
          patch.muted = me.muted;
          patch.deafened = me.deafened;
        }
      }
    }
    const watching = get().watching;
    if (watching && !members.some((m) => m.user_id === watching && m.live)) patch.watching = null;
    const before = get();
    set(patch);
    if (patch.watching === null && watching) {
      this.reconcile();
      this.reportState(["watching"]);
    }
    if (me && (me.server_deafened !== before.serverDeafened || me.server_muted !== before.serverMuted)) {
      this.reconcile();
      void this.syncMic();
    }
  }

  /** The Rooms stream came back: refresh where we stand. */
  private async resync(): Promise<void> {
    if (!this.join) return;
    try {
      const me = await voiceApi.me();
      if (!this.join) return;
      if (this.remote && me.room_id === this.join.room_id && me.device !== "android") {
        void this.end("replaced");
        return;
      }
      if (me.room_id !== this.join.room_id) {
        if (get().status === "connected") void this.end(this.lastEnd?.reason ?? "removed", this.lastEnd?.by);
      } else if (me.session_id && me.session_id !== this.join.session_id) {
        // The server re-registered this connection after a reconnect.
        this.join = { ...this.join, session_id: me.session_id };
        set({ session: me.session_id });
      }
    } catch {
      /* next time */
    }
  }

  private onControl(msg: { action?: string }): void {
    if (this.remote) return; // the app's connection gets those, not this page's
    switch (msg.action) {
      case "mute":
        void this.setMuted(true);
        return;
      case "unmute":
        void this.setMuted(false);
        return;
      case "deafen":
        void this.setDeafened(true);
        return;
      case "undeafen":
        void this.setDeafened(false);
        return;
      case "leave":
        void this.end((this.lastEnd?.reason as VoiceEndKind) ?? "left");
        return;
    }
  }

  private onDisconnected(lk: LiveKit, reason: number | undefined): void {
    const R = lk.DisconnectReason;
    if (reason === R.CLIENT_INITIATED) return;
    if (this.remote) {
      // Only the page's video connection: open it again (the server's
      // events decide whether you're still in the channel).
      const gen = this.gen;
      void this.teardownRoom({ keepPipeline: false }).then(() => {
        if (gen === this.gen && this.remote && reason !== R.DUPLICATE_IDENTITY) this.viewRetry = setTimeout(() => void this.openView(gen), 2000);
      });
      return;
    }
    if (this.joining) return; // our own move replaced this connection
    if (reason === R.DUPLICATE_IDENTITY) {
      void this.end("replaced");
      return;
    }
    if (reason === R.PARTICIPANT_REMOVED || reason === R.ROOM_DELETED || reason === R.ROOM_CLOSED) {
      // The server took us out; its event says why (it may still be on
      // its way). Wait a moment for it.
      if (this.lastEnd) return;
      set({ status: "reconnecting" });
      this.removedTimer = setTimeout(() => {
        this.removedTimer = null;
        if (!this.lastEnd && this.join) void this.end("removed");
      }, REMOVED_GRACE_MS);
      return;
    }
    // Network trouble: rejoin on our own for up to 30 s.
    this.startReconnect();
  }

  private startReconnect(): void {
    const roomId = get().roomId;
    if (!roomId) return;
    this.reconnectStartedAt = Date.now();
    set({ status: "reconnecting" });
    void this.teardownRoom({ keepPipeline: true });
    this.scheduleReconnect(roomId, 0);
  }

  private scheduleReconnect(roomId: string, attempt: number): void {
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (get().roomId !== roomId || get().status !== "reconnecting") return;
      const gen = ++this.gen;
      let join: VoiceJoin;
      let lk: LiveKit;
      try {
        [lk, join] = await Promise.all([this.loadLk(), voiceApi.join(roomId)]);
      } catch (err) {
        if (gen !== this.gen) return;
        const st = statusOf(err);
        if (st === 403 || st === 404 || st === 409) {
          void this.end("access");
          return;
        }
        return this.retryOrGiveUp(roomId, attempt);
      }
      if (gen !== this.gen) return;
      this.join = join;
      set({ session: join.session_id, members: join.members, serverMuted: join.server_muted, serverDeafened: join.server_deafened });
      const ok = await this.connect(lk, this.ensureContext(), join, gen);
      if (gen !== this.gen) return;
      if (ok) {
        set({ problem: null });
        if (get().muted || get().deafened) this.reportState(["muted", "deafened"]);
        return;
      }
      set({ status: "reconnecting", roomId, problem: null });
      this.retryOrGiveUp(roomId, attempt);
    }, delay);
  }

  private retryOrGiveUp(roomId: string, attempt: number): void {
    if (Date.now() - this.reconnectStartedAt >= RECONNECT_GIVE_UP_MS) {
      this.stopSession();
      set({ status: "lost", roomId, notice: { kind: "ended", reason: "connection", roomId, at: Date.now() } });
      return;
    }
    this.scheduleReconnect(roomId, attempt + 1);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  // ================================================================ microphone

  private micAllowed(): boolean {
    const room = this.room;
    const s = get();
    if (!room || !s.canTalk || s.serverMuted || s.serverDeafened) return false;
    const perm = room.localParticipant.permissions;
    if (!perm) return true;
    if (!perm.canPublish) return false;
    const sources = perm.canPublishSources ?? [];
    return sources.length === 0 || (sources as number[]).includes(MICROPHONE_SOURCE);
  }

  private resolveEngine(): EngineChoice {
    const prefs = this.settings.prefs;
    const choice = chooseEngine(prefs.noise, audioCaps(this.ctx), { ...rememberedOverloads(), ...this.loadFailures });
    const prev = this.choice;
    this.choice = choice;
    set((s) => ({ noise: { ...s.noise, pref: prefs.noise, engine: choice.engine, reason: choice.reason } }));
    if (choice.reason && prefs.noise === "enhanced" && (!prev || prev.reason !== choice.reason) && fallbackWords(choice.reason)) {
      if (choice.reason === "overloaded" || choice.reason === "load-failed") {
        set({ notice: { kind: "noise-fallback", reason: choice.reason, at: Date.now() } });
      }
    }
    return choice;
  }

  private gateConfig() {
    const p = this.settings.prefs;
    return { mode: p.input_mode, auto: p.auto_sensitivity, thresholdDb: p.sensitivity_db, releaseMs: p.ptt_release_ms };
  }

  private async ensurePipeline(): Promise<MicPipeline | null> {
    const ctx = this.ensureContext();
    const choice = this.choice ?? this.resolveEngine();
    const stereo = this.join?.quality === "music";
    if (this.pipeline && this.pipeline.ctx === ctx && this.pipeline.stereo === stereo) return this.pipeline;
    this.pipeline?.destroy();
    this.pipeline = null;
    if (!audioCaps(ctx).audioWorklet) return null;
    try {
      const p = await MicPipeline.create(ctx, {
        engine: choice.engine,
        stereo,
        gate: this.gateConfig(),
        agc: usesWorkletSuppressor(choice.engine) && this.settings.prefs.agc,
        inputGain: this.settings.prefs.input_volume / 100,
        muted: get().muted || get().deafened,
      });
      this.pipeline = p;
      this.wirePipeline(p);
      return p;
    } catch {
      return null;
    }
  }

  private wirePipeline(p: MicPipeline): void {
    p.on("gate", (open) => this.onGate(open));
    p.on("talking", (on) => set({ talkingWhileMuted: on && (get().muted || get().deafened) }));
    p.on("quiet", (on) => set({ quiet: on }));
    p.on("load", ({ ratio }) => set((s) => ({ noise: { ...s.noise, load: ratio } })));
    p.on("ready", (engine) => set((s) => ({ noise: { ...s.noise, engine: engine === "none" ? (this.choice?.engine === "none" ? "none" : "browser") : engine } })));
    p.on("overload", (engine) => {
      if (engine === "gtcrn" || engine === "rnnoise") {
        rememberOverload(engine);
        void this.switchEngine();
      }
    });
    p.on("failed", ({ engine }) => {
      if (engine === "gtcrn" || engine === "rnnoise") {
        this.loadFailures[engine] = "load-failed";
        void this.switchEngine();
      }
    });
  }

  private onGate(open: boolean): void {
    const s = get();
    const sending = open && !s.muted && !s.deafened && this.micAllowed();
    if (s.speaking !== sending) set({ speaking: sending });
    if (sending) this.speakingReporter?.input(true);
    else this.speakingReporter?.input(false);
  }

  private captureOptions(engine = this.choice?.engine ?? "browser") {
    const p = this.settings.prefs;
    const music = this.join?.quality === "music";
    const supported = typeof navigator !== "undefined" ? (navigator.mediaDevices?.getSupportedConstraints?.() ?? {}) : {};
    const voiceIsolation = engine === "browser" && "voiceIsolation" in supported ? { voiceIsolation: true } : {};
    return {
      deviceId: savedDevice("mic") || undefined,
      channelCount: music ? 2 : 1,
      ...captureProcessing(engine, { echo: p.echo, agc: p.agc }),
      ...voiceIsolation,
    };
  }

  /** Publish, mute or unpublish the mic to match what you want and may. */
  private async syncMic(): Promise<void> {
    const room = this.room;
    const lk = this.lk;
    if (!room || !lk || !this.join || this.remote) return;
    const s = get();
    const allowed = this.micAllowed();
    const want = allowed && !s.muted && !s.deafened;
    const pub = room.localParticipant.getTrackPublication(lk.Track.Source.Microphone);
    try {
      if (want) {
        if (pub?.track) {
          if (pub.isMuted) await room.localParticipant.setMicrophoneEnabled(true);
        } else {
          this.resolveEngine();
          const pipeline = await this.ensurePipeline();
          const music = this.join.quality === "music";
          // Made here rather than by setMicrophoneEnabled: LiveKit applies a
          // processor passed in capture options before the track has an
          // audio context (livekit-client 2.23), which throws. So: capture,
          // give it our context, put the pipeline on, then publish, so no
          // unprocessed sound ever goes out.
          const track = await lk.createLocalAudioTrack(this.captureOptions());
          if (this.room !== room) {
            track.stop();
            return;
          }
          if (pipeline) {
            await track.setAudioContext(pipeline.ctx);
            await track.setProcessor(asLiveKitProcessor(pipeline));
          }
          await room.localParticipant.publishTrack(track, {
            source: lk.Track.Source.Microphone,
            dtx: !music,
            red: !music,
            forceStereo: music,
            audioPreset: { maxBitrate: this.join.bitrate * 1000 },
          });
          if (this.room !== room) return;
          set({ problem: get().problem?.kind.startsWith("mic") ? null : get().problem });
        }
      } else if (pub?.track && !pub.isMuted && allowed) {
        await room.localParticipant.setMicrophoneEnabled(false);
      }
    } catch (err) {
      if (this.room !== room) return;
      // Listen-only: you're still in the channel and hear everyone.
      set({ problem: { kind: micProblem(err), message: detailOf(err) } });
    }
    this.pipeline?.configure({ muted: s.muted || s.deafened || !allowed });
    if (!want) {
      this.speakingReporter?.forceOff();
      if (get().speaking) set({ speaking: false });
    }
  }

  async setMuted(muted: boolean, opts: { silent?: boolean } = {}): Promise<void> {
    const s = get();
    if (!muted && s.deafened) {
      await this.setDeafened(false);
      return;
    }
    if (s.muted === muted) return;
    if (this.remote) {
      set({ muted, talkingWhileMuted: false, ...(muted ? { speaking: false } : {}) });
      if (!opts.silent) this.sound(muted ? "mute" : "unmute");
      this.remoteControl(muted ? "mute" : "unmute");
      return;
    }
    set({ muted, talkingWhileMuted: false });
    if (!opts.silent) this.sound(muted ? "mute" : "unmute");
    await this.syncMic();
    this.reportState(["muted"]);
  }

  async setDeafened(deafened: boolean): Promise<void> {
    const s = get();
    if (s.deafened === deafened) return;
    if (deafened) {
      this.mutedBeforeDeafen = s.muted;
      set({ deafened: true, muted: true, talkingWhileMuted: false });
    } else {
      set({ deafened: false, muted: this.mutedBeforeDeafen });
    }
    this.sound(deafened ? "deafen" : "undeafen");
    if (this.remote) {
      this.remoteControl(deafened ? "deafen" : "undeafen");
      this.reconcile();
      return;
    }
    this.reconcile();
    await this.syncMic();
    this.reportState(["muted", "deafened"]);
  }

  /** "Try again" after the microphone was refused or failed (still in
   *  the channel, listening). */
  async retryMic(): Promise<void> {
    set({ problem: null });
    if (this.remote) return;
    await this.syncMic();
  }

  /** Push to talk from an on-screen button (phones) or the keybind. */
  pushToTalk(down: boolean): void {
    // The app always uses voice activity.
    if (this.remote && down) return;
    if (this.pttHeld === down) return;
    this.pttHeld = down;
    this.pipeline?.ptt(down);
    set({ pttActive: down });
  }

  // ================================================================ reports

  /** Tell the server what changed (coalesced, one request). */
  private reportState(fields: ("muted" | "deafened" | "video" | "live" | "watching")[]): void {
    if (!this.join) return;
    fields.forEach((f) => this.stateDirty.add(f));
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => void this.sendState(), 60);
  }

  private async sendState(): Promise<void> {
    this.stateTimer = null;
    if (!this.join || !this.stateDirty.size) return;
    const s = get();
    const body: Record<string, unknown> = { session: this.join.session_id };
    for (const f of this.stateDirty) {
      if (f === "muted") body.muted = s.muted;
      if (f === "deafened") body.deafened = s.deafened;
      if (f === "video") body.video = s.camera;
      if (f === "live") body.live = s.live;
      if (f === "watching") body.watching = s.watching ?? "";
    }
    this.stateDirty.clear();
    try {
      await voiceApi.state(body);
    } catch (err) {
      if (statusOf(err) === 404) void this.resync();
    }
  }

  // ================================================================ remote people

  private peerOf(p: RemoteParticipant): VoicePeer | null {
    const lk = this.lk;
    const uid = userOfIdentity(p.identity);
    // Your own identity is the app's connection, not someone else.
    if (!lk || !uid || this.isMe(p.identity)) return null;
    const S = lk.Track.Source;
    const mic = p.getTrackPublication(S.Microphone);
    const cam = p.getTrackPublication(S.Camera);
    const scr = p.getTrackPublication(S.ScreenShare);
    const scrAudio = p.getTrackPublication(S.ScreenShareAudio);
    const prev = get().peers[uid];
    return {
      userId: uid,
      speaking: prev?.speaking ?? p.isSpeaking,
      hasMic: !!mic,
      micMuted: !mic || mic.isMuted,
      camera: cam?.isSubscribed && cam.videoTrack && !cam.isMuted ? (cam.videoTrack as VoicePeer["camera"]) : null,
      live: !!scr,
      screen: scr?.isSubscribed && scr.videoTrack ? (scr.videoTrack as VoicePeer["screen"]) : null,
      streamAudio: !!scrAudio,
      connectionQuality: prev?.connectionQuality ?? "unknown",
    };
  }

  private addPeer(p: RemoteParticipant): void {
    this.refreshPeer(p);
  }

  private refreshPeer(p: RemoteParticipant): void {
    const peer = this.peerOf(p);
    if (!peer) return;
    set((s) => ({ peers: { ...s.peers, [peer.userId]: peer } }));
  }

  /** Subscribe to exactly what you should hear and see, at the right volumes. */
  reconcile(): void {
    const room = this.room;
    const lk = this.lk;
    if (!room || !lk) return;
    const s = get();
    const S = lk.Track.Source;
    const v = { volumes: this.settings.volumes, localMutes: this.settings.localMutes, output: this.settings.prefs.output_volume };
    const hearing = !s.deafened && !s.serverDeafened;
    for (const p of room.remoteParticipants.values()) {
      const uid = userOfIdentity(p.identity);
      if (!uid || this.isMe(p.identity)) continue;
      for (const pub of p.trackPublications.values()) {
        let want: boolean;
        switch (pub.source) {
          case S.Microphone:
            // With the app holding the audio, voices play there, not here.
            want = hearing && !this.remote && !this.settings.localMutes.includes(uid);
            break;
          case S.ScreenShare:
            want = s.watching === uid;
            break;
          case S.ScreenShareAudio:
            want = s.watching === uid && hearing;
            break;
          case S.Camera:
            want = !this.settings.prefs.data_saver;
            break;
          default:
            want = false;
        }
        if (s.serverDeafened && want) want = false;
        if (pub.isSubscribed !== want) pub.setSubscribed(want);
        if (want && pub.source === S.ScreenShare) pub.setVideoQuality(this.settings.prefs.data_saver ? lk.VideoQuality.LOW : lk.VideoQuality.HIGH);
      }
      p.setVolume(personGain(uid, v), S.Microphone);
      p.setVolume(streamGain(s.streamVolume, this.settings.prefs.output_volume), S.ScreenShareAudio);
      this.refreshPeer(p);
    }
  }

  private onSubscribed(lk: LiveKit, track: RemoteTrack, p: RemoteParticipant): void {
    const uid = userOfIdentity(p.identity);
    if (!uid) return;
    if (track.kind === lk.Track.Kind.Audio) {
      // With Web Audio mixing the element stays muted and only keeps the
      // stream flowing; the sound goes through the audio context.
      const el = track.attach();
      const key = `${uid}:${track.source}`;
      this.audioEls.set(key, [...(this.audioEls.get(key) ?? []), el]);
      if (track.source === lk.Track.Source.Microphone) this.addLevel(uid, track.mediaStreamTrack);
      this.reconcileVolumes(p);
    }
    this.refreshPeer(p);
  }

  private onUnsubscribed(track: RemoteTrack, p: RemoteParticipant): void {
    const uid = userOfIdentity(p.identity);
    if (!uid) return;
    const key = `${uid}:${track.source}`;
    for (const el of track.detach()) el.remove();
    this.audioEls.delete(key);
    if (track.source === this.lk?.Track.Source.Microphone) this.dropLevel(uid);
    this.refreshPeer(p);
  }

  private reconcileVolumes(p: RemoteParticipant): void {
    const lk = this.lk;
    const uid = userOfIdentity(p.identity);
    if (!lk || !uid) return;
    const v = { volumes: this.settings.volumes, localMutes: this.settings.localMutes, output: this.settings.prefs.output_volume };
    p.setVolume(personGain(uid, v), lk.Track.Source.Microphone);
    p.setVolume(streamGain(get().streamVolume, this.settings.prefs.output_volume), lk.Track.Source.ScreenShareAudio);
  }

  setPersonVolume(userId: string, pct: number): void {
    const volumes = withVolume(this.settings.volumes, userId, pct);
    this.settings = { ...this.settings, volumes };
    saveVoiceSettings({ volumes });
    this.reconcile();
  }

  setLocalMute(userId: string, muted: boolean): void {
    const localMutes = withLocalMute(this.settings.localMutes, userId, muted);
    this.settings = { ...this.settings, localMutes };
    saveVoiceSettings({ localMutes });
    this.reconcile();
  }

  setStreamVolume(pct: number): void {
    set({ streamVolume: Math.max(0, Math.min(200, Math.round(pct))) });
    try {
      window.localStorage.setItem("promptly.voice.streamVolume", String(get().streamVolume));
    } catch {
      /* this page only */
    }
    this.reconcile();
  }

  // ================================================================ levels and stats

  private addLevel(uid: string, mst: MediaStreamTrack): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.dropLevel(uid);
    try {
      const src = ctx.createMediaStreamSource(new MediaStream([mst]));
      const node = ctx.createAnalyser();
      node.fftSize = 512;
      src.connect(node);
      this.analysers.set(uid, { node, src, buf: new Float32Array(node.fftSize) });
    } catch {
      /* no meter for them */
    }
  }

  private dropLevel(uid: string): void {
    const a = this.analysers.get(uid);
    if (!a) return;
    try {
      a.src.disconnect();
    } catch {
      /* fine */
    }
    this.analysers.delete(uid);
  }

  private pollLevels(): void {
    const levels: Record<string, number> = {};
    for (const [uid, a] of this.analysers) {
      a.node.getFloatTimeDomainData(a.buf as Float32Array<ArrayBuffer>);
      let sum = 0;
      for (let i = 0; i < a.buf.length; i++) sum += a.buf[i] * a.buf[i];
      const db = 20 * Math.log10(Math.sqrt(sum / a.buf.length) + 1e-9);
      levels[uid] = Math.max(0, Math.min(1, (db + 60) / 60));
    }
    const mine = this.pipeline?.reading;
    levels[ME] = mine ? (get().muted || get().deafened ? 0 : mine.level) : 0;
    useVoiceLevels.setState({ levels });
  }

  private async pollStats(): Promise<void> {
    const room = this.room;
    const lk = this.lk;
    if (!room || !lk || get().status !== "connected") return;
    try {
      const mic = room.localParticipant.getTrackPublication(lk.Track.Source.Microphone)?.track;
      const some = mic ?? [...room.remoteParticipants.values()].flatMap((p) => [...p.trackPublications.values()]).find((x) => x.track)?.track;
      const report = (await some?.getRTCStatsReport?.()) as RTCStatsReport | undefined;
      if (!report) return;
      const info = connectionFromStats(report as never);
      let lossPct: number | null = null;
      report.forEach((st: Record<string, unknown>) => {
        if (st.type === "remote-inbound-rtp" && typeof st.fractionLost === "number") lossPct = Math.round((st.fractionLost as number) * 1000) / 10;
        if (st.type === "inbound-rtp" && typeof st.packetsReceived === "number" && lossPct === null) {
          const lost = Math.max(0, Number(st.packetsLost ?? 0));
          const total = lost + (st.packetsReceived as number);
          lossPct = total ? Math.round((lost / total) * 1000) / 10 : 0;
        }
      });
      if (room !== this.room) return;
      set((s) => ({ connection: { ...s.connection, rttMs: info.rttMs, protocol: info.protocol, candidateType: info.candidateType, lossPct } }));
    } catch {
      /* next time */
    }
  }

  // ================================================================ camera and Go Live

  async setCamera(on: boolean): Promise<void> {
    const room = this.room;
    const lk = this.lk;
    if (!room || !lk || this.remote) return;
    if (on && !get().canVideo) return;
    try {
      const pub = await room.localParticipant.setCameraEnabled(
        on,
        { deviceId: savedDevice("camera") || undefined, resolution: lk.VideoPresets.h720.resolution },
        { simulcast: true },
      );
      set({ camera: on, cameraTrack: on ? ((pub?.videoTrack as VoiceStoreState["cameraTrack"]) ?? null) : null, problem: null });
      this.reportState(["video"]);
    } catch (err) {
      const name = (err as { name?: string })?.name;
      set({ camera: false, cameraTrack: null, problem: { kind: name === "NotAllowedError" ? "camera-denied" : "camera-failed", message: detailOf(err) } });
    }
  }

  /** Go Live: pick a screen, window or tab (the browser's chooser). Returns
   *  false if cancelled or refused. ``liveAudio`` says whether sound came
   *  with it (a tab's sound works everywhere; a whole screen's on
   *  Chrome/Edge for Windows and ChromeOS; one window's never). */
  async startLive(opts: { quality?: StreamQuality; hint?: StreamHint; audio?: boolean; surface?: "monitor" | "window" | "browser" } = {}): Promise<boolean> {
    const room = this.room;
    const lk = this.lk;
    if (!room || !lk || !get().canVideo || this.remote) return false;
    const p = this.settings.prefs;
    const plan = streamPlan(opts.quality ?? p.stream_quality, get().maxStream, opts.hint ?? p.stream_hint);
    try {
      const pub = await room.localParticipant.setScreenShareEnabled(
        true,
        {
          audio: opts.audio === false ? false : { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          // Which tab the browser's chooser opens on (a hint; the person
          // can still pick anything there).
          ...(opts.surface ? { video: { displaySurface: opts.surface } } : {}),
          resolution: plan.capture,
          contentHint: plan.contentHint,
          systemAudio: "include",
          selfBrowserSurface: "exclude",
          surfaceSwitching: "include",
          suppressLocalAudioPlayback: false,
        },
        {
          // No ``source`` here: it would label the stream's sound as video too.
          simulcast: true,
          screenShareEncoding: plan.encoding,
          screenShareSimulcastLayers: plan.layers.map((l) => new lk.VideoPreset(l.width, l.height, l.maxBitrate, l.maxFramerate)),
          degradationPreference: plan.degradation,
        },
      );
      if (!pub) return false;
      const audio = !!room.localParticipant.getTrackPublication(lk.Track.Source.ScreenShareAudio);
      set({ live: true, liveAudio: audio, liveQuality: plan.quality, liveTrack: (pub.videoTrack as VoiceStoreState["liveTrack"]) ?? null, problem: null });
      this.sound("live");
      this.reportState(["live"]);
      return true;
    } catch (err) {
      const name = (err as { name?: string })?.name;
      // Cancelling the browser's chooser is not a problem.
      if (name !== "NotAllowedError" && name !== "AbortError") set({ problem: { kind: "screen-failed", message: detailOf(err) } });
      return false;
    }
  }

  async stopLive(): Promise<void> {
    const room = this.room;
    if (!room) return;
    try {
      await room.localParticipant.setScreenShareEnabled(false);
    } catch {
      /* already stopped */
    }
    set({ live: false, liveAudio: null, liveQuality: null, liveTrack: null });
    this.reportState(["live"]);
  }

  /** Watch someone's stream (null to stop). Nothing downloads until you do. */
  setWatching(userId: string | null): void {
    if (get().watching === userId) return;
    set({ watching: userId });
    this.reconcile();
    this.reportState(["watching"]);
  }

  answerStillHere(): Promise<void> {
    set({ stillThere: null });
    return voiceApi.stillHere().catch(() => undefined);
  }

  dismissNotice(): void {
    set({ notice: null });
  }

  dismissProblem(): void {
    set({ problem: null });
  }

  // ================================================================ devices and settings

  async setInputDevice(deviceId: string): Promise<void> {
    saveDevice("mic", deviceId);
    if (this.room) {
      try {
        await this.room.switchActiveDevice("audioinput", deviceId || "default");
      } catch (err) {
        set({ problem: { kind: micProblem(err), message: detailOf(err) } });
      }
    }
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    saveDevice("speaker", deviceId);
    if (this.room) {
      try {
        await this.room.switchActiveDevice("audiooutput", deviceId || "default");
      } catch {
        /* this browser can't choose */
      }
    }
  }

  async setCameraDevice(deviceId: string): Promise<void> {
    saveDevice("camera", deviceId);
    if (this.room && get().camera) {
      try {
        await this.room.switchActiveDevice("videoinput", deviceId || "default");
      } catch {
        /* keep the old one */
      }
    }
  }

  updatePrefs(patch: Partial<VoicePrefs>): void {
    if (patch.noise === "enhanced") forgetOverloads();
    saveVoiceSettings({ prefs: patch });
    // The auth-store subscription applies it.
  }

  private applySettings(before: VoiceSettingsAll, next: VoiceSettingsAll): void {
    const a = before.prefs;
    const b = next.prefs;
    set((s) => ({ noise: { ...s.noise, pref: b.noise } }));
    if (!this.room) return;
    if (a.input_mode !== b.input_mode || a.auto_sensitivity !== b.auto_sensitivity || a.sensitivity_db !== b.sensitivity_db || a.ptt_release_ms !== b.ptt_release_ms) {
      this.pipeline?.configure({ gate: this.gateConfig() });
      if (b.input_mode !== "ptt") this.pushToTalk(false);
    }
    if (a.input_volume !== b.input_volume) this.pipeline?.configure({ inputGain: b.input_volume / 100 });
    if (a.noise !== b.noise || a.echo !== b.echo || a.agc !== b.agc) void this.switchEngine();
    if (
      a.output_volume !== b.output_volume ||
      a.data_saver !== b.data_saver ||
      before.volumes !== next.volumes ||
      before.localMutes !== next.localMutes
    ) {
      this.reconcile();
    }
  }

  /** The suppressor changed (setting, overload, failed load): swap it in
   *  the worklet, restarting the mic when the browser's own processing has
   *  to change too. */
  private async switchEngine(): Promise<void> {
    const before = this.choice?.engine ?? null;
    const choice = this.resolveEngine();
    const room = this.room;
    const lk = this.lk;
    const pipeline = this.pipeline;
    if (pipeline) {
      pipeline.configure({ agc: usesWorkletSuppressor(choice.engine) && this.settings.prefs.agc });
      await pipeline.setEngine(choice.engine);
    }
    if (!room || !lk) return;
    const track = room.localParticipant.getTrackPublication(lk.Track.Source.Microphone)?.track as LocalAudioTrack | undefined;
    if (!track) return;
    const constraintsChanged =
      before === null || usesWorkletSuppressor(before) !== usesWorkletSuppressor(choice.engine) || !usesWorkletSuppressor(choice.engine);
    if (constraintsChanged) {
      try {
        await track.restartTrack(this.captureOptions(choice.engine));
      } catch (err) {
        set({ problem: { kind: micProblem(err), message: detailOf(err) } });
      }
    }
  }

  // ================================================================ keys

  private installKeys(): () => void {
    const isEditable = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    };
    const pttKey = () => (this.settings.prefs.input_mode === "ptt" ? this.settings.prefs.ptt_key : null);
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.code === "KeyM" || e.code === "KeyD")) {
        e.preventDefault();
        if (e.code === "KeyM") void this.setMuted(!get().muted);
        else void this.setDeafened(!get().deafened);
        return;
      }
      if (e.code === pttKey()) {
        if (!isEditable(e.target)) e.preventDefault();
        if (!e.repeat) this.pushToTalk(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === pttKey()) this.pushToTalk(false);
    };
    const mouseKey = (e: MouseEvent) => `Mouse${e.button}`;
    const mdown = (e: MouseEvent) => {
      if (mouseKey(e) === pttKey()) {
        e.preventDefault();
        this.pushToTalk(true);
      }
    };
    const mup = (e: MouseEvent) => {
      if (mouseKey(e) === pttKey()) this.pushToTalk(false);
    };
    // Letting go outside the window, or switching away: release.
    const release = () => this.pushToTalk(false);
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("mousedown", mdown, true);
    window.addEventListener("mouseup", mup, true);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("mousedown", mdown, true);
      window.removeEventListener("mouseup", mup, true);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", release);
      this.pushToTalk(false);
    };
  }

  // ================================================================ sounds

  private sound(s: VoiceSound): void {
    if (!this.settings.prefs.sounds) return;
    playVoiceSound(this.ctx, s, this.settings.prefs.output_volume / 100);
  }

  /** For the dev harness and tests: the pipeline's current readings. */
  debug(): { engine: string | null; load: number | null; pipeline: boolean } {
    return { engine: this.pipeline?.engine ?? null, load: this.pipeline?.load ?? null, pipeline: !!this.pipeline };
  }
}
