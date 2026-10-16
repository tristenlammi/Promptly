import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, DatabaseBackup, Loader2 } from "lucide-react";

import { adminApi, type BackupRun } from "@/api/admin";
import { extractError, formatRelativeTime, humanSize } from "@/components/files/helpers";
import { toast } from "@/store/toastStore";
import { OffsiteBackupCard } from "@/components/admin/OffsiteBackupCard";
import { cn } from "@/utils/cn";

const KIND_LABEL: Record<string, string> = {
  nightly: "Nightly",
  pre_migrate: "Before update",
  manual: "Manual",
  offsite: "Off-site copy",
  check: "Off-site check",
  restore_test: "Trial restore",
};
const DUMP_KINDS = new Set(["nightly", "pre_migrate", "manual"]);

/** A nightly run that's more than this old means the schedule isn't firing. */
const STALE_HOURS = 26;

/**
 * Admin → Backups. Promptly dumps its database before every update and
 * every night (keeping 14); this card says when that last worked, alerts
 * when it didn't, and offers "Back up now". Deleted files' bytes are held
 * for 14 days — shown here so the space they take isn't a mystery.
 */
export function BackupsPanel() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "backups"],
    queryFn: adminApi.backups,
    // Poll while a backup is running so "Back up now" resolves on screen.
    refetchInterval: (q) =>
      q.state.data?.runs.some((r) => r.status === "running") ? 3000 : 60_000,
  });
  const run = useMutation({
    mutationFn: adminApi.runBackup,
    onSuccess: () => {
      toast.success("Backup started");
      void qc.invalidateQueries({ queryKey: ["admin", "backups"] });
    },
    onError: (e) => toast.error(extractError(e)),
  });

  if (isLoading) {
    return (
      <div className="py-8 text-center text-xs text-[var(--text-muted)]">
        Checking backups…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div
        role="alert"
        className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
      >
        Couldn't read the backup status.
      </div>
    );
  }

  const ok = data.last_success;
  const failed = data.last_failure;
  const failingNow =
    failed && (!ok || new Date(failed.created_at) > new Date(ok.created_at));
  const ageH = ok ? (Date.now() - new Date(ok.created_at).getTime()) / 3.6e6 : Infinity;
  const tone = failingNow || !ok ? "bad" : ageH > STALE_HOURS ? "warn" : "good";
  const running = data.runs.some((r) => DUMP_KINDS.has(r.kind) && r.status === "running");

  return (
    <div className="space-y-5">
      <div
        className={cn(
          "flex flex-wrap items-start gap-3 rounded-card border p-4",
          tone === "good" && "border-emerald-500/30 bg-emerald-500/5",
          tone === "warn" && "border-amber-500/40 bg-amber-500/10",
          tone === "bad" && "border-red-500/40 bg-red-500/10"
        )}
      >
        {tone === "good" ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <AlertTriangle
            className={cn(
              "mt-0.5 h-5 w-5 shrink-0",
              tone === "warn" ? "text-amber-600 dark:text-amber-300" : "text-red-600 dark:text-red-400"
            )}
          />
        )}
        <div className="min-w-0 flex-1 text-sm text-[var(--text)]">
          <div className="font-semibold">
            {ok ? `Last backup: ${formatRelativeTime(ok.created_at)}` : "No backup yet"}
          </div>
          <div className="mt-0.5 text-xs text-[var(--text-muted)]">
            {failingNow && failed
              ? `The last attempt failed: ${failed.error ?? "unknown error"}`
              : ok
                ? `${KIND_LABEL[ok.kind] ?? ok.kind} · ${humanSize(ok.size_bytes ?? 0)} · ${ok.filename}`
                : "The first nightly backup runs at 02:00. You can take one now."}
          </div>
        </div>
        <button
          type="button"
          onClick={() => run.mutate()}
          disabled={running || run.isPending}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-input border px-3 py-1.5 text-sm",
            "border-[var(--border)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--hover)]",
            "disabled:cursor-not-allowed disabled:opacity-60"
          )}
        >
          {running || run.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <DatabaseBackup className="h-3.5 w-3.5" />
          )}
          {running ? "Backing up…" : "Back up now"}
        </button>
      </div>

      <div className="grid gap-3 text-xs text-[var(--text-muted)] sm:grid-cols-3">
        <Fact label="Kept">
          Every update, plus the last {data.keep_nightly} nights, in{" "}
          <code className="font-mono">{data.location}</code>
        </Fact>
        <Fact label="Free space there">
          {data.disk_free_bytes === null ? "Unknown" : humanSize(data.disk_free_bytes)}
        </Fact>
        <Fact label="Deleted files, recoverable">
          {data.pending_deletion_count === 0
            ? "None"
            : `${data.pending_deletion_count} · ${humanSize(data.pending_deletion_bytes)} (freed after 14 days)`}
        </Fact>
      </div>

      <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-xs text-[var(--text-muted)]">
        These are database dumps, kept on this machine — they protect against a
        bad update, not a dead disk. Off-site backup below sends them, with
        everyone's files and the server's keys, somewhere else. Restore steps are
        in the README under “Backups”.
      </div>

      <OffsiteBackupCard offsite={data.offsite} />

      <div className="overflow-hidden rounded-card border border-[var(--border)]">
        <table className="w-full text-left text-xs">
          <thead className="bg-[var(--surface)] text-[var(--text-muted)]">
            <tr>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Kind</th>
              <th className="px-3 py-2 font-medium">Result</th>
              <th className="hidden px-3 py-2 font-medium sm:table-cell">Size</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-[var(--text-muted)]">
                  No backups recorded yet.
                </td>
              </tr>
            )}
            {data.runs.map((r) => (
              <RunRow key={r.id} run={r} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RunRow({ run }: { run: BackupRun }) {
  return (
    <tr className="border-t border-[var(--border)] text-[var(--text)]">
      <td className="px-3 py-2" title={new Date(run.created_at).toLocaleString()}>
        {formatRelativeTime(run.created_at)}
      </td>
      <td className="px-3 py-2">{KIND_LABEL[run.kind] ?? run.kind}</td>
      <td className="px-3 py-2">
        {run.status === "ok" ? (
          <span className="text-emerald-600 dark:text-emerald-400">OK</span>
        ) : run.status === "running" ? (
          <span className="text-[var(--text-muted)]">Running…</span>
        ) : run.status === "skipped" ? (
          <span className="text-[var(--text-muted)]" title={run.detail ?? undefined}>Skipped</span>
        ) : (
          <span className="text-red-600 dark:text-red-400" title={run.error ?? undefined}>
            Failed
          </span>
        )}
      </td>
      <td className="hidden px-3 py-2 sm:table-cell">
        {run.size_bytes ? humanSize(run.size_bytes) : "—"}
      </td>
    </tr>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wide">{label}</div>
      <div className="mt-0.5 text-[var(--text)]">{children}</div>
    </div>
  );
}
