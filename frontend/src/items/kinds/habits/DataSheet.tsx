import { Download, FileUp, Upload } from "lucide-react";
import { useRef, useState } from "react";

import { ItemButton, Sheet, Toggle, fmtDay } from "@/items/ui";
import type { ItemHandle } from "@/items/useItem";

import type { HabitsData } from "./types";
import { downloadText, exportCsv, exportHabitsCsv } from "./util";

interface ImportFile {
  name: string;
  content: string;
}

interface ImportReport {
  new_habits: { name: string; type: string; schedule: string; days: number }[];
  matched_habits: { id: string; name: string; days: number }[];
  logs_added: number;
  logs_replaced: number;
  logs_kept: number;
  dropped_old: number;
  first_day: string | null;
  last_day: string | null;
  files: { name: string; format: string; rows: number }[];
  warnings: string[];
}

const FORMAT: Record<string, string> = {
  loop_habits: "Loop · habit list",
  loop_combined: "Loop · check-marks",
  loop_single: "Loop · one habit",
  duplicate: "Loop · notes",
  scores: "Loop · scores (recomputed, skipped)",
  generic: "date / habit / value",
  unknown: "not recognised",
  skipped: "skipped",
  empty: "empty",
};

const MAX_BYTES = 20 * 1024 * 1024;

function errText(e: unknown): string {
  const d = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof d === "string") return d;
  return e instanceof Error ? e.message : "That didn't work.";
}

/** CSV files, or the .csv files inside a ZIP (Loop exports a ZIP). */
async function readFiles(list: FileList): Promise<ImportFile[]> {
  const out: ImportFile[] = [];
  for (const f of Array.from(list)) {
    if (f.size > MAX_BYTES) throw new Error(`${f.name} is larger than 20 MB.`);
    if (/\.zip$/i.test(f.name) || f.type === "application/zip") {
      const { default: JSZip } = await import("jszip");
      const zip = await JSZip.loadAsync(f);
      const entries = Object.values(zip.files).filter((e) => !e.dir && /\.csv$/i.test(e.name));
      for (const e of entries.slice(0, 400)) out.push({ name: e.name, content: await e.async("string") });
    } else out.push({ name: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, content: await f.text() });
  }
  return out;
}

/**
 * Data in and out: export every check-off as CSV (works offline), and
 * import Loop Habit Tracker's export ZIP or any date,habit,value CSV — with
 * a preview first (the server parses, so the preview and the import agree).
 */
export function DataSheet({ open, onClose, item, onDone }: { open: boolean; onClose: () => void; item: ItemHandle<HabitsData>; onDone: (text: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<ImportFile[] | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reset = () => {
    setFiles(null);
    setReport(null);
    setOverwrite(false);
    setError("");
    if (input.current) input.current.value = "";
  };
  const close = () => {
    reset();
    onClose();
  };

  const preview = async (fs: ImportFile[], ow: boolean) => {
    setBusy(true);
    setError("");
    try {
      const res = await item.runAction<ImportReport>("preview_import", { files: fs, overwrite: ow });
      setReport(res.result);
    } catch (e) {
      setError(errText(e));
      setReport(null);
    } finally {
      setBusy(false);
    }
  };

  const pick = async (list: FileList | null) => {
    if (!list?.length) return;
    setError("");
    try {
      const fs = await readFiles(list);
      if (!fs.length) {
        setError("No CSV files in there. In Loop: Settings → Export as CSV, then pick the ZIP it makes.");
        return;
      }
      setFiles(fs);
      if (!navigator.onLine) {
        setError("Importing needs a connection — try again once you're online.");
        return;
      }
      await preview(fs, overwrite);
    } catch (e) {
      setError(errText(e));
    }
  };

  const run = async () => {
    if (!files) return;
    setBusy(true);
    try {
      const res = await item.runAction<ImportReport>("import_history", { files, overwrite });
      onDone(res.summary);
      close();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const stamp = new Date().toISOString().slice(0, 10);
  const logCount = item.data.habits.reduce((n, h) => n + h.logs.length, 0);
  const willAdd = report ? report.logs_added + report.logs_replaced : 0;

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Import & export"
      footer={
        report && item.canEdit ? (
          <>
            <ItemButton variant="ghost" onClick={reset}>
              Choose other files
            </ItemButton>
            <ItemButton variant="primary" block disabled={busy || (!willAdd && !report.new_habits.length)} onClick={run}>
              {busy ? "Importing…" : `Import ${willAdd} day${willAdd === 1 ? "" : "s"}${report.new_habits.length ? ` · ${report.new_habits.length} new habit${report.new_habits.length === 1 ? "" : "s"}` : ""}`}
            </ItemButton>
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-5 pt-1">
        {!report && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-[var(--text)]">Export</h3>
            <p className="text-sm text-[var(--text-muted)]">
              Every check-off, count, note and skip ({logCount} in all) as a spreadsheet-friendly CSV. Import it back here any time.
            </p>
            <div className="flex flex-wrap gap-2">
              <ItemButton icon={<Download className="h-4 w-4" />} onClick={() => downloadText(`habits-history-${stamp}.csv`, exportCsv(item.data))}>
                History (CSV)
              </ItemButton>
              <ItemButton variant="ghost" icon={<Download className="h-4 w-4" />} onClick={() => downloadText(`habits-list-${stamp}.csv`, exportHabitsCsv(item.data))}>
                Habit list (CSV)
              </ItemButton>
            </div>
          </section>
        )}

        {item.canEdit && (
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-[var(--text)]">Import</h3>
            {!report && (
              <>
                <p className="text-sm text-[var(--text-muted)]">
                  From <strong>Loop Habit Tracker</strong>: Settings → Export as CSV, then pick the ZIP. Or any CSV with <code>date</code>, <code>habit</code> and{" "}
                  <code>value</code> columns (optional <code>note</code>, <code>skipped</code>). You'll see what changes before anything is saved.
                </p>
                <input
                  ref={input}
                  type="file"
                  accept=".csv,.zip,text/csv,application/zip"
                  multiple
                  className="sr-only"
                  aria-label="Choose CSV or ZIP files to import"
                  onChange={(e) => void pick(e.target.files)}
                />
                <ItemButton icon={<Upload className="h-4 w-4" />} disabled={busy} onClick={() => input.current?.click()}>
                  {busy ? "Reading…" : "Choose files…"}
                </ItemButton>
              </>
            )}

            {report && (
              <div className="flex flex-col gap-3" aria-live="polite">
                <ul className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
                  {report.files.map((f) => (
                    <li key={f.name} className="flex items-center gap-2">
                      <FileUp className="h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      <span className="shrink-0">{FORMAT[f.format] ?? f.format}</span>
                    </li>
                  ))}
                </ul>
                <div className="grid grid-cols-3 gap-2 text-center">
                  {[
                    ["New days", report.logs_added],
                    [overwrite ? "Replaced" : "Already logged (kept)", overwrite ? report.logs_replaced : report.logs_kept],
                    ["New habits", report.new_habits.length],
                  ].map(([label, n]) => (
                    <div key={label} className="rounded-xl border border-[var(--border)] p-2">
                      <div className="text-lg font-semibold tabular-nums text-[var(--text)]">{n}</div>
                      <div className="text-[11px] text-[var(--text-muted)]">{label}</div>
                    </div>
                  ))}
                </div>
                {report.first_day && report.last_day && (
                  <p className="text-xs text-[var(--text-muted)]">
                    {fmtDay(report.first_day)} – {fmtDay(report.last_day)}
                  </p>
                )}
                {report.new_habits.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-[var(--text-muted)]">Will be created</span>
                    <ul className="flex flex-col divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] text-sm">
                      {report.new_habits.map((h) => (
                        <li key={h.name} className="flex items-center justify-between gap-2 px-3 py-2">
                          <span className="min-w-0 truncate text-[var(--text)]">{h.name}</span>
                          <span className="shrink-0 text-xs text-[var(--text-muted)]">
                            {h.schedule} · {h.days} days
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {report.matched_habits.length > 0 && (
                  <p className="text-xs text-[var(--text-muted)]">Adds to: {report.matched_habits.map((h) => h.name).join(", ")}</p>
                )}
                {report.warnings.length > 0 && (
                  <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-[var(--text-muted)]">
                    {report.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                )}
                <label className="flex items-center justify-between gap-3 text-sm text-[var(--text)]">
                  <span>Replace days I've already logged</span>
                  <Toggle
                    checked={overwrite}
                    onChange={(v) => {
                      setOverwrite(v);
                      if (files) void preview(files, v);
                    }}
                    label="Replace days already logged"
                  />
                </label>
              </div>
            )}
          </section>
        )}

        {error && (
          <p role="alert" className="text-sm text-[var(--danger)]">
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}
