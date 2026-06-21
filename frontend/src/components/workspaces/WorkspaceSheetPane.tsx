import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Workbook, type WorkbookInstance } from "@fortune-sheet/react";
import type { Sheet } from "@fortune-sheet/core";
import "@fortune-sheet/react/dist/index.css";
// Our legibility overrides — imported after the library CSS so they win.
import "@/styles/fortune-sheet.css";

import { workspacesApi } from "@/api/workspaces";

// Fortune-sheet wants at least one named sheet; seed one when a spreadsheet
// page has never been saved (``data`` is null).
const DEFAULT_SHEET: Sheet[] = [{ name: "Sheet1" }];

const SAVE_DEBOUNCE_MS = 800;

// Cap the flattened text we ship for RAG so a giant sheet can't bloat the
// save payload / embeddings. ~200k chars is far beyond any normal sheet.
const FLATTEN_CHAR_CAP = 200_000;

/** A Fortune-sheet cell can be a primitive or a ``{ v, m, ... }`` object —
 *  ``m`` is the rendered display string, ``v`` the raw value. Prefer the
 *  display string so dates/formats read the way the user sees them. */
function cellText(cell: unknown): string {
  if (cell == null) return "";
  if (typeof cell !== "object") return String(cell).trim();
  const obj = cell as { v?: unknown; m?: unknown };
  const val = obj.m ?? obj.v;
  return val == null ? "" : String(val).trim();
}

/** Debug: count non-empty cells across a workbook (celldata + dense grid). */
function countCells(sheets: Sheet[] | null | undefined): number {
  if (!sheets) return -1;
  let n = 0;
  for (const s of sheets) {
    const cd = (s as { celldata?: unknown[] }).celldata;
    if (Array.isArray(cd)) n += cd.length;
    const grid = (s as { data?: unknown[][] }).data;
    if (Array.isArray(grid)) {
      for (const row of grid)
        for (const c of row ?? []) if (c != null) n += 1;
    }
  }
  return n;
}

/** Flatten a workbook to plain text for workspace RAG + memory: each sheet
 *  becomes a ``## Name`` block of tab-separated rows. Reads either the sparse
 *  ``celldata`` form or the dense ``data`` grid, whichever the workbook uses. */
function flattenSheets(sheets: Sheet[]): string {
  const blocks: string[] = [];
  for (const sheet of sheets) {
    const name = sheet.name || "Sheet";
    const rows = new Map<number, Map<number, string>>();
    const put = (r: number, c: number, cell: unknown) => {
      const text = cellText(cell);
      if (!text) return;
      if (!rows.has(r)) rows.set(r, new Map());
      rows.get(r)!.set(c, text);
    };
    const cd = (sheet as { celldata?: Array<{ r: number; c: number; v: unknown }> })
      .celldata;
    const grid = (sheet as { data?: unknown[][] }).data;
    if (cd && cd.length) {
      for (const { r, c, v } of cd) put(r, c, v);
    } else if (grid) {
      for (let r = 0; r < grid.length; r++) {
        const row = grid[r];
        if (!row) continue;
        for (let c = 0; c < row.length; c++) put(r, c, row[c]);
      }
    }
    if (!rows.size) continue;
    const lines = [...rows.keys()]
      .sort((a, b) => a - b)
      .map((r) => {
        const cols = rows.get(r)!;
        return [...cols.keys()]
          .sort((a, b) => a - b)
          .map((c) => cols.get(c)!)
          .join("\t");
      });
    blocks.push(`## ${name}\n${lines.join("\n")}`);
  }
  return blocks.join("\n\n").trim().slice(0, FLATTEN_CHAR_CAP);
}

/**
 * A spreadsheet page of a multi-page document. Mounts Fortune-sheet against a
 * ``Spreadsheet`` row and persists edits with a debounced PUT (single-user
 * for now — live collaboration is a later phase). Lazy-loaded by the note
 * pane so the (large) editor chunk only downloads when a sheet page opens.
 */
export function WorkspaceSheetPane({
  workspaceId,
  sheetId,
  canEdit,
}: {
  workspaceId: string;
  sheetId: string;
  canEdit: boolean;
}) {
  const [data, setData] = useState<Sheet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<Sheet[] | null>(null);
  // Fortune-sheet's ``onChange`` data argument is unreliable — the cell being
  // edited often isn't committed into it, so saving that produces an empty
  // grid. Read the live workbook via the ref at save time instead.
  const workbookRef = useRef<WorkbookInstance | null>(null);

  // The last ``onChange`` snapshot that actually had cells. Fortune-sheet
  // emits a spurious *empty* workbook while tearing down on navigate-away;
  // remembering the last good state lets us save that instead of the blank.
  const lastGoodRef = useRef<Sheet[] | null>(null);

  // Current workbook state. ``getAllSheets()``, the latest ``onChange``
  // snapshot, and the last-good snapshot can disagree (one empty, one
  // populated) depending on commit/teardown timing, so save whichever
  // carries the most cells — never overwrite good data with an empty grid.
  const readSheets = useCallback((): Sheet[] | null => {
    const candidates: (Sheet[] | null | undefined)[] = [
      workbookRef.current?.getAllSheets?.() as Sheet[] | undefined,
      latest.current,
      lastGoodRef.current,
    ];
    let best: Sheet[] | null = null;
    let bestN = -1;
    for (const c of candidates) {
      if (!c) continue;
      const n = countCells(c);
      if (n > bestN) {
        bestN = n;
        best = c;
      }
    }
    return best;
  }, []);

  const persist = useCallback(
    (sheets: Sheet[]) => {
      // Never autosave an empty workbook. Fortune-sheet fires an empty
      // ``onChange`` both as a mount echo (every time the editor opens) and
      // while tearing down on navigate-away; persisting either one clobbers
      // the real data with a blank grid. The only legit "all empty" is a
      // brand-new untouched sheet, which has nothing worth saving anyway.
      // (Clearing individual cells among others still persists — only an
      // all-zero grid is rejected. To truly blank a sheet, delete it.)
      if (countCells(sheets) <= 0) return;
      void workspacesApi
        .saveSpreadsheet(workspaceId, sheetId, {
          data: sheets,
          content_text: flattenSheets(sheets),
        })
        .catch(() => {});
    },
    [workspaceId, sheetId]
  );

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setData(null);
    latest.current = null;
    workspacesApi
      .getSpreadsheet(workspaceId, sheetId)
      .then((s) => {
        if (cancelled) return;
        const sheets = (s.data as Sheet[] | null) ?? null;
        setData(sheets && sheets.length ? sheets : DEFAULT_SHEET);
      })
      .catch((err) => {
        if (cancelled) return;
        const detail =
          (err as { response?: { data?: { detail?: string } } })?.response?.data
            ?.detail ?? "Couldn't open this spreadsheet.";
        setError(detail);
      });
    return () => {
      cancelled = true;
      // Flush any pending edit on unmount / page switch so a quick edit →
      // tab-away doesn't lose the last keystrokes.
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      // Flush the live workbook on unmount / page switch so a quick edit →
      // tab-away doesn't lose the last keystrokes. ``persist`` no-ops on an
      // empty grid, so a teardown that reads blank can't clobber.
      const sheets = readSheets();
      if (sheets && canEdit) persist(sheets);
    };
    // canEdit intentionally excluded — flushing on unmount reads it via ref
    // semantics; re-running the loader on a permission flip isn't desired.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, sheetId]);

  const handleChange = useCallback(
    (next: Sheet[]) => {
      if (!canEdit) return;
      latest.current = next;
      // Remember the last snapshot that had cells, so a save during teardown
      // (when the live workbook reads empty) still writes the real data.
      if (countCells(next) > 0) lastGoodRef.current = next;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        persist(readSheets() ?? next);
      }, SAVE_DEBOUNCE_MS);
    },
    [canEdit, readSheets, persist]
  );

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="rounded-card border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10 text-sm text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Opening sheet…
        </span>
      </div>
    );
  }

  // Fortune-sheet positions its grid absolutely, so the wrapper needs a
  // concrete height — ``flex-1 min-h-0`` plus an explicit 100% height gives
  // it one inside the pane's flex column.
  return (
    <div className="relative min-h-0 flex-1" style={{ height: "100%" }}>
      <Workbook
        ref={workbookRef}
        data={data}
        onChange={handleChange}
        allowEdit={canEdit}
        lang="en"
      />
    </div>
  );
}
