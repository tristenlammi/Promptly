import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarClock,
  CircleDot,
  Clock,
  LayoutGrid,
  Inbox as InboxIcon,
} from "lucide-react";

import { workspacesApi, type MyWorkCard } from "@/api/workspaces";
import { useWorkspaceInvites } from "@/hooks/useWorkspaces";
import { TopNav } from "@/components/layout/TopNav";
import { EmptyState } from "@/components/shared/EmptyState";
import { Skeleton } from "@/components/shared/Skeleton";
import { cn } from "@/utils/cn";

/**
 * "My work" — everything on the caller's plate across every workspace:
 * open cards assigned to them, grouped by urgency (overdue / this week /
 * later / no date), plus a pending-invites strip. The daily-driver page
 * the review called the retention mechanic (§4.2): open one tab, see
 * what needs you, click straight into the right board.
 */
const PRIORITY_DOT: Record<string, string> = {
  high: "text-red-500",
  medium: "text-amber-500",
  low: "text-slate-400",
};

type Bucket = "overdue" | "week" | "later" | "none";

function bucketOf(card: MyWorkCard): Bucket {
  if (!card.due_at) return "none";
  const due = new Date(card.due_at).getTime();
  const now = Date.now();
  if (due < now) return "overdue";
  if (due < now + 7 * 24 * 3600 * 1000) return "week";
  return "later";
}

const BUCKET_META: Record<Bucket, { label: string; tone?: string }> = {
  overdue: { label: "Overdue", tone: "text-[var(--danger)]" },
  week: { label: "Due this week", tone: "text-[var(--warning)]" },
  later: { label: "Later" },
  none: { label: "No due date" },
};

export function MyWorkPage() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ["my-work"],
    queryFn: () => workspacesApi.myWork(),
    refetchInterval: 60_000,
  });
  const { data: invites } = useWorkspaceInvites();

  const buckets = useMemo(() => {
    const out: Record<Bucket, MyWorkCard[]> = {
      overdue: [],
      week: [],
      later: [],
      none: [],
    };
    for (const c of data?.cards ?? []) out[bucketOf(c)].push(c);
    return out;
  }, [data]);

  const total = data?.cards.length ?? 0;

  return (
    <>
      <TopNav
        title="My work"
        subtitle="Every open card assigned to you, across all your workspaces"
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-6">
          {(invites?.length ?? 0) > 0 && (
            <div className="mb-5 flex items-center gap-2 rounded-card border border-[var(--accent)]/40 bg-[var(--accent)]/5 px-3 py-2 text-sm text-[var(--text)]">
              <InboxIcon className="h-4 w-4 text-[var(--accent)]" />
              {invites!.length} pending workspace invite
              {invites!.length === 1 ? "" : "s"} — accept them from the
              sidebar's Invites button.
            </div>
          )}

          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : total === 0 ? (
            <EmptyState
              icon={<CalendarClock className="h-5 w-5" />}
              title="Nothing on your plate"
              description="Cards assigned to you on any workspace board show up here, due-date first. Assign yourself something — or enjoy the quiet."
            />
          ) : (
            (Object.keys(buckets) as Bucket[]).map((bucket) => {
              const cards = buckets[bucket];
              if (cards.length === 0) return null;
              const meta = BUCKET_META[bucket];
              return (
                <section key={bucket} className="mb-6">
                  <h2
                    className={cn(
                      "mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]",
                      meta.tone
                    )}
                  >
                    {meta.label} · {cards.length}
                  </h2>
                  <ul className="divide-y divide-[var(--border)] rounded-card border border-[var(--border)] bg-[var(--surface)]">
                    {cards.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() =>
                            navigate(
                              c.board_item_id
                                ? `/workspaces/${c.workspace_id}?item=${c.board_item_id}`
                                : `/workspaces/${c.workspace_id}`
                            )
                          }
                          className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-[var(--hover)]"
                        >
                          <CircleDot
                            className={cn(
                              "h-3.5 w-3.5 shrink-0",
                              PRIORITY_DOT[c.priority] ?? PRIORITY_DOT.low
                            )}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-[var(--text)]">
                              {c.title}
                            </span>
                            <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                              <LayoutGrid className="h-3 w-3" />
                              {c.workspace_title}
                              {c.board_title && <> · {c.board_title}</>}
                              {c.status === "doing" && <> · In progress</>}
                            </span>
                          </span>
                          {c.due_at && (
                            <span
                              className={cn(
                                "inline-flex shrink-0 items-center gap-1 text-[11px]",
                                bucket === "overdue"
                                  ? "text-[var(--danger)]"
                                  : "text-[var(--text-muted)]"
                              )}
                            >
                              <Clock className="h-3 w-3" />
                              {new Date(c.due_at).toLocaleDateString([], {
                                day: "numeric",
                                month: "short",
                              })}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
