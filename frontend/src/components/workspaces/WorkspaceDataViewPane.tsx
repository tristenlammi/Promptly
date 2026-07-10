import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Database, Loader2, Play } from "lucide-react";

import {
  workspacesApi,
  type DataSourceOption,
  type DataViewResult,
  type WorkspaceItemNode,
} from "@/api/workspaces";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { ItemPaneHeader } from "./ItemPaneHeader";
import { ErrorState } from "@/components/shared/Callout";

function relTime(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function WorkspaceDataViewPane({
  workspaceId,
  dataViewId,
  node,
  canEdit,
}: {
  workspaceId: string;
  dataViewId: string;
  node: WorkspaceItemNode;
  canEdit: boolean;
}) {
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sources, setSources] = useState<DataSourceOption[]>([]);
  const [sourceId, setSourceId] = useState<string>("");
  const [sql, setSql] = useState<string>("");
  const [result, setResult] = useState<DataViewResult | null>(null);
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">(
    "idle"
  );
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);
    Promise.all([
      workspacesApi.getDataView(workspaceId, dataViewId),
      workspacesApi.listDataSources().catch(() => [] as DataSourceOption[]),
    ])
      .then(([dv, srcs]) => {
        if (cancelled) return;
        setSources(srcs);
        setSourceId(dv.data_source_id ?? "");
        setSql(dv.sql ?? "");
        setResult(dv.data ?? null);
        setLastRunAt(dv.last_run_at);
        setLastError(dv.last_error);
        setLoaded(true);
      })
      .catch((e) => {
        if (!cancelled)
          setLoadError(apiErrorMessage(e, "Couldn't open this data view."));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, dataViewId]);

  const saveConfig = useCallback(
    (nextSource: string, nextSql: string) => {
      if (!canEdit) return;
      setSaveState("saving");
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(async () => {
        try {
          await workspacesApi.saveDataView(workspaceId, dataViewId, {
            data_source_id: nextSource || null,
            sql: nextSql,
          });
          setSaveState("saved");
        } catch {
          setSaveState("idle");
        }
      }, 600);
    },
    [canEdit, workspaceId, dataViewId]
  );

  const onSource = (v: string) => {
    setSourceId(v);
    saveConfig(v, sql);
  };
  const onSql = (v: string) => {
    setSql(v);
    saveConfig(sourceId, v);
  };

  const run = useCallback(async () => {
    setRunning(true);
    setLastError(null);
    try {
      // Persist first so the run uses the latest source + query.
      if (canEdit) {
        await workspacesApi.saveDataView(workspaceId, dataViewId, {
          data_source_id: sourceId || null,
          sql,
        });
      }
      const dv = await workspacesApi.runDataView(workspaceId, dataViewId);
      setResult(dv.data ?? null);
      setLastRunAt(dv.last_run_at);
      setLastError(dv.last_error);
    } catch (e) {
      setLastError(apiErrorMessage(e, "Query failed."));
    } finally {
      setRunning(false);
    }
  }, [canEdit, workspaceId, dataViewId, sourceId, sql]);

  useEffect(
    () => () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    },
    []
  );

  if (loadError) return <ErrorState>{loadError}</ErrorState>;
  if (!loaded) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10 text-sm text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Opening data view…
        </span>
      </div>
    );
  }

  const canRun = !running && !!sourceId && sql.trim().length > 0;
  const statusChip =
    saveState === "saving" ? (
      <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
        <Loader2 className="h-3 w-3 animate-spin" /> Saving…
      </span>
    ) : saveState === "saved" ? (
      <span className="text-[11px] text-[var(--text-muted)]">Saved</span>
    ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ItemPaneHeader
        workspaceId={workspaceId}
        itemId={node.id}
        kind="dataview"
        fallbackTitle={node.title}
        canEdit={canEdit}
        status={statusChip}
      />

      <div className="promptly-scroll min-h-0 flex-1 overflow-y-auto">
        {/* Query builder */}
        <div className="border-b border-[var(--border)] px-4 py-3">
          {sources.length === 0 ? (
            <div className="flex items-start gap-2 rounded-card border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-300">
              <Database className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                No data sources are configured. An admin can add a read-only
                database connection under Admin → Data sources.
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                <Database className="h-3.5 w-3.5" />
                Source
                <select
                  value={sourceId}
                  disabled={!canEdit}
                  onChange={(e) => onSource(e.target.value)}
                  className="rounded-input border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)] disabled:opacity-60"
                >
                  <option value="">Choose a database…</option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => void run()}
                disabled={!canRun}
                className={cn(
                  "ml-auto inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition",
                  "bg-[var(--accent)] text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                )}
              >
                {running ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                Run
              </button>
            </div>
          )}

          <textarea
            value={sql}
            disabled={!canEdit}
            onChange={(e) => onSql(e.target.value)}
            placeholder="SELECT … (read-only — a single SELECT or WITH query)"
            spellCheck={false}
            rows={4}
            className="promptly-scroll mt-2 w-full resize-y rounded-card border border-[var(--border)] bg-[var(--bg)] px-3 py-2 font-mono text-xs text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/60 focus:outline-none disabled:opacity-60"
          />
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
            <span>Read-only · one SELECT · 1,000-row cap · 15s timeout</span>
            <span>Last run: {relTime(lastRunAt)}</span>
          </div>
        </div>

        {/* Error / result */}
        {lastError && (
          <div className="mx-4 mt-3 flex items-start gap-2 rounded-card border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="break-words">{lastError}</span>
          </div>
        )}

        {result && result.columns.length > 0 ? (
          <div className="px-4 py-3">
            {result.truncated && (
              <p className="mb-1.5 text-[11px] text-[var(--text-muted)]">
                Showing the first {result.row_count.toLocaleString()} rows (result
                was truncated).
              </p>
            )}
            <div className="promptly-scroll overflow-auto rounded-card border border-[var(--border)]">
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0">
                  <tr className="border-b border-[var(--border)] bg-[var(--surface)]">
                    {result.columns.map((c, i) => (
                      <th
                        key={i}
                        className="whitespace-nowrap px-2.5 py-1.5 text-left font-semibold text-[var(--text)]"
                      >
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, ri) => (
                    <tr
                      key={ri}
                      className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--hover)]"
                    >
                      {row.map((v, ci) => (
                        <td
                          key={ci}
                          className="max-w-[320px] truncate px-2.5 py-1 text-[var(--text)]"
                          title={v == null ? "" : String(v)}
                        >
                          {v == null ? (
                            <span className="text-[var(--text-muted)]">∅</span>
                          ) : (
                            String(v)
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] text-[var(--text-muted)]">
              This result is indexed into the workspace, so its chat can answer
              from the latest data.
            </p>
          </div>
        ) : (
          !lastError && (
            <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center text-sm text-[var(--text-muted)]">
              <Database className="h-6 w-6 opacity-50" />
              {canEdit
                ? "Pick a source, write a SELECT, and press Run."
                : "No results yet."}
            </div>
          )
        )}
      </div>
    </div>
  );
}
