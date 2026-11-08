/**
 * The Calls tab in Rooms (Spaces · Messages · Calls; Calls WP-D4): your
 * call history, missed calls in red and the new ones in bold, a call-back
 * button on every row, each call's details, and a "New call" picker.
 *
 *   CallsList    the list (Rooms' side column on a desktop, the tab on a phone)
 *   CallDetail   one call (and the rest with the same people)
 *   CallsHome    the desktop's main pane when no call is picked
 *   NewCallSheet call someone you can call (Contacts names too: "Mum")
 *
 * Calls ring through ``calls`` (``rtc/call/actions.ts``). Opening the tab
 * clears the missed-calls badge on every device (``POST /calls/missed/seen``);
 * the rows you hadn't seen stay bold until you leave it.
 */
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import {
  ArrowLeft,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
  Search,
  Trash2,
  Video,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  CALL_HISTORY_KEY,
  dmCallsApi,
  type CallablePerson,
  type CallHistoryEntry,
  type CallHistoryPage,
  type CallMedia,
} from "@/api/dmCalls";
import type { Bootstrap, RoomUser } from "@/api/rooms";
import { EmptyState, ItemButton, Segmented, Sheet } from "@/items/ui";
import { calls } from "@/rtc/call/actions";
import { setMissed } from "@/rtc/call/live";
import { useCallStore } from "@/rtc/call/store";
import { CALL_GREEN } from "@/rtc/call/ui/bits";
import { historyWords } from "@/rtc/call/words";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { dayLabel, shortWhen, timeOf } from "../format";
import { Popover, UserAvatar } from "./ui";

const rowFocus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--item-accent)]";
const roundBtn =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--item-accent)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] disabled:cursor-not-allowed disabled:text-[var(--text-muted)] disabled:opacity-50 md:h-9 md:w-9";

type Users = Record<string, RoomUser>;

// ------------------------------------------------------------------ data

type HistoryData = InfiniteData<CallHistoryPage, string | null>;

export function useCallHistory(enabled = true) {
  return useInfiniteQuery({
    queryKey: CALL_HISTORY_KEY,
    queryFn: ({ pageParam }) => dmCallsApi.history(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    staleTime: 15_000,
    enabled,
  });
}

function flatten(data: InfiniteData<CallHistoryPage, unknown> | undefined): { entries: CallHistoryEntry[]; users: Users } {
  const entries: CallHistoryEntry[] = [];
  const users: Users = {};
  const seen = new Set<string>();
  for (const p of data?.pages ?? []) {
    Object.assign(users, p.users);
    for (const e of p.calls) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      entries.push(e);
    }
  }
  return { entries, users };
}

/** Several calls in a row with the same people, all missed or all not,
 *  on the same day, are one row: "Ben (3)". */
interface CallGroup {
  key: string;
  entries: CallHistoryEntry[];
}

function groupCalls(entries: CallHistoryEntry[]): CallGroup[] {
  const out: CallGroup[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    const head = last?.entries[0];
    if (
      head &&
      !head.live &&
      !e.live &&
      head.room_id === e.room_id &&
      (head.outcome === "missed") === (e.outcome === "missed") &&
      dayLabel(head.started_at) === dayLabel(e.started_at)
    ) {
      last.entries.push(e);
    } else {
      out.push({ key: e.id, entries: [e] });
    }
  }
  return out;
}

/** The name of a call's other side: a person, or a group. */
export function callTitle(e: Pick<CallHistoryEntry, "group" | "name" | "who">, users: Users): string {
  if (e.group && e.name) return e.name;
  const names = e.who.map((id) => users[id]?.username ?? "Someone");
  if (names.length === 0) return "Just you";
  if (names.length === 1) return names[0];
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
}

/** Take calls out of the cached history at once (the server is told too). */
function dropFromCache(qc: ReturnType<typeof useQueryClient>, ids: Set<string>): void {
  qc.setQueryData<HistoryData>(CALL_HISTORY_KEY, (d) =>
    d ? { ...d, pages: d.pages.map((p) => ({ ...p, calls: p.calls.filter((c) => !ids.has(c.id)) })) } : d,
  );
}

async function removeCalls(qc: ReturnType<typeof useQueryClient>, ids: string[]): Promise<boolean> {
  dropFromCache(qc, new Set(ids));
  try {
    await Promise.all(ids.map((id) => dmCallsApi.hide(id)));
    toast.success(ids.length === 1 ? "Removed from your call history" : `Removed ${ids.length} calls from your call history`);
    return true;
  } catch (err) {
    toast.error(apiErrorMessage(err, "Couldn't remove it. Try again."));
    void qc.invalidateQueries({ queryKey: CALL_HISTORY_KEY });
    return false;
  }
}

/** While the Calls tab is open and in front: the badge's calls are seen. */
function useSeeMissed(active: boolean) {
  const missed = useCallStore((s) => s.missed);
  useEffect(() => {
    if (!active) return;
    let busy = false;
    const see = () => {
      if (busy || document.visibilityState !== "visible" || useCallStore.getState().missed <= 0) return;
      busy = true;
      dmCallsApi
        .seen()
        .then(setMissed, () => undefined)
        .finally(() => {
          busy = false;
        });
    };
    see();
    document.addEventListener("visibilitychange", see);
    window.addEventListener("focus", see);
    return () => {
      document.removeEventListener("visibilitychange", see);
      window.removeEventListener("focus", see);
    };
  }, [active, missed]);
}

/** Start a call to a conversation from the history (rings it, or joins its live call). */
function callBack(e: CallHistoryEntry, media: CallMedia): void {
  void calls.start(e.room_id, media);
}

// ------------------------------------------------------------------ bits

function CallAvatar({ e, users, size }: { e: Pick<CallHistoryEntry, "who">; users: Users; size: number }) {
  if (e.who.length <= 1) return <UserAvatar user={users[e.who[0]]} size={size} />;
  const small = Math.round(size * 0.7);
  return (
    <span className="relative shrink-0" style={{ width: size, height: size }} aria-hidden>
      <UserAvatar user={users[e.who[0]]} size={small} className="absolute left-0 top-0 ring-2 ring-[var(--bg)]" />
      <UserAvatar user={users[e.who[1]]} size={small} className="absolute bottom-0 right-0 ring-2 ring-[var(--bg)]" />
    </span>
  );
}

function DirectionIcon({ e, className }: { e: CallHistoryEntry; className?: string }) {
  const Icon =
    e.outcome === "missed"
      ? PhoneMissed
      : e.outcome === "live"
        ? PhoneCall
        : e.outcome === "cancelled"
          ? PhoneOff
          : e.direction === "outgoing"
            ? PhoneOutgoing
            : PhoneIncoming;
  return <Icon className={cn("h-3.5 w-3.5 shrink-0", className)} aria-hidden />;
}

function CallBackButton({ e, title, media }: { e: CallHistoryEntry; title: string; media?: CallMedia }) {
  const m = media ?? e.media;
  const Icon = m === "video" ? Video : Phone;
  const label = e.can_call ? `${m === "video" ? "Video call" : "Call"} ${title}` : `You can't call ${title} from here`;
  return (
    <button
      type="button"
      className={roundBtn}
      aria-label={label}
      title={label}
      disabled={!e.can_call}
      onClick={() => callBack(e, m)}
      data-testid="calls-call-back"
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}

// ------------------------------------------------------------------ the list

export function CallsList({
  b,
  activeKey,
  isPhone,
  onNewCall,
}: {
  b: Bootstrap;
  /** The row whose details are open (desktop). */
  activeKey: string | null;
  isPhone: boolean;
  onNewCall: () => void;
}) {
  const qc = useQueryClient();
  const q = useCallHistory();
  const [filter, setFilter] = useState<"all" | "missed">("all");
  const [menu, setMenu] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  useSeeMissed(true);

  const { entries, users } = useMemo(() => flatten(q.data), [q.data]);
  const allUsers = useMemo(() => ({ ...users, ...b.users }), [users, b.users]);
  const groups = useMemo(() => groupCalls(filter === "missed" ? entries.filter((e) => e.outcome === "missed") : entries), [entries, filter]);

  // More pages as you reach the bottom.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !q.hasNextPage) return;
    const io = new IntersectionObserver((xs) => {
      if (xs.some((x) => x.isIntersecting) && !q.isFetchingNextPage) void q.fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [q, q.hasNextPage, q.isFetchingNextPage]);

  const clearAll = async () => {
    setMenu(false);
    if (!window.confirm("Clear your call history? This removes every call from your list. Nobody else's list changes.")) return;
    qc.setQueryData<HistoryData>(CALL_HISTORY_KEY, (d) => (d ? { ...d, pages: d.pages.map((p) => ({ ...p, calls: p.calls.filter((c) => c.live) })) } : d));
    try {
      await dmCallsApi.clearHistory();
      toast.success("Call history cleared");
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't clear it. Try again."));
    }
    void qc.invalidateQueries({ queryKey: CALL_HISTORY_KEY });
  };

  let body: ReactNode;
  if (q.isLoading) {
    body = (
      <div className="flex justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--text-muted)]" aria-label="Loading your calls" />
      </div>
    );
  } else if (q.isError) {
    body = (
      <div className="flex flex-col items-center gap-3 p-6 text-center text-sm text-[var(--text-muted)]">
        Couldn't load your calls.
        <ItemButton variant="secondary" onClick={() => void q.refetch()}>
          Try again
        </ItemButton>
      </div>
    );
  } else if (groups.length === 0) {
    body =
      filter === "missed" && entries.length > 0 ? (
        <EmptyState icon={PhoneMissed} title="No missed calls" text="Calls you miss show here, in red." className="m-2" />
      ) : (
        <EmptyState
          icon={Phone}
          title="No calls yet"
          text="Calls you make and get show here. Call someone from a conversation, from Contacts, or press Ctrl+K and type “call” and a name."
          action={
            <ItemButton variant="primary" onClick={onNewCall} icon={<Phone className="h-4 w-4" />}>
              New call
            </ItemButton>
          }
          className="m-2"
        />
      );
  } else {
    body = (
      <ul className="flex flex-col gap-0.5" data-testid="calls-list">
        {groups.map((g) => (
          <li key={g.key}>
            <CallRow g={g} users={allUsers} active={g.key === activeKey} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!isPhone && (
        <div className="flex h-14 shrink-0 items-center gap-1 border-b border-[var(--border)] px-4">
          <span className="flex-1 font-semibold text-[var(--text)]">Calls</span>
          <button
            type="button"
            aria-label="New call"
            title="New call"
            onClick={onNewCall}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
            data-testid="calls-new"
          >
            <PhoneCall className="h-[18px] w-[18px]" />
          </button>
          <button
            ref={menuBtn}
            type="button"
            aria-label="More"
            title="More"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            <MoreHorizontal className="h-[18px] w-[18px]" />
          </button>
        </div>
      )}
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-2">
        <Segmented
          size="sm"
          className="flex-1"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "missed", label: "Missed" },
          ]}
        />
        {isPhone && (
          <button
            ref={menuBtn}
            type="button"
            aria-label="More"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            <MoreHorizontal className="h-[18px] w-[18px]" />
          </button>
        )}
      </div>
      <Popover anchor={menuBtn.current} open={menu} onClose={() => setMenu(false)} width={240}>
        <div role="menu" className="p-1">
          <button
            type="button"
            role="menuitem"
            disabled={entries.length === 0}
            onClick={() => void clearAll()}
            className="flex h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm text-[var(--danger)] hover:bg-[var(--hover)] disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" /> Clear call history
          </button>
        </div>
      </Popover>
      <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Calls">
        {body}
        <div ref={sentinel} aria-hidden className="h-px" />
        {q.isFetchingNextPage && (
          <div className="flex justify-center p-3">
            <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" aria-label="Loading more calls" />
          </div>
        )}
      </nav>
    </div>
  );
}

function CallRow({ g, users, active }: { g: CallGroup; users: Users; active: boolean }) {
  const e = g.entries[0];
  const w = historyWords(e);
  const title = callTitle(e, users);
  const isNew = g.entries.some((x) => x.new);
  const n = g.entries.length;
  return (
    <div
      className={cn("flex h-16 items-center gap-1 rounded-xl pr-1", active ? "bg-[var(--hover)]" : "hover:bg-[var(--hover)]")}
      data-testid="calls-row"
      data-missed={w.missed ? "true" : undefined}
      data-new={isNew ? "true" : undefined}
    >
      <Link
        to={`/rooms/calls/${g.key}`}
        aria-current={active ? "page" : undefined}
        aria-label={`${title}, ${w.text}${w.detail ? `, ${w.detail}` : ""}${n > 1 ? `, ${n} calls` : ""}, ${shortWhen(e.started_at)}`}
        className={cn("flex h-full min-w-0 flex-1 items-center gap-3 rounded-xl pl-2.5", rowFocus)}
      >
        <CallAvatar e={e} users={users} size={40} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-baseline gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[15px] md:text-sm",
                w.missed ? "text-[var(--danger)]" : "text-[var(--text)]",
                isNew ? "font-bold" : "font-medium",
              )}
            >
              {title}
              {n > 1 && <span className="font-normal"> ({n})</span>}
            </span>
            <span className={cn("shrink-0 text-[11px]", isNew ? "font-semibold text-[var(--danger)]" : "text-[var(--text-muted)]")}>
              {shortWhen(e.started_at)}
            </span>
          </span>
          <span className={cn("flex min-w-0 items-center gap-1.5 text-[13px]", w.missed ? "text-[var(--danger)]" : "text-[var(--text-muted)]")}>
            <DirectionIcon e={e} />
            <span className="truncate">
              {w.text}
              {w.detail ? ` · ${w.detail}` : ""}
            </span>
          </span>
        </span>
      </Link>
      {e.live ? (
        <button
          type="button"
          onClick={() => void calls.start(e.room_id, e.media)}
          className="shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] focus-visible:ring-offset-2"
          style={{ background: CALL_GREEN }}
        >
          Join
        </button>
      ) : (
        <CallBackButton e={e} title={title} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ one call

export function CallDetail({ b, callKey, isPhone, onBack }: { b: Bootstrap; callKey: string; isPhone: boolean; onBack?: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useCallHistory();
  useSeeMissed(true);
  const { entries, users } = useMemo(() => flatten(q.data), [q.data]);
  const allUsers = useMemo(() => ({ ...users, ...b.users }), [users, b.users]);
  const group = useMemo(() => groupCalls(entries).find((g) => g.key === callKey || g.entries.some((x) => x.id === callKey)) ?? null, [entries, callKey]);
  const e = group?.entries[0] ?? null;

  // Not loaded yet: page on until it turns up (an old call opened by its link).
  useEffect(() => {
    if (!e && q.hasNextPage && !q.isFetchingNextPage && !q.isLoading) void q.fetchNextPage();
  }, [e, q]);

  const header = (
    <header className="flex h-14 shrink-0 items-center gap-1 border-b border-[var(--border)] px-2 md:px-4">
      {isPhone && (
        <button
          type="button"
          aria-label="Back to calls"
          onClick={onBack}
          className="flex h-11 w-11 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
      )}
      <h1 className="flex-1 px-1 font-semibold text-[var(--text)]">Call details</h1>
    </header>
  );

  if (!e) {
    const waiting = q.isLoading || q.isFetchingNextPage || q.hasNextPage;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="flex flex-1 items-center justify-center p-6">
          {waiting ? (
            <Loader2 className="h-6 w-6 animate-spin text-[var(--text-muted)]" aria-label="Loading the call" />
          ) : (
            <EmptyState
              icon={Phone}
              title="This call isn't in your history"
              text="It may have been removed."
              action={
                <ItemButton variant="secondary" onClick={() => navigate("/rooms/calls")}>
                  Back to calls
                </ItemButton>
              }
            />
          )}
        </div>
      </div>
    );
  }

  const title = callTitle(e, allUsers);
  const ids = new Set(group!.entries.map((x) => x.id));
  // Every call you have with these people (loaded so far), newest first.
  const withThem = entries.filter((x) => x.room_id === e.room_id);
  const live = withThem.find((x) => x.live) ?? null;
  const why = e.can_call ? null : e.group ? "You're no longer in this conversation, so you can't call it from here." : "Calls can't be made in this conversation.";
  const removeGroup = async () => {
    if (await removeCalls(qc, [...ids])) navigate("/rooms/calls", { replace: true });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="call-detail">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-xl flex-col items-center gap-3 px-4 pb-4 pt-6 text-center">
          <CallAvatar e={e} users={allUsers} size={72} />
          <div>
            <p className="text-lg font-semibold text-[var(--text)]">{title}</p>
            {e.group && e.name && <p className="text-sm text-[var(--text-muted)]">{e.who.map((id) => allUsers[id]?.username ?? "Someone").join(", ")}</p>}
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {live ? (
              <ItemButton
                variant="primary"
                icon={<PhoneCall className="h-4 w-4" />}
                onClick={() => void calls.start(e.room_id, live.media)}
                style={{ background: CALL_GREEN }}
              >
                Join the call
              </ItemButton>
            ) : (
              <>
                <ItemButton variant="primary" icon={<Phone className="h-4 w-4" />} disabled={!e.can_call} onClick={() => callBack(e, "audio")} data-testid="call-detail-call">
                  Call
                </ItemButton>
                <ItemButton variant="secondary" icon={<Video className="h-4 w-4" />} disabled={!e.can_call} onClick={() => callBack(e, "video")} data-testid="call-detail-video">
                  Video call
                </ItemButton>
              </>
            )}
            {e.can_call && (
              <ItemButton variant="secondary" icon={<MessageSquare className="h-4 w-4" />} onClick={() => navigate(`/rooms/r/${e.room_id}`)}>
                Message
              </ItemButton>
            )}
          </div>
          {why && <p className="text-xs text-[var(--text-muted)]">{why}</p>}
        </div>

        <section aria-labelledby="calls-with" className="mx-auto max-w-xl px-2 pb-6 md:px-4">
          <h2 id="calls-with" className="px-2 pb-1 text-sm font-semibold text-[var(--text)]">
            {e.group ? "Calls in this conversation" : `Calls with ${title}`}
          </h2>
          <ul className="flex flex-col">
            {withThem.map((x, i) => {
              const w = historyWords(x);
              const day = dayLabel(x.started_at);
              const showDay = i === 0 || dayLabel(withThem[i - 1].started_at) !== day;
              return (
                <li key={x.id}>
                  {showDay && <p className="px-2 pb-1 pt-3 text-xs font-medium text-[var(--text-muted)]">{day}</p>}
                  <div className={cn("flex min-h-12 items-center gap-3 rounded-xl px-2", ids.has(x.id) && "bg-[var(--hover)]")} data-testid="call-detail-entry">
                    <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)]", w.missed ? "text-[var(--danger)]" : "text-[var(--text-muted)]")}>
                      <DirectionIcon e={x} className="h-4 w-4" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col text-left">
                      <span className={cn("truncate text-sm", w.missed ? "text-[var(--danger)]" : "text-[var(--text)]", x.new && "font-semibold")}>{w.text}</span>
                      <span className="truncate text-xs text-[var(--text-muted)]">
                        {timeOf(x.started_at)}
                        {w.detail ? ` · ${w.detail}` : ""}
                        {x.group && x.started_by && x.direction === "incoming" ? ` · ${allUsers[x.started_by]?.username ?? "Someone"} called` : ""}
                      </span>
                    </span>
                    {!x.live && (
                      <button
                        type="button"
                        aria-label={`Remove the ${w.text.toLowerCase()} at ${timeOf(x.started_at)} from your call history`}
                        title="Remove from call history"
                        onClick={() => {
                          void removeCalls(qc, [x.id]).then((ok) => {
                            if (ok && ids.has(x.id) && ids.size === 1) navigate("/rooms/calls", { replace: true });
                          });
                        }}
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] md:h-9 md:w-9"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {!e.live && (
            <div className="mt-4 flex justify-center">
              <ItemButton variant="ghost" className="text-[var(--danger)]" icon={<Trash2 className="h-4 w-4" />} onClick={() => void removeGroup()} data-testid="call-detail-remove">
                {ids.size === 1 ? "Remove from call history" : `Remove these ${ids.size} calls`}
              </ItemButton>
            </div>
          )}
          <p className="mt-3 px-2 text-center text-xs text-[var(--text-muted)]">Removing a call only changes your list. The others keep theirs.</p>
        </section>
      </div>
    </div>
  );
}

/** The desktop's main pane on the Calls tab, before a call is picked. */
export function CallsHome({ onNewCall }: { onNewCall: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <EmptyState
        icon={Phone}
        title="Calls"
        text="Pick a call on the left to see its details, or start one. Voice and video calls work one-to-one and with a group."
        action={
          <ItemButton variant="primary" onClick={onNewCall} icon={<PhoneCall className="h-4 w-4" />}>
            New call
          </ItemButton>
        }
        className="max-w-md"
      />
    </div>
  );
}

// ------------------------------------------------------------------ new call

export function NewCallSheet({ open, onClose, b }: { open: boolean; onClose: () => void; b: Bootstrap }) {
  const [text, setText] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setTerm(text.trim()), 200);
    return () => window.clearTimeout(t);
  }, [text]);
  useEffect(() => {
    if (!open) setText("");
  }, [open]);

  // Suggestions: the people you message one-to-one, most recent first.
  const recentIds = useMemo(() => {
    const out: string[] = [];
    for (const r of [...b.dms].sort((x, y) => (y.last_message_at ?? "").localeCompare(x.last_message_at ?? ""))) {
      if (r.kind !== "dm" || r.can_send === false) continue;
      const other = (r.members ?? []).find((id) => id !== b.me.id);
      if (other && !out.includes(other)) out.push(other);
      if (out.length >= 8) break;
    }
    return out;
  }, [b]);
  const suggestions = useQuery({
    queryKey: ["calls", "people", "ids", recentIds],
    queryFn: () => dmCallsApi.callable(recentIds),
    enabled: open && !term && recentIds.length > 0,
    staleTime: 60_000,
  });
  const found = useQuery({
    queryKey: ["calls", "people", "q", term],
    queryFn: () => dmCallsApi.people(term),
    enabled: open && !!term,
    staleTime: 30_000,
  });
  const order = new Map(recentIds.map((id, i) => [id, i]));
  const people: CallablePerson[] = term
    ? (found.data ?? [])
    : [...(suggestions.data ?? [])].sort((x, y) => (order.get(x.user.id) ?? 99) - (order.get(y.user.id) ?? 99));
  const loading = term ? found.isLoading : suggestions.isLoading && recentIds.length > 0;

  const go = (p: CallablePerson, media: CallMedia) => {
    onClose();
    void calls.startWith([p.user.id], media);
  };

  return (
    <Sheet open={open} onClose={onClose} title="New call" size="md">
      <label className="relative block">
        <span className="sr-only">Who do you want to call?</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" aria-hidden />
        <input
          autoFocus
          value={text}
          onChange={(ev) => setText(ev.target.value)}
          placeholder="Name, or what you call them (Mum)"
          className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-9 pr-3 text-sm text-[var(--text)] outline-none focus:border-[var(--item-accent)] focus:ring-2 focus:ring-[var(--item-accent)]/30"
          data-testid="new-call-search"
        />
      </label>
      <p className="mt-3 px-1 text-xs font-medium text-[var(--text-muted)]">{term ? "People" : "Recent"}</p>
      <div className="mt-1 min-h-[8rem]">
        {loading ? (
          <div className="flex justify-center p-6">
            <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" aria-label="Finding people" />
          </div>
        ) : people.length === 0 ? (
          <p className="px-1 py-6 text-center text-sm text-[var(--text-muted)]">
            {term ? `No one called “${term}” you can call.` : "Type a name to find someone to call."}
          </p>
        ) : (
          <ul className="flex flex-col">
            {people.map((p) => (
              <li key={p.user.id} className="flex min-h-14 items-center gap-3 rounded-xl px-1 hover:bg-[var(--hover)]" data-testid="new-call-person">
                <UserAvatar user={p.user} size={36} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-[var(--text)]">
                    {p.said && p.said !== p.name ? `${p.said} · ${p.name}` : p.name}
                  </span>
                  <span className="truncate text-xs text-[var(--text-muted)]">
                    {p.label && p.label !== p.said ? `${p.label} · ` : ""}@{p.user.username}
                  </span>
                </span>
                <button type="button" className={roundBtn} aria-label={`Call ${p.name}`} title={`Call ${p.name}`} onClick={() => go(p, "audio")}>
                  <Phone className="h-5 w-5" />
                </button>
                <button type="button" className={roundBtn} aria-label={`Video call ${p.name}`} title={`Video call ${p.name}`} onClick={() => go(p, "video")}>
                  <Video className="h-5 w-5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}
