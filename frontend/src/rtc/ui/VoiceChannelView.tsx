/**
 * A voice channel's page: the stage with everyone as a tile (speaking
 * ring, camera video when it's on), live streams with Watch and a viewer
 * count, a big view of the stream you watch (theatre, full screen and
 * pop-out), the controls bar, and the channel's own text chat beside it.
 * On a phone: full screen, a grid, big buttons, and chat a tap away.
 */
import {
  ArrowLeft,
  ChevronDown,
  Eye,
  Hand,
  Maximize2,
  MessageSquare,
  Minimize2,
  MonitorUp,
  PhoneOff,
  PictureInPicture2,
  RectangleHorizontal,
  ScreenShareOff,
  Settings,
  Video,
  VideoOff,
  Volume2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";

import type { Bootstrap, Room, Space } from "@/api/rooms";
import type { VoiceMember } from "@/api/voiceChannels";
import { ItemButton } from "@/items/ui";
import { UserAvatar } from "@/rooms/components/ui";
import { useAuthStore } from "@/store/authStore";
import { cn } from "@/utils/cn";

import { voice } from "../voice/actions";
import { useVoice, useVoiceSettings } from "../voice/hooks";
import { VideoTrackView } from "../voice/VideoTrackView";
import { MemberIcons, SignalIcon, signalLevel, VoiceAvatar } from "./bits";
import { joinAndOpen } from "./ChannelRow";
import { isSpaceAdmin, nameOf, useChannelMembers, useSpeaking } from "./directory";
import { canGoLive, MuteDeafenButtons } from "./VoicePanel";
import { useVoiceUi } from "./uiStore";
import { problemWords } from "./words";

const PHONE_WARNED_KEY = "promptly.voice.phoneWarned";

const barBtn =
  "inline-flex h-11 w-11 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text)] transition hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent,var(--accent))] disabled:opacity-40";

type Focus = { kind: "screen" | "camera"; userId: string } | null;

export function VoiceChannelView({
  b,
  room,
  space,
  isPhone,
  onBack,
  chat,
  onSettings,
}: {
  b: Bootstrap;
  room: Room;
  space: Space;
  isPhone: boolean;
  onBack?: () => void;
  /** The channel's text chat (the room's message list and composer). */
  chat: ReactNode;
  onSettings: () => void;
}) {
  const navigate = useNavigate();
  const meId = useAuthStore((s) => s.user?.id) ?? "";
  const s = useVoice((v) => ({
    status: v.status,
    roomId: v.roomId,
    joiningRoomId: v.joiningRoomId,
    connection: v.connection,
    watching: v.watching,
    camera: v.camera,
    live: v.live,
    canVideo: v.canVideo,
    problem: v.problem,
  }));
  const here = s.roomId === room.id && s.status !== "idle";
  const members = useChannelMembers(room.id);
  const chatOpen = useVoiceUi((v) => v.chatOpen);
  const setChatOpen = useVoiceUi((v) => v.setChatOpen);
  const theatre = useVoiceUi((v) => v.theatre);
  const setTheatre = useVoiceUi((v) => v.setTheatre);
  const openGoLive = useVoiceUi((v) => v.openGoLive);
  const [phoneChat, setPhoneChat] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const viewWidth = useWidth(viewRef);
  const [focus, setFocus] = useState<Focus>(null);
  const stage = useRef<HTMLDivElement>(null);
  const available = b.voice_available !== false;
  const admin = isSpaceAdmin(space);
  const limit = room.voice?.user_limit ?? 0;
  const full = limit > 0 && members.length >= limit && !here;
  const { prefs } = useVoiceSettings();

  // The stream you watch is the focus; leaving it (or its end) unfocuses.
  useEffect(() => {
    if (s.watching) setFocus({ kind: "screen", userId: s.watching });
    else setFocus((f) => (f?.kind === "screen" ? null : f));
  }, [s.watching]);
  useEffect(() => {
    if (!here) {
      setFocus(null);
      setTheatre(false);
    }
  }, [here, setTheatre]);
  // Theatre ends with Escape (and when you leave the page).
  useEffect(() => {
    if (!theatre) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.fullscreenElement) setTheatre(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [theatre, setTheatre]);
  useEffect(() => () => setTheatre(false), [setTheatre]);

  // Phones: keep the screen on while you're in the channel here.
  useEffect(() => {
    if (!isPhone || !here || s.status !== "connected") return;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
    if (!nav.wakeLock) return;
    let lock: { release: () => Promise<void> } | null = null;
    let gone = false;
    const take = () => {
      if (document.visibilityState !== "visible") return;
      nav.wakeLock!.request("screen").then(
        (l) => {
          if (gone) void l.release();
          else lock = l;
        },
        () => undefined,
      );
    };
    take();
    document.addEventListener("visibilitychange", take);
    return () => {
      gone = true;
      document.removeEventListener("visibilitychange", take);
      void lock?.release().catch(() => undefined);
    };
  }, [isPhone, here, s.status]);

  const [phoneWarned, setPhoneWarned] = useState(() => {
    try {
      return window.localStorage.getItem(PHONE_WARNED_KEY) === "1";
    } catch {
      return true;
    }
  });
  const dismissPhoneWarning = () => {
    setPhoneWarned(true);
    try {
      window.localStorage.setItem(PHONE_WARNED_KEY, "1");
    } catch {
      /* shown again next time */
    }
  };

  const join = () => void joinAndOpen(room.id, room.name, navigate, { full, admin });
  const live = members.filter((m) => m.live);
  const viewers = (uid: string) => members.filter((m) => m.watching === uid).length;
  const level = signalLevel(s.connection);

  const openMenu = useVoiceUi((v) => v.openPersonMenu);
  const onPerson = useCallback(
    (e: MouseEvent<HTMLElement>, userId: string) => {
      e.preventDefault();
      openMenu({ userId, roomId: room.id, anchor: e.currentTarget, point: e.type === "contextmenu" && e.clientX ? { x: e.clientX, y: e.clientY } : null });
    },
    [openMenu, room.id],
  );

  // ------------------------------------------------------------ header
  const header = (
    <header className="flex h-14 shrink-0 items-center gap-1 border-b border-[var(--border)] px-1.5 md:gap-2 md:px-4">
      {onBack && (
        <button
          type="button"
          aria-label={here ? "Minimise" : "Back"}
          title={here ? "Minimise (you stay connected)" : "Back"}
          onClick={onBack}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--text)] hover:bg-[var(--hover)]"
        >
          {here ? <ChevronDown className="h-5 w-5" /> : <ArrowLeft className="h-5 w-5" />}
        </button>
      )}
      <button
        type="button"
        onClick={onSettings}
        className="flex min-w-0 items-center gap-2 rounded-xl px-1 py-1 text-left hover:bg-[var(--hover)]"
        aria-label={`${room.name} settings`}
      >
        <Volume2 className={cn("h-5 w-5 shrink-0", here ? "text-[var(--success)]" : "text-[var(--text-muted)]")} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[15px] font-semibold leading-tight text-[var(--text)]">{room.name}</span>
          <span className="truncate text-[11px] leading-tight text-[var(--text-muted)]">
            {members.length === 0 ? "No one's here" : `${members.length} in voice`}
            {limit > 0 ? ` · limit ${limit}` : ""}
            {isPhone ? ` · ${space.name}` : ""}
          </span>
        </span>
      </button>
      {here && s.status === "connected" && (
        <span className="ml-1 hidden items-center gap-1 text-[11px] text-[var(--text-muted)] sm:inline-flex" title="Connection">
          <SignalIcon level={level} />
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center">
        {!isPhone && (
          <button
            type="button"
            aria-label={chatOpen ? "Hide chat" : "Show chat"}
            title={chatOpen ? "Hide chat" : "Show chat"}
            aria-pressed={chatOpen}
            onClick={() => setChatOpen(!chatOpen)}
            className={cn(
              "relative flex h-9 w-9 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]",
              chatOpen && "bg-[var(--hover)] !text-[var(--item-accent)]",
            )}
          >
            <MessageSquare className="h-[18px] w-[18px]" />
            {!chatOpen && room.unread > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[var(--danger)]" aria-label="New messages" />}
          </button>
        )}
        <button
          type="button"
          aria-label="Channel settings"
          title="Channel settings"
          onClick={onSettings}
          className="flex h-11 w-11 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] md:h-9 md:w-9"
        >
          <Settings className="h-[18px] w-[18px]" />
        </button>
      </div>
    </header>
  );

  // ------------------------------------------------------------ not in it
  const lobby = (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      {members.length > 0 ? (
        <>
          <ul className="flex flex-wrap justify-center gap-3" aria-label={`In ${room.name}`}>
            {members.map((m) => (
              <LobbyPerson key={m.user_id} b={b} roomId={room.id} m={m} />
            ))}
          </ul>
          <p className="text-sm text-[var(--text-muted)]">
            {members.length === 1 ? `${nameOf(b, members[0].user_id)} is here.` : `${members.length} people are here.`}
          </p>
        </>
      ) : (
        <>
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--surface-2)]">
            <Volume2 className="h-8 w-8 text-[var(--text-muted)]" />
          </span>
          <div>
            <p className="text-lg font-semibold text-[var(--text)]">{room.name}</p>
            <p className="mt-1 max-w-sm text-sm text-[var(--text-muted)]">
              {available ? "No one's here yet. Drop in and others can join you." : "Voice isn't available to you on this server. You can still use the chat."}
            </p>
          </div>
        </>
      )}
      {available && (
        <>
          {s.problem && s.joiningRoomId === null && !here && (
            <p className="max-w-sm text-sm text-[var(--danger)]" role="alert">
              {problemWords(s.problem, room.name).title}
            </p>
          )}
          <ItemButton
            variant="primary"
            size="lg"
            onClick={join}
            disabled={(full && !admin) || s.joiningRoomId === room.id}
            icon={<Volume2 className="h-5 w-5" />}
            data-testid="voice-join"
          >
            {s.joiningRoomId === room.id ? "Joining…" : full && !admin ? `${room.name} is full` : s.status !== "idle" ? `Switch to ${room.name}` : "Join voice"}
          </ItemButton>
          {s.status === "idle" && <p className="text-xs text-[var(--text-muted)]">You can keep using Promptly while you talk: the voice panel stays with you.</p>}
        </>
      )}
    </div>
  );

  // ------------------------------------------------------------ tiles
  const tiles: ReactNode[] = [];
  for (const m of members) {
    if (focus?.kind === "camera" && focus.userId === m.user_id) continue;
    tiles.push(<PersonTile key={`p-${m.user_id}`} b={b} roomId={room.id} m={m} me={m.user_id === meId} onMenu={onPerson} onFocus={() => setFocus({ kind: "camera", userId: m.user_id })} />);
  }
  for (const m of live) {
    if (focus?.kind === "screen" && focus.userId === m.user_id) continue;
    tiles.push(
      <StreamTile
        key={`s-${m.user_id}`}
        b={b}
        m={m}
        me={m.user_id === meId}
        viewers={viewers(m.user_id)}
        isPhone={isPhone}
      />,
    );
  }

  const focusNode = focus ? (
    <FocusView
      b={b}
      roomId={room.id}
      focus={focus}
      meId={meId}
      viewers={focus.kind === "screen" ? viewers(focus.userId) : 0}
      stage={stage}
      isPhone={isPhone}
      onClose={() => (focus.kind === "screen" ? void voice.watch(null) : setFocus(null))}
    />
  ) : null;

  const controls = here && (
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-t border-[var(--border)] bg-[var(--surface)] px-3 py-3 md:gap-3">
      <MuteDeafenButtons size="lg" showSettings={!isPhone} />
      {!isPhone && (
        <button
          type="button"
          aria-label={s.camera ? "Turn camera off" : "Turn camera on"}
          title={s.canVideo ? (s.camera ? "Turn camera off" : "Turn camera on") : "Video is off in this channel"}
          aria-pressed={s.camera}
          disabled={!s.canVideo || s.status !== "connected"}
          onClick={() => void voice.setCamera(!s.camera)}
          className={cn(barBtn, s.camera && "text-[var(--success)]")}
        >
          {s.camera ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
        </button>
      )}
      {canGoLive() && !isPhone && (
        <button
          type="button"
          aria-label={s.live ? "Stop streaming" : "Go Live"}
          title={s.canVideo ? (s.live ? "Stop streaming" : "Go Live: share your screen") : "Go Live is off in this channel"}
          aria-pressed={s.live}
          disabled={!s.canVideo || s.status !== "connected"}
          onClick={() => (s.live ? void voice.stopLive() : openGoLive())}
          className={cn(barBtn, s.live && "bg-[var(--danger)] text-white")}
        >
          {s.live ? <ScreenShareOff className="h-5 w-5" /> : <MonitorUp className="h-5 w-5" />}
        </button>
      )}
      {isPhone && (
        <button type="button" aria-label="Chat" title="Chat" onClick={() => setPhoneChat(true)} className={barBtn}>
          <MessageSquare className="h-5 w-5" />
        </button>
      )}
      <button
        type="button"
        aria-label="Leave voice"
        title="Leave voice"
        onClick={() => void voice.leave()}
        className="inline-flex h-11 w-14 items-center justify-center rounded-full bg-[var(--danger)] text-white transition hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--danger)] focus-visible:ring-offset-2"
        data-testid="voice-leave"
      >
        <PhoneOff className="h-5 w-5" />
      </button>
      {isPhone && prefs.input_mode === "ptt" && <HoldToTalk />}
    </div>
  );

  const stageBody = !here ? (
    lobby
  ) : (
    <div ref={stage} className="flex min-h-0 flex-1 flex-col bg-[var(--bg)]" data-testid="voice-stage">
      {isPhone && !phoneWarned && (
        <div className="m-3 flex items-start gap-2 rounded-xl border border-[var(--warning-border)] bg-[var(--warning-bg)] p-3 text-xs text-[var(--text)]" role="note">
          <span className="flex-1">Voice may stop if you lock your phone or switch apps. On Android, install the Promptly app to stay connected.</span>
          <button type="button" aria-label="Dismiss" onClick={dismissPhoneWarning} className="-m-1 rounded-md p-1 hover:bg-[var(--hover)]">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {focusNode ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2 md:p-3">
          <div className="min-h-0 flex-1">{focusNode}</div>
          {tiles.length > 0 && !theatre && <div className="flex h-24 shrink-0 gap-2 overflow-x-auto md:h-28">{tiles.map((t, i) => <div key={i} className="aspect-video h-full shrink-0">{t}</div>)}</div>}
        </div>
      ) : (
        <TileGrid count={tiles.length}>{tiles}</TileGrid>
      )}
      {controls}
    </div>
  );

  if (isPhone) {
    return (
      <section className="relative flex min-h-0 min-w-0 flex-1 flex-col" aria-label={`Voice channel ${room.name}`}>
        {header}
        {phoneChat ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border)] px-2">
              <button type="button" onClick={() => setPhoneChat(false)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-medium text-[var(--item-accent)] hover:bg-[var(--hover)]">
                <ArrowLeft className="h-4 w-4" /> Back to voice
              </button>
            </div>
            {chat}
          </div>
        ) : here ? (
          stageBody
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            {lobby}
            <div className="flex shrink-0 justify-center border-t border-[var(--border)] p-2">
              <button type="button" onClick={() => setPhoneChat(true)} className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)]">
                <MessageSquare className="h-4 w-4" /> Open chat
              </button>
            </div>
          </div>
        )}
      </section>
    );
  }

  const view = (
    <div
      ref={viewRef}
      className={cn("relative flex min-h-0 min-w-0 flex-1", theatre && "fixed inset-0 z-[70] bg-[var(--bg)]")}
      data-testid="voice-channel-view"
      data-theatre={theatre ? "true" : "false"}
    >
      <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={`Voice channel ${room.name}`}>
        {header}
        {stageBody}
      </section>
      {chatOpen && !theatre && (
        <aside
          className={cn(
            "flex w-[360px] max-w-full shrink-0 flex-col border-l border-[var(--border)] bg-[var(--surface)]",
            // Not enough room beside the stage: over it, from the right.
            viewWidth < 900 && "absolute inset-y-0 right-0 z-20 shadow-[var(--shadow-lg)]",
          )}
          aria-label={`Chat in ${room.name}`}
        >
          {chat}
        </aside>
      )}
    </div>
  );
  // Theatre covers the whole window: drawn on <body>, above every layout.
  return theatre ? createPortal(view, document.body) : view;
}

// ---------------------------------------------------------------- tiles

function LobbyPerson({ b, roomId, m }: { b: Bootstrap; roomId: string; m: VoiceMember }) {
  const speaking = useSpeaking(roomId, m.user_id);
  return (
    <li className="flex w-20 flex-col items-center gap-1.5">
      <VoiceAvatar user={b.users[m.user_id]} size={56} speaking={speaking} ringGap={3} />
      <span className="flex max-w-full items-center gap-1">
        <span className="truncate text-xs font-medium text-[var(--text)]">{nameOf(b, m.user_id)}</span>
      </span>
      <MemberIcons m={m} size={12} />
    </li>
  );
}

function PersonTile({
  b,
  roomId,
  m,
  me,
  onMenu,
  onFocus,
}: {
  b: Bootstrap;
  roomId: string;
  m: VoiceMember;
  me: boolean;
  onMenu: (e: MouseEvent<HTMLElement>, userId: string) => void;
  onFocus: () => void;
}) {
  const speaking = useSpeaking(roomId, m.user_id);
  const track = useVoice((v) => (me ? v.cameraTrack : (v.peers[m.user_id]?.camera ?? null)));
  const name = nameOf(b, m.user_id);
  const user = b.users[m.user_id];
  return (
    <div
      className={cn(
        "group relative flex h-full w-full items-center justify-center overflow-hidden rounded-2xl bg-[var(--surface-2)] outline outline-2 -outline-offset-2 transition-[outline-color]",
        speaking ? "outline-[#23a55a]" : "outline-transparent",
      )}
      data-testid={`voice-tile-${name}`}
      data-speaking={speaking ? "true" : "false"}
      onContextMenu={(e) => onMenu(e, m.user_id)}
      onDoubleClick={track ? onFocus : undefined}
    >
      {track ? (
        <VideoTrackView track={track} label={`${name}'s camera`} fit="cover" mirror={me} className="absolute inset-0 h-full w-full bg-black" />
      ) : (
        <span
          className="absolute inset-0 opacity-25"
          style={{ background: user?.color ? `radial-gradient(circle at 50% 45%, ${user.color}, transparent 70%)` : undefined }}
          aria-hidden
        />
      )}
      {!track && <VoiceAvatar user={user} size={72} speaking={speaking} ringGap={3} className="relative [--voice-ring-gap:var(--surface-2)]" />}
      <button
        type="button"
        onClick={(e) => onMenu(e, m.user_id)}
        className="absolute bottom-2 left-2 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-lg bg-black/60 px-2 py-1 text-xs font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        aria-label={`${name}${me ? " (you)" : ""}${speaking ? ", talking" : ""}. Options`}
        aria-haspopup="dialog"
      >
        <span className="truncate">
          {name}
          {me ? " (you)" : ""}
        </span>
        <MemberIcons m={m} size={12} className="!text-white" />
      </button>
      {track && (
        <button
          type="button"
          onClick={onFocus}
          aria-label={`Focus ${name}'s camera`}
          title="Focus"
          className="absolute right-2 top-2 hidden h-8 w-8 items-center justify-center rounded-lg bg-black/60 text-white group-hover:flex group-focus-within:flex"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function StreamTile({ b, m, me, viewers, isPhone }: { b: Bootstrap; m: VoiceMember; me: boolean; viewers: number; isPhone: boolean }) {
  const liveTrack = useVoice((v) => (me ? v.liveTrack : null));
  const liveAudio = useVoice((v) => (me ? v.liveAudio : null));
  const name = nameOf(b, m.user_id);
  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl bg-[#111214] p-3 text-white" data-testid={`voice-stream-${name}`}>
      {me && liveTrack ? <VideoTrackView track={liveTrack} label="Your stream" className="absolute inset-0 h-full w-full opacity-60" /> : null}
      <span className="absolute left-2 top-2 rounded-[4px] bg-[#da373c] px-1.5 text-[10px] font-bold uppercase leading-4 tracking-wide text-white">Live</span>
      <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-black/60 px-1.5 text-[11px] leading-5" data-testid="stream-viewers">
        <Eye className="h-3 w-3" /> {viewers} watching
      </span>
      <div className="relative flex flex-col items-center gap-2 text-center">
        {!me && <UserAvatar user={b.users[m.user_id]} size={40} />}
        <p className="text-sm font-semibold">{me ? "You're live" : `${name} is live`}</p>
        {me ? (
          <>
            {liveAudio === false && <p className="text-[11px] text-white/80">No sound with this share</p>}
            <button
              type="button"
              onClick={() => void voice.stopLive()}
              className="inline-flex h-9 items-center gap-2 rounded-xl bg-[#da373c] px-3 text-sm font-semibold text-white hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <ScreenShareOff className="h-4 w-4" /> Stop streaming
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => void voice.watch(m.user_id)}
            className="inline-flex h-9 items-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-[#111214] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#111214]"
            aria-label={`Watch ${name}'s stream`}
          >
            <Eye className="h-4 w-4" /> {isPhone ? "Watch" : "Watch stream"}
          </button>
        )}
      </div>
    </div>
  );
}

function FocusView({
  b,
  roomId,
  focus,
  meId,
  viewers,
  stage,
  isPhone,
  onClose,
}: {
  b: Bootstrap;
  roomId: string;
  focus: NonNullable<Focus>;
  meId: string;
  viewers: number;
  stage: RefObject<HTMLDivElement>;
  isPhone: boolean;
  onClose: () => void;
}) {
  const me = focus.userId === meId;
  const track = useVoice((v) =>
    focus.kind === "screen" ? (me ? v.liveTrack : (v.peers[focus.userId]?.screen ?? null)) : me ? v.cameraTrack : (v.peers[focus.userId]?.camera ?? null),
  );
  const { streamVolume, streamAudio } = useVoice((v) => ({ streamVolume: v.streamVolume, streamAudio: !!v.peers[focus.userId]?.streamAudio }));
  const theatre = useVoiceUi((v) => v.theatre);
  const setTheatre = useVoiceUi((v) => v.setTheatre);
  const box = useRef<HTMLDivElement>(null);
  const [fs, setFs] = useState(false);
  const name = nameOf(b, focus.userId);
  const pipOk = typeof document !== "undefined" && "pictureInPictureEnabled" in document && document.pictureInPictureEnabled;
  const speaking = useSpeaking(roomId, focus.userId);

  useEffect(() => {
    const on = () => setFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void (box.current ?? stage.current)?.requestFullscreen?.().catch(() => undefined);
  }, [stage]);

  const popOut = () => {
    const v = box.current?.querySelector("video");
    if (!v) return;
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined);
    else void v.requestPictureInPicture().catch(() => undefined);
  };

  const label = focus.kind === "screen" ? (me ? "Your stream" : `${name}'s stream`) : `${name}'s camera`;
  const tool =
    "inline-flex h-9 w-9 items-center justify-center rounded-lg bg-black/60 text-white hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white";

  return (
    <div
      ref={box}
      className="group relative flex h-full w-full items-center justify-center overflow-hidden rounded-2xl bg-black"
      onDoubleClick={toggleFullscreen}
      data-testid="voice-focus"
    >
      {track ? (
        <VideoTrackView track={track} label={label} fit="contain" mirror={focus.kind === "camera" && me} className="h-full w-full" />
      ) : (
        <p className="text-sm text-white/80">Loading…</p>
      )}
      <div className="absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/70 to-transparent p-2 text-white opacity-100 transition md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
        {focus.kind === "screen" && <span className="rounded-[4px] bg-[#da373c] px-1.5 text-[10px] font-bold uppercase leading-4 tracking-wide">Live</span>}
        <span className={cn("truncate text-sm font-semibold", speaking && "underline decoration-[#23a55a] decoration-2 underline-offset-4")}>{label}</span>
        {focus.kind === "screen" && (
          <span className="inline-flex items-center gap-1 text-xs text-white/90" data-testid="focus-viewers">
            <Eye className="h-3.5 w-3.5" /> {viewers} watching
          </span>
        )}
        <button type="button" onClick={onClose} className={cn(tool, "ml-auto")} aria-label={focus.kind === "screen" ? "Stop watching" : "Close"} title={focus.kind === "screen" ? "Stop watching" : "Close"}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent p-2 text-white opacity-100 transition md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
        {focus.kind === "screen" && !me && streamAudio && (
          <label className="flex items-center gap-2 text-xs">
            <Volume2 className="h-4 w-4" />
            <span className="sr-only">Stream volume</span>
            <input
              type="range"
              min={0}
              max={200}
              step={5}
              value={streamVolume}
              aria-label="Stream volume"
              aria-valuetext={`${streamVolume}%`}
              onChange={(e) => void voice.setStreamVolume(Number(e.target.value))}
              className="w-28"
              style={{ accentColor: "#fff" }}
            />
            <span className="w-10 tabular-nums">{streamVolume}%</span>
          </label>
        )}
        {focus.kind === "screen" && !me && !streamAudio && <span className="text-xs text-white/80">No sound with this stream</span>}
        <div className="ml-auto flex items-center gap-1.5">
          {!isPhone && (
            <button type="button" className={tool} onClick={() => setTheatre(!theatre)} aria-pressed={theatre} aria-label={theatre ? "Exit theatre mode" : "Theatre mode"} title={theatre ? "Exit theatre (Esc)" : "Theatre mode"}>
              <RectangleHorizontal className="h-4 w-4" />
            </button>
          )}
          {pipOk && track && (
            <button type="button" className={tool} onClick={popOut} aria-label="Pop out" title="Pop out (picture-in-picture)">
              <PictureInPicture2 className="h-4 w-4" />
            </button>
          )}
          <button type="button" className={tool} onClick={toggleFullscreen} aria-label={fs ? "Exit full screen" : "Full screen"} title={fs ? "Exit full screen (Esc)" : "Full screen (double-click)"}>
            {fs ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}

function HoldToTalk() {
  const [down, setDown] = useState(false);
  const press = (on: boolean) => {
    setDown(on);
    void voice.pushToTalk(on);
  };
  return (
    <button
      type="button"
      aria-label="Hold to talk"
      aria-pressed={down}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        press(true);
      }}
      onPointerUp={() => press(false)}
      onPointerCancel={() => press(false)}
      onKeyDown={(e) => (e.key === " " || e.key === "Enter") && !e.repeat && press(true)}
      onKeyUp={(e) => (e.key === " " || e.key === "Enter") && press(false)}
      className={cn(
        "inline-flex h-12 flex-1 basis-full items-center justify-center gap-2 rounded-full text-sm font-semibold transition",
        down ? "bg-[var(--success)] text-white" : "bg-[var(--surface-2)] text-[var(--text)]",
      )}
    >
      <Hand className="h-5 w-5" /> {down ? "Talking…" : "Hold to talk"}
    </button>
  );
}

/** Width of an element, kept up to date. */
function useWidth(ref: RefObject<HTMLElement>): number {
  const [w, setW] = useState(1200);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    setW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** Tiles at 16:9, as big as the stage allows: picks the number of columns
 *  that gives the largest tiles, then centres them (Discord's grid). */
function TileGrid({ count, children }: { count: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 450 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const gap = 12;
  let best = { cols: 1, tileW: 0 };
  for (let cols = 1; cols <= Math.max(1, count); cols++) {
    const rows = Math.ceil(count / cols);
    const byW = (size.w - gap * (cols - 1)) / cols;
    const byH = ((size.h - gap * (rows - 1)) / rows) * (16 / 9);
    const tileW = Math.min(byW, byH);
    if (tileW > best.tileW) best = { cols, tileW };
  }
  // Many people on a small stage: a scrolling grid of a sensible minimum.
  const tileW = Math.max(best.tileW, Math.min(220, size.w));
  return (
    <div ref={box} className="min-h-0 flex-1 overflow-y-auto p-2 md:p-3" data-testid="voice-grid">
      <div className="flex min-h-full flex-wrap content-center items-center justify-center" style={{ gap }}>
        {Array.isArray(children)
          ? children.map((c, i) => (
              <div key={i} className="aspect-video" style={{ width: Math.floor(tileW) }}>
                {c}
              </div>
            ))
          : children}
      </div>
    </div>
  );
}
