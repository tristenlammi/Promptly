import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, HardDrive, Images, Loader2, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";

import { adminApi, type StorageCheckRun } from "@/api/admin";
import { extractError, formatRelativeTime, humanSize } from "@/components/files/helpers";
import { confirm } from "@/components/shared/ConfirmDialog";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

/**
 * Admin → Storage (WP-7.2): is every file still what was stored? The disk
 * (and whether uploads are paused for lack of space), the nightly integrity
 * check and what it found, files to restore from a backup, the quarantine of
 * unreferenced blobs, and whether the database keeps page checksums.
 */
const STATUS_LABEL: Record<StorageCheckRun["status"], string> = {
  running: "Running…",
  ok: "All good",
  problems: "Found problems",
  failed: "Didn't finish",
};

export function StoragePanel() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "storage"],
    queryFn: adminApi.storageHealth,
    refetchInterval: (q) => (q.state.data?.runs.some((r) => r.status === "running") ? 3000 : 60_000),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "storage"] });
  const check = useMutation({
    mutationFn: adminApi.runStorageCheck,
    onSuccess: () => {
      toast.success("Check started");
      window.setTimeout(() => void refresh(), 800);
    },
    onError: (e) => toast.error(extractError(e)),
  });
  const recheck = useMutation({
    mutationFn: adminApi.recheckFile,
    onSuccess: (r) => {
      toast[r.state === "ready" ? "success" : "error"](
        r.state === "ready" ? "The file checks out now." : `Still ${r.state}.`
      );
      void refresh();
    },
    onError: (e) => toast.error(extractError(e)),
  });
  const retryUnderstanding = useMutation({
    mutationFn: adminApi.retryUnderstanding,
    onSuccess: (r) => {
      toast.success(r.retried ? `Trying ${r.retried} again.` : "Trying again.");
      void refresh();
    },
    onError: (e) => toast.error(extractError(e)),
  });
  const retryMedia = useMutation({
    mutationFn: adminApi.retryMedia,
    onSuccess: (r) => {
      toast.success(`Queued ${r.queued} again.`);
      void refresh();
    },
    onError: (e) => toast.error(extractError(e)),
  });
  const empty = useMutation({
    mutationFn: adminApi.emptyQuarantine,
    onSuccess: (r) => {
      toast.success(`Deleted ${r.deleted} file${r.deleted === 1 ? "" : "s"} from the quarantine.`);
      void refresh();
    },
    onError: (e) => toast.error(extractError(e)),
  });

  if (isLoading) return <div className="py-8 text-center text-xs text-[var(--text-muted)]">Checking storage…</div>;
  if (isError || !data) {
    return (
      <div role="alert" className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
        Couldn't read the storage status.
      </div>
    );
  }

  const { disk, files, runs, quarantine } = data;
  const last = runs.find((r) => r.status !== "running");
  const running = runs.some((r) => r.status === "running");
  const pct = disk.percent_used;
  const coverage = files.hashed ? Math.round((100 * files.verified_30d) / files.hashed) : 100;
  const card = "rounded-card border border-[var(--border)] bg-[var(--surface)] p-4";

  return (
    <div className="space-y-4">
      {/* Disk */}
      <section className={card} aria-label="Disk space">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <HardDrive className="h-4 w-4 text-[var(--text-muted)]" /> Disk
          {disk.uploads_paused && (
            <span className="ml-auto rounded bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
              Uploads paused
            </span>
          )}
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-[var(--surface-2)]" aria-hidden>
          <div
            className={cn("h-full rounded-full", pct >= 95 ? "bg-red-500" : pct >= 85 ? "bg-amber-500" : "bg-emerald-500")}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          {humanSize(disk.free)} free of {humanSize(disk.total)} ({pct}% used). Uploads pause below{" "}
          {humanSize(disk.min_free)} free; admins are told at 85% and 95%.
        </p>
      </section>

      {/* Integrity */}
      <section className={card} aria-label="Integrity check">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
          {data.problem_count ? (
            <AlertTriangle className="h-4 w-4 text-red-500" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          )}
          Integrity
          <button
            type="button"
            onClick={() => check.mutate()}
            disabled={running || check.isPending}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 py-1 text-xs font-normal hover:bg-[var(--hover)] disabled:opacity-50"
          >
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {running ? "Checking…" : "Check now"}
          </button>
        </div>
        <p className="text-xs text-[var(--text-muted)]">
          {last
            ? `Last check ${formatRelativeTime(last.finished_at ?? last.started_at)}: ${STATUS_LABEL[last.status]} — ${last.checked.toLocaleString()} files looked at, ${last.verified.toLocaleString()} re-read (${humanSize(last.bytes_verified)}).`
            : "Not checked yet — the first check runs tonight."}{" "}
          Every file is looked at nightly; {coverage}% were re-read against their fingerprint in the last 30 days.
          {files.unhashed > 0 && ` ${files.unhashed.toLocaleString()} older files are still being fingerprinted.`}
        </p>
        {last?.error && <p className="mt-1 text-xs text-red-500">{last.error}</p>}

        {data.problems.length > 0 && (
          <div className="mt-3">
            <h3 className="mb-1 text-xs font-semibold text-red-600 dark:text-red-400">
              {data.problem_count} file{data.problem_count === 1 ? "" : "s"} to restore from a backup
            </h3>
            <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
              {data.problems.map((p) => (
                <li key={p.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 font-medium",
                      p.state === "missing" ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-red-500/15 text-red-600 dark:text-red-400"
                    )}
                  >
                    {p.state === "missing" ? "Missing" : "Damaged"}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={p.storage_path}>
                    {p.filename}
                    <span className="text-[var(--text-muted)]">
                      {" "}
                      · {p.owner ?? "shared"} · {humanSize(p.size_bytes)}
                      {p.trashed ? " · in the trash" : ""}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => recheck.mutate(p.id)}
                    disabled={recheck.isPending}
                    className="shrink-0 rounded border border-[var(--border)] px-2 py-0.5 hover:bg-[var(--hover)]"
                    title="After putting the file back from a backup"
                  >
                    Check again
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[11px] text-[var(--text-muted)]">
              Put each back at its path inside the uploads folder from a backup (shown on hover), then “Check again”.
            </p>
          </div>
        )}
      </section>

      {/* Photos & videos (the media worker) */}
      <section className={card} aria-label="Photos and videos">
        <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <Images className="h-4 w-4 text-[var(--text-muted)]" /> Photos and videos
          {(data.media.counts.failed ?? 0) > 0 && (
            <button
              type="button"
              onClick={() => retryMedia.mutate()}
              disabled={retryMedia.isPending}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 py-1 text-xs font-normal hover:bg-[var(--hover)] disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Try the failed ones again
            </button>
          )}
        </div>
        <p className="text-xs text-[var(--text-muted)]">
          {(data.media.counts.ready ?? 0).toLocaleString()} ready
          {(data.media.counts.pending ?? 0) + (data.media.counts.processing ?? 0) > 0 &&
            ` · ${((data.media.counts.pending ?? 0) + (data.media.counts.processing ?? 0)).toLocaleString()} being prepared`}
          {(data.media.counts.failed ?? 0) > 0 && ` · ${data.media.counts.failed} couldn't be prepared`}
          {" "}— thumbnails, previews and web-playable videos take {humanSize(data.media.derived_bytes)}, made again
          if lost and never counted against anyone's storage.
        </p>
        {data.understanding && (
          <div className="mt-3 border-t border-[var(--border)] pt-3">
            <div className="flex items-center gap-2 text-xs font-medium">
              Understanding photos
              {(data.understanding.gazetteer.error ||
                data.understanding.stages.some((s) => s.failed > 0)) && (
                <button
                  type="button"
                  onClick={() => retryUnderstanding.mutate()}
                  disabled={retryUnderstanding.isPending}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 py-1 text-xs font-normal hover:bg-[var(--hover)] disabled:opacity-50"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Try again
                </button>
              )}
            </div>
            <ul className="mt-1 space-y-0.5 text-xs text-[var(--text-muted)]">
              {data.understanding.stages.map((s) => (
                <li key={s.stage}>
                  {s.label}: {s.done.toLocaleString()} of {s.total.toLocaleString()}
                  {s.failed > 0 && ` · ${s.failed} couldn't be read`}
                  {s.waiting && ` · ${s.waiting}`}
                </li>
              ))}
              <li>
                {data.understanding.gazetteer.places > 0
                  ? `${data.understanding.gazetteer.places.toLocaleString()} place names, offline. ${data.understanding.gazetteer.attribution}.`
                  : data.understanding.gazetteer.error
                    ? `Place names couldn't be downloaded from ${data.understanding.gazetteer.source} (${data.understanding.gazetteer.error}). Without internet, put cities500.zip, admin1CodesASCII.txt and countryInfo.txt in uploads/.geonames/ and try again.`
                    : "Place names are downloaded (about 10 MB) the first time a photo has a location."}
              </li>
            </ul>
          </div>
        )}
      </section>

      {/* Quarantine */}
      <section className={card} aria-label="Quarantine">
        <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4 text-[var(--text-muted)]" /> Quarantine
          {quarantine.count > 0 && (
            <button
              type="button"
              onClick={async () => {
                const ok = await confirm({
                  title: "Delete the quarantined files?",
                  message: `${quarantine.count} file${quarantine.count === 1 ? "" : "s"} (${humanSize(quarantine.bytes)}) that no file in Promptly refers to. This can't be undone.`,
                  confirmLabel: "Delete",
                  danger: true,
                });
                if (ok) empty.mutate();
              }}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 py-1 text-xs font-normal text-red-600 hover:bg-red-500/10 dark:text-red-400"
            >
              <Trash2 className="h-3.5 w-3.5" /> Empty
            </button>
          )}
        </div>
        <p className="text-xs text-[var(--text-muted)]">
          {quarantine.count
            ? `${quarantine.count} file${quarantine.count === 1 ? "" : "s"} (${humanSize(quarantine.bytes)}) on disk that nothing refers to were set aside in .quarantine/ inside the uploads folder. Nothing is deleted on its own — look, then empty it.`
            : "Empty. Once a week, files on disk that nothing refers to are set aside here rather than deleted."}
        </p>
      </section>

      {/* Database checksums */}
      <section className={card} aria-label="Database checksums">
        <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
          {data.checksums ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <AlertTriangle className="h-4 w-4 text-amber-500" />}
          Database checksums {data.checksums ? "on" : data.checksums === false ? "off" : "unknown"}
        </div>
        <p className="text-xs text-[var(--text-muted)]">
          {data.checksums
            ? "Every database page carries a checksum, so a disk quietly corrupting data is noticed."
            : "This database was created before checksums were the default. Switching them on takes a few minutes offline — see “Database checksums” in the README."}
        </p>
      </section>
    </div>
  );
}
