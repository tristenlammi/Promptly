import { useQuery } from "@tanstack/react-query";
import { Bell, Download, Home, Loader2, MessageSquarePlus, MessagesSquare, Plus, Search, Settings, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, Navigate, useLocation, useMatch, useNavigate } from "react-router-dom";

import { roomsApi, type Bootstrap, type Space } from "@/api/rooms";
import { NetworkStatusToast } from "@/components/layout/NetworkStatusToast";
import { InstallFromLink } from "@/components/pwa/InstallFromLink";
import { usePushSubscription } from "@/hooks/usePushSubscription";
import { useIsMobile } from "@/hooks/useIsMobile";
import { EmptyState, ItemButton, Segmented, Sheet } from "@/items/ui";
import "@/items/ui/items.css";
import { useInstallPrompt } from "@/lib/installPrompt";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

import { BOOTSTRAP_KEY, findRoom, totals } from "./cache";
import { useRoomsEvents } from "./live";
import { useRoomsStore } from "./store";
import { DmList, SpaceRoomList } from "./components/Lists";
import { SearchPanel } from "./components/Panels";
import { CreateRoomSheet, NewDmSheet } from "./components/RoomSheets";
import { RoomView } from "./components/RoomView";
import { CreateSpaceSheet, SpaceSettingsSheet } from "./components/SpaceSheets";
import { CountBadge, SpaceIcon } from "./components/ui";
import { useRecordOpen } from "@/hooks/useRecordOpen";

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

/** Rooms inside Promptly's own layout (desktop browser): Promptly's
 *  sidebar is right there, so no "Back to Promptly" buttons of our own. */
const EmbeddedContext = createContext(false);

function isStandalone() {
  return typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)").matches;
}

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
 * ``/rooms/*`` — Promptly Rooms as its own app (own manifest, scope
 * ``/rooms/``): spaces of text rooms + direct messages. No Promptly chrome.
 */
export function RoomsApp({ embedded = false }: { embedded?: boolean } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const isPhone = useIsMobile(767);
  const roomMatch = useMatch("/rooms/r/:roomId");
  const roomId = roomMatch?.params.roomId ?? null;
  useRecordOpen("room", roomId);
  const onDmPath = location.pathname.startsWith("/rooms/dm");
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
  const [globalSearch, setGlobalSearch] = useState(false);

  useRoomsEvents(roomId);

  // Accent for the whole page (sheets render in a portal) + own touch sizing.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--item-accent", ROOMS_ACCENT);
    root.dataset.itemApp = "";
    return () => {
      root.style.removeProperty("--item-accent");
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

  const sel: string | null = useMemo(() => {
    if (!b) return null;
    if (railSel === "dms") return "dms";
    if (railSel && b.spaces.some((s) => s.id === railSel)) return railSel;
    return b.spaces[0]?.id ?? "dms";
  }, [b, railSel]);
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
    if (!b || isPhone || roomId) return;
    if (onDmPath) {
      const latest = [...b.dms].sort((x, y) => (y.last_message_at ?? "").localeCompare(x.last_message_at ?? ""))[0];
      if (latest) navigate(`/rooms/r/${latest.id}`, { replace: true });
      return;
    }
    const last = readLS<string | null>(LAST_ROOM_KEY, null);
    const target = (last && findRoom(b, last)?.room) || b.spaces[0]?.rooms[0];
    if (target) navigate(`/rooms/r/${target.id}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b ? 1 : 0, isPhone, roomId, onDmPath]);

  // Alt+↑ / Alt+↓: previous / next room in the list (desktop).
  useEffect(() => {
    if (isPhone || !b) return;
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

  const rootStyle: CSSProperties = {
    "--item-accent": ROOMS_ACCENT,
    ...(vv ? { position: "fixed", left: 0, right: 0, top: vv.top, height: vv.h } : {}),
  } as CSSProperties;

  let body: ReactNode;
  if (!b) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-[var(--text-muted)]">
        {isLoading ? (
          <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading Rooms" />
        ) : isError ? (
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
    body = roomId ? (
      <RoomView
        key={roomId}
        roomId={roomId}
        b={b}
        isPhone
        onBack={() => navigate(open && !open.space ? "/rooms/dm" : "/rooms/")}
      />
    ) : (
      <PhoneHome
        b={b}
        tab={onDmPath ? "dms" : "spaces"}
        selSpace={sel === "dms" ? (b.spaces[0] ?? null) : selSpace}
        totals={t}
        onSelectSpace={(s) => setRailSel(s.id)}
        onCreateSpace={() => setCreateSpace(true)}
        onNewDm={() => setNewDm(true)}
        onSpaceSettings={(id) => setSpaceSettings(id)}
        onNewRoom={(id) => setNewRoomIn(id)}
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
          {sel === "dms" || !selSpace ? (
            <DmList b={b} activeRoomId={roomId} onNew={() => setNewDm(true)} isPhone={false} />
          ) : (
            <SpaceRoomList
              b={b}
              space={selSpace}
              activeRoomId={roomId}
              onSettings={() => setSpaceSettings(selSpace.id)}
              onNewRoom={() => setNewRoomIn(selSpace.id)}
              isPhone={false}
            />
          )}
          <SideFooter />
        </div>
        <main id={embedded ? undefined : "main"} className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg)]">
          {roomId ? (
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
    <EmbeddedContext.Provider value={embedded}>
    <div
      style={embedded ? undefined : rootStyle}
      className={cn(
        "flex flex-col overflow-hidden bg-[var(--bg)] text-[var(--text)]",
        embedded ? "h-full min-h-0" : "pl-safe pr-safe pt-safe",
        !embedded && !vv && "h-[100dvh]",
      )}
    >
      {body}
      <CreateSpaceSheet open={createSpace} onClose={() => setCreateSpace(false)} />
      {b && <NewDmSheet open={newDm} onClose={() => setNewDm(false)} b={b} />}
      {b && settingsSpace && (
        <SpaceSettingsSheet open={!!settingsSpace} onClose={() => setSpaceSettings(null)} space={settingsSpace} b={b} />
      )}
      {newRoomSpace && <CreateRoomSheet open={!!newRoomSpace} onClose={() => setNewRoomIn(null)} space={newRoomSpace} />}
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
    </EmbeddedContext.Provider>
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
          "relative flex h-12 w-12 items-center justify-center rounded-2xl transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-2)]",
          active ? "ring-2 ring-[var(--item-accent)] ring-offset-2 ring-offset-[var(--surface-2)]" : "hover:brightness-95",
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
  onMessages,
  onSpace,
  onCreateSpace,
  onSearch,
}: {
  b: Bootstrap;
  sel: string | null;
  totals: ReturnType<typeof totals>;
  onMessages: () => void;
  onSpace: (s: Space) => void;
  onCreateSpace: () => void;
  onSearch: () => void;
}) {
  const embedded = useContext(EmbeddedContext);
  const plainBtn =
    "flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--surface)] text-[var(--text-muted)] transition hover:bg-[var(--item-accent)] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]";
  return (
    <nav className="flex w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto bg-[var(--surface-2)] py-3" aria-label="Spaces">
      <RailButton label="Messages" active={sel === "dms"} onClick={onMessages} badge={t.dmUnread}>
        <span
          className={cn(
            "flex h-12 w-12 items-center justify-center rounded-2xl",
            sel === "dms" ? "bg-[var(--item-accent)] text-white" : "bg-[var(--surface)] text-[var(--text)]",
          )}
        >
          <MessagesSquare className="h-6 w-6" />
        </span>
      </RailButton>
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
        {!isStandalone() && !embedded && (
          <Link to="/" aria-label="Back to Promptly" title="Back to Promptly" className={plainBtn}>
            <Home className="h-5 w-5" />
          </Link>
        )}
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
          <Download className="h-4 w-4 text-[var(--item-accent)]" /> Install Rooms
        </button>
      )}
    </div>
  );
}

function DesktopEmpty({ b, onCreateSpace, onNewDm, dms }: { b: Bootstrap; onCreateSpace: () => void; onNewDm: () => void; dms: boolean }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      {dms || b.spaces.length > 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title={dms ? "Start a conversation" : "Pick a room"}
          text={dms ? "Message one person or a small group. Only the people in it can read it." : "Choose a room on the left to start chatting."}
          action={
            dms ? (
              <ItemButton variant="primary" onClick={onNewDm} icon={<MessageSquarePlus className="h-4 w-4" />}>
                New message
              </ItemButton>
            ) : undefined
          }
          className="max-w-md"
        />
      ) : (
        <EmptyState
          icon={Plus}
          title="Create a space for your family or friends"
          text="A space holds a few rooms — #general, #holidays, #photos — for the people you add. Mention @promptly in any message to ask Promptly."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <ItemButton variant="primary" onClick={onCreateSpace} icon={<Plus className="h-4 w-4" />}>
                Create a space
              </ItemButton>
              <ItemButton variant="secondary" onClick={onNewDm} icon={<MessageSquarePlus className="h-4 w-4" />}>
                Message someone
              </ItemButton>
            </div>
          }
          className="max-w-md"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------

function PhoneHome({
  b,
  tab,
  selSpace,
  totals: t,
  onSelectSpace,
  onCreateSpace,
  onNewDm,
  onSpaceSettings,
  onNewRoom,
  onSearch,
}: {
  b: Bootstrap;
  tab: "spaces" | "dms";
  selSpace: Space | null;
  totals: ReturnType<typeof totals>;
  onSelectSpace: (s: Space) => void;
  onCreateSpace: () => void;
  onNewDm: () => void;
  onSpaceSettings: (id: string) => void;
  onNewRoom: (id: string) => void;
  onSearch: () => void;
}) {
  const embedded = useContext(EmbeddedContext);
  const navigate = useNavigate();
  const spaceMentions = Object.values(t.spaces).reduce((n, s) => n + s.mentions, 0);
  const iconBtn = "flex h-11 w-11 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-1 px-2">
        {!isStandalone() && !embedded && (
          <Link to="/" aria-label="Back to Promptly" className={iconBtn}>
            <Home className="h-5 w-5" />
          </Link>
        )}
        <h1 className="flex-1 px-2 text-lg font-bold text-[var(--text)]">Rooms</h1>
        <button type="button" aria-label="Search all rooms" onClick={onSearch} className={iconBtn}>
          <Search className="h-5 w-5" />
        </button>
        <button
          type="button"
          aria-label={tab === "dms" ? "New message" : "Create a space"}
          onClick={tab === "dms" ? onNewDm : onCreateSpace}
          className={iconBtn}
        >
          {tab === "dms" ? <MessageSquarePlus className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
        </button>
      </header>
      <div className="shrink-0 px-3 pb-2">
        <Segmented
          className="w-full"
          value={tab}
          onChange={(v) => navigate(v === "dms" ? "/rooms/dm" : "/rooms/", { replace: true })}
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
          ]}
        />
      </div>

      {tab === "dms" ? (
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
                  <span className={cn("relative rounded-[16px]", active && "ring-2 ring-[var(--item-accent)] ring-offset-2 ring-offset-[var(--bg)]")}>
                    <SpaceIcon space={s} size={52} />
                    {st?.mentions ? (
                      <CountBadge n={st.mentions} className="absolute -right-1 -top-1 ring-2 ring-[var(--bg)]" />
                    ) : st?.unread ? (
                      <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full bg-[var(--text)] ring-2 ring-[var(--bg)]" aria-label="Unread" />
                    ) : null}
                  </span>
                  <span className={cn("w-full truncate text-center text-[11px]", active ? "font-semibold text-[var(--text)]" : "text-[var(--text-muted)]")}>
                    {s.name}
                  </span>
                </button>
              );
            })}
            <button type="button" onClick={onCreateSpace} className="flex w-16 shrink-0 flex-col items-center gap-1" aria-label="Create a space">
              <span className="flex h-[52px] w-[52px] items-center justify-center rounded-[16px] border-2 border-dashed border-[var(--border)] text-[var(--text-muted)]">
                <Plus className="h-6 w-6" />
              </span>
              <span className="text-[11px] text-[var(--text-muted)]">New</span>
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
