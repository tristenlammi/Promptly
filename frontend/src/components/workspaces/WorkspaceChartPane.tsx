import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AreaChart as AreaIcon,
  BarChart3,
  Loader2,
  LineChart as LineIcon,
  PieChart as PieIcon,
  Plus,
  Table2,
  Trash2,
} from "lucide-react";

import {
  workspacesApi,
  type ChartDoc,
  type ChartType,
  type WorkspaceItemNode,
} from "@/api/workspaces";
import { useWorkspaceTree } from "@/hooks/useWorkspaces";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

import { ItemPaneHeader } from "./ItemPaneHeader";
import { ErrorState } from "@/components/shared/Callout";

// Series colours — accent first, then a spread of distinct hues. Themed via
// the accent CSS var; the rest are fixed so a chart reads the same in light
// and dark.
const PALETTE = [
  "var(--accent)",
  "#4C86E0",
  "#4C9A6A",
  "#C99A3E",
  "#8B5CF6",
  "#EC4899",
  "#159AA8",
  "#E06B4C",
];

const CHART_TYPES: { type: ChartType; label: string; icon: typeof BarChart3 }[] =
  [
    { type: "bar", label: "Bar", icon: BarChart3 },
    { type: "line", label: "Line", icon: LineIcon },
    { type: "area", label: "Area", icon: AreaIcon },
    { type: "pie", label: "Pie", icon: PieIcon },
  ];

function emptyDoc(): ChartDoc {
  return {
    chartType: "bar",
    labelKey: "Category",
    valueKeys: ["Value"],
    rows: [
      { Category: "A", Value: 10 },
      { Category: "B", Value: 20 },
      { Category: "C", Value: 15 },
    ],
  };
}

/** Ordered union of column names across rows (falling back to the configured
 *  label/value keys so freshly-emptied charts keep their columns). */
function columnsOf(doc: ChartDoc): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (k: string) => {
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  };
  add(doc.labelKey);
  doc.valueKeys.forEach(add);
  for (const row of doc.rows) Object.keys(row).forEach(add);
  return out;
}

function toNum(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

/** Flattened text table pushed to the backend for workspace RAG so a chat can
 *  answer questions about the numbers. */
function toContentText(title: string, doc: ChartDoc): string {
  const cols = columnsOf(doc);
  if (!doc.rows.length || !cols.length) return "";
  const lines = [
    `Chart: ${title} (${doc.chartType}).`,
    `Columns: ${cols.join(", ")}.`,
    ...doc.rows.map(
      (r) => cols.map((c) => `${c}: ${r[c] ?? ""}`).join(" · ")
    ),
  ];
  return lines.join("\n");
}

/** Decode a Fortune-sheet workbook (the `Spreadsheet.data` shape) into a
 *  header row + data rows. Mirrors the backend's `_sheet_csvs`: cells are a
 *  sparse `{r,c,v}` list where `v` is `{m,v}` (display over raw) or a scalar;
 *  row 0 is the header. Reads the first tab only. */
function decodeSheet(data: unknown): {
  headers: string[];
  rows: Record<string, string | number>[];
} {
  if (!Array.isArray(data) || data.length === 0) return { headers: [], rows: [] };
  const sheet = data[0] as { celldata?: unknown };
  const cells = sheet?.celldata;
  if (!Array.isArray(cells)) return { headers: [], rows: [] };

  const grid = new Map<string, string>();
  let maxR = -1;
  let maxC = -1;
  for (const cell of cells as { r?: number; c?: number; v?: unknown }[]) {
    const r = Number(cell?.r);
    const c = Number(cell?.c);
    if (!Number.isInteger(r) || !Number.isInteger(c)) continue;
    const v = cell?.v;
    let text: unknown;
    if (v && typeof v === "object") {
      const o = v as { m?: unknown; v?: unknown };
      text = o.m ?? o.v;
    } else {
      text = v;
    }
    if (text == null || text === "") continue;
    grid.set(`${r}:${c}`, String(text));
    maxR = Math.max(maxR, r);
    maxC = Math.max(maxC, c);
  }
  if (maxR < 0) return { headers: [], rows: [] };
  const at = (r: number, c: number) => grid.get(`${r}:${c}`) ?? "";

  const headers: string[] = [];
  for (let c = 0; c <= maxC; c++) {
    let name = at(0, c).trim() || `Column ${c + 1}`;
    while (headers.includes(name)) name = `${name}_`;
    headers.push(name);
  }
  const rows: Record<string, string | number>[] = [];
  for (let r = 1; r <= maxR; r++) {
    const row: Record<string, string | number> = {};
    let any = false;
    for (let c = 0; c <= maxC; c++) {
      const val = at(r, c);
      row[headers[c]] = val;
      if (val !== "") any = true;
    }
    if (any) rows.push(row);
  }
  return { headers, rows };
}

export function WorkspaceChartPane({
  workspaceId,
  chartId,
  node,
  canEdit,
}: {
  workspaceId: string;
  chartId: string;
  node: WorkspaceItemNode;
  canEdit: boolean;
}) {
  const [doc, setDoc] = useState<ChartDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">(
    "idle"
  );
  const saveTimer = useRef<number | null>(null);
  const latest = useRef<ChartDoc | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setError(null);
    workspacesApi
      .getChart(workspaceId, chartId)
      .then((res) => {
        if (cancelled) return;
        const d = (res.data as ChartDoc | null) ?? emptyDoc();
        setDoc(d);
        latest.current = d;
      })
      .catch((e) => {
        if (!cancelled) setError(apiErrorMessage(e, "Couldn't open this chart."));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, chartId]);

  const flush = useCallback(async () => {
    const next = latest.current;
    if (!next) return;
    setSaveState("saving");
    try {
      await workspacesApi.saveChart(workspaceId, chartId, {
        data: next,
        content_text: toContentText(node.title || "Chart", next),
      });
      setSaveState("saved");
    } catch {
      setSaveState("idle");
    }
  }, [workspaceId, chartId, node.title]);

  const commit = useCallback(
    (next: ChartDoc) => {
      setDoc(next);
      latest.current = next;
      if (!canEdit) return;
      setSaveState("saving");
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void flush(), 700);
    },
    [canEdit, flush]
  );

  // Flush any pending save on unmount.
  useEffect(
    () => () => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
        void flush();
      }
    },
    [flush]
  );

  const columns = useMemo(() => (doc ? columnsOf(doc) : []), [doc]);
  const chartData = useMemo(() => {
    if (!doc) return [];
    return doc.rows.map((r) => {
      const o: Record<string, string | number> = {
        [doc.labelKey]: String(r[doc.labelKey] ?? ""),
      };
      for (const k of doc.valueKeys) o[k] = toNum(r[k]);
      return o;
    });
  }, [doc]);

  // Workspace sheets available to import data from (a snapshot — the chart
  // keeps its own copy of the rows, it doesn't live-link to the sheet).
  const { data: tree } = useWorkspaceTree(workspaceId);
  const sheets = useMemo(() => {
    const out: { refId: string; title: string }[] = [];
    const walk = (nodes: WorkspaceItemNode[] | undefined) => {
      for (const n of nodes ?? []) {
        if (n.kind === "sheet" && n.ref_id)
          out.push({ refId: n.ref_id, title: n.title || "Untitled sheet" });
        if (n.children?.length) walk(n.children);
      }
    };
    walk(tree);
    return out;
  }, [tree]);
  const [importing, setImporting] = useState(false);

  const importFromSheet = useCallback(
    async (sheetRefId: string) => {
      if (!sheetRefId || !doc) return;
      setImporting(true);
      try {
        const sheet = await workspacesApi.getSpreadsheet(
          workspaceId,
          sheetRefId
        );
        const { headers, rows } = decodeSheet(sheet.data);
        if (!headers.length || !rows.length) {
          toast.error("That sheet has no data to chart yet.");
          return;
        }
        commit({
          ...doc,
          labelKey: headers[0],
          valueKeys: headers.slice(1),
          rows,
          sourceSheetId: sheetRefId,
        });
        toast.success(`Imported ${rows.length} rows from “${sheet.title}”.`);
      } catch (e) {
        toast.error(apiErrorMessage(e, "Couldn't import from that sheet."));
      } finally {
        setImporting(false);
      }
    },
    [doc, workspaceId, commit]
  );

  if (error) return <ErrorState>{error}</ErrorState>;
  if (!doc) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10 text-sm text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Opening chart…
        </span>
      </div>
    );
  }

  const statusChip =
    saveState === "saving" ? (
      <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
        <Loader2 className="h-3 w-3 animate-spin" /> Saving…
      </span>
    ) : saveState === "saved" ? (
      <span className="text-[11px] text-[var(--text-muted)]">Saved</span>
    ) : null;

  // --- Mutators (all go through commit) ---
  const setType = (chartType: ChartType) => commit({ ...doc, chartType });
  const setLabelKey = (labelKey: string) =>
    commit({
      ...doc,
      labelKey,
      valueKeys: doc.valueKeys.filter((k) => k !== labelKey),
    });
  const toggleValue = (key: string) =>
    commit({
      ...doc,
      valueKeys: doc.valueKeys.includes(key)
        ? doc.valueKeys.filter((k) => k !== key)
        : [...doc.valueKeys, key],
    });
  const setCell = (rowIdx: number, col: string, value: string) => {
    const rows = doc.rows.map((r, i) =>
      i === rowIdx ? { ...r, [col]: value } : r
    );
    commit({ ...doc, rows });
  };
  const addRow = () => {
    const blank: Record<string, string | number> = {};
    for (const c of columns) blank[c] = "";
    commit({ ...doc, rows: [...doc.rows, blank] });
  };
  const removeRow = (i: number) =>
    commit({ ...doc, rows: doc.rows.filter((_, idx) => idx !== i) });
  const addColumn = () => {
    let n = columns.length + 1;
    let name = `Column ${n}`;
    while (columns.includes(name)) name = `Column ${++n}`;
    commit({
      ...doc,
      rows: doc.rows.map((r) => ({ ...r, [name]: "" })),
      valueKeys: [...doc.valueKeys, name],
    });
  };
  const renameColumn = (oldName: string, newName: string) => {
    const nn = newName.trim();
    if (!nn || nn === oldName || columns.includes(nn)) return;
    commit({
      ...doc,
      labelKey: doc.labelKey === oldName ? nn : doc.labelKey,
      valueKeys: doc.valueKeys.map((k) => (k === oldName ? nn : k)),
      rows: doc.rows.map((r) => {
        const { [oldName]: v, ...rest } = r;
        return { ...rest, [nn]: v ?? "" };
      }),
    });
  };
  const removeColumn = (col: string) => {
    if (columns.length <= 1) return;
    commit({
      ...doc,
      labelKey:
        doc.labelKey === col
          ? columns.find((c) => c !== col) ?? ""
          : doc.labelKey,
      valueKeys: doc.valueKeys.filter((k) => k !== col),
      rows: doc.rows.map((r) => {
        const { [col]: _drop, ...rest } = r;
        return rest;
      }),
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ItemPaneHeader
        workspaceId={workspaceId}
        itemId={node.id}
        kind="chart"
        fallbackTitle={node.title}
        canEdit={canEdit}
        status={statusChip}
      />

      <div className="promptly-scroll min-h-0 flex-1 overflow-y-auto">
        {/* Chart type + series controls */}
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
            <div className="inline-flex overflow-hidden rounded-lg border border-[var(--border)]">
              {CHART_TYPES.map(({ type, label, icon: Icon }) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setType(type)}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs transition",
                    doc.chartType === type
                      ? "bg-[var(--accent)] text-white"
                      : "text-[var(--text-muted)] hover:bg-[var(--hover)]"
                  )}
                  title={label}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </div>

            <label className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
              Label
              <select
                value={doc.labelKey}
                onChange={(e) => setLabelKey(e.target.value)}
                className="rounded-input border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)]"
              >
                {columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-[var(--text-muted)]">Series</span>
              {columns
                .filter((c) => c !== doc.labelKey)
                .map((c, i) => {
                  const on = doc.valueKeys.includes(c);
                  const color = PALETTE[i % PALETTE.length];
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => toggleValue(c)}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition",
                        on
                          ? "border-transparent text-white"
                          : "border-[var(--border)] text-[var(--text-muted)]"
                      )}
                      style={on ? { background: color } : undefined}
                    >
                      {c}
                    </button>
                  );
                })}
            </div>

            {/* Import data from a workspace Sheet (snapshot, not live-linked) */}
            {sheets.length > 0 && (
              <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                {importing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Table2 className="h-3.5 w-3.5" />
                )}
                <select
                  value=""
                  disabled={importing}
                  onChange={(e) => {
                    const v = e.target.value;
                    e.target.value = "";
                    void importFromSheet(v);
                  }}
                  className="rounded-input border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)] disabled:opacity-60"
                  title="Replace this chart's data with a snapshot of a sheet"
                >
                  <option value="">Import from sheet…</option>
                  {sheets.map((s) => (
                    <option key={s.refId} value={s.refId}>
                      {s.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}

        {/* Chart render */}
        <div className="px-4 py-4">
          <div className="h-[320px] w-full rounded-card border border-[var(--border)] bg-[var(--surface)] p-3">
            <ChartRender doc={doc} data={chartData} />
          </div>
        </div>

        {/* Data grid editor */}
        {canEdit ? (
          <div className="px-4 pb-6">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                Data
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={addColumn}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-muted)] transition hover:bg-[var(--hover)]"
                >
                  <Plus className="h-3 w-3" /> Column
                </button>
                <button
                  type="button"
                  onClick={addRow}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-muted)] transition hover:bg-[var(--hover)]"
                >
                  <Plus className="h-3 w-3" /> Row
                </button>
              </div>
            </div>
            <div className="promptly-scroll overflow-x-auto rounded-card border border-[var(--border)]">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] bg-[var(--surface)]">
                    {columns.map((c) => (
                      <th key={c} className="px-1 py-1 text-left">
                        <div className="flex items-center gap-1">
                          <input
                            defaultValue={c}
                            onBlur={(e) => renameColumn(c, e.target.value)}
                            className="w-full min-w-[90px] rounded border border-transparent bg-transparent px-1.5 py-1 text-xs font-semibold text-[var(--text)] hover:border-[var(--border)] focus:border-[var(--accent)] focus:outline-none"
                          />
                          {columns.length > 1 && (
                            <button
                              type="button"
                              onClick={() => removeColumn(c)}
                              className="shrink-0 rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--hover-strong)] hover:text-[var(--danger)]"
                              title="Delete column"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      </th>
                    ))}
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {doc.rows.map((row, ri) => (
                    <tr
                      key={ri}
                      className="border-b border-[var(--border)] last:border-0"
                    >
                      {columns.map((c) => (
                        <td key={c} className="px-1 py-0.5">
                          <input
                            value={String(row[c] ?? "")}
                            onChange={(e) => setCell(ri, c, e.target.value)}
                            className="w-full min-w-[90px] rounded border border-transparent bg-transparent px-1.5 py-1 text-xs text-[var(--text)] hover:border-[var(--border)] focus:border-[var(--accent)] focus:outline-none"
                          />
                        </td>
                      ))}
                      <td className="px-1">
                        <button
                          type="button"
                          onClick={() => removeRow(ri)}
                          className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover-strong)] hover:text-[var(--danger)]"
                          title="Delete row"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] text-[var(--text-muted)]">
              This chart's data is indexed into the workspace, so its chat can
              answer questions about the numbers.
            </p>
          </div>
        ) : (
          <p className="px-4 pb-6 text-center text-xs text-[var(--text-muted)]">
            Read-only — open on desktop with edit access to change the data.
          </p>
        )}
      </div>
    </div>
  );
}

function ChartRender({
  doc,
  data,
}: {
  doc: ChartDoc;
  data: Record<string, string | number>[];
}) {
  if (!data.length || !doc.valueKeys.length) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-[var(--text-muted)]">
        Add data rows and pick at least one series to plot.
      </div>
    );
  }
  const tooltipStyle = {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    fontSize: 12,
    color: "var(--text)",
  } as const;
  const axisTick = { fontSize: 11, fill: "var(--text-muted)" } as const;

  if (doc.chartType === "pie") {
    const key = doc.valueKeys[0];
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Tooltip contentStyle={tooltipStyle} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Pie
            data={data}
            dataKey={key}
            nameKey={doc.labelKey}
            outerRadius="80%"
            label={(e: { name?: string }) => e.name ?? ""}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={cssColor(PALETTE[i % PALETTE.length])} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    );
  }

  const commonAxes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.4} />
      <XAxis dataKey={doc.labelKey} tick={axisTick} stroke="var(--border)" />
      <YAxis tick={axisTick} stroke="var(--border)" width={48} />
      <Tooltip contentStyle={tooltipStyle} />
      <Legend wrapperStyle={{ fontSize: 11 }} />
    </>
  );

  if (doc.chartType === "line") {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
          {commonAxes}
          {doc.valueKeys.map((k, i) => (
            <Line
              key={k}
              type="monotone"
              dataKey={k}
              stroke={cssColor(PALETTE[i % PALETTE.length])}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  if (doc.chartType === "area") {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
          {commonAxes}
          {doc.valueKeys.map((k, i) => {
            const c = cssColor(PALETTE[i % PALETTE.length]);
            return (
              <Area
                key={k}
                type="monotone"
                dataKey={k}
                stroke={c}
                fill={c}
                fillOpacity={0.18}
                strokeWidth={2}
              />
            );
          })}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  // bar (default)
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
        {commonAxes}
        {doc.valueKeys.map((k, i) => (
          <Bar key={k} dataKey={k} fill={cssColor(PALETTE[i % PALETTE.length])} radius={[3, 3, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

// recharts' SVG fills don't resolve CSS vars, so map the accent var to its
// literal; other palette entries are already literal hexes.
function cssColor(c: string): string {
  if (!c.startsWith("var(")) return c;
  if (typeof window !== "undefined") {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue("--accent")
      .trim();
    if (v) return v;
  }
  return "#D97757";
}
