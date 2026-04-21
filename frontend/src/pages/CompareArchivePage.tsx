import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Crown, Plus, Split } from "lucide-react";

import {
  compareApi,
  type CompareArchiveFilter,
  type CompareGroupSummary,
} from "@/api/compare";
import { cn } from "@/utils/cn";

/**
 * Listing of all compare groups the user has created — active,
 * archived, and post-crown ("archived because a winner was picked").
 * The main ``/chat`` sidebar deliberately hides non-crowned columns
 * (see ``list_conversations`` server-side) so this page is the one
 * place to find historical compare runs.
 */
export function CompareArchivePage() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<CompareArchiveFilter>("all");

  const { data = [], isLoading, isError } = useQuery({
    queryKey: ["compare-groups", filter],
    queryFn: () => compareApi.list(filter),
  });

  const grouped = useMemo(() => {
    const active: CompareGroupSummary[] = [];
    const crowned: CompareGroupSummary[] = [];
    const archived: CompareGroupSummary[] = [];
    for (const g of data) {
      if (g.archived_at) archived.push(g);
      else if (g.crowned_conversation_id) crowned.push(g);
      else active.push(g);
    }
    return { active, crowned, archived };
  }, [data]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <header className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3">
        <button
          type="button"
          onClick={() => navigate("/chat")}
          className="inline-flex items-center gap-1 text-sm text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to chat
        </button>
        <h1 className="flex items-center gap-2 text-lg font-semibold text-[var(--text)]">
          <Split className="h-4 w-4" />
          Compares
        </h1>
        <div className="ml-auto flex items-center gap-2">
          <FilterPill value="all" current={filter} onChange={setFilter}>
            All
          </FilterPill>
          <FilterPill value="active" current={filter} onChange={setFilter}>
            Active
          </FilterPill>
          <FilterPill value="archived" current={filter} onChange={setFilter}>
            Archived
          </FilterPill>
          <Link
            to="/chat/compare/new"
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-medium",
              "bg-[var(--accent)] text-white hover:opacity-90"
            )}
          >
            <Plus className="h-3 w-3" />
            New compare
          </Link>
        </div>
      </header>

      <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-5">
        {isLoading && (
          <div className="text-sm text-[var(--text-muted)]">Loading…</div>
        )}
        {isError && (
          <div className="text-sm text-red-500">Couldn't load compares.</div>
        )}

        {!isLoading && !isError && data.length === 0 && (
          <EmptyState />
        )}

        {grouped.active.length > 0 && (
          <Section title="Active">
            {grouped.active.map((g) => (
              <GroupRow key={g.id} group={g} />
            ))}
          </Section>
        )}
        {grouped.crowned.length > 0 && (
          <Section title="Crowned">
            {grouped.crowned.map((g) => (
              <GroupRow key={g.id} group={g} />
            ))}
          </Section>
        )}
        {grouped.archived.length > 0 && (
          <Section title="Archived">
            {grouped.archived.map((g) => (
              <GroupRow key={g.id} group={g} />
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        {title}
      </h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function GroupRow({ group }: { group: CompareGroupSummary }) {
  const when = new Date(group.updated_at).toLocaleString();
  return (
    <Link
      to={`/chat/compare/${group.id}`}
      className={cn(
        "block rounded-md border px-3 py-2 transition",
        "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--accent)]/60"
      )}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text)]">
          {group.title || "Untitled compare"}
        </div>
        {group.crowned_conversation_id && (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
              "bg-[var(--accent)]/15 text-[var(--accent)]"
            )}
          >
            <Crown className="h-3 w-3" />
            Winner picked
          </span>
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
        <span>{group.column_count} columns</span>
        <span>·</span>
        <span>{when}</span>
      </div>
      {group.seed_prompt && (
        <div className="mt-1 line-clamp-2 text-xs text-[var(--text-muted)]">
          {group.seed_prompt}
        </div>
      )}
    </Link>
  );
}

function FilterPill({
  value,
  current,
  onChange,
  children,
}: {
  value: CompareArchiveFilter;
  current: CompareArchiveFilter;
  onChange: (v: CompareArchiveFilter) => void;
  children: React.ReactNode;
}) {
  const active = value === current;
  return (
    <button
      type="button"
      onClick={() => onChange(value)}
      className={cn(
        "rounded-full px-3 py-1 text-xs transition",
        active
          ? "bg-[var(--accent)] text-white"
          : "border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]"
      )}
    >
      {children}
    </button>
  );
}

function EmptyState() {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center",
        "border-[var(--border)] text-[var(--text-muted)]"
      )}
    >
      <Split className="h-8 w-8" />
      <div className="text-sm">
        No compares yet. Start one to pit two models against the same prompt
        and crown the winner.
      </div>
      <Link
        to="/chat/compare/new"
        className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
      >
        <Plus className="mr-1 inline h-3 w-3" />
        New compare
      </Link>
    </div>
  );
}
