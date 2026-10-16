import { useMemo, useState, type MutableRefObject } from "react";
import type { WorkbookInstance } from "@fortune-sheet/react";
import { Check, Loader2, Sparkles, X } from "lucide-react";

import { editorAiApi, type SheetAiResult } from "@/api/editorAi";
import { NO_MODEL_MESSAGE, useEditorModel } from "@/lib/editorModel";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * Sheets AI (WP-5.5): fill a column from the other columns, clean the
 * selected cells, build a new tab from a description, explain a formula.
 * Every result is a preview first — nothing touches the sheet until Apply,
 * and applied changes are ordinary edits (Undo works, collaborators see them).
 */
type Mode = "fill" | "clean" | "build" | "explain";

export function colName(c: number): string {
  let s = "";
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Fortune's read calls throw until the workbook has loaded (and for a
 *  tab that isn't ready) — treat that as "nothing there yet". */
export function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

interface CellInfo {
  text: string;
  value: string | number;
  formula?: string;
}

/** The active tab's cells by row / column. */
export function readGrid(wb: WorkbookInstance | null): { cells: Map<string, CellInfo>; maxRow: number; maxCol: number } {
  const cells = new Map<string, CellInfo>();
  let maxRow = -1;
  let maxCol = -1;
  const sheet = safely(() => wb?.getSheet?.(), undefined);
  for (const cd of sheet?.celldata ?? []) {
    const v = cd.v as { v?: unknown; m?: unknown; f?: string } | null;
    if (v == null) continue;
    const raw = v.v ?? v.m;
    const text = v.m != null ? String(v.m) : raw != null ? String(raw) : "";
    if (!text && !v.f) continue;
    cells.set(`${cd.r}:${cd.c}`, {
      text,
      value: typeof raw === "number" ? raw : text,
      formula: v.f || undefined,
    });
    maxRow = Math.max(maxRow, cd.r);
    maxCol = Math.max(maxCol, cd.c);
  }
  return { cells, maxRow, maxCol };
}

/** The selection as a label + tab-separated text (for the Ask panel). */
export function describeSelection(wb: WorkbookInstance | null): { label: string; text: string } | null {
  const sel = safely(() => wb?.getSelection?.()?.[0], undefined);
  if (!sel) return null;
  const [r0, r1] = sel.row;
  const [c0, c1] = sel.column;
  const { cells } = readGrid(wb);
  const lines: string[] = [];
  for (let r = r0; r <= Math.min(r1, r0 + 199); r++) {
    const row: string[] = [];
    for (let c = c0; c <= Math.min(c1, c0 + 25); c++) {
      const cell = cells.get(`${r}:${c}`);
      row.push(cell ? (cell.formula ? `${cell.text} [${cell.formula}]` : cell.text) : "");
    }
    lines.push(row.join("\t"));
  }
  const label = r0 === r1 && c0 === c1 ? `${colName(c0)}${r0 + 1}` : `${colName(c0)}${r0 + 1}:${colName(c1)}${r1 + 1}`;
  const text = lines.join("\n");
  if (!text.trim()) return null;
  return { label: `Cells ${label}`, text };
}

export function SheetAiPanel({
  fileId,
  workbookRef,
  onClose,
  onExplain,
}: {
  fileId: string;
  workbookRef: MutableRefObject<WorkbookInstance | null>;
  onClose: () => void;
  /** Ask the Ask panel (Explain formula); absent outside an editor page. */
  onExplain?: (question: string) => void;
}) {
  const { providerId, modelId } = useEditorModel();
  const [mode, setMode] = useState<Mode>("fill");
  const [instruction, setInstruction] = useState("");
  const [target, setTarget] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ mode: Mode; data: SheetAiResult; meta: Record<string, unknown> } | null>(null);

  const grid = useMemo(() => readGrid(workbookRef.current), [workbookRef, mode, result]);
  const headers = useMemo(() => {
    const out: { col: number; name: string }[] = [];
    for (let c = 0; c <= grid.maxCol; c++) out.push({ col: c, name: grid.cells.get(`0:${c}`)?.text || colName(c) });
    return out;
  }, [grid]);
  const newCol = grid.maxCol + 1;

  const call = async (
    body: Omit<Parameters<typeof editorAiApi.sheet>[1], "provider_id" | "model_id">,
    meta: Record<string, unknown>
  ) => {
    if (!providerId || !modelId) {
      toast.error(NO_MODEL_MESSAGE);
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const data = await editorAiApi.sheet(fileId, { ...body, provider_id: providerId, model_id: modelId });
      setResult({ mode: body.mode, data, meta });
    } catch (e) {
      toast.error(apiErrorMessage(e, "Couldn't get that from the AI."));
    } finally {
      setBusy(false);
    }
  };

  const runFill = () => {
    const col = target === "" ? newCol : Number(target);
    const targetName = col === newCol ? newName.trim() || "New column" : headers[col]?.name || colName(col);
    const sel = safely(() => workbookRef.current?.getSelection?.()?.[0], undefined);
    const selected = sel && sel.row[1] > sel.row[0] ? [Math.max(1, sel.row[0]), sel.row[1]] : null;
    const rows: { row: number; values: Record<string, string | number> }[] = [];
    const from = selected ? selected[0] : 1;
    const to = selected ? selected[1] : grid.maxRow;
    for (let r = from; r <= to && rows.length < 200; r++) {
      const values: Record<string, string | number> = {};
      let any = false;
      for (const h of headers) {
        if (h.col === col) continue;
        const cell = grid.cells.get(`${r}:${h.col}`);
        if (cell?.text) {
          values[h.name] = cell.value;
          any = true;
        }
      }
      if (any) rows.push({ row: r + 1, values });
    }
    if (!rows.length) {
      toast.info("There are no rows with data to fill (the first row is read as the headers).");
      return;
    }
    void call({ mode: "fill", instruction, target: targetName, rows }, { col, targetName, isNew: col === newCol });
  };

  const runClean = () => {
    const sel = safely(() => workbookRef.current?.getSelection?.()?.[0], undefined);
    if (!sel || (sel.row[0] === sel.row[1] && sel.column[0] === sel.column[1])) {
      toast.info("Select the cells to clean first.");
      return;
    }
    const [r0, r1] = sel.row;
    const [c0, c1] = sel.column;
    if ((r1 - r0 + 1) * (c1 - c0 + 1) > 2000) {
      toast.info("Select up to 2,000 cells at a time.");
      return;
    }
    const cells: (string | number)[][] = [];
    for (let r = r0; r <= r1; r++) {
      const row: (string | number)[] = [];
      for (let c = c0; c <= c1; c++) row.push(grid.cells.get(`${r}:${c}`)?.value ?? "");
      cells.push(row);
    }
    void call({ mode: "clean", instruction, cells }, { r0, c0, before: cells });
  };

  const runBuild = () => {
    if (!instruction.trim()) {
      toast.info("Describe the sheet you want.");
      return;
    }
    void call({ mode: "build", instruction }, {});
  };

  const [applying, setApplying] = useState(false);
  const apply = async () => {
    const wb = workbookRef.current;
    if (!wb || !result || applying) return;
    setApplying(true);
    try {
      if (result.mode === "fill") {
        const { col, targetName, isNew } = result.meta as { col: number; targetName: string; isNew: boolean };
        if (isNew) wb.setCellValue(0, col, targetName);
        for (const v of result.data.values) wb.setCellValue(v.row - 1, col, v.value);
        toast.success(`Filled ${result.data.values.length} cell${result.data.values.length === 1 ? "" : "s"}.`);
      } else if (result.mode === "clean") {
        const { r0, c0, before } = result.meta as { r0: number; c0: number; before: (string | number)[][] };
        let n = 0;
        result.data.cells.forEach((row, i) =>
          row.forEach((v, j) => {
            const had = grid.cells.get(`${r0 + i}:${c0 + j}`);
            if (had?.formula) return; // never overwrite a formula with its value
            if (String(v) !== String(before[i]?.[j] ?? "")) {
              wb.setCellValue(r0 + i, c0 + j, v);
              n++;
            }
          })
        );
        toast.success(`Cleaned ${n} cell${n === 1 ? "" : "s"}.`);
      } else if (result.mode === "build") {
        // The workbook applies each change on its next render, and a tab's
        // grid only exists once it's shown — so: add it (with our own id),
        // show it, then fill it, letting it catch up in between.
        // The workbook object is rebuilt on every render — always use the
        // current one, or a step sees the tabs as they were before.
        const live = () => workbookRef.current ?? wb;
        const id = `ai-${Math.random().toString(36).slice(2, 10)}`;
        const opts = { id };
        const name = (result.data.title || "AI sheet").slice(0, 60);
        live().addSheet(id);
        await settle();
        live().activateSheet(opts);
        await settle();
        try {
          live().setSheetName(name, opts);
        } catch {
          /* a clashing name keeps the default */
        }
        const need = result.data.table.length + 1;
        const have = live().getSheet(opts).data?.length ?? 0;
        if (have && need > have) {
          live().insertRowOrColumn("row", have - 1, need - have, "rightbottom", opts);
          await settle();
        }
        result.data.columns.forEach((h, c) => {
          live().setCellValue(0, c, h, opts);
          live().setCellFormat(0, c, "bl", 1, opts);
        });
        result.data.table.forEach((row, r) =>
          row.forEach((v, c) => {
            if (v !== "" && v != null) live().setCellValue(r + 1, c, v, opts);
          })
        );
        toast.success(`Added the tab “${name}”.`);
      }
      setResult(null);
    } catch (e) {
      console.warn("Sheet AI apply failed", e);
      toast.error("Couldn't apply that to the sheet.");
    } finally {
      setApplying(false);
    }
  };

  const active = safely(() => workbookRef.current?.getSelection?.()?.[0], undefined);
  const activeRef = active ? `${colName(active.column[0])}${active.row[0] + 1}` : null;
  const activeFormula = active ? grid.cells.get(`${active.row[0]}:${active.column[0]}`)?.formula : undefined;

  const tab = (m: Mode, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === m}
      onClick={() => {
        setMode(m);
        setResult(null);
      }}
      className={cn(
        "rounded-md px-2 py-1 text-xs",
        mode === m ? "bg-[var(--accent)]/10 font-medium text-[var(--accent-text)]" : "text-[var(--text-muted)] hover:text-[var(--text)]"
      )}
    >
      {label}
    </button>
  );
  const field =
    "w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]";

  return (
    <div
      role="dialog"
      aria-label="Sheet AI"
      className="absolute right-2 top-2 z-30 flex max-h-[calc(100%-1rem)] w-[min(24rem,calc(100%-1rem))] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl"
    >
      <div className="flex items-center gap-1.5 border-b border-[var(--border)] px-3 py-2">
        <Sparkles className="h-4 w-4 text-[var(--accent-text)]" />
        <span className="text-sm font-medium">Sheet AI</span>
        <button type="button" onClick={onClose} aria-label="Close Sheet AI" className="ml-auto rounded p-1 text-[var(--text-muted)] hover:bg-[var(--hover)]">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div role="tablist" className="flex gap-1 border-b border-[var(--border)] px-2 py-1.5">
        {tab("fill", "Fill column")}
        {tab("clean", "Clean")}
        {tab("build", "Build")}
        {tab("explain", "Explain")}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-sm">
        {mode === "fill" && (
          <>
            <label className="block text-xs text-[var(--text-muted)]">
              Column to fill
              <select aria-label="Column to fill" value={target} onChange={(e) => setTarget(e.target.value)} className={cn(field, "mt-1")}>
                <option value="">New column ({colName(newCol)})</option>
                {headers.map((h) => (
                  <option key={h.col} value={String(h.col)}>
                    {colName(h.col)} · {h.name}
                  </option>
                ))}
              </select>
            </label>
            {target === "" && (
              <input aria-label="New column name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name for the new column" className={field} />
            )}
            <textarea
              aria-label="What to fill in"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={2}
              placeholder="e.g. the spending category of each item"
              className={field}
            />
            <p className="text-[11px] text-[var(--text-muted)]">
              Uses the other columns of each row (row 1 is read as headers) — the selected rows, or every row with data.
            </p>
            <RunButton busy={busy} onClick={runFill} label="Suggest values" />
          </>
        )}
        {mode === "clean" && (
          <>
            <textarea
              aria-label="How to clean"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={2}
              placeholder="Optional — e.g. Title Case names, dates as YYYY-MM-DD"
              className={field}
            />
            <p className="text-[11px] text-[var(--text-muted)]">Select the cells first. Formulas are left alone.</p>
            <RunButton busy={busy} onClick={runClean} label="Suggest a clean-up" />
          </>
        )}
        {mode === "build" && (
          <>
            <textarea
              aria-label="Describe the sheet"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={3}
              placeholder="e.g. a monthly budget with categories, planned and actual amounts, and totals"
              className={field}
            />
            <RunButton busy={busy} onClick={runBuild} label="Design it" />
          </>
        )}
        {mode === "explain" && (
          <div className="space-y-2">
            {activeFormula ? (
              <>
                <div className="rounded-md bg-[var(--hover)] px-2 py-1.5 font-mono text-xs">
                  {activeRef}: {activeFormula}
                </div>
                <button
                  type="button"
                  disabled={!onExplain}
                  onClick={() => onExplain?.(`Explain the formula in ${activeRef}: ${activeFormula}`)}
                  className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                >
                  <Sparkles className="h-3.5 w-3.5" /> Explain it
                </button>
              </>
            ) : (
              <p className="text-xs text-[var(--text-muted)]">Select a cell with a formula, then come back here.</p>
            )}
          </div>
        )}

        {result && <Preview result={result} headers={headers} grid={grid} />}
      </div>

      {result && (
        <div className="flex justify-end gap-2 border-t border-[var(--border)] px-3 py-2">
          <button type="button" onClick={() => setResult(null)} className="rounded-md px-2.5 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--hover)]">
            Discard
          </button>
          <button
            type="button"
            onClick={() => void apply()}
            disabled={applying}
            className="inline-flex items-center gap-1 rounded-md bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-60"
          >
            {applying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Apply
          </button>
        </div>
      )}
    </div>
  );
}

/** Two frames — long enough for the workbook to render a queued change. */
function settle(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function RunButton({ busy, onClick, label }: { busy: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-60"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
      {busy ? "Thinking…" : label}
    </button>
  );
}

function Preview({
  result,
  grid,
}: {
  result: { mode: Mode; data: SheetAiResult; meta: Record<string, unknown> };
  headers: { col: number; name: string }[];
  grid: ReturnType<typeof readGrid>;
}) {
  const { mode, data, meta } = result;
  const box = "max-h-64 overflow-auto rounded-md border border-[var(--border)]";
  const th = "border-b border-[var(--border)] bg-[var(--hover)] px-2 py-1 text-left text-[11px] font-medium text-[var(--text-muted)]";
  const td = "border-b border-[var(--border)] px-2 py-1 text-xs";
  if (mode === "fill") {
    const col = meta.col as number;
    return (
      <div className="space-y-1" aria-label="Preview">
        <p className="text-xs font-medium">
          {data.values.length} value{data.values.length === 1 ? "" : "s"} for “{String(meta.targetName)}” — check, then Apply.
        </p>
        <div className={box}>
          <table className="w-full">
            <thead>
              <tr>
                <th className={th}>Row</th>
                <th className={th}>{String(meta.targetName)}</th>
              </tr>
            </thead>
            <tbody>
              {data.values.map((v) => (
                <tr key={v.row}>
                  <td className={cn(td, "text-[var(--text-muted)]")}>{v.row}</td>
                  <td className={td}>
                    {String(v.value)}
                    {grid.cells.get(`${v.row - 1}:${col}`)?.text && (
                      <span className="ml-1 text-[10px] text-amber-600">replaces “{grid.cells.get(`${v.row - 1}:${col}`)?.text}”</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  if (mode === "clean") {
    const { r0, c0, before } = meta as { r0: number; c0: number; before: (string | number)[][] };
    const diffs: { ref: string; from: string; to: string }[] = [];
    data.cells.forEach((row, i) =>
      row.forEach((v, j) => {
        if (String(v) !== String(before[i]?.[j] ?? "")) diffs.push({ ref: `${colName(c0 + j)}${r0 + i + 1}`, from: String(before[i]?.[j] ?? ""), to: String(v) });
      })
    );
    return (
      <div className="space-y-1" aria-label="Preview">
        <p className="text-xs font-medium">{diffs.length ? `${diffs.length} cell${diffs.length === 1 ? "" : "s"} would change.` : "Nothing needs cleaning."}</p>
        {diffs.length > 0 && (
          <div className={box}>
            <table className="w-full">
              <tbody>
                {diffs.slice(0, 200).map((d) => (
                  <tr key={d.ref}>
                    <td className={cn(td, "font-mono text-[var(--text-muted)]")}>{d.ref}</td>
                    <td className={cn(td, "text-[var(--text-muted)] line-through")}>{d.from}</td>
                    <td className={td}>{d.to}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-1" aria-label="Preview">
      <p className="text-xs font-medium">“{data.title || "AI sheet"}” — added as a new tab.</p>
      <div className={box}>
        <table className="w-full">
          <thead>
            <tr>
              {data.columns.map((c) => (
                <th key={c} className={th}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.table.slice(0, 30).map((row, i) => (
              <tr key={i}>
                {row.map((v, j) => (
                  <td key={j} className={cn(td, String(v).startsWith("=") && "font-mono text-[var(--accent-text)]")}>
                    {String(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.table.length > 30 && <p className="text-[11px] text-[var(--text-muted)]">…and {data.table.length - 30} more rows.</p>}
    </div>
  );
}
