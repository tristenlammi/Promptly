/**
 * The call screen. Full screen while you talk (dark, calm, Messenger-like):
 * the other person big, yourself small in the corner, a grid for a group,
 * a shared screen big with everyone in a strip. Controls at the bottom:
 * Mute, Camera, Share screen, Flip (phones), More (speaker, microphone,
 * camera, ring again, pop out), Hang up. Minimise keeps the call in a
 * small window you can drag around while you use Promptly; "Pop out" puts
 * the video in the browser's own picture-in-picture window.
 */
import {
  BellRing,
  Check,
  ChevronDown,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  MoreHorizontal,
  PhoneOff,
  PictureInPicture2,
  Smartphone,
  SwitchCamera,
  Video,
  VideoOff,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { RoomUser } from "@/api/rooms";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";

import { savedDevice, useMediaDevices } from "../../devices";
import { canChooseSpeaker } from "../../livekit";
import { Floating } from "../../ui/Floating";
import { calls } from "../actions";
import { useCallStore, type CallPeer, type CallStoreState } from "../store";
import { clock, endedWords } from "../words";
import {
  CALL_ACCENT_STYLE,
  CallVideo,
  callTitle,
  personOf,
  RoundButton,
  TalkingAvatar,
  useCallPeople,
  useElapsed,
  type CallVideoHandle,
} from "./bits";

export function CallScreen() {
  const status = useCallStore((s) => s.status);
  const view = useCallStore((s) => s.view);
  if (status === "idle") return null;
  if (view === "mini" && status !== "ended") return <MiniCall />;
  return <FullCall />;
}

// ---------------------------------------------------------------- shared

function useCallView() {
  const s = useCallStore();
  const { users, b } = useCallPeople(true);
  const self = useAuthStore((a) => a.user);
  const meUser: RoomUser = personOf(users, self?.id, self?.username ?? "You");
  const peers = Object.values(s.peers).sort((a, b2) => a.name.localeCompare(b2.name));
  const participantIds = s.call?.participants.map((p) => p.user_id) ?? s.ended?.peerIds ?? [];
  const title = callTitle(b, users, s.roomId ?? s.ended?.roomId ?? null, [...participantIds, ...peers.map((p) => p.userId)]);
  const ringing = (s.call?.ringing ?? []).filter((id) => id !== self?.id && !s.peers[id]);
  const group = !!s.call?.group || (s.ended?.peerIds.length ?? 0) > 1;
  const answeredAt = s.call?.answered_at ? Date.parse(s.call.answered_at) : null;
  const elapsed = useElapsed(s.status === "connected" || s.status === "reconnecting" ? (answeredAt ?? s.connectedAt) : null);
  const status = statusWords(s, elapsed, group, peers.length);
  // The person to show big in a 1:1 call (or whoever you're calling).
  const other = peers[0] ?? null;
  const otherId = other?.userId ?? s.call?.participants.find((p) => p.user_id !== self?.id)?.user_id ?? s.ended?.peerIds[0] ?? null;
  const otherUser = personOf(users, otherId, other?.name);
  return { s, users, b, meUser, peers, title, ringing, group, status, other, otherUser };
}

function statusWords(s: CallStoreState, elapsed: number, group: boolean, people: number): string {
  switch (s.status) {
    case "connecting":
      return "Connecting…";
    case "calling":
      return group ? "Ringing everyone…" : "Calling…";
    case "reconnecting":
      return "Reconnecting…";
    case "ended":
      return endedWords(s.ended?.kind ?? "ended", s.ended?.seconds ?? 0);
    default:
      if (group) return people === 0 ? `Waiting for others · ${clock(elapsed)}` : `${people + 1} people · ${clock(elapsed)}`;
      return clock(elapsed);
  }
}

/** The browser's own picture-in-picture for a video, and Chrome's automatic
 *  one when you switch tabs mid-call. */
function usePictureInPicture(video: React.RefObject<CallVideoHandle>, available: boolean) {
  const supported = typeof document !== "undefined" && "pictureInPictureEnabled" in document && !!(document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled;
  const popOut = useCallback(async () => {
    const el = video.current?.el;
    if (!el) return;
    try {
      if (document.pictureInPictureElement === el) await document.exitPictureInPicture();
      else await el.requestPictureInPicture();
    } catch {
      /* not allowed now */
    }
  }, [video]);
  useEffect(() => {
    if (!supported || !available || !("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler("enterpictureinpicture" as MediaSessionAction, () => void popOut());
    } catch {
      return;
    }
    return () => {
      try {
        navigator.mediaSession.setActionHandler("enterpictureinpicture" as MediaSessionAction, null);
      } catch {
        /* fine */
      }
    };
  }, [supported, available, popOut]);
  return { supported, popOut };
}

// ---------------------------------------------------------------- full screen

function FullCall() {
  const isPhone = useIsMobile();
  const v = useCallView();
  const { s, peers, group, other, otherUser, meUser, ringing, users } = v;
  const dialog = useRef<HTMLDivElement>(null);
  const mainVideo = useRef<CallVideoHandle>(null);
  const sharer = peers.find((p) => p.screen) ?? null;
  const bigVideo = sharer?.screen ?? (!group ? other?.camera : null) ?? null;
  const pip = usePictureInPicture(mainVideo, !!bigVideo);
  const ended = s.status === "ended";

  useEffect(() => {
    // Into the call: focus the controls (Escape minimises).
    const t = window.setTimeout(() => dialog.current?.querySelector<HTMLElement>("[data-call-focus]")?.focus(), 30);
    return () => window.clearTimeout(t);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || ended) return;
      if (document.querySelector('[role="dialog"][aria-label="Call options"]')) return;
      e.preventDefault();
      calls.minimize();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ended]);

  return createPortal(
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-label={`Call with ${v.title}`}
      data-testid="call-screen"
      data-status={s.status}
      style={CALL_ACCENT_STYLE}
      className="fixed inset-0 z-[96] flex flex-col overflow-hidden bg-[#151312] text-white"
    >
      {/* Top: who, how long, minimise. */}
      <div className="relative z-10 flex shrink-0 items-start gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:px-5">
        {!ended && (
          <button
            type="button"
            aria-label="Minimise call"
            title="Minimise (Esc): keep talking while you use Promptly"
            onClick={() => calls.minimize()}
            data-testid="call-minimize"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/90 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            {isPhone ? <ChevronDown className="h-6 w-6" /> : <Minimize2 className="h-5 w-5" />}
          </button>
        )}
        <div className="min-w-0 flex-1 pt-1.5 text-center">
          <h2 className="truncate text-[17px] font-semibold" data-testid="call-title">
            {v.title}
          </h2>
          <p className="truncate text-[13px] tabular-nums text-white/70" aria-live="polite" data-testid="call-status">
            {v.status}
          </p>
        </div>
        {!ended && pip.supported && bigVideo ? (
          <button
            type="button"
            aria-label="Pop out video"
            title="Pop out video (picture-in-picture)"
            onClick={() => void pip.popOut()}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/90 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <PictureInPicture2 className="h-5 w-5" />
          </button>
        ) : (
          <span className="h-11 w-11 shrink-0" aria-hidden />
        )}
      </div>

      {/* The stage. */}
      <div className="relative min-h-0 flex-1">
        {ended ? (
          <EndedStage s={s} who={group ? null : otherUser} />
        ) : sharer || (group && s.pinned) ? (
          <FocusStage v={v} sharer={sharer} mainVideo={mainVideo} isPhone={isPhone} />
        ) : group ? (
          <GridStage peers={peers} ringing={ringing} users={users} meUser={meUser} isPhone={isPhone} />
        ) : (
          <OneToOneStage other={other} otherUser={otherUser} s={s} mainVideo={mainVideo} />
        )}
        {/* Yourself, small, in a 1:1 call. */}
        {!ended && !group && !sharer && s.camera && s.cameraTrack && (
          <div className="absolute bottom-3 right-3 z-10 aspect-[3/4] w-[min(26vw,9rem)] overflow-hidden rounded-2xl bg-black shadow-xl ring-1 ring-white/15 md:aspect-video md:w-56">
            <CallVideo track={s.cameraTrack} mirror={s.facing === "user"} label="Your camera" testId="call-self-video" className="h-full w-full" />
          </div>
        )}
        <Notices s={s} />
      </div>

      {/* Controls. */}
      {!ended ? (
        <Controls isPhone={isPhone} pipSupported={pip.supported && !!bigVideo} onPopOut={() => void pip.popOut()} />
      ) : (
        <div className="flex shrink-0 justify-center pb-[max(2rem,env(safe-area-inset-bottom))] pt-4">
          <button
            type="button"
            data-call-focus=""
            onClick={() => void calls.dismissEnded()}
            className="rounded-full bg-white/15 px-6 py-2.5 text-sm font-semibold hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            Close
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}

function OneToOneStage({
  other,
  otherUser,
  s,
  mainVideo,
}: {
  other: CallPeer | null;
  otherUser: RoomUser;
  s: CallStoreState;
  mainVideo: React.RefObject<CallVideoHandle>;
}) {
  if (other?.camera) {
    return (
      <div className="absolute inset-0" data-testid={`call-tile-${otherUser.username}`} data-speaking={other.speaking ? "true" : "false"}>
        <CallVideo ref={mainVideo} track={other.camera} fit="cover" label={`${otherUser.username}'s camera`} testId={`call-video-${otherUser.username}`} className="h-full w-full" />
        {other.micMuted && <MutedBadge name={otherUser.username} className="absolute left-4 top-4" />}
      </div>
    );
  }
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 px-6" data-testid={`call-tile-${otherUser.username}`} data-speaking={other?.speaking ? "true" : "false"}>
      <TalkingAvatar user={otherUser} size={136} speaking={!!other?.speaking} />
      <div className="flex items-center gap-2 text-white/80">
        {other?.micMuted && <MutedBadge name={otherUser.username} />}
        {s.status === "connected" && other && !other.camera && <span className="text-sm">Camera off</span>}
      </div>
    </div>
  );
}

function MutedBadge({ name, className }: { name: string; className?: string }) {
  return (
    <span role="img" aria-label={`${name} is muted`} title="Muted" className={cn("inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white", className)}>
      <MicOff className="h-4 w-4" />
    </span>
  );
}

function gridCols(n: number, isPhone: boolean): string {
  if (isPhone) return n <= 1 ? "grid-cols-1" : "grid-cols-2";
  if (n <= 1) return "grid-cols-1";
  if (n <= 4) return "grid-cols-2";
  if (n <= 9) return "grid-cols-3";
  return "grid-cols-4";
}

function GridStage({
  peers,
  ringing,
  users,
  meUser,
  isPhone,
}: {
  peers: CallPeer[];
  ringing: string[];
  users: Record<string, RoomUser>;
  meUser: RoomUser;
  isPhone: boolean;
}) {
  const n = peers.length + 1 + ringing.length;
  return (
    <div className={cn("grid h-full auto-rows-fr gap-2 p-2 md:gap-3 md:p-4", gridCols(n, isPhone))} data-testid="call-grid">
      <SelfTile meUser={meUser} />
      {peers.map((p) => (
        <PeerTile key={p.userId} peer={p} user={personOf(users, p.userId, p.name)} />
      ))}
      {ringing.map((id) => {
        const u = personOf(users, id);
        return (
          <div key={id} className="relative flex min-h-0 flex-col items-center justify-center gap-3 rounded-2xl bg-white/[0.04] opacity-70" data-testid={`call-ringing-${u.username}`}>
            <TalkingAvatar user={u} size={isPhone ? 56 : 72} speaking={false} />
            <span className="text-sm text-white/80">{u.username}</span>
            <span className="text-xs text-white/60">Ringing…</span>
          </div>
        );
      })}
    </div>
  );
}

function tileFrame(speaking: boolean): string {
  return cn("relative min-h-0 overflow-hidden rounded-2xl bg-white/[0.07] ring-2 transition-[box-shadow] duration-150", speaking ? "ring-[#23a55a]" : "ring-transparent");
}

function PeerTile({ peer, user, small }: { peer: CallPeer; user: RoomUser; small?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => calls.pin(useCallStore.getState().pinned === peer.userId ? null : peer.userId)}
      aria-label={`${user.username}${peer.micMuted ? ", muted" : ""}. Show bigger`}
      className={cn(tileFrame(peer.speaking), "focus-visible:outline-none focus-visible:ring-white/70", small ? "h-full w-40 shrink-0" : "h-full w-full")}
      data-testid={`call-tile-${user.username}`}
      data-speaking={peer.speaking ? "true" : "false"}
    >
      {peer.camera ? (
        <CallVideo track={peer.camera} label={`${user.username}'s camera`} testId={`call-video-${user.username}`} className="absolute inset-0 h-full w-full" />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center">
          <TalkingAvatar user={user} size={small ? 44 : 72} speaking={peer.speaking} />
        </span>
      )}
      <span className="absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-full bg-black/55 px-2 py-0.5 text-xs font-medium text-white">
        {peer.micMuted && <MicOff className="h-3.5 w-3.5 shrink-0" aria-label="Muted" />}
        <span className="truncate">{user.username}</span>
      </span>
    </button>
  );
}

function SelfTile({ meUser, small }: { meUser: RoomUser; small?: boolean }) {
  const { camera, cameraTrack, muted, speaking, facing } = useCallStore((s) => ({ camera: s.camera, cameraTrack: s.cameraTrack, muted: s.muted, speaking: s.speaking, facing: s.facing }));
  return (
    <div className={cn(tileFrame(speaking), small ? "h-full w-40 shrink-0" : "h-full w-full")} data-testid="call-tile-me" data-speaking={speaking ? "true" : "false"}>
      {camera && cameraTrack ? (
        <CallVideo track={cameraTrack} mirror={facing === "user"} label="Your camera" testId="call-self-video" className="absolute inset-0 h-full w-full" />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center">
          <TalkingAvatar user={meUser} size={small ? 44 : 72} speaking={speaking} />
        </span>
      )}
      <span className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-full bg-black/55 px-2 py-0.5 text-xs font-medium text-white">
        {muted && <MicOff className="h-3.5 w-3.5" aria-label="Muted" />}
        You
      </span>
    </div>
  );
}

function FocusStage({
  v,
  sharer,
  mainVideo,
  isPhone,
}: {
  v: ReturnType<typeof useCallView>;
  sharer: CallPeer | null;
  mainVideo: React.RefObject<CallVideoHandle>;
  isPhone: boolean;
}) {
  const { s, peers, users, meUser } = v;
  const pinned = !sharer && s.pinned ? (peers.find((p) => p.userId === s.pinned) ?? null) : null;
  const focus = sharer ?? pinned;
  const focusUser = personOf(users, focus?.userId, focus?.name);
  return (
    <div className="flex h-full flex-col gap-2 p-2 md:gap-3 md:p-4">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl bg-black">
        {sharer?.screen ? (
          <CallVideo ref={mainVideo} track={sharer.screen} fit="contain" label={`${focusUser.username}'s screen`} testId={`call-screen-${focusUser.username}`} className="h-full w-full" />
        ) : focus?.camera ? (
          <CallVideo ref={mainVideo} track={focus.camera} fit="contain" label={`${focusUser.username}'s camera`} testId={`call-video-${focusUser.username}`} className="h-full w-full" />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center">
            <TalkingAvatar user={focusUser} size={120} speaking={!!focus?.speaking} />
          </span>
        )}
        <span className="absolute left-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium">
          {sharer ? `${focusUser.username} is sharing their screen` : focusUser.username}
        </span>
        {pinned && (
          <button type="button" onClick={() => calls.pin(null)} className="absolute right-3 top-3 rounded-full bg-black/60 px-3 py-1 text-xs font-semibold hover:bg-black/75">
            Back to everyone
          </button>
        )}
      </div>
      <div className={cn("flex shrink-0 gap-2 overflow-x-auto", isPhone ? "h-24" : "h-28")} aria-label="Everyone in the call">
        <SelfTile meUser={meUser} small />
        {peers.map((p) => (
          <PeerTile key={p.userId} peer={p} user={personOf(users, p.userId, p.name)} small />
        ))}
      </div>
    </div>
  );
}

function EndedStage({ s, who }: { s: CallStoreState; who: RoomUser | null }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 px-6 text-center" data-testid="call-ended">
      {who && <TalkingAvatar user={who} size={112} speaking={false} />}
      <p className="text-lg font-semibold">{endedWords(s.ended?.kind ?? "ended", s.ended?.seconds ?? 0)}</p>
    </div>
  );
}

/** Problems and the browser holding sound back, over the stage. */
function Notices({ s }: { s: CallStoreState }) {
  const problem = s.problem;
  if (!problem && !s.audioBlocked && !s.screen && !s.phone) return null;
  const words: Record<string, string> = {
    "mic-denied": "Your browser is blocking the microphone, so they can't hear you. Allow it in the address bar, then try again.",
    "mic-missing": "No microphone found. Plug one in, then try again.",
    "mic-failed": "Your microphone wouldn't start. Try again, or pick another in More.",
    "camera-denied": "Your browser is blocking the camera. Allow it in the address bar, then turn the camera on again.",
    "camera-failed": "Your camera wouldn't start. It may be in use by another app.",
    "screen-failed": "Screen sharing couldn't start.",
  };
  return (
    <div className="absolute inset-x-0 top-2 z-20 flex flex-col items-center gap-2 px-3">
      {s.audioBlocked && (
        <button
          type="button"
          onClick={() => void calls.resumeAudio()}
          className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-[#1c1917] shadow-lg"
          data-testid="call-sound-blocked"
        >
          <Volume2 className="h-4 w-4" /> Your browser paused the sound. Turn it on
        </button>
      )}
      {s.phone && (
        <span className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1.5 text-xs font-semibold text-white" data-testid="call-in-app">
          <Smartphone className="h-3.5 w-3.5" aria-hidden /> Sound is in the Promptly app&apos;s call
        </span>
      )}
      {s.screen && (
        <span className="inline-flex items-center gap-2 rounded-full bg-[var(--accent-strong)] px-3 py-1.5 text-xs font-semibold text-white" data-testid="call-sharing">
          <MonitorUp className="h-3.5 w-3.5" /> You're sharing your screen{s.screenAudio ? " with sound" : ""}
        </span>
      )}
      {problem && words[problem.kind] && (
        <div role="alert" className="flex max-w-md items-start gap-3 rounded-2xl bg-white px-4 py-3 text-sm text-[#1c1917] shadow-lg" data-testid="call-problem">
          <span className="flex-1">{words[problem.kind]}</span>
          {problem.kind.startsWith("mic") && (
            <button type="button" onClick={() => void calls.retryMic()} className="shrink-0 font-semibold text-[var(--accent-strong)] underline">
              Try again
            </button>
          )}
          <button type="button" onClick={() => void calls.dismissProblem()} className="shrink-0 text-[#57534e] underline">
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- controls

/** The call is in the Promptly Android app (it holds the sound): its mute
 *  and loudspeaker from here, the camera by moving the call to this page. */
function PhoneControls({ isPhone }: { isPhone: boolean }) {
  const { muted, phoneSpeaker, callId, roomId } = useCallStore((s) => ({ muted: s.muted, phoneSpeaker: s.phoneSpeaker, callId: s.callId, roomId: s.roomId }));
  const size = isPhone ? 60 : 56;
  return (
    <div className="relative z-10 flex shrink-0 items-center justify-center gap-3 px-3 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-3 md:gap-4" role="toolbar" aria-label="Call controls">
      <RoundButton label={muted ? "Unmute" : "Mute"} tone={muted ? "on" : "plain"} pressed={muted} size={size} onClick={() => void calls.toggleMute()} testId="call-mute" focusFirst>
        {muted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
      </RoundButton>
      <RoundButton label={phoneSpeaker ? "Speaker on" : "Speaker"} tone={phoneSpeaker ? "accent" : "plain"} pressed={phoneSpeaker} size={size} onClick={() => void calls.togglePhoneSpeaker()} testId="call-speaker">
        <Volume2 className="h-6 w-6" />
      </RoundButton>
      <RoundButton
        label="Turn camera on (the call moves to this page)"
        tone="on"
        size={size}
        onClick={() => callId && void calls.answer(callId, { video: true, roomId, media: "video" })}
        testId="call-camera"
      >
        <VideoOff className="h-6 w-6" />
      </RoundButton>
      <RoundButton label="Hang up" tone="red" size={size + 8} onClick={() => void calls.hangUp()} testId="call-hangup">
        <PhoneOff className="h-7 w-7" />
      </RoundButton>
    </div>
  );
}

function Controls({ isPhone, pipSupported, onPopOut }: { isPhone: boolean; pipSupported: boolean; onPopOut: () => void }) {
  const { muted, camera, screen, phone } = useCallStore((s) => ({ muted: s.muted, camera: s.camera, screen: s.screen, phone: s.phone }));
  const [more, setMore] = useState<HTMLElement | null>(null);
  const canShare = !isPhone && typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
  const { cameras } = useMediaDevices();
  const size = isPhone ? 60 : 56;
  if (phone) return <PhoneControls isPhone={isPhone} />;
  return (
    <div className="relative z-10 flex shrink-0 items-center justify-center gap-3 px-3 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-3 md:gap-4" role="toolbar" aria-label="Call controls">
      <RoundButton label={muted ? "Unmute" : "Mute"} tone={muted ? "on" : "plain"} pressed={muted} size={size} onClick={() => void calls.toggleMute()} testId="call-mute" focusFirst>
        {muted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
      </RoundButton>
      <RoundButton label={camera ? "Turn camera off" : "Turn camera on"} tone={camera ? "plain" : "on"} pressed={camera} size={size} onClick={() => void calls.toggleCamera()} testId="call-camera">
        {camera ? <Video className="h-6 w-6" /> : <VideoOff className="h-6 w-6" />}
      </RoundButton>
      {isPhone && camera && cameras.length !== 1 && (
        <RoundButton label="Switch camera" size={size} onClick={() => void calls.flipCamera()} testId="call-flip">
          <SwitchCamera className="h-6 w-6" />
        </RoundButton>
      )}
      {canShare && (
        <RoundButton
          label={screen ? "Stop sharing your screen" : "Share your screen"}
          tone={screen ? "accent" : "plain"}
          pressed={screen}
          size={size}
          onClick={() => void (screen ? calls.stopScreen() : calls.startScreen())}
          testId="call-share"
        >
          <MonitorUp className="h-6 w-6" />
        </RoundButton>
      )}
      <RoundButton label="More options" size={size} onClick={(e) => setMore(more ? null : e.currentTarget)} testId="call-more">
        <MoreHorizontal className="h-6 w-6" />
      </RoundButton>
      <RoundButton label="Hang up" tone="red" size={size + 8} onClick={() => void calls.hangUp()} testId="call-hangup">
        <PhoneOff className="h-7 w-7" />
      </RoundButton>
      <MoreMenu anchor={more} onClose={() => setMore(null)} pipSupported={pipSupported} onPopOut={onPopOut} />
    </div>
  );
}

function MoreMenu({ anchor, onClose, pipSupported, onPopOut }: { anchor: HTMLElement | null; onClose: () => void; pipSupported: boolean; onPopOut: () => void }) {
  const { mics, speakers, cameras } = useMediaDevices();
  const call = useCallStore((s) => s.call);
  const self = useAuthStore((a) => a.user?.id);
  const missing = useMemo(() => (call?.participants ?? []).filter((p) => p.user_id !== self && !p.in_call && p.ring !== "ringing"), [call, self]);
  const [speaker, setSpeaker] = useState(() => savedDevice("speaker"));
  const [mic, setMic] = useState(() => savedDevice("mic"));
  const [cam, setCam] = useState(() => savedDevice("camera"));
  const item = "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-none";
  const section = (title: string, list: MediaDeviceInfo[], current: string, pick: (id: string) => void, fallback: string): ReactNode =>
    list.length > 1 ? (
      <div className="border-b border-[var(--border)] py-1" role="group" aria-label={title}>
        <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">{title}</p>
        {list.map((d, i) => {
          const on = (current || "default") === d.deviceId || (!current && i === 0);
          return (
            <button key={d.deviceId} type="button" className={item} aria-pressed={on} onClick={() => pick(d.deviceId)}>
              <Check className={cn("h-4 w-4 shrink-0", on ? "text-[var(--item-accent)]" : "invisible")} />
              <span className="truncate">{d.label || `${fallback} ${i + 1}`}</span>
            </button>
          );
        })}
      </div>
    ) : null;
  return (
    <Floating open={!!anchor} onClose={onClose} anchor={anchor} label="Call options" width={300} zIndex={98}>
      <div className="max-h-[60vh] overflow-y-auto">
        {canChooseSpeaker() &&
          section("Speaker", speakers, speaker, (id) => {
            setSpeaker(id);
            void calls.setOutputDevice(id);
          }, "Speaker")}
        {section("Microphone", mics, mic, (id) => {
          setMic(id);
          void calls.setInputDevice(id);
        }, "Microphone")}
        {section("Camera", cameras, cam, (id) => {
          setCam(id);
          void calls.setCameraDevice(id);
        }, "Camera")}
        <div className="py-1">
          {call?.group && missing.length > 0 && (
            <button
              type="button"
              className={item}
              onClick={() => {
                onClose();
                void calls.ringAgain();
              }}
            >
              <BellRing className="h-4 w-4 shrink-0 text-[var(--text-muted)]" /> Ring everyone who isn't here
            </button>
          )}
          {pipSupported && (
            <button
              type="button"
              className={item}
              onClick={() => {
                onClose();
                onPopOut();
              }}
            >
              <PictureInPicture2 className="h-4 w-4 shrink-0 text-[var(--text-muted)]" /> Pop out video
            </button>
          )}
          <button
            type="button"
            className={item}
            onClick={() => {
              onClose();
              calls.minimize();
            }}
          >
            <Minimize2 className="h-4 w-4 shrink-0 text-[var(--text-muted)]" /> Minimise and keep talking
          </button>
          {call?.group && call.started_by === self && (
            <button
              type="button"
              className={cn(item, "text-[var(--danger)]")}
              onClick={() => {
                onClose();
                void calls.endForEveryone();
              }}
            >
              <PhoneOff className="h-4 w-4 shrink-0" /> End the call for everyone
            </button>
          )}
        </div>
      </div>
    </Floating>
  );
}

// ---------------------------------------------------------------- the small window

const MINI_KEY = "promptly.call.mini";

function MiniCall() {
  const isPhone = useIsMobile();
  const v = useCallView();
  const { s, peers, group, other, otherUser } = v;
  const mainVideo = useRef<CallVideoHandle>(null);
  const sharer = peers.find((p) => p.screen) ?? null;
  const speaker = peers.find((p) => p.speaking) ?? other;
  const showPeer = group ? speaker : other;
  const track = sharer?.screen ?? showPeer?.camera ?? null;
  const showUser = personOf(v.users, showPeer?.userId ?? (group ? null : otherUser.id), showPeer?.name ?? otherUser.username);
  const pip = usePictureInPicture(mainVideo, !!track);
  const w = isPhone ? 168 : 288;
  const h = isPhone ? 224 : 176;
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(MINI_KEY) ?? "null") as { x: number; y: number } | null;
      if (saved) return saved;
    } catch {
      /* default */
    }
    return { x: window.innerWidth - w - 16, y: window.innerHeight - h - (isPhone ? 96 : 24) };
  });
  const drag = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);
  const clamp = useCallback((p: { x: number; y: number }) => ({ x: Math.max(8, Math.min(window.innerWidth - w - 8, p.x)), y: Math.max(8, Math.min(window.innerHeight - h - 8, p.y)) }), [w, h]);
  useEffect(() => {
    const onResize = () => setPos((p) => clamp(p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp]);
  const placed = clamp(pos);
  return createPortal(
    <div
      role="region"
      aria-label={`Call with ${v.title}`}
      data-testid="call-mini"
      style={{ ...CALL_ACCENT_STYLE, left: placed.x, top: placed.y, width: w, height: h, touchAction: "none" }}
      className="fixed z-[94] overflow-hidden rounded-2xl bg-[#1c1917] text-white shadow-[0_20px_50px_-12px_rgba(0,0,0,0.55)] ring-1 ring-white/10"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        drag.current = { dx: e.clientX - placed.x, dy: e.clientY - placed.y, moved: false };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.moved = true;
        setPos(clamp({ x: e.clientX - d.dx, y: e.clientY - d.dy }));
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        try {
          window.sessionStorage.setItem(MINI_KEY, JSON.stringify(placed));
        } catch {
          /* this page only */
        }
        if (!d.moved) calls.expand();
      }}
    >
      {track ? (
        <CallVideo ref={mainVideo} track={track} fit={sharer ? "contain" : "cover"} label={`${showUser.username}'s video`} className="absolute inset-0 h-full w-full" />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center pb-10">
          <TalkingAvatar user={showUser} size={isPhone ? 64 : 56} speaking={!!showPeer?.speaking} />
        </span>
      )}
      <div className="absolute inset-x-0 top-0 bg-gradient-to-b from-black/70 to-transparent px-3 pb-4 pt-2">
        <p className="truncate text-[13px] font-semibold">{v.title}</p>
        <p className="truncate text-[11px] tabular-nums text-white/75" data-testid="call-mini-status">
          {v.status}
        </p>
      </div>
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-2 pb-2 pt-5">
        <RoundButton label={s.muted ? "Unmute" : "Mute"} tone={s.muted ? "on" : "plain"} pressed={s.muted} size={36} onClick={() => void calls.toggleMute()} testId="call-mini-mute">
          {s.muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </RoundButton>
        {!isPhone && pip.supported && track && (
          <RoundButton label="Pop out video" size={36} onClick={() => void pip.popOut()}>
            <PictureInPicture2 className="h-4 w-4" />
          </RoundButton>
        )}
        <RoundButton label="Back to the call" size={36} onClick={() => calls.expand()} testId="call-expand">
          <Maximize2 className="h-4 w-4" />
        </RoundButton>
        <RoundButton label="Hang up" tone="red" size={36} onClick={() => void calls.hangUp()} testId="call-mini-hangup">
          <PhoneOff className="h-4 w-4" />
        </RoundButton>
      </div>
    </div>,
    document.body,
  );
}
