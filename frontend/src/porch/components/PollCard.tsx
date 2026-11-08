import { Check, Clock, Lock } from "lucide-react";
import { useState } from "react";

import type { PorchPost, PorchUser } from "@/api/porch";
import { Sheet } from "@/items/ui";
import { cn } from "@/utils/cn";

import { usePostTalk } from "../talkActions";
import { PersonLink, PorchAvatar } from "./ui";

/** "Closes in 2 days", "Closes in 3 hours", "Closed". */
export function closesWords(closesAt: string | null, closed: boolean, now = Date.now()): string {
  if (closed) return "Closed";
  if (!closesAt) return "No closing time";
  const ms = new Date(closesAt).getTime() - now;
  const h = Math.round(ms / 3_600_000);
  if (h < 1) return "Closes in under an hour";
  if (h < 24) return `Closes in ${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `Closes in ${d} day${d === 1 ? "" : "s"}`;
}

function names(people: PorchUser[]): string {
  if (people.length <= 2) return people.map((p) => p.name).join(" and ");
  return `${people[0].name}, ${people[1].name} and ${people.length - 2} more`;
}

/**
 * A poll: tap an option to vote (changeable until it closes). The results —
 * how many and who voted for what (decision D4) — show once you've voted,
 * when it closes, and always on your own poll.
 */
export function PollCard({ post }: { post: PorchPost }) {
  const poll = post.poll;
  const { vote } = usePostTalk();
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState<string | null>(null);
  if (!poll) return null;
  const total = poll.total ?? 0;
  const can = !poll.closed;
  const go = async (id: string | null) => {
    if (busy || !can) return;
    setBusy(true);
    await vote(post, id);
    setBusy(false);
  };
  const shown = poll.options.find((o) => o.id === who);
  return (
    <div className="mx-4 flex flex-col gap-2 md:mx-0" data-poll={post.id}>
      <div role="radiogroup" aria-label={post.body ? `Poll: ${post.body}` : "Poll"} aria-disabled={!can} className="flex flex-col gap-2">
        {poll.options.map((o) => {
          const mine = poll.my_vote === o.id;
          const pct = poll.show_results && total ? Math.round(((o.votes ?? 0) / total) * 100) : 0;
          return (
            <div key={o.id} className="flex flex-col gap-1">
              <button
                type="button"
                role="radio"
                aria-checked={mine}
                disabled={!can || busy}
                onClick={() => void go(mine ? null : o.id)}
                aria-label={
                  poll.show_results
                    ? `${o.label}: ${o.votes ?? 0} ${(o.votes ?? 0) === 1 ? "vote" : "votes"}${mine ? ", your vote" : ""}`
                    : o.label
                }
                className={cn(
                  "relative flex min-h-[44px] w-full items-center gap-2 overflow-hidden rounded-xl border px-3 py-2 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)] disabled:cursor-default",
                  mine ? "border-[var(--item-accent)]" : "border-[var(--border)]",
                  can && !poll.show_results && "hover:border-[var(--item-accent)] hover:bg-[var(--hover)]",
                )}
              >
                {poll.show_results && (
                  <span
                    aria-hidden
                    className={cn("absolute inset-y-0 left-0 transition-[width] duration-300", mine ? "bg-[color-mix(in_srgb,var(--item-accent)_22%,transparent)]" : "bg-[var(--surface-2)]")}
                    style={{ width: `${pct}%` }}
                  />
                )}
                <span className="relative flex min-w-0 flex-1 items-center gap-2 font-medium text-[var(--text)]">
                  {mine && <Check className="h-4 w-4 shrink-0 text-[var(--accent-text)]" aria-hidden />}
                  <span className="break-words">{o.label}</span>
                </span>
                {poll.show_results && (
                  <span aria-hidden className="relative shrink-0 tabular-nums text-[var(--text-muted)]">
                    {pct}%
                  </span>
                )}
              </button>
              {poll.show_results && o.voters && o.voters.length > 0 && (
                <button
                  type="button"
                  onClick={() => setWho(o.id)}
                  className="flex w-fit items-center gap-1.5 rounded px-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--item-accent)]"
                >
                  <span className="flex -space-x-1.5" aria-hidden>
                    {o.voters.slice(0, 3).map((u) => (
                      <PorchAvatar key={u.id} user={u} size={18} className="ring-2 ring-[var(--surface)]" />
                    ))}
                  </span>
                  <span>
                    {names(o.voters)}
                    <span className="sr-only"> voted for {o.label}</span>
                  </span>
                </button>
              )}
            </div>
          );
        })}
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-1">
          {poll.closed ? <Lock className="h-3.5 w-3.5" aria-hidden /> : <Clock className="h-3.5 w-3.5" aria-hidden />}
          {closesWords(poll.closes_at, poll.closed)}
        </span>
        {poll.show_results ? (
          <span>· {total === 1 ? "1 vote" : `${total} votes`}</span>
        ) : (
          can && <span>· Vote to see the results</span>
        )}
        {poll.my_vote && can && (
          <button type="button" disabled={busy} onClick={() => void go(null)} className="font-medium text-[var(--accent-text)] hover:underline">
            Take my vote back
          </button>
        )}
      </p>
      <Sheet open={!!shown} onClose={() => setWho(null)} title={shown ? `Voted “${shown.label}”` : ""} size="sm">
        <ul className="-mx-2 flex flex-col">
          {(shown?.voters ?? []).map((u) => (
            <li key={u.id} className="flex min-h-[48px] items-center gap-3 px-2">
              <PorchAvatar user={u} size={32} />
              <PersonLink user={u} className="text-sm" />
            </li>
          ))}
        </ul>
      </Sheet>
    </div>
  );
}
