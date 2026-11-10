import { useQuery } from "@tanstack/react-query";
import { Bell, Download, MessageSquarePlus, MessagesSquare, Phone, PhoneCall, Plus, Search, Settings, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Navigate, useLocation, useMatch, useNavigate } from "react-router-dom";

import { roomsApi, type Bootstrap, type Space } from "@/api/rooms";
import { NetworkStatusToast } from "@/components/layout/NetworkStatusToast";
import { Skeleton } from "@/components/shared/Skeleton";
import { PromptlyMenuButton } from "@/components/layout/PromptlyNavDrawer";
import { InstallFromLink } from "@/components/pwa/InstallFromLink";
import { usePushSubscription } from "@/hooks/usePushSubscription";
import { useIsMobile } from "@/hooks/useIsMobile";
import { EmptyState, ItemButton, Segmented, Sheet } from "@/items/ui";
import "@/items/ui/items.css";
import "./rooms.css";
import { useInstallPrompt } from "@/lib/installPrompt";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { BOOTSTRAP_KEY, findRoom, totals } from "./cache";
import { useRoomsEvents } from "./live";
import { useRoomsStore } from "./store";
import { CallDetail, CallsHome, CallsList, NewCallSheet } from "./components/Calls";
import { ConfirmSheetHost } from "./components/ConfirmSheet";
import { DmList, SpaceRoomList } from "./components/Lists";
import { SearchPanel } from "./components/Panels";
import { CreateRoomSheet, NewDmSheet } from "./components/RoomSheets";
import { RoomView } from "./components/RoomView";
import { CreateSpaceSheet, SpaceSettingsSheet } from "./components/SpaceSheets";
import { CountBadge, SpaceIcon } from "./components/ui";
import { useRecordOpen } from "@/hooks/useRecordOpen";
import { useCallStore } from "@/rtc/call/store";
import { useVoiceLive } from "@/rtc/voice/hooks";
import { seedFromBootstrap } from "@/rtc/ui/directory";
import { VoicePanel } from "@/rtc/ui/VoicePanel";
import { VoicePill } from "@/rtc/ui/VoicePill";

/** Rooms' own colour. Only the app mark wears it; buttons, selection and
 *  bubbles use the theme accent like the rest of Promptly. */
export const ROOMS_ACCENT = "#5865F2";
const LAST_ROOM_KEY = "rooms:last-room";
const LAST_IN_SPACE_KEY = "rooms:last-in-space";
const PUSH_HINT_KEY = "rooms:push-hint-dismissed";

function readLS<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeLS(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage blocked */
  }
}

/** Rooms full screen on a phone but inside Promptly (not the installed Rooms
 *  app): Promptly's menu button opens its drawer (App.tsx's RoomsGate). */
const PromptlyNavContext = createContext(false);

/** The phone's visible area — keeps the composer above the on-screen keyboard. */
function useVisualViewport(enabled: boolean) {
  const [vv, setVv] = useState<{ h: number; top: number } | null>(null);
  useEffect(() => {
    const v = window.visualViewport;
    if (!enabled || !v) {
      setVv(null);
      return;
    }
    const on = () => setVv({ h: v.height, top: v.offsetTop });
    on();
    v.addEventListener("resize", on);
    v.addEventListener("scroll", on);
    return () => {
      v.removeEventListener("resize", on);
      v.removeEventListener("scroll", on);
    };
  }, [enabled]);
  return vv;
}

/**
 * ``/rooms/*`` — Promptly Rooms: spaces of text rooms + direct messages.
 * As the installed Rooms app (own manifest, scope ``/rooms/``) there's no
 * Promptly chrome. Inside Promptly it's ``embedded`` in Promptly's layout on
 * a big screen, or full screen with Promptly's menu button (``promptlyNav``)
 * on a phone.
 */
export function RoomsApp({ embedded = false, promptlyNav = false }: { embedded?: boolean; promptlyNav?: boolean } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const isPhone = useIsMobile(767);
  const roomMatch = useMatch("/rooms/r/:roomId");
  const roomId = roomMatch?.params.roomId ?? null;
  useRecordOpen("room", roomId);
  const onDmPath = location.pathname.startsWith("/rooms/dm");
  // Calls WP-D4: the Calls tab (/rooms/calls) and one call's details.
  const onCallsPath = location.pathname.startsWith("/rooms/calls");
  const callKey = useMatch("/rooms/calls/:callKey")?.params.callKey ?? null;
  const missedCalls = useCallStore((s) => s.missed);
  // Rooms opens on Messages (your DMs); after that, Spaces is a tap away.
  const launching = useRef(!roomId && !onDmPath);
  useEffect(() => {
    launching.current = false;
  }, []);
  const { data: b, isLoading, isError, refetch } = useQuery({
    queryKey: BOOTSTRAP_KEY,
    queryFn: roomsApi.bootstrap,
    staleTime: 30_000,
  });
  const railSel = useRoomsStore((s) => s.railSel);
  const setRailSel = useRoomsStore((s) => s.setRailSel);
  const vv = useVisualViewport(isPhone);

  const [createSpace, setCreateSpace] = useState(false);
  const [newDm, setNewDm] = useState(false);
  const [spaceSettings, setSpaceSettings] = useState<string | null>(null);
  const [newRoomIn, setNewRoomIn] = useState<string | null>(null);
  const [newRoomKind, setNewRoomKind] = useState<"text" | "voice">("text");
  const [globalSearch, setGlobalSearch] = useState(false);
  const [newCall, setNewCall] = useState(false);

  useRoomsEvents(roomId);
  // Calls: who's in each voice channel, live, and the bootstrap's view of it.
  useVoiceLive();
  useEffect(() => seedFromBootstrap(b), [b]);

  // Rooms does its own touch sizing.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.itemApp = "";
    return () => {
      delete root.dataset.itemApp;
    };
  }, []);

  // Typing indicators expire.
  useEffect(() => {
    const t = window.setInterval(() => useRoomsStore.getState().sweepTyping(), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Unread → document title + app badge.
  const t = useMemo(() => totals(b), [b]);
  useEffect(() => {
    const before = document.title;
    return () => {
      document.title = before;
      const nav = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
      void nav.clearAppBadge?.().catch(() => undefined);
    };
  }, []);
  useEffect(() => {
    document.title = t.total > 0 ? `(${t.total > 99 ? "99+" : t.total}) Rooms` : "Rooms";
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    try {
      if (t.total > 0) void nav.setAppBadge?.(t.total).catch(() => undefined);
      else void nav.clearAppBadge?.().catch(() => undefined);
    } catch {
      /* not supported */
    }
  }, [t.total]);

  // Presence: the room you're looking at (no pushes for it).
  useEffect(() => {
    const send = () => {
      const visible = document.visibilityState === "visible" && document.hasFocus();
      void roomsApi.presence(visible ? roomId : null).catch(() => undefined);
    };
    send();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") send();
    }, 30_000);
    window.addEventListener("focus", send);
    window.addEventListener("blur", send);
    document.addEventListener("visibilitychange", send);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", send);
      window.removeEventListener("blur", send);
      document.removeEventListener("visibilitychange", send);
      void roomsApi.presence(null).catch(() => undefined);
    };
  }, [roomId]);

  // The open room decides which space the rail shows; remember it.
  const open = findRoom(b, roomId);
  const openSpaceId = open ? (open.space?.id ?? "dms") : null;
  useEffect(() => {
    if (!roomId || !openSpaceId) return;
    setRailSel(openSpaceId);
    writeLS(LAST_ROOM_KEY, roomId);
    if (openSpaceId !== "dms") writeLS(LAST_IN_SPACE_KEY, { ...readLS<Record<string, string>>(LAST_IN_SPACE_KEY, {}), [openSpaceId]: roomId });
  }, [roomId, openSpaceId, setRailSel]);
  useEffect(() => {
    if (onDmPath) setRailSel("dms");
  }, [onDmPath, setRailSel]);

  const callsOn = b?.voice_available === true;
  const sel: string | null = useMemo(() => {
    if (!b) return null;
    if (onCallsPath && b.voice_available === true) return "calls";
    if (railSel === "dms") return "dms";
    if (railSel && b.spaces.some((s) => s.id === railSel)) return railSel;
    return b.spaces[0]?.id ?? "dms";
  }, [b, railSel, onCallsPath]);
  const selSpace = b?.spaces.find((s) => s.id === sel) ?? null;

  const openSpace = useCallback(
    (s: Space) => {
      setRailSel(s.id);
      if (isPhone) return;
      const last = readLS<Record<string, string>>(LAST_IN_SPACE_KEY, {})[s.id];
      const target = s.rooms.find((r) => r.id === last) ?? s.rooms[0];
      if (target) navigate(`/rooms/r/${target.id}`);
    },
    [isPhone, navigate, setRailSel],
  );

  // Desktop, nothing open: Messages opens your latest conversation; a
  // space reopens the room you were last in.
  useEffect(() => {
    if (!b || isPhone || roomId || onCallsPath) return;
    if (onDmPath) {
      const latest = [...b.dms].sort((x, y) => (y.last_message_at ?? "").localeCompare(x.last_message_at ?? ""))[0];
      if (latest) navigate(`/rooms/r/${latest.id}`, { replace: true });
      return;
    }
    const last = readLS<string | null>(LAST_ROOM_KEY, null);
    const target = (last && findRoom(b, last)?.room) || b.spaces[0]?.rooms[0];
    if (target) navigate(`/rooms/r/${target.id}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b ? 1 : 0, isPhone, roomId, onDmPath, onCallsPath]);

  // Alt+↑ / Alt+↓: previous / next room in the list (desktop).
  useEffect(() => {
    if (isPhone || !b || sel === "calls") return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      const list =
        sel === "dms"
          ? [...b.dms].sort((x, y) => (y.last_message_at ?? "").localeCompare(x.last_message_at ?? ""))
          : (b.spaces.find((s) => s.id === sel)?.rooms ?? []);
      if (!list.length) return;
      e.preventDefault();
      const at = list.findIndex((r) => r.id === roomId);
      const next = e.key === "ArrowUp" ? (at <= 0 ? list.length - 1 : at - 1) : (at + 1) % list.length;
      navigate(`/rooms/r/${list[next].id}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPhone, b, sel, roomId, navigate]);

  if (launching.current && (location.pathname === "/rooms" || location.pathname === "/rooms/")) {
    return <Navigate replace to={{ pathname: "/rooms/dm", search: location.search, hash: location.hash }} />;
  }
  if (location.pathname === "/rooms") {
    return <Navigate replace to={{ pathname: "/rooms/", search: location.search, hash: location.hash }} />;
  }
  // Calls are off for you: no Calls tab.
  if (onCallsPath && b && !callsOn) return <Navigate replace to="/rooms/dm" />;

  const rootStyle: CSSProperties = vv ? { position: "fixed", left: 0, right: 0, top: vv.top, height: vv.h } : {};

  let body: ReactNode;
  if (!b) {
    body = isLoading ? (
      <RoomsSkeleton isPhone={isPhone} />
    ) : (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-[var(--text-muted)]">
        {isError ? (
          <>
            Couldn't reach Rooms.
            <ItemButton variant="secondary" onClick={() => void refetch()}>
              Try again
            </ItemButton>
          </>
        ) : null}
      </div>
    );
  } else if (isPhone) {
    const pill = <VoicePill hideFor={roomId} />;
    body = callKey ? (
      <CallDetail key={callKey} b={b} callKey={callKey} isPhone onBack={() => navigate("/rooms/calls")} />
    ) : roomId ? (
      <RoomView
        key={roomId}
        roomId={roomId}
        b={b}
        isPhone
        onBack={() => navigate(open && !open.space ? "/rooms/dm" : "/rooms/")}
        pill={pill}
      />
    ) : (
      <PhoneHome
        pill={pill}
        b={b}
        tab={onCallsPath ? "calls" : onDmPath ? "dms" : "spaces"}
        missedCalls={missedCalls}
        onNewCall={() => setNewCall(true)}
        selSpace={sel === "dms" ? (b.spaces[0] ?? null) : selSpace}
        totals={t}
        onSelectSpace={(s) => setRailSel(s.id)}
        onCreateSpace={() => setCreateSpace(true)}
        onNewDm={() => setNewDm(true)}
        onSpaceSettings={(id) => setSpaceSettings(id)}
        onNewRoom={(id, kind = "text") => {
          setNewRoomKind(kind);
          setNewRoomIn(id);
        }}
        onSearch={() => setGlobalSearch(true)}
      />
    );
  } else {
    body = (
      <div className="flex min-h-0 flex-1">
        <Rail
          b={b}
          sel={sel}
          totals={t}
          missedCalls={missedCalls}
          onCalls={() => navigate("/rooms/calls")}
          onMessages={() => {
            setRailSel("dms");
            const lastDm = [...b.dms].sort((x, y) => (y.last_message_at ?? "").localeCompare(x.last_message_at ?? ""))[0];
            navigate(lastDm ? `/rooms/r/${lastDm.id}` : "/rooms/dm");
          }}
          onSpace={openSpace}
          onCreateSpace={() => setCreateSpace(true)}
          onSearch={() => setGlobalSearch(true)}
        />
        <div className="flex w-60 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] lg:w-64">
          {sel === "calls" ? (
            <CallsList b={b} activeKey={callKey} isPhone={false} onNewCall={() => setNewCall(true)} />
          ) : sel === "dms" || !selSpace ? (
            <DmList b={b} activeRoomId={roomId} onNew={() => setNewDm(true)} isPhone={false} />
          ) : (
            <SpaceRoomList
              b={b}
              space={selSpace}
              activeRoomId={roomId}
              onSettings={() => setSpaceSettings(selSpace.id)}
              onNewRoom={() => {
                setNewRoomKind("text");
                setNewRoomIn(selSpace.id);
              }}
              onNewVoice={() => {
                setNewRoomKind("voice");
                setNewRoomIn(selSpace.id);
              }}
              isPhone={false}
            />
          )}
          <VoicePanel variant="rooms" />
          <SideFooter />
        </div>
        <main id={embedded ? undefined : "main"} data-toast-anchor className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg)]">
          {sel === "calls" ? (
            callKey ? (
              <CallDetail key={callKey} b={b} callKey={callKey} isPhone={false} />
            ) : (
              <CallsHome onNewCall={() => setNewCall(true)} />
            )
          ) : roomId ? (
            <RoomView key={roomId} roomId={roomId} b={b} isPhone={false} />
          ) : (
            <DesktopEmpty b={b} onCreateSpace={() => setCreateSpace(true)} onNewDm={() => setNewDm(true)} dms={sel === "dms"} />
          )}
        </main>
      </div>
    );
  }

  const settingsSpace = b?.spaces.find((s) => s.id === spaceSettings) ?? null;
  const newRoomSpace = b?.spaces.find((s) => s.id === newRoomIn) ?? null;

  return (
    <PromptlyNavContext.Provider value={promptlyNav}>
    <div
      style={embedded ? undefined : rootStyle}
      className={cn(
        "flex flex-col overflow-hidden bg-[var(--bg)] text-[var(--text)]",
        embedded ? "h-full min-h-0" : "pl-safe pr-safe pt-safe",
        !embedded && !vv && "h-[100dvh]",
      )}
    >
      {body}
      <ConfirmSheetHost />
      <CreateSpaceSheet open={createSpace} onClose={() => setCreateSpace(false)} />
      {b && <NewDmSheet open={newDm} onClose={() => setNewDm(false)} b={b} />}
      {b && callsOn && <NewCallSheet open={newCall} onClose={() => setNewCall(false)} b={b} />}
      {b && settingsSpace && (
        <SpaceSettingsSheet open={!!settingsSpace} onClose={() => setSpaceSettings(null)} space={settingsSpace} b={b} />
      )}
      {newRoomSpace && (
        <CreateRoomSheet
          open={!!newRoomSpace}
          onClose={() => setNewRoomIn(null)}
          space={newRoomSpace}
          kind={newRoomKind}
          voiceAvailable={b?.voice_available === true}
        />
      )}
      {b && (
        <Sheet open={globalSearch} onClose={() => setGlobalSearch(false)} title="Search Rooms" size="lg">
          <div className="-mx-5 h-[65dvh]">
            <SearchPanel
              b={b}
              roomId={null}
              onJump={(rid, seq) => {
                useRoomsStore.getState().requestJump(rid, seq);
                setGlobalSearch(false);
                navigate(`/rooms/r/${rid}`);
              }}
            />
          </div>
        </Sheet>
      )}
      {!embedded && (
        <>
          <InstallFromLink
            appName="Promptly Rooms"
            iconSrc="/item-icons/rooms-192.png"
            description="Chat with your family and friends — spaces, rooms and messages as their own app."
          />
          <NetworkStatusToast />
        </>
      )}
    </div>
    </PromptlyNavContext.Provider>
  );
}

// ---------------------------------------------------------------------

function RailButton({
  label,
  active,
  onClick,
  children,
  badge,
  dot,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  badge?: number;
  dot?: boolean;
}) {
  return (
    <div className="relative flex w-full justify-center">
      <span
        aria-hidden
        className={cn(
          "absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-[var(--text)] transition-all",
          active ? "h-9" : dot ? "h-2" : "h-0",
        )}
      />
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-current={active ? "page" : undefined}
        onClick={onClick}
        className={cn(
          "relative flex h-12 w-12 items-center justify-center rounded-2xl transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-2)]",
          active ? "ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--surface-2)]" : "hover:brightness-95",
        )}
      >
        {children}
        {!!badge && <CountBadge n={badge} className="absolute -bottom-1 -right-1 ring-2 ring-[var(--surface-2)]" />}
      </button>
    </div>
  );
}

function Rail({
  b,
  sel,
  totals: t,
  missedCalls,
  onCalls,
  onMessages,
  onSpace,
  onCreateSpace,
  onSearch,
}: {
  b: Bootstrap;
  sel: string | null;
  totals: ReturnType<typeof totals>;
  missedCalls: number;
  onCalls: () => void;
  onMessages: () => void;
  onSpace: (s: Space) => void;
  onCreateSpace: () => void;
  onSearch: () => void;
}) {
  const promptlyNav = useContext(PromptlyNavContext);
  const plainBtn =
    "flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--surface)] text-[var(--text-muted)] transition hover:bg-[var(--accent)] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]";
  return (
    <nav className="flex w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto bg-[var(--surface-2)] py-3" aria-label="Spaces">
      <RailButton label="Messages" active={sel === "dms"} onClick={onMessages} badge={t.dmUnread}>
        <span
          className={cn(
            "flex h-12 w-12 items-center justify-center rounded-2xl",
            sel === "dms" ? "bg-[var(--accent)] text-white" : "bg-[var(--surface)] text-[var(--text)]",
          )}
        >
          <MessagesSquare className="h-6 w-6" />
        </span>
      </RailButton>
      {b.voice_available === true && (
        <RailButton label={missedCalls > 0 ? `Calls, ${missedCalls} missed` : "Calls"} active={sel === "calls"} onClick={onCalls} badge={missedCalls}>
          <span
            className={cn(
              "flex h-12 w-12 items-center justify-center rounded-2xl",
              sel === "calls" ? "bg-[var(--accent)] text-white" : "bg-[var(--surface)] text-[var(--text)]",
            )}
          >
            <Phone className="h-6 w-6" />
          </span>
        </RailButton>
      )}
      <span className="h-px w-8 bg-[var(--border)]" />
      {b.spaces.map((s) => {
        const st = t.spaces[s.id];
        return (
          <RailButton key={s.id} label={s.name} active={sel === s.id} onClick={() => onSpace(s)} badge={st?.mentions} dot={st?.unread}>
            <SpaceIcon space={s} size={48} />
          </RailButton>
        );
      })}
      <button type="button" aria-label="Create a space" title="Create a space" onClick={onCreateSpace} className={plainBtn}>
        <Plus className="h-6 w-6" />
      </button>
      <div className="mt-auto flex flex-col items-center gap-2 pt-2">
        <button type="button" aria-label="Search all rooms" title="Search all rooms" onClick={onSearch} className={plainBtn}>
          <Search className="h-5 w-5" />
        </button>
        {promptlyNav && <PromptlyMenuButton className="h-11 w-11 rounded-xl" />}
      </div>
    </nav>
  );
}

/** Notifications / install hints under the room list. */
function SideFooter() {
  const push = usePushSubscription();
  const install = useInstallPrompt();
  const [dismissed, setDismissed] = useState(() => readLS<boolean>(PUSH_HINT_KEY, false));
  const showPush =
    !dismissed && !push.loading && push.supported && push.serverConfigured === true && !push.subscribed && push.permission !== "denied";
  const showInstall = install.canPrompt && !install.standalone;
  if (!showPush && !showInstall) return null;
  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-[var(--border)] p-2">
      {showPush && (
        <div className="relative rounded-xl bg-[var(--surface-2)] p-3 pr-8 text-xs text-[var(--text-muted)]">
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              setDismissed(true);
              writeLS(PUSH_HINT_KEY, true);
            }}
            className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-lg hover:bg-[var(--hover)]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <p className="mb-2">Get a notification when someone messages you.</p>
          <ItemButton
            size="sm"
            variant="primary"
            icon={<Bell className="h-3.5 w-3.5" />}
            onClick={() =>
              void push.subscribe().then(
                () => undefined,
                () => toast.error("Couldn't turn on notifications."),
              )
            }
          >
            Turn on notifications
          </ItemButton>
        </div>
      )}
      {showInstall && (
        <button
          type="button"
          onClick={() => void install.prompt()}
          className="flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-medium text-[var(--text)] hover:bg-[var(--hover)]"
        >
          <Download className="h-4 w-4 text-[var(--accent-text)]" /> Install Rooms
        </button>
      )}
    </div>
  );
}

/** The app mark: the one place Rooms keeps its own colour. */
function RoomsMark({ size = 28 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center text-white"
      style={{ width: size, height: size, borderRadius: size * 0.3, background: ROOMS_ACCENT }}
    >
      <MessagesSquare style={{ width: size * 0.58, height: size * 0.58 }} />
    </span>
  );
}

/** The shape of Rooms while it loads: spaces, a room list, a conversation. */
function RoomsSkeleton({ isPhone }: { isPhone: boolean }) {
  const rows = ["w-32", "w-24", "w-36", "w-28", "w-20", "w-32"];
  const list = (
    <div className="flex flex-col gap-1 p-3">
      <Skeleton className="mb-2 h-4 w-20" />
      {rows.map((w, i) => (
        <div key={i} className="flex h-11 items-center gap-2.5 px-1 md:h-9">
          <Skeleton className="h-4 w-4 shrink-0" />
          <Skeleton className={cn("h-4", w)} />
        </div>
      ))}
    </div>
  );
  if (isPhone) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" role="status" aria-label="Loading Rooms">
        <div className="flex h-14 shrink-0 items-center gap-2 px-4">
          <RoomsMark />
          <Skeleton className="h-5 w-24" />
        </div>
        <div className="flex shrink-0 gap-3 px-3 pb-2 pt-1">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[52px] w-[52px] shrink-0 !rounded-[16px]" />
          ))}
        </div>
        {list}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1" role="status" aria-label="Loading Rooms">
      <div className="flex w-[72px] shrink-0 flex-col items-center gap-2 bg-[var(--surface-2)] py-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-12 w-12 !rounded-2xl" />
        ))}
      </div>
      <div className="w-60 shrink-0 border-r border-[var(--border)] bg-[var(--surface)] lg:w-64">
        <div className="flex h-14 items-center border-b border-[var(--border)] px-4">
          <Skeleton className="h-4 w-28" />
        </div>
        {list}
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-end gap-4 bg-[var(--bg)] p-6">
        {["w-64", "w-40", "w-52"].map((w, i) => (
          <div key={i} className="mx-auto flex w-full max-w-[760px] gap-3">
            <Skeleton className="h-9 w-9 shrink-0 !rounded-full" />
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className={cn("h-8 !rounded-2xl", w)} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DesktopEmpty({ b, onCreateSpace, onNewDm, dms }: { b: Bootstrap; onCreateSpace: () => void; onNewDm: () => void; dms: boolean }) {
  // Brand new: one invitation, one button. (The list column stays quiet.)
  const brandNew = b.spaces.length === 0 && b.dms.length === 0;
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      {brandNew || (!dms && b.spaces.length === 0) ? (
        <EmptyState
          icon={Plus}
          title="Create a space for your family or friends"
          text="A space holds a few rooms, like #general, #holidays and #photos, for the people you add. Mention @promptly in any message to ask Promptly."
          action={
            <ItemButton variant="primary" onClick={onCreateSpace} icon={<Plus className="h-4 w-4" />}>
              Create a space
            </ItemButton>
          }
          className="max-w-md"
        />
      ) : dms && b.dms.length === 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title="Start a conversation"
          text="Message one person or a small group. Only the people in it can read it."
          action={
            <ItemButton variant="primary" onClick={onNewDm} icon={<MessageSquarePlus className="h-4 w-4" />}>
              New message
            </ItemButton>
          }
          className="max-w-md"
        />
      ) : (
        <EmptyState
          icon={MessagesSquare}
          title={dms ? "Pick a conversation" : "Pick a room"}
          text={dms ? "Choose a conversation on the left to carry on." : "Choose a room on the left to start chatting."}
          className="max-w-md"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------

function PhoneHome({
  pill,
  b,
  tab,
  selSpace,
  totals: t,
  missedCalls,
  onNewCall,
  onSelectSpace,
  onCreateSpace,
  onNewDm,
  onSpaceSettings,
  onNewRoom,
  onSearch,
}: {
  b: Bootstrap;
  tab: "spaces" | "dms" | "calls";
  selSpace: Space | null;
  totals: ReturnType<typeof totals>;
  missedCalls: number;
  onNewCall: () => void;
  onSelectSpace: (s: Space) => void;
  onCreateSpace: () => void;
  onNewDm: () => void;
  onSpaceSettings: (id: string) => void;
  onNewRoom: (id: string, kind?: "text" | "voice") => void;
  onSearch: () => void;
  pill?: ReactNode;
}) {
  const promptlyNav = useContext(PromptlyNavContext);
  const navigate = useNavigate();
  const spaceMentions = Object.values(t.spaces).reduce((n, s) => n + s.mentions, 0);
  const iconBtn = "flex h-11 w-11 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {pill}
      <header className="flex h-14 shrink-0 items-center gap-1 px-2">
        {promptlyNav && <PromptlyMenuButton className="h-11 w-11 rounded-xl" />}
        <h1 className="flex flex-1 items-center gap-2 px-2 text-lg font-bold text-[var(--text)]">
          <RoomsMark />
          Rooms
        </h1>
        <button type="button" aria-label="Search all rooms" onClick={onSearch} className={iconBtn}>
          <Search className="h-5 w-5" />
        </button>
        <button
          type="button"
          aria-label={tab === "calls" ? "New call" : tab === "dms" ? "New message" : "Create a space"}
          onClick={tab === "calls" ? onNewCall : tab === "dms" ? onNewDm : onCreateSpace}
          className={iconBtn}
        >
          {tab === "calls" ? <PhoneCall className="h-5 w-5" /> : tab === "dms" ? <MessageSquarePlus className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
        </button>
      </header>
      <div className="shrink-0 px-3 pb-2">
        <Segmented
          className="w-full"
          value={tab}
          onChange={(v) => navigate(v === "calls" ? "/rooms/calls" : v === "dms" ? "/rooms/dm" : "/rooms/", { replace: true })}
          options={[
            {
              value: "spaces",
              label: (
                <span className="inline-flex items-center gap-1.5">
                  Spaces <CountBadge n={spaceMentions} />
                </span>
              ),
            },
            {
              value: "dms",
              label: (
                <span className="inline-flex items-center gap-1.5">
                  Messages <CountBadge n={t.dmUnread} />
                </span>
              ),
            },
            ...(b.voice_available === true
              ? [
                  {
                    value: "calls" as const,
                    label: (
                      <span className="inline-flex items-center gap-1.5">
                        Calls <CountBadge n={missedCalls} />
                        {missedCalls > 0 && <span className="sr-only">missed</span>}
                      </span>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </div>

      {tab === "calls" ? (
        <CallsList b={b} activeKey={null} isPhone onNewCall={onNewCall} />
      ) : tab === "dms" ? (
        <DmList b={b} activeRoomId={null} onNew={onNewDm} isPhone />
      ) : b.spaces.length === 0 || !selSpace ? (
        <div className="p-4">
          <EmptyState
            icon={Plus}
            title="Create a space for your family or friends"
            text="A space holds rooms like #general and #holidays for the people you add. Ask Promptly anything with @promptly."
            action={
              <ItemButton variant="primary" onClick={onCreateSpace} icon={<Plus className="h-4 w-4" />}>
                Create a space
              </ItemButton>
            }
          />
        </div>
      ) : (
        <>
          <div className="flex shrink-0 gap-3 overflow-x-auto px-3 pb-2 pt-1" role="tablist" aria-label="Spaces">
            {b.spaces.map((s) => {
              const st = t.spaces[s.id];
              const active = s.id === selSpace.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => onSelectSpace(s)}
                  className="flex w-16 shrink-0 flex-col items-center gap-1"
                >
                  <span className={cn("relative rounded-[16px]", active && "ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--bg)]")}>
                    <SpaceIcon space={s} size={52} />
                    {st?.mentions ? (
                      <CountBadge n={st.mentions} className="absolute -right-1 -top-1 ring-2 ring-[var(--bg)]" />
                    ) : st?.unread ? (
                      <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full bg-[var(--text)] ring-2 ring-[var(--bg)]" aria-label="Unread" />
                    ) : null}
                  </span>
                  <span className={cn("w-full truncate text-center text-xs", active ? "font-semibold text-[var(--text)]" : "text-[var(--text-muted)]")}>
                    {s.name}
                  </span>
                </button>
              );
            })}
            <button type="button" onClick={onCreateSpace} className="flex w-16 shrink-0 flex-col items-center gap-1" aria-label="Create a space">
              <span className="flex h-[52px] w-[52px] items-center justify-center rounded-[16px] border-2 border-dashed border-[var(--border)] text-[var(--text-muted)]">
                <Plus className="h-6 w-6" />
              </span>
              <span className="text-xs text-[var(--text-muted)]">New</span>
            </button>
          </div>
          <div className="flex shrink-0 items-center gap-1 border-y border-[var(--border)] px-3 py-1">
            <span className="min-w-0 flex-1 truncate font-semibold text-[var(--text)]">{selSpace.name}</span>
            <button type="button" aria-label={`${selSpace.name} settings`} onClick={() => onSpaceSettings(selSpace.id)} className={iconBtn}>
              <Settings className="h-5 w-5" />
            </button>
          </div>
          <SpaceRoomList
            b={b}
            space={selSpace}
            activeRoomId={null}
            onSettings={() => onSpaceSettings(selSpace.id)}
            onNewRoom={() => onNewRoom(selSpace.id)}
            onNewVoice={() => onNewRoom(selSpace.id, "voice")}
            isPhone
          />
        </>
      )}
      <div className="pb-safe">
        <SideFooter />
      </div>
    </div>
  );
}
