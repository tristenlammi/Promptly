/**
 * The call engine (web, DM calls): one LiveKit connection to the call
 * you're in, your microphone through the same audio pipeline as voice
 * channels (noise suppression from Voice & video settings), your camera
 * and screen, and everyone else's sound and video. Loaded on first use
 * (``actions.ts``); writes ``useCallStore``. One instance per tab.
 *
 * The server is the authority (``backend/app/calls/dm.py``): starting,
 * answering or joining asks it first (it takes you out of any other call
 * or voice channel and moves the call off your other devices), then this
 * connects with the token it hands back. Its events (``live.ts`` passes
 * them on) end the call here: ``call_ended``, and ``call_disconnected``
 * when you took the call elsewhere or joined another.
 */
import type { Participant, RemoteParticipant, RemoteTrack, Room } from "livekit-client";

import { dmCallsApi, type CallDisconnectReason, type CallJoin, type CallMedia, type DmCall } from "@/api/dmCalls";
import { API_BASE_URL, authHeader } from "@/api/client";
import { useAuthStore } from "@/store/authStore";

import { captureProcessing, chooseEngine, rememberedOverloads, usesWorkletSuppressor } from "../audio/engines";
import { asLiveKitProcessor, audioCaps, createVoiceContext, MicPipeline } from "../audio/pipeline";
import { savedDevice, saveDevice } from "../devices";
import { loadLiveKit, signalUrl, type LiveKit } from "../livekit";
import { streamPlan } from "../voice/goLive";
import { currentVoiceSettings } from "../voice/prefs";
import { playVoiceSound, type VoiceSound } from "../voice/sounds";
import { useVoiceStore } from "../voice/store";
import { playTone } from "./ringtone";
import {
  inCallHere,
  initialCallConnection,
  rememberUsers,
  useCallStore,
  type CallEndKind,
  type CallPeer,
  type CallProblemKind,
  type CallStoreState,
} from "./store";

const RECONNECT_GIVE_UP_MS = 30_000;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000];
const REMOVED_GRACE_MS = 2500;
/** How long "Call ended" stays on screen. */
const ENDED_SHOWN_MS = 2600;

const set = (patch: Partial<CallStoreState> | ((s: CallStoreState) => Partial<CallStoreState>)) =>
  useCallStore.setState(patch as Partial<CallStoreState>);
const get = () => useCallStore.getState();

export function userOfIdentity(identity: string): string | null {
  const m = /^u:([0-9a-f-]{36})$/i.exec(identity);
  return m ? m[1].toLowerCase() : null;
}

function statusOf(err: unknown): number | null {
  return (err as { response?: { status?: number } })?.response?.status ?? null;
}

function detailOf(err: unknown): string {
  const e = err as { response?: { data?: { detail?: unknown } }; message?: string };
  const d = e?.response?.data?.detail;
  if (typeof d === "string") return d;
  return e?.message ?? String(err);
}

function mediaProblem(err: unknown, kind: "mic" | "camera"): CallProblemKind {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return kind === "mic" ? "mic-denied" : "camera-denied";
  if (kind === "mic" && (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError")) return "mic-missing";
  return kind === "mic" ? "mic-failed" : "camera-failed";
}

function joinProblem(err: unknown): { kind: CallProblemKind; message: string } {
  const st = statusOf(err);
  const message = detailOf(err);
  if (st === 403) return { kind: "refused", message };
  if (st === 404 || st === 409) return { kind: "unavailable", message: st === 404 ? "This call isn't available." : message };
  return { kind: "connect-failed", message };
}

function me(): string | null {
  return useAuthStore.getState().user?.id ?? null;
}

export class CallEngine {
  private lk: LiveKit | null = null;
  private room: Room | null = null;
  private join: CallJoin | null = null;
  private ctx: AudioContext | null = null;
  private pipeline: MicPipeline | null = null;
  private gen = 0;
  private audioEls = new Map<string, HTMLMediaElement>();
  private audioHost: HTMLDivElement | null = null;
  private unsubs: (() => void)[] = [];
  private reconnectStartedAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private removedTimer: ReturnType<typeof setTimeout> | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private stopRingback: (() => void) | null = null;
  private leaving = false;
  /** The server already said why it ended (wins over LiveKit's view). */
  private serverEnd: CallEndKind | null = null;

  // ================================================================ getting in

  /** Call a conversation (rings the others). */
  start(roomId: string, media: CallMedia): Promise<boolean> {
    return this.enter(() => dmCallsApi.start(roomId, media), { outgoing: true, video: media === "video", roomId, media });
  }

  /** Call people (Contacts, a person's page): opens the conversation first. */
  startWith(userIds: string[], media: CallMedia): Promise<boolean> {
    return this.enter(() => dmCallsApi.startDm(userIds, media), { outgoing: true, video: media === "video", roomId: null, media });
  }

  /** Answer a call ringing you, join a live group call, or move your call here. */
  answer(callId: string, opts: { video: boolean; roomId?: string | null; media?: CallMedia }): Promise<boolean> {
    return this.enter(() => dmCallsApi.join(callId), { outgoing: false, video: opts.video, roomId: opts.roomId ?? null, media: opts.media ?? "audio" });
  }

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === "closed") this.ctx = createVoiceContext();
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => undefined);
    return this.ctx;
  }

  private async loadLk(): Promise<LiveKit> {
    if (!this.lk) this.lk = await loadLiveKit();
    return this.lk;
  }

  private async enter(
    fetchJoin: () => Promise<CallJoin>,
    opts: { outgoing: boolean; video: boolean; roomId: string | null; media: CallMedia },
  ): Promise<boolean> {
    // One live conversation at a time: out of a voice channel and any
    // other call in this tab first, so two microphones never overlap.
    if (useVoiceStore.getState().status !== "idle") {
      const { voice } = await import("../voice/actions");
      await voice.leave().catch(() => undefined);
    }
    if (inCallHere(get())) await this.teardown();
    const gen = ++this.gen;
    this.clearEndTimer();
    this.serverEnd = null;
    set({
      ...initialCallConnection,
      ended: null,
      status: "connecting",
      outgoing: opts.outgoing,
      roomId: opts.roomId,
      media: opts.media,
      camera: false,
    });
    // A click got us here: the audio context may start now.
    const ctx = this.ensureContext();
    let join: CallJoin;
    let lk: LiveKit;
    try {
      [lk, join] = await Promise.all([this.loadLk(), fetchJoin()]);
    } catch (err) {
      if (gen !== this.gen) return false;
      set({ ...initialCallConnection, problem: joinProblem(err) });
      this.closeContextSoon();
      return false;
    }
    if (gen !== this.gen) {
      void dmCallsApi.leave(join.call.id, join.session_id).catch(() => undefined);
      return false;
    }
    this.join = join;
    this.noteCall(join.call);
    set({ callId: join.call.id, roomId: join.room_id, session: join.session_id, media: join.call.media, call: join.call });

    const room = new lk.Room({
      adaptiveStream: true,
      dynacast: true,
      disconnectOnPageLeave: true,
      publishDefaults: {
        dtx: true,
        red: true,
        stopMicTrackOnMute: false,
        videoSimulcastLayers: [lk.VideoPresets.h180, lk.VideoPresets.h360],
      },
    });
    this.room = room;
    this.wire(lk, room, gen);
    try {
      await room.connect(signalUrl(join.url), join.token, { autoSubscribe: true });
    } catch (err) {
      if (gen !== this.gen) return false;
      this.room = null;
      room.removeAllListeners();
      void dmCallsApi.leave(join.call.id, join.session_id).catch(() => undefined);
      this.join = null;
      set({ ...initialCallConnection, problem: { kind: "connect-failed", message: detailOf(err) } });
      this.closeContextSoon();
      return false;
    }
    if (gen !== this.gen) return false;
    await room.startAudio().catch(() => undefined);
    if (gen !== this.gen) return false;
    for (const p of room.remoteParticipants.values()) this.refreshPeer(p);
    set({ connectedAt: Date.now(), audioBlocked: !room.canPlaybackAudio });
    this.updateStatus();
    this.startSession();
    await this.publishMic(room, ctx);
    if (opts.video && gen === this.gen) await this.setCamera(true);
    return gen === this.gen;
  }

  // ================================================================ the connection

  private wire(lk: LiveKit, room: Room, gen: number): void {
    const E = lk.RoomEvent;
    const mine = () => gen === this.gen && this.room === room;
    room
      .on(E.ParticipantConnected, (p) => {
        if (!mine()) return;
        this.refreshPeer(p);
        this.updateStatus();
        if (get().status === "connected") this.sound("peer-join");
      })
      .on(E.ParticipantDisconnected, (p) => {
        if (!mine()) return;
        const uid = userOfIdentity(p.identity);
        if (!uid) return;
        set((s) => {
          const peers = { ...s.peers };
          delete peers[uid];
          return { peers, pinned: s.pinned === uid ? null : s.pinned };
        });
        if (inCallHere(get())) this.sound("peer-leave");
      })
      .on(E.TrackSubscribed, (track, _pub, p) => mine() && this.onSubscribed(lk, track, p))
      .on(E.TrackUnsubscribed, (track, _pub, p) => {
        if (!mine()) return;
        for (const el of track.detach()) el.remove();
        if (track.sid) this.audioEls.delete(track.sid);
        this.refreshPeer(p);
      })
      .on(E.TrackPublished, (_pub, p) => mine() && this.refreshPeer(p))
      .on(E.TrackUnpublished, (_pub, p) => mine() && this.refreshPeer(p))
      .on(E.TrackMuted, (_pub, p) => mine() && p !== room.localParticipant && this.refreshPeer(p as RemoteParticipant))
      .on(E.TrackUnmuted, (_pub, p) => mine() && p !== room.localParticipant && this.refreshPeer(p as RemoteParticipant))
      .on(E.ActiveSpeakersChanged, (speakers: Participant[]) => {
        if (!mine()) return;
        const on = new Set(speakers.map((p) => userOfIdentity(p.identity)).filter(Boolean) as string[]);
        const self = me();
        set((s) => {
          const peers: Record<string, CallPeer> = {};
          for (const [id, peer] of Object.entries(s.peers)) peers[id] = peer.speaking === on.has(id) ? peer : { ...peer, speaking: on.has(id) };
          const speaking = !!self && on.has(self) && !s.muted;
          return { peers, speaking };
        });
      })
      .on(E.ConnectionQualityChanged, (q, p) => {
        if (!mine()) return;
        const quality = (["excellent", "good", "poor", "lost"].includes(q) ? q : "unknown") as CallPeer["connectionQuality"];
        if (p === room.localParticipant) set({ quality });
        else {
          const uid = userOfIdentity(p.identity);
          if (uid) set((s) => (s.peers[uid] ? { peers: { ...s.peers, [uid]: { ...s.peers[uid], connectionQuality: quality } } } : {}));
        }
      })
      .on(E.LocalTrackUnpublished, (pub) => {
        if (!mine()) return;
        if (pub.source === lk.Track.Source.ScreenShare) set({ screen: false, screenTrack: null, screenAudio: null });
        else if (pub.source === lk.Track.Source.Camera) set({ camera: false, cameraTrack: null });
      })
      .on(E.AudioPlaybackStatusChanged, () => mine() && set({ audioBlocked: !room.canPlaybackAudio }))
      .on(E.Reconnecting, () => mine() && set({ status: "reconnecting" }))
      .on(E.SignalReconnecting, () => mine() && set({ status: "reconnecting" }))
      .on(E.Reconnected, () => {
        if (!mine()) return;
        this.updateStatus(true);
      })
      .on(E.Disconnected, (reason) => {
        if (!mine()) return;
        this.onDisconnected(lk, reason);
      });
  }

  /** "Calling…" until someone else is in, then connected. */
  private updateStatus(force = false): void {
    const s = get();
    if (!this.room || (s.status !== "connecting" && s.status !== "calling" && !(force && s.status === "reconnecting"))) return;
    const others = this.room.remoteParticipants.size > 0;
    const answered = !!s.call?.answered_at || !s.outgoing;
    const next = others || answered ? "connected" : "calling";
    if (next !== s.status) set({ status: next });
    if (next === "calling" && !this.stopRingback) {
      this.stopRingback = playTone("ringback", { volume: currentVoiceSettings().prefs.output_volume / 100 });
    } else if (next === "connected") {
      this.stopRingback?.();
      this.stopRingback = null;
      if (s.status === "calling" || s.status === "connecting") this.sound("join");
    }
  }

  private onDisconnected(lk: LiveKit, reason: number | undefined): void {
    const R = lk.DisconnectReason;
    if (reason === R.CLIENT_INITIATED || this.leaving) return;
    if (reason === R.DUPLICATE_IDENTITY) {
      // The call moved to another tab or device of yours.
      void this.finish("replaced");
      return;
    }
    if (reason === R.PARTICIPANT_REMOVED || reason === R.ROOM_DELETED || reason === R.ROOM_CLOSED) {
      // The server took us out; its event says why (it may be on its way).
      if (this.serverEnd) return;
      set({ status: "reconnecting" });
      this.removedTimer = setTimeout(() => {
        this.removedTimer = null;
        if (this.join) void this.finish(this.serverEnd ?? "ended");
      }, REMOVED_GRACE_MS);
      return;
    }
    this.startReconnect();
  }

  private startReconnect(): void {
    const callId = get().callId;
    if (!callId) return;
    this.reconnectStartedAt = Date.now();
    set({ status: "reconnecting" });
    void this.dropRoom();
    this.scheduleReconnect(callId, 0);
  }

  private scheduleReconnect(callId: string, attempt: number): void {
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (get().callId !== callId || get().status !== "reconnecting") return;
      const gen = ++this.gen;
      let join: CallJoin;
      let lk: LiveKit;
      try {
        [lk, join] = await Promise.all([this.loadLk(), dmCallsApi.join(callId)]);
      } catch (err) {
        if (gen !== this.gen) return;
        const st = statusOf(err);
        if (st === 403 || st === 404 || st === 409) {
          void this.finish("ended");
          return;
        }
        this.retryOrGiveUp(callId, attempt);
        return;
      }
      if (gen !== this.gen) return;
      this.join = join;
      this.noteCall(join.call);
      set({ session: join.session_id, call: join.call });
      const room = new lk.Room({ adaptiveStream: true, dynacast: true, disconnectOnPageLeave: true, publishDefaults: { dtx: true, red: true, stopMicTrackOnMute: false } });
      this.room = room;
      this.wire(lk, room, gen);
      try {
        await room.connect(signalUrl(join.url), join.token, { autoSubscribe: true });
      } catch {
        if (gen !== this.gen) return;
        this.room = null;
        room.removeAllListeners();
        this.retryOrGiveUp(callId, attempt);
        return;
      }
      if (gen !== this.gen) return;
      await room.startAudio().catch(() => undefined);
      for (const p of room.remoteParticipants.values()) this.refreshPeer(p);
      set({ status: "connected", problem: null });
      await this.publishMic(room, this.ensureContext());
      if (get().camera) {
        set({ camera: false });
        await this.setCamera(true);
      }
    }, delay);
  }

  private retryOrGiveUp(callId: string, attempt: number): void {
    if (Date.now() - this.reconnectStartedAt >= RECONNECT_GIVE_UP_MS) {
      void this.finish("lost");
      return;
    }
    this.scheduleReconnect(callId, attempt + 1);
  }

  // ================================================================ session

  private startSession(): void {
    if (this.unsubs.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === "KeyM") {
        e.preventDefault();
        void this.setMuted(!get().muted);
      }
    };
    // The page is going away: hang up now rather than leave the others
    // looking at a frozen picture until LiveKit notices.
    const onHide = (e: PageTransitionEvent) => {
      if (e.persisted) return;
      const j = this.join;
      if (!j) return;
      try {
        void fetch(`${API_BASE_URL}/calls/${j.call.id}/leave`, {
          method: "POST",
          keepalive: true,
          headers: { ...authHeader(), "Content-Type": "application/json" },
          body: JSON.stringify({ session: j.session_id }),
        });
      } catch {
        /* LiveKit's own leave covers it */
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pagehide", onHide);
    this.unsubs.push(() => window.removeEventListener("keydown", onKey, true));
    this.unsubs.push(() => window.removeEventListener("pagehide", onHide));
  }

  private stopSession(): void {
    this.unsubs.splice(0).forEach((u) => u());
  }

  // ================================================================ leaving

  /** Hang up. A 1:1 call ends for both; a group call carries on. */
  async hangUp(): Promise<void> {
    const j = this.join;
    const s = get();
    if (!inCallHere(s) && !this.room) return;
    const kind: CallEndKind = s.status === "calling" ? "cancelled" : "ended";
    if (j) void dmCallsApi.leave(j.call.id, j.session_id).catch(() => undefined);
    await this.finish(kind, { quiet: false });
  }

  /** Hang up because you're joining a voice channel (no "Call ended"). */
  async leaveQuietly(): Promise<void> {
    const j = this.join;
    if (!inCallHere(get()) && !this.room) return;
    if (j) void dmCallsApi.leave(j.call.id, j.session_id).catch(() => undefined);
    await this.finish("elsewhere", { quiet: true });
  }

  /** End a group call for everyone (whoever started it). */
  async endForEveryone(): Promise<void> {
    const j = this.join;
    if (!j) return;
    try {
      await dmCallsApi.end(j.call.id);
    } catch {
      /* hang up at least */
    }
    await this.finish("ended");
  }

  /** The server's word about the call this tab is in. */
  onCallState(call: DmCall, ended: boolean): void {
    if (call.id !== get().callId) return;
    set({ call });
    if (!ended) {
      this.updateStatus();
      return;
    }
    const s = get();
    let kind: CallEndKind = "ended";
    if (!call.answered_at && s.outgoing) {
      kind = call.ended_reason === "cancelled" ? "cancelled" : call.ended_reason === "declined" ? "declined" : "no-answer";
    }
    this.serverEnd = kind;
    void this.finish(kind);
  }

  onDisconnectedEvent(callId: string, session: string | null, reason: CallDisconnectReason): void {
    if (callId !== get().callId || !this.join) return;
    if (session && session !== this.join.session_id) return;
    if (this.leaving) return;
    const kind: CallEndKind = reason === "replaced" ? "replaced" : reason === "elsewhere" ? "elsewhere" : reason === "access" ? "access" : "lost";
    this.serverEnd = kind;
    void this.finish(kind, { quiet: reason === "replaced" || reason === "elsewhere" });
  }

  /** Out of the call here (any reason): drop the connection and say how
   *  it ended for a moment. */
  private async finish(kind: CallEndKind, opts: { quiet?: boolean } = {}): Promise<void> {
    if (!this.join && !this.room && !inCallHere(get())) return;
    const s = get();
    const answeredAt = s.call?.answered_at ? Date.parse(s.call.answered_at) : null;
    const seconds = answeredAt ? Math.max(0, Math.round((Date.now() - answeredAt) / 1000)) : 0;
    const self = me();
    const peerIds = [...new Set([...Object.keys(s.peers), ...(s.call?.participants.map((p) => p.user_id) ?? [])])].filter((id) => id !== self);
    const roomId = s.roomId;
    await this.teardown();
    if (!opts.quiet) this.sound("leave");
    // Moved to another device or call: no "ended" screen here.
    const showEnded = kind !== "replaced" && kind !== "elsewhere";
    set({ ...initialCallConnection, ended: showEnded ? { kind, seconds, at: Date.now(), roomId, peerIds } : null, status: showEnded ? "ended" : "idle" });
    if (showEnded) {
      this.clearEndTimer();
      this.endTimer = setTimeout(() => {
        this.endTimer = null;
        if (get().status === "ended") set({ status: "idle", ended: null });
      }, ENDED_SHOWN_MS);
    }
  }

  /** Close the "Call ended" screen now. */
  dismissEnded(): void {
    this.clearEndTimer();
    if (get().status === "ended") set({ status: "idle", ended: null });
  }

  private clearEndTimer(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
  }

  private async teardown(): Promise<void> {
    this.gen++;
    this.leaving = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.removedTimer) clearTimeout(this.removedTimer);
    this.removedTimer = null;
    this.stopRingback?.();
    this.stopRingback = null;
    await this.dropRoom();
    this.pipeline?.destroy();
    this.pipeline = null;
    this.stopSession();
    this.join = null;
    this.leaving = false;
    this.closeContextSoon();
    this.exitPictureInPicture();
  }

  private async dropRoom(): Promise<void> {
    const room = this.room;
    this.room = null;
    for (const el of this.audioEls.values()) el.remove();
    this.audioEls.clear();
    if (room) {
      room.removeAllListeners();
      try {
        await room.disconnect(true);
      } catch {
        /* gone already */
      }
    }
  }

  private closeContextSoon(): void {
    const ctx = this.ctx;
    window.setTimeout(() => {
      if (ctx && this.ctx === ctx && !this.room && ctx.state !== "closed") {
        void ctx.close().catch(() => undefined);
        this.ctx = null;
      }
    }, 700);
  }

  private exitPictureInPicture(): void {
    try {
      if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined);
    } catch {
      /* not supported */
    }
  }

  // ================================================================ people

  private noteCall(call: DmCall): void {
    useCallStore.setState((s) => ({ live: call.live ? { ...s.live, [call.id]: call } : s.live }));
  }

  private peerOf(p: RemoteParticipant): CallPeer | null {
    const lk = this.lk;
    const uid = userOfIdentity(p.identity);
    if (!lk || !uid || uid === me()) return null;
    const S = lk.Track.Source;
    const mic = p.getTrackPublication(S.Microphone);
    const cam = p.getTrackPublication(S.Camera);
    const scr = p.getTrackPublication(S.ScreenShare);
    const prev = get().peers[uid];
    if (p.name && !get().users[uid]) rememberUsers([{ id: uid, username: p.name, avatar_url: null, color: null }]);
    return {
      userId: uid,
      name: p.name || prev?.name || "",
      speaking: prev?.speaking ?? p.isSpeaking,
      micMuted: !mic || mic.isMuted,
      camera: cam?.isSubscribed && cam.videoTrack && !cam.isMuted ? (cam.videoTrack as CallPeer["camera"]) : null,
      screen: scr?.isSubscribed && scr.videoTrack ? (scr.videoTrack as CallPeer["screen"]) : null,
      connectionQuality: prev?.connectionQuality ?? "unknown",
    };
  }

  private refreshPeer(p: RemoteParticipant): void {
    const peer = this.peerOf(p);
    if (!peer) return;
    set((s) => ({ peers: { ...s.peers, [peer.userId]: peer } }));
  }

  private onSubscribed(lk: LiveKit, track: RemoteTrack, p: RemoteParticipant): void {
    if (track.kind === lk.Track.Kind.Audio) {
      const el = track.attach();
      el.setAttribute("data-call-audio", userOfIdentity(p.identity) ?? "");
      if (!this.audioHost || !document.body.contains(this.audioHost)) {
        this.audioHost = document.createElement("div");
        this.audioHost.hidden = true;
        this.audioHost.setAttribute("aria-hidden", "true");
        document.body.appendChild(this.audioHost);
      }
      this.audioHost.appendChild(el);
      if (track.sid) this.audioEls.set(track.sid, el);
      const speaker = savedDevice("speaker");
      if (speaker && "setSinkId" in el) void (el as HTMLMediaElement & { setSinkId(id: string): Promise<void> }).setSinkId(speaker).catch(() => undefined);
    }
    this.refreshPeer(p);
  }

  // ================================================================ your microphone

  private async publishMic(room: Room, ctx: AudioContext): Promise<void> {
    const lk = this.lk;
    if (!lk || this.room !== room) return;
    const prefs = currentVoiceSettings().prefs;
    const choice = chooseEngine(prefs.noise, audioCaps(ctx), rememberedOverloads());
    try {
      let pipeline: MicPipeline | null = null;
      if (audioCaps(ctx).audioWorklet) {
        try {
          pipeline = await MicPipeline.create(ctx, {
            engine: choice.engine,
            // Calls never use push to talk: the gate opens on speech.
            gate: { mode: "vad", auto: prefs.auto_sensitivity, thresholdDb: prefs.sensitivity_db, releaseMs: prefs.ptt_release_ms },
            agc: usesWorkletSuppressor(choice.engine) && prefs.agc,
            inputGain: prefs.input_volume / 100,
            muted: get().muted,
          });
        } catch {
          pipeline = null;
        }
      }
      const track = await lk.createLocalAudioTrack({
        deviceId: savedDevice("mic") || undefined,
        channelCount: 1,
        ...captureProcessing(choice.engine, { echo: prefs.echo, agc: prefs.agc }),
      });
      if (this.room !== room) {
        track.stop();
        pipeline?.destroy();
        return;
      }
      if (pipeline) {
        await track.setAudioContext(pipeline.ctx);
        await track.setProcessor(asLiveKitProcessor(pipeline));
        this.pipeline?.destroy();
        this.pipeline = pipeline;
      }
      await room.localParticipant.publishTrack(track, { source: lk.Track.Source.Microphone, dtx: true, red: true });
      if (get().muted) await room.localParticipant.setMicrophoneEnabled(false);
    } catch (err) {
      if (this.room !== room) return;
      // Still in the call: you hear everyone, they can't hear you.
      set({ problem: { kind: mediaProblem(err, "mic"), message: detailOf(err) } });
    }
  }

  async setMuted(muted: boolean): Promise<void> {
    if (get().muted === muted) return;
    set({ muted, ...(muted ? { speaking: false } : {}) });
    this.sound(muted ? "mute" : "unmute");
    this.pipeline?.configure({ muted });
    const room = this.room;
    if (!room) return;
    try {
      await room.localParticipant.setMicrophoneEnabled(!muted);
    } catch (err) {
      set({ problem: { kind: mediaProblem(err, "mic"), message: detailOf(err) } });
    }
  }

  async retryMic(): Promise<void> {
    set({ problem: null });
    const room = this.room;
    if (!room || !this.lk) return;
    if (room.localParticipant.getTrackPublication(this.lk.Track.Source.Microphone)) return;
    await this.publishMic(room, this.ensureContext());
  }

  // ================================================================ camera and screen

  async setCamera(on: boolean): Promise<void> {
    const room = this.room;
    const lk = this.lk;
    if (!room || !lk) return;
    try {
      const pub = await room.localParticipant.setCameraEnabled(
        on,
        { deviceId: savedDevice("camera") || undefined, facingMode: get().facing, resolution: lk.VideoPresets.h720.resolution },
        { simulcast: true },
      );
      set({ camera: on, cameraTrack: on ? ((pub?.videoTrack as CallStoreState["cameraTrack"]) ?? null) : null, problem: null });
    } catch (err) {
      set({ camera: false, cameraTrack: null, problem: { kind: mediaProblem(err, "camera"), message: detailOf(err) } });
    }
  }

  /** Phones: the front or back camera. */
  async flipCamera(): Promise<void> {
    const room = this.room;
    const lk = this.lk;
    if (!room || !lk) return;
    const facing = get().facing === "user" ? "environment" : "user";
    set({ facing });
    const track = room.localParticipant.getTrackPublication(lk.Track.Source.Camera)?.videoTrack;
    if (!track) return;
    try {
      await (track as unknown as { restartTrack(o: { facingMode: string }): Promise<void> }).restartTrack({ facingMode: facing });
      set({ cameraTrack: track as CallStoreState["cameraTrack"] });
    } catch (err) {
      set({ problem: { kind: "camera-failed", message: detailOf(err) } });
    }
  }

  /** Share your screen, a window or a tab (the browser's chooser), with
   *  Go Live's capture settings. False when cancelled or refused. */
  async startScreen(): Promise<boolean> {
    const room = this.room;
    const lk = this.lk;
    if (!room || !lk) return false;
    const prefs = currentVoiceSettings().prefs;
    const plan = streamPlan(prefs.stream_quality, this.join?.max_stream ?? "720p30", prefs.stream_hint);
    try {
      const pub = await room.localParticipant.setScreenShareEnabled(
        true,
        {
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          resolution: plan.capture,
          contentHint: plan.contentHint,
          systemAudio: "include",
          selfBrowserSurface: "exclude",
          surfaceSwitching: "include",
          suppressLocalAudioPlayback: false,
        },
        {
          simulcast: true,
          screenShareEncoding: plan.encoding,
          screenShareSimulcastLayers: plan.layers.map((l) => new lk.VideoPreset(l.width, l.height, l.maxBitrate, l.maxFramerate)),
          degradationPreference: plan.degradation,
        },
      );
      if (!pub) return false;
      const audio = !!room.localParticipant.getTrackPublication(lk.Track.Source.ScreenShareAudio);
      set({ screen: true, screenAudio: audio, screenTrack: (pub.videoTrack as CallStoreState["screenTrack"]) ?? null, problem: null });
      this.sound("live");
      return true;
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name !== "NotAllowedError" && name !== "AbortError") set({ problem: { kind: "screen-failed", message: detailOf(err) } });
      return false;
    }
  }

  async stopScreen(): Promise<void> {
    const room = this.room;
    if (room) {
      try {
        await room.localParticipant.setScreenShareEnabled(false);
      } catch {
        /* already stopped */
      }
    }
    set({ screen: false, screenTrack: null, screenAudio: null });
  }

  // ================================================================ devices, sound, people

  async setOutputDevice(deviceId: string): Promise<void> {
    saveDevice("speaker", deviceId);
    for (const el of this.audioEls.values()) {
      if ("setSinkId" in el) await (el as HTMLMediaElement & { setSinkId(id: string): Promise<void> }).setSinkId(deviceId || "").catch(() => undefined);
    }
  }

  async setInputDevice(deviceId: string): Promise<void> {
    saveDevice("mic", deviceId);
    if (this.room) {
      try {
        await this.room.switchActiveDevice("audioinput", deviceId || "default");
      } catch (err) {
        set({ problem: { kind: mediaProblem(err, "mic"), message: detailOf(err) } });
      }
    }
  }

  async setCameraDevice(deviceId: string): Promise<void> {
    saveDevice("camera", deviceId);
    if (this.room && get().camera) await this.room.switchActiveDevice("videoinput", deviceId || "default").catch(() => undefined);
  }

  async resumeAudio(): Promise<void> {
    if (this.ctx?.state === "suspended") await this.ctx.resume().catch(() => undefined);
    await this.room?.startAudio().catch(() => undefined);
    for (const el of this.audioEls.values()) void (el as HTMLMediaElement).play?.().catch(() => undefined);
    set({ audioBlocked: !!this.room && !this.room.canPlaybackAudio });
  }

  /** Ring the people in the conversation who aren't in the call. */
  async ringAgain(userIds?: string[]): Promise<string[]> {
    const j = this.join;
    if (!j) return [];
    const out = await dmCallsApi.ring(j.call.id, userIds);
    this.onCallState(out, false);
    return out.rang;
  }

  dismissProblem(): void {
    set({ problem: null });
  }

  private sound(s: VoiceSound): void {
    const prefs = currentVoiceSettings().prefs;
    if (!prefs.sounds) return;
    playVoiceSound(this.ctx, s, prefs.output_volume / 100);
  }
}
