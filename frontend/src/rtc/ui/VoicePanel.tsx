/**
 * The voice panel: shown at the bottom of the Rooms channel column and of
 * Promptly's sidebar whenever you're in voice, on every page, so you can
 * keep talking while you do other things. How good the connection is in
 * plain words (click for ping, loss and how it connected), how long you've
 * been in, the channel (click to open it), Leave, Camera, Go Live, who's in
 * the channel, and your own Mute, Deafen and Voice & video settings.
 */
import {
  AlertTriangle,
  Headphones,
  HeadphoneOff,
  Loader2,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  ScreenShareOff,
  Settings,
  Video,
  VideoOff,
  Volume2,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { UserAvatar } from "@/rooms/components/ui";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";

import { fallbackWords } from "../audio/engines";
import { voice } from "../voice/actions";
import { useVoice } from "../voice/hooks";
import type { VoiceStoreState } from "../voice/store";
import { SIGNAL_COLOR, SignalIcon, signalLevel, VoiceAvatar } from "./bits";
import { findChannel, nameOf, useChannelMembers, useRoomsBootstrap, useSpeaking } from "./directory";
import { Floating } from "./Floating";
import { useVoiceUi } from "./uiStore";
import { SHORTCUTS } from "./words";
import "./voicePanel.css";

const iconBtn =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40 [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10";

/** How long the leaving animation runs before the card is taken away. */
const LEAVE_MS = 180;

export const canGoLive = () => typeof navigator !== "undefined" && !!navigator.mediaDevices && "getDisplayMedia" in navigator.mediaDevices;

type SignalLevelName = ReturnType<typeof signalLevel>;

/** The connection in plain words. The numbers are a tap away. */
function statusWords(s: Pick<VoiceStoreState, "status" | "joiningRoomId">, level: SignalLevelName): { text: string; tone: "ok" | "busy" | "bad" } {
  switch (s.status) {
    case "joining":
      return { text: "Connecting…", tone: "busy" };
    case "reconnecting":
      return { text: "Reconnecting…", tone: "busy" };
    case "lost":
      return { text: "Connection lost", tone: "bad" };
    default:
      if (s.joiningRoomId) return { text: "Switching…", tone: "busy" };
      return { text: level === "fair" ? "Okay connection" : level === "poor" ? "Weak connection" : level === "good" ? "Good connection" : "Connected", tone: "ok" };
  }
}

/** "4:07", "1:02:45": how long you've been in. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [since]);
  const total = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, "0");
  const text = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  return (
    <span className="shrink-0 text-xs tabular-nums text-[var(--text-muted)]" role="timer" aria-label={`In voice for ${text}`} data-testid="voice-timer">
      {text}
    </span>
  );
}

/** Mute and Deafen for your row (also used by the channel view's bar). */
export function MuteDeafenButtons({ size = "sm", showSettings = true }: { size?: "sm" | "lg"; showSettings?: boolean }) {
  const s = useVoice((v) => ({
    muted: v.muted,
    deafened: v.deafened,
    serverMuted: v.serverMuted,
    serverDeafened: v.serverDeafened,
    canTalk: v.canTalk,
    status: v.status,
    talkingWhileMuted: v.talkingWhileMuted,
  }));
  const openSettings = useVoiceUi((v) => v.openSettings);
  const inVoice = s.status !== "idle";
  const micOff = s.muted || s.deafened || s.serverMuted || (inVoice && !s.canTalk);
  const big = size === "lg";
  const cls = big
    ? "inline-flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text)] transition hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
    : iconBtn;
  const muteLabel = s.serverMuted
    ? "An admin muted you"
    : inVoice && !s.canTalk
      ? "Only admins can talk here"
      : s.muted || s.deafened
        ? "Unmute"
        : "Mute";
  return (
    <>
      <span className="relative inline-flex">
        <button
          type="button"
          aria-label={muteLabel}
          title={`${muteLabel} (${SHORTCUTS.mute})`}
          aria-keyshortcuts="Control+Shift+M"
          aria-pressed={s.muted || s.deafened}
          disabled={s.serverMuted || (inVoice && !s.canTalk)}
          onClick={() => void voice.toggleMute()}
          className={cn(cls, micOff && "text-[var(--danger)]", big && micOff && "bg-[color-mix(in_srgb,var(--danger)_16%,var(--surface-2))]")}
          data-testid="voice-mute"
        >
          {micOff ? <MicOff className={big ? "h-5 w-5" : "h-4 w-4"} /> : <Mic className={big ? "h-5 w-5" : "h-4 w-4"} />}
        </button>
        {s.serverMuted && (
          <span className="pointer-events-none absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-[var(--danger)] ring-2 ring-[var(--surface)]" aria-hidden />
        )}
        {s.talkingWhileMuted && !s.serverMuted && (
          <span
            role="status"
            className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-[var(--text)] px-2 py-1 text-xs font-medium text-[var(--bg)] shadow"
          >
            You're muted
          </span>
        )}
      </span>
      <button
        type="button"
        aria-label={s.serverDeafened ? "An admin deafened you" : s.deafened ? "Undeafen" : "Deafen"}
        title={`${s.serverDeafened ? "An admin deafened you" : s.deafened ? "Undeafen" : "Deafen"} (${SHORTCUTS.deafen})`}
        aria-keyshortcuts="Control+Shift+D"
        aria-pressed={s.deafened}
        disabled={s.serverDeafened}
        onClick={() => void voice.toggleDeafen()}
        className={cn(cls, (s.deafened || s.serverDeafened) && "text-[var(--danger)]", big && s.deafened && "bg-[color-mix(in_srgb,var(--danger)_16%,var(--surface-2))]")}
        data-testid="voice-deafen"
      >
        {s.deafened || s.serverDeafened ? <HeadphoneOff className={big ? "h-5 w-5" : "h-4 w-4"} /> : <Headphones className={big ? "h-5 w-5" : "h-4 w-4"} />}
      </button>
      {showSettings && (
        <button type="button" aria-label="Voice & video settings" title="Voice & video settings" onClick={openSettings} className={cls}>
          <Settings className={big ? "h-5 w-5" : "h-4 w-4"} />
        </button>
      )}
    </>
  );
}

function SignalDetails({ onClose, anchor }: { onClose: () => void; anchor: HTMLElement | null }) {
  const s = useVoice((v) => ({ connection: v.connection, noise: v.noise, status: v.status }));
  const c = s.connection;
  const level = signalLevel(c);
  const how =
    c.candidateType === "relay"
      ? "Through a relay"
      : c.protocol === "udp"
        ? "Direct (UDP) · best"
        : c.protocol === "tcp"
          ? "Fallback over TCP · fine"
          : "Measuring…";
  const noise =
    s.noise.pref === "off"
      ? "Off"
      : s.noise.pref === "standard"
        ? "Standard (your browser's)"
        : s.noise.engine === "gtcrn" || s.noise.engine === "rnnoise"
          ? "Enhanced"
          : "Standard (your browser's)";
  return (
    <Floating open onClose={onClose} anchor={anchor} width={260} label="Connection details">
      <div className="flex flex-col gap-2 p-3 text-sm" data-testid="voice-signal-details">
        <p className="flex items-center gap-2 font-semibold">
          <SignalIcon level={level} />
          {level === "good" ? "Good connection" : level === "fair" ? "Okay connection" : level === "poor" ? "Weak connection" : "Checking the connection…"}
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
          <dt className="text-[var(--text-muted)]">Ping</dt>
          <dd className="tabular-nums">{c.rttMs !== null ? `${Math.round(c.rttMs)} ms` : "—"}</dd>
          <dt className="text-[var(--text-muted)]">Packet loss</dt>
          <dd className="tabular-nums">{c.lossPct !== null ? `${c.lossPct.toFixed(1)}%` : "—"}</dd>
          <dt className="text-[var(--text-muted)]">Connection</dt>
          <dd>{how}</dd>
          <dt className="text-[var(--text-muted)]">Noise filter</dt>
          <dd>{noise}</dd>
        </dl>
        {s.noise.reason && s.noise.pref === "enhanced" && <p className="text-xs text-[var(--text-muted)]">{fallbackWords(s.noise.reason)}</p>}
        {level === "poor" && (
          <p className="text-xs text-[var(--text-muted)]">Others may hear you break up. Data saver (in Voice & video settings) turns off cameras to help.</p>
        )}
      </div>
    </Floating>
  );
}

export function VoicePanel({ variant }: { variant: "rooms" | "sidebar" | "collapsed" }) {
  const navigate = useNavigate();
  const meId = useAuthStore((s) => s.user?.id) ?? "";
  const s = useVoice((v) => ({
    status: v.status,
    roomId: v.roomId,
    joiningRoomId: v.joiningRoomId,
    connection: v.connection,
    camera: v.camera,
    live: v.live,
    canVideo: v.canVideo,
    canTalk: v.canTalk,
    serverMuted: v.serverMuted,
    serverDeafened: v.serverDeafened,
    quiet: v.quiet,
    audioBlocked: v.audioBlocked,
    joinedAt: v.joinedAt,
  }));
  const live = s.status !== "idle";
  // After you leave, the card stays for a moment so it can slide away,
  // still showing the channel you were in.
  const [leaving, setLeaving] = useState(false);
  const [prevLive, setPrevLive] = useState(live);
  if (prevLive !== live) {
    // Set while rendering, so the card never blinks out for a frame first.
    setPrevLive(live);
    setLeaving(!live);
  }
  const lastRoom = useRef(s.roomId);
  if (live && s.roomId) lastRoom.current = s.roomId;
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => setLeaving(false), LEAVE_MS);
    return () => window.clearTimeout(t);
  }, [leaving]);
  const inVoice = live || leaving;
  const roomId = live ? s.roomId : lastRoom.current;
  const b = useRoomsBootstrap(inVoice || variant === "rooms");
  const members = useChannelMembers(roomId);
  const openGoLive = useVoiceUi((v) => v.openGoLive);
  const openSettings = useVoiceUi((v) => v.openSettings);
  const signalBtn = useRef<HTMLButtonElement>(null);
  const [details, setDetails] = useState(false);

  if (!inVoice && variant !== "rooms") return null;
  if (variant === "rooms" && !inVoice && b?.voice_available !== true) return null;

  const ch = findChannel(b, roomId);
  const level = signalLevel(s.connection);
  const words: ReturnType<typeof statusWords> = live ? statusWords(s, level) : { text: "You left", tone: "busy" };
  const motion = live ? "voice-panel-in" : "voice-panel-out";
  const color = words.tone === "ok" ? SIGNAL_COLOR[level === "unknown" ? "good" : level] : words.tone === "busy" ? "var(--warning)" : "var(--danger)";
  const openChannel = () => roomId && navigate(`/rooms/r/${roomId}`);

  if (variant === "collapsed") {
    return (
      <div className={cn("mt-auto flex flex-col items-center gap-1 border-t border-[var(--border)] pt-2", motion)} data-testid="voice-panel">
        <button type="button" className={iconBtn} onClick={openChannel} aria-label={`Open ${ch?.room.name ?? "voice channel"}`} title={ch?.room.name}>
          <Volume2 className="h-4 w-4" style={{ color }} />
        </button>
        <MuteDeafenButtons showSettings={false} />
        <button type="button" className={cn(iconBtn, "hover:text-[var(--danger)]")} onClick={() => void voice.leave()} aria-label="Leave voice" title="Leave voice">
          <PhoneOff className="h-4 w-4" />
        </button>
      </div>
    );
  }

  const me = b?.users[meId];
  return (
    <section
      aria-label="Voice"
      className={cn(
        "shrink-0 border-t border-[var(--border)] bg-[var(--surface-2)]",
        variant === "sidebar" && "mx-2 mb-2 rounded-xl border",
        // In the sidebar the whole card comes and goes; in Rooms your own row stays.
        variant === "sidebar" && motion,
      )}
      data-testid="voice-panel"
    >
      {inVoice && (
        <div className={cn("px-2 pb-1.5 pt-2", variant === "rooms" && motion)}>
          <div className="flex items-center gap-1.5">
            <button
              ref={signalBtn}
              type="button"
              onClick={() => setDetails((v) => !v)}
              aria-expanded={details}
              aria-label={`${words.text}. Connection details`}
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1 py-0.5 text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              {!live ? (
                <PhoneOff className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />
              ) : words.tone === "busy" ? (
                <Loader2 className="h-4 w-4 animate-spin" style={{ color }} aria-hidden />
              ) : (
                <SignalIcon level={words.tone === "bad" ? "poor" : level} />
              )}
              <span
                className={cn(
                  "truncate text-[13px] font-semibold",
                  !live
                    ? "text-[var(--text-muted)]"
                    : words.tone === "bad" || (words.tone === "ok" && level === "poor")
                      ? "text-[var(--danger)]"
                      : words.tone === "busy" || level === "fair"
                        ? "text-[var(--warning-text)]"
                        : "text-[var(--success-text)]",
                )}
                data-testid="voice-status-words"
              >
                {words.text}
              </span>
              {/* The fixed name of the state, whatever the wording above says. */}
              {live && (
                <span className="sr-only" data-testid="voice-status">
                  {s.status === "connected" && !s.joiningRoomId ? "Voice connected" : words.text}
                </span>
              )}
            </button>
            {live && s.status === "connected" && s.joinedAt !== null && <Elapsed since={s.joinedAt} />}
            {s.status === "lost" && (
              <button type="button" onClick={() => void voice.rejoin()} className="rounded-md px-2 py-1 text-xs font-semibold text-[var(--accent-text)] hover:bg-[var(--hover)] [@media(pointer:coarse)]:min-h-10">
                Rejoin
              </button>
            )}
            <button
              type="button"
              className={cn(iconBtn, "hover:text-[var(--danger)]")}
              onClick={() => void voice.leave()}
              aria-label="Leave voice"
              title="Leave voice"
              data-testid="voice-disconnect"
            >
              <PhoneOff className="h-4 w-4" />
            </button>
          </div>
          <button
            type="button"
            onClick={openChannel}
            className="block w-full truncate rounded-md px-1 text-left text-xs text-[var(--text-muted)] hover:text-[var(--text)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            data-testid="voice-panel-channel"
          >
            {ch ? `${ch.room.name} / ${ch.space.name}` : "Voice channel"}
          </button>

          {s.audioBlocked && (
            <PanelNote tone="warn">
              Your browser paused sound.{" "}
              <button type="button" className="font-semibold underline" onClick={() => void voice.resumeAudio()}>
                Turn on sound
              </button>
            </PanelNote>
          )}
          {s.serverMuted && <PanelNote tone="bad">An admin muted you. You can't unmute until they lift it.</PanelNote>}
          {!s.serverMuted && !s.canTalk && s.status === "connected" && <PanelNote tone="info">Only admins can talk here. You can listen.</PanelNote>}
          {s.serverDeafened && <PanelNote tone="bad">An admin deafened you.</PanelNote>}
          {s.quiet && (
            <PanelNote tone="warn">
              You might be too quiet.{" "}
              <button type="button" className="font-semibold underline" onClick={openSettings}>
                Lower the sensitivity
              </button>
            </PanelNote>
          )}

          <div className="mt-1.5 flex items-center gap-1">
            <button
              type="button"
              aria-label={s.camera ? "Turn camera off" : "Turn camera on"}
              title={s.canVideo ? (s.camera ? "Turn camera off" : "Turn camera on") : "Video is off in this channel"}
              aria-pressed={s.camera}
              disabled={!s.canVideo || s.status !== "connected"}
              onClick={() => void voice.setCamera(!s.camera)}
              className={cn(
                "inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--surface)] text-xs font-medium [@media(pointer:coarse)]:h-10 text-[var(--text)] transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40",
                s.camera && "text-[var(--success)]",
              )}
            >
              {s.camera ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
              Camera
            </button>
            {canGoLive() && (
              <button
                type="button"
                aria-label={s.live ? "Stop streaming" : "Go Live"}
                title={s.canVideo ? (s.live ? "Stop streaming" : "Go Live: share your screen") : "Go Live is off in this channel"}
                aria-pressed={s.live}
                disabled={!s.canVideo || s.status !== "connected"}
                onClick={() => (s.live ? void voice.stopLive() : openGoLive())}
                className={cn(
                  "inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--surface)] text-xs font-medium [@media(pointer:coarse)]:h-10 text-[var(--text)] transition hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40",
                  s.live && "bg-[var(--danger)] text-white hover:bg-[var(--danger)] hover:brightness-95",
                )}
              >
                {s.live ? <ScreenShareOff className="h-4 w-4" /> : <MonitorUp className="h-4 w-4" />}
                {s.live ? "Stop" : "Go Live"}
              </button>
            )}
          </div>
          {members.length > 0 && (
            <ul className="mt-1.5 flex flex-wrap items-center gap-1.5 px-0.5" aria-label="In this channel">
              {members.slice(0, 8).map((m) => (
                <MiniMember key={m.user_id} roomId={roomId!} userId={m.user_id} name={nameOf(b, m.user_id)} user={b?.users[m.user_id]} muted={m.muted || m.server_muted} />
              ))}
              {members.length > 8 && <li className="text-xs text-[var(--text-muted)]">+{members.length - 8}</li>}
            </ul>
          )}
        </div>
      )}
      <div className={cn("flex items-center gap-1 px-2 py-1.5", inVoice && "border-t border-[var(--border)]")}>
        {variant === "rooms" ? (
          <>
            <UserAvatar user={me} size={28} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--text)]">{me?.username ?? ""}</span>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate px-1 text-xs text-[var(--text-muted)]">You</span>
        )}
        <MuteDeafenButtons />
      </div>
      {details && <SignalDetails anchor={signalBtn.current} onClose={() => setDetails(false)} />}
    </section>
  );
}

function MiniMember({ roomId, userId, name, user, muted }: { roomId: string; userId: string; name: string; user: Parameters<typeof VoiceAvatar>[0]["user"]; muted: boolean }) {
  const speaking = useSpeaking(roomId, userId);
  return (
    <li className="relative" title={`${name}${speaking ? " (talking)" : ""}${muted ? " (muted)" : ""}`} data-speaking={speaking ? "true" : "false"}>
      <span className="sr-only">
        {name}
        {speaking ? ", talking" : ""}
        {muted ? ", muted" : ""}
      </span>
      <VoiceAvatar user={user} size={22} speaking={speaking} />
      {muted && (
        <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-[var(--surface)]" aria-hidden>
          <MicOff className="h-2.5 w-2.5 text-[var(--danger)]" />
        </span>
      )}
    </li>
  );
}

function PanelNote({ tone, children }: { tone: "info" | "warn" | "bad"; children: ReactNode }) {
  return (
    <p
      role="status"
      className={cn(
        "mt-1 flex items-start gap-1.5 rounded-md px-1.5 py-1 text-xs leading-snug",
        tone === "bad" ? "bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-[var(--text)]" : "bg-[var(--surface)] text-[var(--text)]",
      )}
    >
      {tone !== "info" && <AlertTriangle className={cn("mt-px h-3 w-3 shrink-0", tone === "bad" ? "text-[var(--danger)]" : "text-[var(--warning)]")} aria-hidden />}
      <span>{children}</span>
    </p>
  );
}
