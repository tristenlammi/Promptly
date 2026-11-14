import { BarChart3, Check, Lock } from "lucide-react";
import { useEffect, useState } from "react";

import { roomsApi, type Message, type PollMeta, type PollState, type RoomUser } from "@/api/rooms";
import { confirm } from "@/components/shared/ConfirmDialog";
import { Sheet } from "@/items/ui";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { useRoomsStore } from "../store";
import { UserAvatar } from "./ui";

const EMPTY: PollState = { counts: {}, voters_total: 0, closed: false };

/** "closes in 3 hours", "closes tomorrow at 9:00 AM". */
function closesIn(iso: string, now: number): string {
  const at = new Date(iso).getTime();
  const mins = Math.round((at - now) / 60_000);
  if (mins < 1) return "closes any moment";
  if (mins < 60) return `closes in ${mins} min`;
  if (mins < 36 * 60) {
    const h = Math.round(mins / 60);
    return `closes in ${h} hour${h === 1 ? "" : "s"}`;
  }
  return `closes ${new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}`;
}

/** Your answers, as far as this page knows them. */
function mineOf(state: PollState, meId: string): string[] {
  if (state.mine) return state.mine;
  if (!state.voters) return [];
  return Object.entries(state.voters)
    .filter(([, ids]) => ids.includes(meId))
    .map(([o]) => o);
}

/**
 * A poll in the conversation: the question, each answer as a button with its
 * bar and count, and who's voted. Tap to vote; tap again to change your mind
 * or take it back. The count moves live for everyone.
 */
export function PollCard({
  m,
  poll,
  own,
  meId,
  users,
  canModerate,
}: {
  m: Message;
  poll: PollMeta;
  own: boolean;
  meId: string;
  users: Record<string, RoomUser>;
  canModerate: boolean;
}) {
  const state = m.poll ?? EMPTY;
  const [busy, setBusy] = useState(false);
  const [votesOpen, setVotesOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // A closing time: the card closes by itself when it comes.
  useEffect(() => {
    if (!poll.closes_at || poll.closed_at) return;
    const t = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => window.clearInterval(t);
  }, [poll.closes_at, poll.closed_at]);

  const closed = !!poll.closed_at || state.closed || (!!poll.closes_at && now >= new Date(poll.closes_at).getTime());
  const mine = mineOf(state, meId);
  const total = state.voters_total;
  const top = Math.max(0, ...poll.options.map((o) => state.counts[o.id] ?? 0));

  const vote = async (id: string) => {
    if (closed || busy) return;
    const had = mine.includes(id);
    const next = poll.multiple ? (had ? mine.filter((x) => x !== id) : [...mine, id]) : had ? [] : [id];
    const store = useRoomsStore.getState();
    const before = state;
    // Show it at once; the server's count replaces this.
    const counts = { ...state.counts };
    for (const o of mine) if (!next.includes(o)) counts[o] = Math.max(0, (counts[o] ?? 0) - 1);
    for (const o of next) if (!mine.includes(o)) counts[o] = (counts[o] ?? 0) + 1;
    const voters_total = total + (mine.length === 0 && next.length > 0 ? 1 : 0) - (mine.length > 0 && next.length === 0 ? 1 : 0);
    const voters = state.voters
      ? Object.fromEntries(poll.options.map((o) => [o.id, [...(state.voters![o.id] ?? []).filter((u) => u !== meId), ...(next.includes(o.id) ? [meId] : [])]]))
      : undefined;
    store.patchMessage(m.room_id, m.id, (cur) => ({ ...cur, poll: { ...state, counts, voters_total, mine: next, ...(voters ? { voters } : {}) } }));
    setBusy(true);
    try {
      const fresh = await roomsApi.votePoll(m.id, next);
      store.patchMessage(m.room_id, m.id, (cur) => ({ ...cur, poll: fresh }));
    } catch (err) {
      store.patchMessage(m.room_id, m.id, (cur) => ({ ...cur, poll: before }));
      toast.error(apiErrorMessage(err, "Your vote didn't go through. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    const ok = await confirm({ title: "Close this poll?", message: "Nobody will be able to vote or change their vote after this.", confirmLabel: "Close poll" });
    if (!ok) return;
    try {
      useRoomsStore.getState().upsertMessage(await roomsApi.closePoll(m.id));
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't close the poll."));
    }
  };

  const nameOf = (id: string) => (id === meId ? "You" : users[id]?.username ?? "Someone");
  const canSeeVotes = !poll.anonymous && total > 0 && !!state.voters;

  return (
    <div
      className="w-[min(360px,calc(100vw-7.5rem))] max-w-full rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3"
      role="group"
      aria-label={`Poll: ${poll.question}`}
      data-poll={m.id}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent-text)]">
          <BarChart3 className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="select-text break-words text-[15px] font-semibold leading-snug text-[var(--text)]">{poll.question}</p>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            {closed ? "Closed" : poll.multiple ? "Pick any that fit" : "Pick one"}
            {poll.anonymous && " · nobody sees who voted"}
          </p>
        </div>
      </div>

      <ul className="mt-2.5 flex flex-col gap-1.5">
        {poll.options.map((o) => {
          const n = state.counts[o.id] ?? 0;
          const picked = mine.includes(o.id);
          const pct = total > 0 ? Math.round((n / total) * 100) : 0;
          const leading = closed && n > 0 && n === top;
          return (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => void vote(o.id)}
                disabled={closed}
                aria-pressed={picked}
                aria-label={`${o.text}: ${n} vote${n === 1 ? "" : "s"}${picked ? ", your answer" : ""}`}
                className={cn(
                  "relative flex min-h-[44px] w-full items-center gap-2 overflow-hidden rounded-xl border px-3 py-2 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
                  picked ? "border-[var(--accent)]" : "border-[var(--border)]",
                  !closed && "hover:border-[color-mix(in_srgb,var(--accent)_60%,var(--border))]",
                  closed && "cursor-default",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "absolute inset-y-0 left-0 transition-[width] duration-300 ease-out",
                    picked || leading ? "bg-[color-mix(in_srgb,var(--accent)_22%,transparent)]" : "bg-[color-mix(in_srgb,var(--text)_8%,transparent)]",
                  )}
                  style={{ width: `${pct}%` }}
                />
                <span
                  aria-hidden
                  className={cn(
                    "relative flex h-5 w-5 shrink-0 items-center justify-center border",
                    poll.multiple ? "rounded-md" : "rounded-full",
                    picked ? "border-[var(--accent-strong)] bg-[var(--accent-strong)] text-white" : "border-[color-mix(in_srgb,var(--text)_35%,transparent)]",
                    closed && !picked && "opacity-40",
                  )}
                >
                  {picked && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                </span>
                <span className={cn("relative min-w-0 flex-1 break-words text-[var(--text)]", (picked || leading) && "font-medium")}>{o.text}</span>
                <span className="relative shrink-0 text-xs tabular-nums text-[var(--text-muted)]">{total > 0 ? `${n} · ${pct}%` : ""}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-muted)]">
        <span>
          {total === 0 ? "No votes yet" : `${total} ${total === 1 ? "person has" : "people have"} voted`}
          {!closed && poll.closes_at && ` · ${closesIn(poll.closes_at, now)}`}
        </span>
        {closed && (
          <span className="inline-flex items-center gap-1">
            <Lock className="h-3 w-3" aria-hidden /> Voting has ended
          </span>
        )}
        <span className="ml-auto flex gap-3">
          {canSeeVotes && (
            <button type="button" onClick={() => setVotesOpen(true)} className="font-semibold text-[var(--accent-text)] hover:underline">
              See votes
            </button>
          )}
          {!closed && (own || canModerate) && (
            <button type="button" onClick={() => void close()} className="font-semibold text-[var(--text-muted)] hover:text-[var(--text)] hover:underline">
              Close poll
            </button>
          )}
        </span>
      </div>

      {/* Drawn elsewhere on the page, but taps bubble here: keep them from
          opening the message's own menu. */}
      <div className="contents" onClick={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
        <Sheet open={votesOpen} onClose={() => setVotesOpen(false)} title={poll.question} size="sm">
          <div className="flex flex-col gap-4 pb-2">
            {poll.options.map((o) => {
              const ids = state.voters?.[o.id] ?? [];
              return (
                <section key={o.id}>
                  <h3 className="flex items-baseline justify-between gap-2 text-sm font-semibold text-[var(--text)]">
                    <span className="min-w-0 break-words">{o.text}</span>
                    <span className="shrink-0 text-xs font-normal tabular-nums text-[var(--text-muted)]">{ids.length}</span>
                  </h3>
                  {ids.length === 0 ? (
                    <p className="py-1 text-xs text-[var(--text-muted)]">Nobody yet</p>
                  ) : (
                    <ul className="mt-1 flex flex-col">
                      {ids.map((id) => (
                        <li key={id} className="flex min-h-[40px] items-center gap-3 py-0.5">
                          <UserAvatar user={users[id]} size={28} />
                          <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">{nameOf(id)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        </Sheet>
      </div>
    </div>
  );
}
