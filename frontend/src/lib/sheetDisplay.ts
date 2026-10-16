/**
 * Small fix-ups a Fortune-sheet workbook needs before it's drawn (WP-4.4).
 *
 * Fortune-sheet paints a cell's ``m`` (display text) and never formats a
 * number itself, so an imported date with no ``m`` would show as 46112.
 * The server fills ``m`` for the formats it knows; :func:`fillDisplayText`
 * fills the rest with Fortune's own SSF formatter, passed in (so this file
 * stays pure and testable without the editor bundle).
 *
 * Fortune-sheet also doesn't calculate formulas on load: a formula that
 * arrived without a result (a workbook written by a script, or by our own
 * export) stays blank until edited. :func:`needsRecalc` spots those so the
 * editor can run ``calculateFormula()`` once.
 */
type Cell = { v?: unknown; m?: unknown; f?: unknown; ct?: { fa?: unknown; t?: unknown } } & Record<string, unknown>;
type Tab = { celldata?: { r: number; c: number; v: unknown }[] } & Record<string, unknown>;

function isFormatted(v: Cell): boolean {
  const t = v.ct?.t;
  const fa = v.ct?.fa;
  return (t === "n" || t === "d") && typeof fa === "string" && fa !== "" && fa !== "General";
}

export function fillDisplayText<T>(sheets: T[], format: (fa: string, v: unknown) => unknown): T[] {
  return sheets.map((s) => {
    const tab = s as unknown as Tab;
    if (!Array.isArray(tab.celldata)) return s;
    let touched = false;
    const celldata = tab.celldata.map((cell) => {
      const v = cell.v as Cell | null;
      if (!v || typeof v !== "object" || v.m != null || v.v == null || v.v === "" || !isFormatted(v)) return cell;
      const n = typeof v.v === "number" ? v.v : Number(v.v);
      if (!Number.isFinite(n)) return cell;
      let shown: unknown;
      try {
        shown = format(String(v.ct!.fa), n);
      } catch {
        return cell;
      }
      if (shown == null || shown === "") return cell;
      touched = true;
      return { ...cell, v: { ...v, m: String(shown) } };
    });
    return touched ? ({ ...tab, celldata } as unknown as T) : s;
  });
}

export function needsRecalc(sheets: unknown[]): boolean {
  for (const s of sheets) {
    const tab = s as Tab;
    for (const cell of tab?.celldata ?? []) {
      const v = cell.v as Cell | null;
      if (v && typeof v === "object" && typeof v.f === "string" && v.f && (v.v == null || v.v === "")) return true;
    }
  }
  return false;
}
