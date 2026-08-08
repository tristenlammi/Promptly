import { useQuery } from "@tanstack/react-query";
import { Activity, Database, MessageSquare, Timer } from "lucide-react";

import { adminApi } from "@/api/admin";
import { cn } from "@/utils/cn";

/**
 * Live runtime health for the admin Console.
 *
 * Exists because several resource-starvation bugs (a pooled DB connection
 * held for a whole generation, 100 MB uploads blocking the event loop,
 * background tasks collected mid-flight) were all fixed blind — there was no
 * way to confirm a fix held, or to spot the next one before users did.
 *
 * The DB-pool bar is the important one: that ceiling is what turned a busy
 * instance into a restart loop.
 */
export function HealthPanel() {
  const { data, isLoading, isError, dataUpdatedAt } = useQuery({
    queryKey: ["admin", "runtime-metrics"],
    queryFn: adminApi.runtimeMetrics,
    // Live enough to watch a spike develop, slow enough to be free.
    refetchInterval: 5000,
  });

  if (isLoading) {
    return (
      <div className="py-8 text-center text-xs text-[var(--text-muted)]">
        Reading process metrics…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div
        role="alert"
        className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
      >
        Couldn't read runtime metrics.
      </div>
    );
  }

  const pool = data.db_pool;
  const poolPct = pool.available ? pool.utilisation_pct : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          icon={<Timer className="h-4 w-4" />}
          label="Uptime"
          value={formatUptime(data.uptime_seconds)}
        />
        <Stat
          icon={<MessageSquare className="h-4 w-4" />}
          label="Active replies"
          value={String(data.streams.active)}
          hint={
            data.streams.retained > data.streams.active
              ? `${data.streams.retained - data.streams.active} finished, kept for replay`
              : undefined
          }
        />
        <Stat
          icon={<Activity className="h-4 w-4" />}
          label="Background tasks"
          value={String(data.background_tasks)}
          hint="in flight"
        />
        <Stat
          icon={<Database className="h-4 w-4" />}
          label="Memory"
          value={
            data.memory_rss_bytes === null
              ? "—"
              : `${(data.memory_rss_bytes / 1024 / 1024).toFixed(0)} MB`
          }
        />
      </div>

      {/* DB pool — the metric behind the outage loop a busy instance used to
          hit. Exhaustion blocked /api/health too, so the container got
          restarted, killing every in-flight reply. */}
      <section className="rounded-card border border-[var(--border)] p-4">
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-sm font-medium">Database connections</h3>
          {pool.available && (
            <span className="text-xs text-[var(--text-muted)]">
              {pool.checked_out} of {pool.capacity} in use
            </span>
          )}
        </div>
        {pool.available ? (
          <>
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-[var(--bg)]"
              role="progressbar"
              aria-valuenow={poolPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Database connection pool usage"
            >
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  poolPct >= 80
                    ? "bg-red-500"
                    : poolPct >= 50
                      ? "bg-amber-500"
                      : "bg-[var(--accent)]"
                )}
                style={{ width: `${Math.min(100, poolPct)}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-[var(--text-muted)]">
              {poolPct >= 80
                ? "Close to the ceiling — new requests will start queueing, including the health check."
                : "Each in-flight request holds one connection while it's actively querying."}
            </p>
          </>
        ) : (
          <p className="text-xs text-[var(--text-muted)]">
            Pool statistics unavailable.
          </p>
        )}
      </section>

      <section className="rounded-card border border-[var(--border)] p-4">
        <h3 className="mb-3 text-sm font-medium">Requests</h3>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
          <Row label="Total" value={data.requests.total.toLocaleString()} />
          <Row
            label="Errors (5xx)"
            value={`${data.requests.by_class["5xx"] ?? 0} (${data.requests.error_rate_pct}%)`}
            tone={data.requests.error_rate_pct > 1 ? "bad" : undefined}
          />
          <Row label="4xx" value={String(data.requests.by_class["4xx"] ?? 0)} />
          <Row label="2xx" value={String(data.requests.by_class["2xx"] ?? 0)} />
        </div>

        <h4 className="mb-2 mt-4 text-xs font-medium text-[var(--text-muted)]">
          Response time (last {data.latency_ms.samples} requests)
        </h4>
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
          <Row label="Median" value={`${data.latency_ms.p50} ms`} />
          <Row label="p95" value={`${data.latency_ms.p95} ms`} />
          <Row label="p99" value={`${data.latency_ms.p99} ms`} />
          <Row label="Max" value={`${data.latency_ms.max} ms`} />
        </div>
        {data.latency_ms.slowest_route && (
          <p className="mt-3 text-xs text-[var(--text-muted)]">
            Slowest since start:{" "}
            <span className="font-mono">{data.latency_ms.slowest_route}</span> at{" "}
            {data.latency_ms.slowest_ms} ms
          </p>
        )}
      </section>

      <p className="text-[11px] text-[var(--text-muted)]">
        Process-local and reset on restart — the backend runs as a single
        worker, so this describes the whole app. Updated{" "}
        {new Date(dataUpdatedAt).toLocaleTimeString()}.
      </p>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-card border border-[var(--border)] p-3">
      <div className="flex items-center gap-1.5 text-[var(--text-muted)]">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <div className="mt-1 text-lg font-medium">{value}</div>
      {hint && (
        <div className="text-[11px] text-[var(--text-muted)]">{hint}</div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "bad";
}) {
  return (
    <div>
      <div className="text-[var(--text-muted)]">{label}</div>
      <div
        className={cn(
          "font-medium",
          tone === "bad" && "text-red-600 dark:text-red-400"
        )}
      >
        {value}
      </div>
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
