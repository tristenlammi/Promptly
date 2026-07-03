import { useState } from "react";
import {
  AlertTriangle,
  Building2,
  RotateCcw,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react";

import { Button } from "@/components/shared/Button";
import { confirm } from "@/components/shared/ConfirmDialog";
import {
  usePendingDeletions,
  usePurgeDeletionOrg,
  usePurgeDeletionUser,
  useRestoreDeletionOrg,
  useRestoreDeletionUser,
} from "@/hooks/useAdminUsers";
import { cn } from "@/utils/cn";
import type {
  PendingDeletionOrg,
  PendingDeletionUser,
} from "@/api/types";

/**
 * Operator-only "Data & deletion" surface over ``/api/admin/deletion``.
 *
 * A Clerk deletion soft-deletes the row (recoverable) and a daily job hard-
 * purges it once the grace window elapses. Here the operator can see what's
 * queued and, per row, **restore** (undo) or **purge now** (skip the wait —
 * irreversible, so it's confirm-gated).
 */
export function DeletionPanel() {
  const { data, isLoading, isError } = usePendingDeletions();
  const purgeUser = usePurgeDeletionUser();
  const restoreUser = useRestoreDeletionUser();
  const purgeOrg = usePurgeDeletionOrg();
  const restoreOrg = useRestoreDeletionOrg();
  const [error, setError] = useState<string | null>(null);

  const act = async (p: Promise<unknown>) => {
    setError(null);
    try {
      await p;
    } catch (e) {
      setError(
        (e as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ??
          (e instanceof Error ? e.message : String(e))
      );
    }
  };

  const onPurgeUser = async (u: PendingDeletionUser) => {
    const ok = await confirm({
      title: "Purge account permanently?",
      danger: true,
      confirmLabel: "Purge permanently",
      message: (
        <>
          This <strong>immediately and irreversibly</strong> deletes{" "}
          <strong>{u.email}</strong> and everything they created — chats,
          files, workspaces, everything. It skips the grace window and cannot
          be undone.
        </>
      ),
    });
    if (ok) act(purgeUser.mutateAsync(u.id));
  };

  const onPurgeOrg = async (o: PendingDeletionOrg) => {
    const ok = await confirm({
      title: "Purge organisation permanently?",
      danger: true,
      confirmLabel: "Purge permanently",
      message: (
        <>
          This <strong>immediately and irreversibly</strong> deletes{" "}
          <strong>{o.name}</strong> and its config — providers &amp; API keys,
          custom models, groups, connectors. Members keep their own accounts
          and content. This cannot be undone.
        </>
      ),
    });
    if (ok) act(purgeOrg.mutateAsync(o.id));
  };

  if (isLoading) {
    return (
      <div className="text-sm text-[var(--text-muted)]">
        Loading pending deletions…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="text-sm text-red-600 dark:text-red-400">
        Couldn't load pending deletions. Refresh and try again.
      </div>
    );
  }

  const nothing = data.users.length === 0 && data.orgs.length === 0;

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-sm font-semibold text-[var(--text)]">
          Data &amp; deletion
        </h2>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">
          When an account or organisation is deleted in Clerk, it's soft-deleted
          and kept for <strong>{data.grace_days} days</strong>, then permanently
          erased by the daily purge. Restore to undo, or purge now to erase
          immediately.
        </p>
      </header>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {nothing ? (
        <div className="flex flex-col items-center gap-2 rounded-card border border-[var(--border)] bg-[var(--surface)] px-4 py-10 text-center">
          <ShieldCheck className="h-6 w-6 text-emerald-500" />
          <div className="text-sm font-medium text-[var(--text)]">
            Nothing pending deletion
          </div>
          <div className="text-xs text-[var(--text-muted)]">
            Soft-deleted accounts and organisations will appear here.
          </div>
        </div>
      ) : (
        <>
          <Section
            title="Accounts"
            icon={<UserRound className="h-3.5 w-3.5" />}
            count={data.users.length}
          >
            {data.users.map((u) => (
              <Row
                key={u.id}
                primary={u.email}
                secondary={u.username}
                deletedAt={u.deleted_at}
                purgeAfter={u.purge_after}
                onRestore={() => act(restoreUser.mutateAsync(u.id))}
                onPurge={() => onPurgeUser(u)}
                restoring={
                  restoreUser.isPending && restoreUser.variables === u.id
                }
                purging={purgeUser.isPending && purgeUser.variables === u.id}
              />
            ))}
          </Section>

          <Section
            title="Organisations"
            icon={<Building2 className="h-3.5 w-3.5" />}
            count={data.orgs.length}
          >
            {data.orgs.map((o) => (
              <Row
                key={o.id}
                primary={o.name}
                secondary="Providers, keys, custom models, groups & connectors"
                deletedAt={o.deleted_at}
                purgeAfter={o.purge_after}
                onRestore={() => act(restoreOrg.mutateAsync(o.id))}
                onPurge={() => onPurgeOrg(o)}
                restoring={
                  restoreOrg.isPending && restoreOrg.variables === o.id
                }
                purging={purgeOrg.isPending && purgeOrg.variables === o.id}
              />
            ))}
          </Section>
        </>
      )}
    </div>
  );
}

function Section({
  title,
  icon,
  count,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        {icon}
        {title}
        <span className="text-[var(--text-muted)]">({count})</span>
      </div>
      <div className="divide-y divide-[var(--border)] overflow-hidden rounded-card border border-[var(--border)]">
        {children}
      </div>
    </div>
  );
}

function Row({
  primary,
  secondary,
  deletedAt,
  purgeAfter,
  onRestore,
  onPurge,
  restoring,
  purging,
}: {
  primary: string;
  secondary: string;
  deletedAt: string;
  purgeAfter: string;
  onRestore: () => void;
  onPurge: () => void;
  restoring: boolean;
  purging: boolean;
}) {
  const busy = restoring || purging;
  return (
    <div className="flex flex-wrap items-center gap-3 bg-[var(--surface)] px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-[var(--text)]">
          {primary}
        </div>
        <div className="truncate text-[11px] text-[var(--text-muted)]">
          {secondary}
        </div>
      </div>
      <div className="text-right text-[11px] text-[var(--text-muted)]">
        <div>Deleted {new Date(deletedAt).toLocaleDateString()}</div>
        <PurgeCountdown iso={purgeAfter} />
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          onClick={onRestore}
          disabled={busy}
          loading={restoring}
        >
          <RotateCcw className="mr-1 h-3.5 w-3.5" />
          Restore
        </Button>
        <Button
          variant="danger"
          size="sm"
          onClick={onPurge}
          disabled={busy}
          loading={purging}
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" />
          Purge now
        </Button>
      </div>
    </div>
  );
}

/** "Purges in N days" — or an overdue hint if the next run hasn't caught it. */
function PurgeCountdown({ iso }: { iso: string }) {
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  const overdue = days <= 0;
  return (
    <div
      className={cn(
        "font-medium",
        overdue
          ? "text-amber-600 dark:text-amber-400"
          : "text-[var(--text-muted)]"
      )}
    >
      {overdue
        ? "Purges on next run"
        : `Purges in ${days} day${days === 1 ? "" : "s"}`}
    </div>
  );
}
