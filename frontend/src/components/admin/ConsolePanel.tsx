import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bug,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { API_BASE_URL, authHeader } from "@/api/client";
import {
  useErrorEvent,
  useErrorGroupEvents,
  useErrorGroups,
  useReopenErrorGroup,
  useResolveErrorGroup,
} from "@/hooks/useAdminUsers";
import { cn } from "@/utils/cn";
import type { ErrorGroupRow } from "@/api/types";

type Tab = "live" | "errors";
type Level = "" | "INFO" | "WARNING" | "ERROR";

const TAB_LABELS: Record<Tab, string> = {
  live: "Live logs",
  errors: "Errors",
};

export function ConsolePanel() {
  const [tab, setTab] = useState<Tab>("live");

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Console tabs"
        className="inline-flex overflow-hidden rounded-input border border-[var(--border)]"
      >
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition",
              tab === t
                ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                : "text-[var(--text-muted)] hover:text-[var(--text)]"
            )}
          >
            {t === "live" ? (
              <CircleDot className="h-3.5 w-3.5" />
            ) : (
              <Bug className="h-3.5 w-3.5" />
            )}
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {tab === "live" ? <LiveLogs /> : <ErrorsView />}
    </div>
  );
}

// --------------------------------------------------------------------
// Live logs (SSE tail)
// --------------------------------------------------------------------
interface LogLine {
  raw: string;
  parsed: LogRecord | null;
  receivedAt: number;
}

interface LogRecord {
  ts?: string;
  level?: string;
  logger?: string;
  message?: string;
  request_id?: string;
  user_id?: string;
  route?: string;
  status_code?: number | string;
  latency_ms?: number;
  exception_class?: string;
  stack?: string;
  [key: string]: unknown;
}

const MAX_LINES = 500;

function LiveLogs() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useState<Level>("");
  const [filter, setFilter] = useState("");
  const [requestFilter, setRequestFilter] = useState("");
  const [userFilter, setUserFilter] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const idCounter = useRef(0);

  // Stream subscription. Reconnects whenever level changes.
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setError(null);
    setConnected(false);

    (async () => {
      try {
        const url = new URL(
          `${API_BASE_URL}/admin/logs/stream`,
          window.location.origin
        );
        if (level) url.searchParams.set("level", level);
        const resp = await fetch(url.toString(), {
          method: "GET",
          headers: {
            ...authHeader(),
            Accept: "text/event-stream",
          },
          signal: controller.signal,
        });
        if (!resp.ok || !resp.body) {
          throw new Error(`SSE failed (${resp.status})`);
        }
        setConnected(true);
        const reader = resp.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE frames are terminated by "\n\n" — split on that and
          // process whole frames; keep the trailing partial in buffer.
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const dataLines = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart());
            if (dataLines.length === 0) continue;
            const raw = dataLines.join("\n");
            ingestLine(raw);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Stream error");
        }
      } finally {
        setConnected(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level]);

  function ingestLine(raw: string) {
    if (pausedRef.current) return;
    let parsed: LogRecord | null = null;
    try {
      parsed = JSON.parse(raw) as LogRecord;
    } catch {
      // Non-JSON sentinel (the "hello" greeting etc.) — keep as raw.
      parsed = null;
    }
    setLines((prev) => {
      const next = [...prev, { raw, parsed, receivedAt: Date.now() }];
      if (next.length > MAX_LINES) {
        next.splice(0, next.length - MAX_LINES);
      }
      return next;
    });
  }

  // Keep view scrolled to the bottom while autoscroll is on.
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, autoScroll]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rq = requestFilter.trim();
    const uq = userFilter.trim();
    return lines
      .map((l, i) => ({ ...l, idx: i }))
      .filter((l) => {
        if (l.parsed) {
          if (rq && l.parsed.request_id !== rq) return false;
          if (uq && l.parsed.user_id !== uq) return false;
        } else if (rq || uq) {
          return false;
        }
        if (q && !l.raw.toLowerCase().includes(q)) return false;
        return true;
      });
  }, [lines, filter, requestFilter, userFilter]);

  const toggleExpand = (idx: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ConnectionPill connected={connected} paused={paused} />
        <Select
          ariaLabel="Minimum level"
          value={level}
          onChange={(v) => setLevel(v as Level)}
        >
          <option value="">All levels</option>
          <option value="INFO">Info+</option>
          <option value="WARNING">Warning+</option>
          <option value="ERROR">Error+</option>
        </Select>
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            type="text"
            placeholder="Filter text…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className={cn(
              "h-8 w-full rounded-input border bg-[var(--surface)] pl-7 pr-2 text-xs",
              "border-[var(--border)] text-[var(--text)]",
              "focus:border-[var(--accent)] focus:outline-none"
            )}
          />
        </div>
        <input
          type="text"
          placeholder="request_id"
          value={requestFilter}
          onChange={(e) => setRequestFilter(e.target.value)}
          className={cn(
            "h-8 w-32 rounded-input border bg-[var(--surface)] px-2 text-xs font-mono",
            "border-[var(--border)] text-[var(--text)]",
            "focus:border-[var(--accent)] focus:outline-none"
          )}
        />
        <input
          type="text"
          placeholder="user_id"
          value={userFilter}
          onChange={(e) => setUserFilter(e.target.value)}
          className={cn(
            "h-8 w-32 rounded-input border bg-[var(--surface)] px-2 text-xs font-mono",
            "border-[var(--border)] text-[var(--text)]",
            "focus:border-[var(--accent)] focus:outline-none"
          )}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={
            paused ? (
              <Play className="h-3.5 w-3.5" />
            ) : (
              <Pause className="h-3.5 w-3.5" />
            )
          }
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<Trash2 className="h-3.5 w-3.5" />}
          onClick={() => setLines([])}
        >
          Clear
        </Button>
        <label className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          Autoscroll
        </label>
      </div>

      {error && (
        <div className="rounded-card border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {error}. The connection will retry on the next page reload.
        </div>
      )}

      <div
        ref={scrollRef}
        className="h-[480px] overflow-y-auto rounded-card border border-[var(--border)] bg-black/[0.02] font-mono text-[11px] leading-relaxed dark:bg-white/[0.02]"
      >
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-[var(--text-muted)]">
            {connected
              ? "Waiting for log activity…"
              : "Connecting to log stream…"}
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {filtered.map((l) => {
              const id = idCounter.current++;
              const open = expanded.has(l.idx);
              return (
                <li
                  key={`${l.idx}-${id}`}
                  className="px-2 py-1 hover:bg-[var(--surface-hover)]"
                >
                  <button
                    type="button"
                    onClick={() => toggleExpand(l.idx)}
                    className="flex w-full items-start gap-2 text-left"
                  >
                    {open ? (
                      <ChevronDown className="mt-0.5 h-3 w-3 shrink-0 text-[var(--text-muted)]" />
                    ) : (
                      <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-[var(--text-muted)]" />
                    )}
                    <LogLineSummary line={l} />
                  </button>
                  {open && (
                    <pre className="mt-1 ml-5 max-h-64 overflow-auto rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-[10px] text-[var(--text)] whitespace-pre-wrap break-all">
                      {prettyPrint(l.raw)}
                    </pre>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex justify-between text-[11px] text-[var(--text-muted)]">
        <span>
          {filtered.length} / {lines.length} lines
        </span>
        <span>Buffer keeps the last {MAX_LINES} lines client-side.</span>
      </div>
    </div>
  );
}

function ConnectionPill({
  connected,
  paused,
}: {
  connected: boolean;
  paused: boolean;
}) {
  const status = paused
    ? { label: "Paused", color: "bg-amber-500/15 text-amber-700 dark:text-amber-400" }
    : connected
      ? { label: "Live", color: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" }
      : { label: "Offline", color: "bg-red-500/15 text-red-600 dark:text-red-400" };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
        status.color
      )}
    >
      <span
        className={cn(
          "inline-block h-1.5 w-1.5 rounded-full",
          paused
            ? "bg-amber-500"
            : connected
              ? "animate-pulse bg-emerald-500"
              : "bg-red-500"
        )}
      />
      {status.label}
    </span>
  );
}

function LogLineSummary({ line }: { line: LogLine }) {
  const r = line.parsed;
  if (!r) {
    return (
      <span className="break-all text-[var(--text-muted)]">{line.raw}</span>
    );
  }
  return (
    <div className="min-w-0 flex-1 grid grid-cols-[auto_auto_1fr] items-baseline gap-2">
      <LevelBadge level={r.level} />
      <span className="text-[10px] text-[var(--text-muted)] tabular-nums">
        {formatTs(r.ts)}
      </span>
      <span className="min-w-0 break-all text-[var(--text)]">
        {r.message ?? ""}
        {r.route && (
          <span className="ml-1 text-[10px] text-[var(--text-muted)]">
            · {r.route}
          </span>
        )}
        {r.exception_class && (
          <span className="ml-1 text-[10px] text-red-600 dark:text-red-400">
            · {r.exception_class}
          </span>
        )}
      </span>
    </div>
  );
}

function LevelBadge({ level }: { level?: string }) {
  const lv = (level ?? "INFO").toUpperCase();
  const styles: Record<string, string> = {
    DEBUG: "bg-slate-500/15 text-slate-600 dark:text-slate-300",
    INFO: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
    WARNING: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    ERROR: "bg-red-500/15 text-red-600 dark:text-red-400",
    CRITICAL: "bg-red-700/20 text-red-700 dark:text-red-300",
  };
  return (
    <span
      className={cn(
        "inline-block rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider",
        styles[lv] ?? styles.INFO
      )}
    >
      {lv}
    </span>
  );
}

// --------------------------------------------------------------------
// Errors view
// --------------------------------------------------------------------
function ErrorsView() {
  const [status, setStatus] = useState<"open" | "resolved" | "all">("open");
  const [q, setQ] = useState("");
  const [openGroup, setOpenGroup] = useState<ErrorGroupRow | null>(null);
  const groups = useErrorGroups({ status, q: q || undefined });
  const resolve = useResolveErrorGroup();
  const reopen = useReopenErrorGroup();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          ariaLabel="Status filter"
          value={status}
          onChange={(v) => setStatus(v as "open" | "resolved" | "all")}
        >
          <option value="open">Open issues</option>
          <option value="resolved">Resolved</option>
          <option value="all">All</option>
        </Select>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            type="text"
            placeholder="Search messages…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className={cn(
              "h-8 w-full rounded-input border bg-[var(--surface)] pl-7 pr-2 text-xs",
              "border-[var(--border)] text-[var(--text)]",
              "focus:border-[var(--accent)] focus:outline-none"
            )}
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={
            <RefreshCw
              className={cn(
                "h-3.5 w-3.5",
                groups.isFetching && "animate-spin"
              )}
            />
          }
          onClick={() => groups.refetch()}
          disabled={groups.isFetching}
        >
          Refresh
        </Button>
      </div>

      {groups.isError && (
        <div
          role="alert"
          className="rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400"
        >
          Failed to load error groups.
        </div>
      )}

      <div className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
        {groups.isLoading ? (
          <div className="flex items-center justify-center px-4 py-12 text-sm text-[var(--text-muted)]">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading errors…
          </div>
        ) : (groups.data ?? []).length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-[var(--text-muted)]">
            No {status === "open" ? "open" : status} issues — nice.
          </div>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-[var(--border)] bg-black/[0.02] text-left text-[10px] uppercase tracking-wider text-[var(--text-muted)] dark:bg-white/[0.03]">
                <th className="px-3 py-2 font-semibold">Issue</th>
                <th className="px-3 py-2 font-semibold text-right">Count</th>
                <th className="px-3 py-2 font-semibold">First seen</th>
                <th className="px-3 py-2 font-semibold">Last seen</th>
                <th className="px-3 py-2 font-semibold w-32">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(groups.data ?? []).map((g) => (
                <tr
                  key={g.fingerprint}
                  className="cursor-pointer border-t border-[var(--border)] first:border-t-0 hover:bg-[var(--surface-hover)]"
                  onClick={() => setOpenGroup(g)}
                >
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <LevelBadge level={g.level} />
                      {g.resolved ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                      )}
                    </div>
                    <div className="mt-1 text-xs font-medium text-[var(--text)]">
                      {g.exception_class ?? g.logger}
                    </div>
                    <div
                      className="text-[11px] text-[var(--text-muted)] truncate max-w-[60ch]"
                      title={g.sample_message}
                    >
                      {g.sample_message}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-medium">
                    {g.occurrences}
                  </td>
                  <td className="px-3 py-2.5 text-[var(--text-muted)]">
                    {relativeTime(new Date(g.first_seen_at))}
                  </td>
                  <td className="px-3 py-2.5 text-[var(--text-muted)]">
                    {relativeTime(new Date(g.last_seen_at))}
                  </td>
                  <td
                    className="px-3 py-2.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {g.resolved ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => reopen.mutate(g.fingerprint)}
                        disabled={reopen.isPending}
                      >
                        Reopen
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => resolve.mutate(g.fingerprint)}
                        disabled={resolve.isPending}
                      >
                        Resolve
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ErrorGroupDialog
        group={openGroup}
        onClose={() => setOpenGroup(null)}
      />
    </div>
  );
}

function ErrorGroupDialog({
  group,
  onClose,
}: {
  group: ErrorGroupRow | null;
  onClose: () => void;
}) {
  const events = useErrorGroupEvents(group?.fingerprint ?? null);
  const [eventId, setEventId] = useState<string | null>(null);
  const detail = useErrorEvent(eventId);

  // Reset selected event when switching groups.
  const groupId = group?.fingerprint ?? null;
  const selectedRef = useRef(eventId);
  selectedRef.current = eventId;
  useEffect(() => {
    setEventId(null);
  }, [groupId]);

  return (
    <Modal
      open={group !== null}
      onClose={onClose}
      title={
        group
          ? group.exception_class || group.logger || "Error issue"
          : "Issue"
      }
      description={group?.sample_message}
      widthClass="max-w-4xl"
    >
      {group && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
          <div>
            <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              Occurrences
            </div>
            <div className="max-h-[420px] overflow-y-auto rounded-card border border-[var(--border)]">
              {events.isLoading ? (
                <div className="flex items-center justify-center px-3 py-6 text-xs text-[var(--text-muted)]">
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  Loading…
                </div>
              ) : (events.data ?? []).length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-[var(--text-muted)]">
                  No events.
                </div>
              ) : (
                <ul>
                  {(events.data ?? []).map((ev) => (
                    <li key={ev.id}>
                      <button
                        type="button"
                        onClick={() => setEventId(ev.id)}
                        className={cn(
                          "block w-full px-2.5 py-1.5 text-left text-[11px]",
                          ev.id === eventId
                            ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                            : "hover:bg-[var(--surface-hover)]"
                        )}
                      >
                        <div className="font-medium">
                          {new Date(ev.created_at).toLocaleString()}
                        </div>
                        <div className="text-[10px] text-[var(--text-muted)] truncate">
                          {ev.route ?? ev.logger}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div>
            <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              Detail
            </div>
            {!eventId ? (
              <div className="rounded-card border border-dashed border-[var(--border)] px-4 py-12 text-center text-xs text-[var(--text-muted)]">
                Select an occurrence on the left to inspect.
              </div>
            ) : detail.isLoading ? (
              <div className="flex items-center gap-2 px-3 py-6 text-xs text-[var(--text-muted)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading event…
              </div>
            ) : detail.data ? (
              <DetailPanel detail={detail.data} />
            ) : (
              <div className="text-xs text-[var(--text-muted)]">
                Event not found.
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function DetailPanel({
  detail,
}: {
  detail: import("@/api/types").ErrorEventDetail;
}) {
  const [showStack, setShowStack] = useState(true);
  const copyDetails = useCallback(() => {
    const text = JSON.stringify(detail, null, 2);
    void navigator.clipboard.writeText(text);
  }, [detail]);

  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <LevelBadge level={detail.level} />
        <span className="font-mono text-[10px] text-[var(--text-muted)]">
          {detail.id}
        </span>
        <Button variant="ghost" size="sm" onClick={copyDetails}>
          Copy JSON
        </Button>
      </div>
      <DetailRow label="When">
        {new Date(detail.created_at).toLocaleString()}
      </DetailRow>
      <DetailRow label="Logger">{detail.logger}</DetailRow>
      {detail.exception_class && (
        <DetailRow label="Class">{detail.exception_class}</DetailRow>
      )}
      <DetailRow label="Message">
        <span className="whitespace-pre-wrap break-words">{detail.message}</span>
      </DetailRow>
      {detail.route && <DetailRow label="Route">{detail.route}</DetailRow>}
      {detail.status_code !== null && (
        <DetailRow label="Status">{detail.status_code}</DetailRow>
      )}
      {detail.request_id && (
        <DetailRow label="request_id">
          <span className="font-mono">{detail.request_id}</span>
        </DetailRow>
      )}
      {detail.user_id && (
        <DetailRow label="user_id">
          <span className="font-mono">{detail.user_id}</span>
        </DetailRow>
      )}
      {detail.extra && Object.keys(detail.extra).length > 0 && (
        <DetailRow label="Extra">
          <pre className="overflow-auto rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-[10px]">
            {JSON.stringify(detail.extra, null, 2)}
          </pre>
        </DetailRow>
      )}
      {detail.stack && (
        <div>
          <button
            type="button"
            onClick={() => setShowStack((v) => !v)}
            className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text)]"
          >
            {showStack ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Stack trace
          </button>
          {showStack && (
            <pre className="mt-1 max-h-72 overflow-auto rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-[10px] whitespace-pre-wrap break-all">
              {detail.stack}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[100px_1fr] items-baseline gap-2">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </div>
      <div className="text-xs text-[var(--text)]">{children}</div>
    </div>
  );
}

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------
function Select({
  value,
  onChange,
  children,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  ariaLabel: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      className={cn(
        "h-8 rounded-input border bg-[var(--surface)] px-2 text-xs",
        "border-[var(--border)] text-[var(--text)]",
        "focus:border-[var(--accent)] focus:outline-none"
      )}
    >
      {children}
    </select>
  );
}

function formatTs(ts?: string): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return ts;
  }
}

function prettyPrint(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function relativeTime(when: Date): string {
  const diffSec = Math.round((Date.now() - when.getTime()) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86_400)}d ago`;
}
