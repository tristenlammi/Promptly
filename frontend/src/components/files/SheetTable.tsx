import { useMemo, useState, type CSSProperties } from "react";

import { cn } from "@/utils/cn";

/**
 * A Fortune-sheet workbook drawn as a plain, read-only HTML table, one tab
 * at a time — the share-link view of a Promptly sheet (WP-3.4) and the
 * preview of an uploaded .xlsx / .ods (WP-4.4). It keeps what makes a
 * spreadsheet readable: bold / italic / colours / fills, alignment and
 * wrapping, merged cells, column widths and row heights.
 */
export interface SheetCell {
  v?: unknown;
  m?: unknown;
  f?: string;
  ct?: { fa?: string; t?: string; s?: { v?: unknown }[] };
  bl?: number | string;
  it?: number | string;
  un?: number | string;
  cl?: number | string;
  fs?: number | string;
  ff?: string | number;
  fc?: string;
  bg?: string;
  ht?: number | string;
  vt?: number | string;
  tb?: number | string;
  mc?: { r: number; c: number; rs?: number; cs?: number };
}

interface CellData {
  r: number;
  c: number;
  v?: SheetCell | string | number | null;
}

interface Tab {
  name?: string;
  hide?: number;
  celldata?: CellData[];
  config?: {
    columnlen?: Record<string, number>;
    rowlen?: Record<string, number>;
    colhidden?: Record<string, number>;
    rowhidden?: Record<string, number>;
  };
}

export function sheetCellText(v: CellData["v"]): string {
  if (v == null) return "";
  if (typeof v !== "object") return String(v);
  if (v.m != null) return String(v.m);
  if (v.ct?.t === "inlineStr" && Array.isArray(v.ct.s)) return v.ct.s.map((p) => String(p?.v ?? "")).join("");
  // A formula never calculated in the editor has no value yet — show it.
  const shown = v.v ?? v.f;
  return shown == null ? "" : String(shown);
}

function colName(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const isOn = (x: unknown) => x === 1 || x === "1";
const H_ALIGN: Record<string, CSSProperties["textAlign"]> = { "0": "center", "1": "left", "2": "right" };
const V_ALIGN: Record<string, CSSProperties["verticalAlign"]> = { "0": "middle", "1": "top", "2": "bottom" };
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i;

function cellStyle(v: SheetCell | undefined, width: number | undefined): CSSProperties {
  const style: CSSProperties = {};
  if (width) {
    style.width = width;
    style.minWidth = width;
    style.maxWidth = width;
  }
  if (!v) return style;
  if (isOn(v.bl)) style.fontWeight = 600;
  if (isOn(v.it)) style.fontStyle = "italic";
  const deco = [v.un && v.un !== "0" && v.un !== 0 ? "underline" : "", isOn(v.cl) ? "line-through" : ""]
    .filter(Boolean)
    .join(" ");
  if (deco) style.textDecoration = deco;
  if (typeof v.fc === "string" && SAFE_COLOR.test(v.fc)) style.color = v.fc;
  if (typeof v.bg === "string" && SAFE_COLOR.test(v.bg)) style.backgroundColor = v.bg;
  const fs = Number(v.fs);
  if (Number.isFinite(fs) && fs > 0 && fs < 100) style.fontSize = `${fs}pt`;
  if (typeof v.ff === "string" && /^[\w\s-]{1,60}$/.test(v.ff)) style.fontFamily = `"${v.ff}", ui-sans-serif, sans-serif`;
  const ht = v.ht != null ? H_ALIGN[String(v.ht)] : undefined;
  const t = v.ct?.t;
  style.textAlign = ht ?? (t === "n" || t === "d" ? "right" : undefined);
  if (v.vt != null) style.verticalAlign = V_ALIGN[String(v.vt)];
  if (String(v.tb) === "2") {
    style.whiteSpace = "pre-wrap";
    style.overflowWrap = "anywhere";
  }
  return style;
}

export function SheetTable({
  sheets,
  maxRows = 500,
  maxCols = 60,
  truncated: alreadyTruncated = false,
}: {
  sheets: unknown[];
  maxRows?: number;
  maxCols?: number;
  /** The server already cut the workbook down (a preview). */
  truncated?: boolean;
}) {
  const tabs = useMemo(
    () => ((Array.isArray(sheets) ? sheets : []) as Tab[]).filter((t) => t && t.hide !== 1),
    [sheets]
  );
  const [tab, setTab] = useState(0);
  const sheet = tabs[Math.min(tab, Math.max(0, tabs.length - 1))];
  const grid = useMemo(() => {
    const all = sheet?.celldata ?? [];
    const cells = all.filter((c) => c.r < maxRows && c.c < maxCols);
    const rows = cells.reduce((n, c) => Math.max(n, c.r + 1), 0);
    const cols = cells.reduce((n, c) => Math.max(n, c.c + 1), 0);
    const map = new Map<string, CellData>();
    // Covered by a merge: drawn by the merge's top-left cell.
    const covered = new Set<string>();
    for (const c of cells) {
      map.set(`${c.r}:${c.c}`, c);
      const mc = typeof c.v === "object" && c.v ? c.v.mc : undefined;
      if (mc && (mc.r !== c.r || mc.c !== c.c)) covered.add(`${c.r}:${c.c}`);
    }
    const truncated = alreadyTruncated || all.some((c) => c.r >= maxRows || c.c >= maxCols);
    const cfg = sheet?.config ?? {};
    return { rows, cols, map, covered, truncated, cfg };
  }, [sheet, maxRows, maxCols, alreadyTruncated]);

  const colHidden = grid.cfg.colhidden ?? {};
  const rowHidden = grid.cfg.rowhidden ?? {};
  const visibleCols = Array.from({ length: grid.cols }, (_, c) => c).filter((c) => !(String(c) in colHidden));

  return (
    <div className="flex h-full flex-col">
      <div className="promptly-scroll min-h-0 flex-1 overflow-auto bg-white text-neutral-900">
        {grid.rows === 0 ? (
          <div className="p-6 text-sm text-neutral-500">This sheet is empty.</div>
        ) : (
          <table className="border-collapse text-[13px]" aria-label={sheet?.name || "Sheet"}>
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-20 w-10 border border-neutral-200 bg-neutral-100" />
                {visibleCols.map((c) => (
                  <th
                    key={c}
                    style={grid.cfg.columnlen?.[String(c)] ? { width: grid.cfg.columnlen[String(c)] } : undefined}
                    className="sticky top-0 z-10 min-w-[4rem] border border-neutral-200 bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-500"
                  >
                    {colName(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: grid.rows }, (_, r) => r)
                .filter((r) => !(String(r) in rowHidden))
                .map((r) => {
                  const height = grid.cfg.rowlen?.[String(r)];
                  return (
                    <tr key={r} style={height ? { height } : undefined}>
                      <th className="sticky left-0 z-10 border border-neutral-200 bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-500">
                        {r + 1}
                      </th>
                      {visibleCols.map((c) => {
                        const key = `${r}:${c}`;
                        if (grid.covered.has(key)) return null;
                        const cell = grid.map.get(key);
                        const v = typeof cell?.v === "object" && cell?.v ? cell.v : undefined;
                        const mc = v?.mc && v.mc.r === r && v.mc.c === c ? v.mc : undefined;
                        const wrap = String(v?.tb) === "2";
                        return (
                          <td
                            key={c}
                            colSpan={mc?.cs && mc.cs > 1 ? Math.min(mc.cs, grid.cols - c) : undefined}
                            rowSpan={mc?.rs && mc.rs > 1 ? Math.min(mc.rs, grid.rows - r) : undefined}
                            style={cellStyle(v, mc ? undefined : grid.cfg.columnlen?.[String(c)])}
                            className={cn(
                              "border border-neutral-200 px-2 py-1",
                              !wrap && "max-w-[20rem] truncate whitespace-nowrap",
                              !grid.cfg.columnlen?.[String(c)] && "min-w-[4rem]"
                            )}
                          >
                            {sheetCellText(cell?.v)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
            </tbody>
          </table>
        )}
        {grid.truncated && (
          <div className="p-3 text-xs text-neutral-500">
            Showing the first {maxRows} rows and {maxCols} columns — open or download it for everything.
          </div>
        )}
      </div>
      {tabs.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-t border-[var(--border)] bg-[var(--surface)] px-2 py-1" role="tablist">
          {tabs.map((t, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === tab}
              onClick={() => setTab(i)}
              className={cn(
                "rounded px-3 py-1 text-xs",
                i === tab ? "bg-[var(--accent)]/15 font-medium text-[var(--text)]" : "text-[var(--text-muted)] hover:bg-[var(--hover)]"
              )}
            >
              {t.name || `Sheet${i + 1}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
