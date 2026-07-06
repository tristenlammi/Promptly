import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Eraser, Loader2, Users, Wifi, WifiOff } from "lucide-react";
import { Workbook, type WorkbookInstance } from "@fortune-sheet/react";
import type { Sheet } from "@fortune-sheet/core";
import "@fortune-sheet/react/dist/index.css";
// Our legibility overrides — imported after the library CSS so they win.
import "@/styles/fortune-sheet.css";

import { workspacesApi, type WorkspaceItemNode } from "@/api/workspaces";
import { apiErrorMessage } from "@/utils/apiError";
import { confirm } from "@/components/shared/ConfirmDialog";
import { ErrorState } from "@/components/shared/Callout";
import { ItemPaneHeader } from "./ItemPaneHeader";
import { PresenceChips } from "./PresenceChips";
import { useSheetCollabProvider } from "./useSheetCollabProvider";
import { useSheetCollab } from "./useSheetCollab";

type SaveState = "idle" | "saving" | "saved" | "error";

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

/**
 * Normalise sheets to Fortune-sheet's sparse ``celldata`` form, which is what
 * ``<Workbook data>`` initialises its grid from. ``getAllSheets()`` hands back
 * cells in the dense ``data`` matrix instead — persisting that produces a sheet
 * that reloads blank (the matrix is ignored on init). So we convert the matrix
 * to ``celldata`` (and drop the matrix to avoid ambiguity) for both save and
 * load. Sheets already carrying ``celldata`` pass through untouched.
 */
function toCelldata(sheets: Sheet[]): Sheet[] {
  return sheets.map((s) => {
    const sheet = s as {
      celldata?: { r: number; c: number; v: unknown }[];
      data?: unknown[][];
      [k: string]: unknown;
    };
    if (Array.isArray(sheet.celldata) && sheet.celldata.length) {
      const { data: _drop, ...rest } = sheet;
      return rest as unknown as Sheet;
    }
    const grid = sheet.data;
    if (!Array.isArray(grid)) return s;
    const celldata: { r: number; c: number; v: unknown }[] = [];
    for (let r = 0; r < grid.length; r++) {
      const row = grid[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        if (row[c] != null) celldata.push({ r, c, v: row[c] });
      }
    }
    const { data: _drop, ...rest } = sheet;
    return { ...rest, celldata } as unknown as Sheet;
  });
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
  node,
}: {
  workspaceId: string;
  sheetId: string;
  canEdit: boolean;
  /** When set, the unified ItemPaneHeader (title / ⚡ / duplicate) replaces
   *  the bare status strip; status + Clear fold into its slots. Absent for
   *  contexts that bring their own chrome (notebook pages). */
  node?: WorkspaceItemNode;
}) {
  const [data, setData] = useState<Sheet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  // Bumped to force a fresh Workbook mount after an explicit "Clear sheet".
  const [resetKey, setResetKey] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<Sheet[] | null>(null);
  // Guards state updates from in-flight saves after unmount.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Fortune-sheet's ``onChange`` data argument is unreliable — the cell being
  // edited often isn't committed into it, so saving that produces an empty
  // grid. Read the live workbook via the ref at save time instead.
  const workbookRef = useRef<WorkbookInstance | null>(null);

  // Live collaboration — binds the workbook to a ``sheet:<id>`` Y.Doc. Edits
  // sync peer-to-peer via Hocuspocus; the debounced PUT below still runs to
  // keep the DB snapshot + RAG text fresh (the collab server doesn't decode
  // the sheet schema). Collab is best-effort: if it can't connect, the sheet
  // keeps working single-user off the snapshot save.
  const collab = useSheetCollabProvider(workspaceId, sheetId);
  const { onLocalChange, clearAll, peers, peerUsers } = useSheetCollab({
    workbookRef,
    ydoc: collab.ydoc,
    provider: collab.provider,
    user: collab.user,
    readOnly: !canEdit,
  });

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

  // Low-level save with a status report (guarded against post-unmount state
  // updates). Saves whatever it's given — the empty-grid guard lives in
  // ``persist``; an explicit "Clear sheet" calls this directly to bypass it.
  const saveWorkbook = useCallback(
    (sheets: Sheet[]) => {
      const celldataSheets = toCelldata(sheets);
      if (aliveRef.current) setSaveState("saving");
      return workspacesApi
        .saveSpreadsheet(workspaceId, sheetId, {
          data: celldataSheets,
          content_text: flattenSheets(celldataSheets),
        })
        .then(() => {
          if (aliveRef.current) setSaveState("saved");
        })
        .catch(() => {
          if (aliveRef.current) setSaveState("error");
        });
    },
    [workspaceId, sheetId]
  );

  const persist = useCallback(
    (sheets: Sheet[]) => {
      // Never autosave an empty workbook. Fortune-sheet fires an empty
      // ``onChange`` both as a mount echo (every time the editor opens) and
      // while tearing down on navigate-away; persisting either one clobbers
      // the real data with a blank grid. The only legit "all empty" is a
      // brand-new untouched sheet (nothing worth saving) or an explicit
      // "Clear sheet" (which goes through ``saveWorkbook`` directly).
      if (countCells(sheets) <= 0) return;
      void saveWorkbook(sheets);
    },
    [saveWorkbook]
  );

  // Let the "Saved" / "Save failed" tick fade back to nothing.
  useEffect(() => {
    if (saveState !== "saved" && saveState !== "error") return;
    const t = setTimeout(() => setSaveState("idle"), 2200);
    return () => clearTimeout(t);
  }, [saveState]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setData(null);
    setSaveState("idle");
    latest.current = null;
    lastGoodRef.current = null;
    workspacesApi
      .getSpreadsheet(workspaceId, sheetId)
      .then((s) => {
        if (cancelled) return;
        const sheets = (s.data as Sheet[] | null) ?? null;
        setData(
          sheets && sheets.length ? toCelldata(sheets) : DEFAULT_SHEET
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setError(apiErrorMessage(err, "Couldn't open this spreadsheet."));
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
      // Broadcast the edit to peers immediately (cheap diff vs. last sync);
      // remote echoes are suppressed inside the binding.
      onLocalChange(next);
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
    [canEdit, readSheets, persist, onLocalChange]
  );

  // Explicit "Clear sheet" — the one path allowed to persist an empty grid.
  // Resets local edit-tracking, remounts a blank Workbook, and saves empty.
  const handleClear = useCallback(async () => {
    const ok = await confirm({
      title: "Clear sheet",
      message:
        "Remove all content from this sheet? This can't be undone.",
      confirmLabel: "Clear sheet",
      danger: true,
    });
    if (!ok) return;
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    latest.current = null;
    lastGoodRef.current = null;
    clearAll(); // wipe the shared cell map so the clear reaches peers
    const blank: Sheet[] = [{ name: "Sheet1" }];
    setData(blank);
    setResetKey((k) => k + 1); // force a fresh, empty Workbook mount
    void saveWorkbook(blank); // explicit empty save (bypasses the empty guard)
  }, [saveWorkbook, clearAll]);

  if (error) {
    return <ErrorState>{error}</ErrorState>;
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
  // concrete height — the flex column (``height: 100%``) gives the grid
  // container a real ``flex-1`` height below the thin status/actions bar.
  const statusChips = (
    <>
      <PresenceChips peers={peerUsers} />
      <CollabStatus status={collab.status} peers={peers} />
      <span className="mx-1 h-3 w-px bg-[var(--border)]" />
      <SaveStatus state={saveState} />
    </>
  );
  const clearButton = canEdit ? (
    <button
      type="button"
      onClick={() => void handleClear()}
      title="Clear all content from this sheet"
      className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)]"
    >
      <Eraser className="h-3.5 w-3.5" />
      Clear
    </button>
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ height: "100%" }}>
      {node ? (
        <ItemPaneHeader
          workspaceId={workspaceId}
          itemId={node.id}
          kind="sheet"
          fallbackTitle={node.title}
          canEdit={canEdit}
          status={statusChips}
          extra={clearButton}
        />
      ) : (
        <div className="flex shrink-0 items-center justify-end gap-1 border-b border-[var(--border)] bg-[var(--surface)] px-2 py-1">
          {statusChips}
          {clearButton}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <Workbook
          key={resetKey}
          ref={workbookRef}
          data={data}
          onChange={handleChange}
          allowEdit={canEdit}
          lang="en"
        />
      </div>
    </div>
  );
}

function CollabStatus({
  status,
  peers,
}: {
  status: "connecting" | "connected" | "disconnected";
  peers: number;
}) {
  if (status === "connected") {
    return (
      <span
        className="inline-flex items-center gap-1 px-1 text-[11px] text-[var(--text-muted)]"
        title={
          peers > 0
            ? `Live — ${peers} other ${peers === 1 ? "person" : "people"} editing`
            : "Live — changes sync in real time"
        }
      >
        {peers > 0 ? (
          <>
            <Users className="h-3 w-3 text-[var(--success)]" />
            <span className="text-[var(--success)]">{peers + 1}</span>
          </>
        ) : (
          <Wifi className="h-3 w-3 text-[var(--success)]" />
        )}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-1 text-[11px] text-[var(--text-muted)]"
      title={
        status === "connecting"
          ? "Connecting to live collaboration…"
          : "Offline — your edits save but won't sync live"
      }
    >
      {status === "connecting" ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <WifiOff className="h-3 w-3" />
      )}
    </span>
  );
}

function SaveStatus({ state }: { state: SaveState }) {
  if (state === "saving") {
    return (
      <span className="inline-flex items-center gap-1 px-1 text-[11px] text-[var(--text-muted)]">
        <Loader2 className="h-3 w-3 animate-spin" />
        Saving…
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span className="inline-flex items-center gap-1 px-1 text-[11px] text-[var(--success)]">
        <Check className="h-3 w-3" />
        Saved
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className="inline-flex items-center gap-1 px-1 text-[11px] text-[var(--danger)]">
        <CircleAlert className="h-3 w-3" />
        Save failed
      </span>
    );
  }
  return null;
}
