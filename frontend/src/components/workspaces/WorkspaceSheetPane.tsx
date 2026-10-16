import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  Download,
  Eraser,
  History,
  MessageSquare,
  Sparkles,
  Loader2,
  Upload,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Workbook, type WorkbookInstance } from "@fortune-sheet/react";
import { update as ssfFormat, type Sheet } from "@fortune-sheet/core";
import "@fortune-sheet/react/dist/index.css";
// Our legibility overrides — imported after the library CSS so they win.
import "@/styles/fortune-sheet.css";

import type { SheetVersion, WorkspaceItemNode } from "@/api/workspaces";
import { toast } from "@/store/toastStore";
import { formatRelativeTime } from "@/components/files/helpers";
import { apiErrorMessage } from "@/utils/apiError";
import { fillDisplayText, needsRecalc } from "@/lib/sheetDisplay";
import { confirm } from "@/components/shared/ConfirmDialog";
import { ErrorState } from "@/components/shared/Callout";
import { ItemPaneHeader } from "./ItemPaneHeader";
import { SheetAiPanel, describeSelection } from "./SheetAiPanel";
import { SheetComments } from "./SheetComments";
import { VersionHistoryPanel } from "@/components/files/VersionHistoryPanel";
import { useDocComments } from "@/components/files/documents/useDocComments";
import { useAskEditorAi, useRegisterEditorAi } from "@/lib/editorAiBridge";
import { PresenceChips } from "./PresenceChips";
import { useSheetCollabProvider } from "./useSheetCollabProvider";
import { workspaceSheetBackend, type SheetBackend } from "./sheetBackend";
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
  backend,
  focusCell,
  fileId,
  openCommentId,
}: {
  /** The workspace the sheet is in; absent when opened from Files. */
  workspaceId?: string;
  sheetId: string;
  canEdit: boolean;
  /** Where to load and save (WP-3.4). Defaults to the workspace routes;
   *  the Files editor page passes the file-scoped one. Memoise it. */
  backend?: SheetBackend;
  /** When set, the unified ItemPaneHeader (title / ⚡ / duplicate) replaces
   *  the bare status strip; status + Clear fold into its slots. Absent for
   *  contexts that bring their own chrome (notebook pages). */
  node?: WorkspaceItemNode;
  /** Open on this row (1-based, as the sheet shows it) of this tab, with
   *  the row selected — where a chat citation points (WP-5.2). */
  focusCell?: { tab?: string; row: number };
  /** The sheet's file — turns on comments (WP-6.1) and, for editors, Sheet
   *  AI (fill / clean / build / explain, WP-5.5). */
  fileId?: string;
  /** Open the comments on this thread (a notification's link). */
  openCommentId?: string | null;
}) {
  const be = useMemo(
    () => backend ?? workspaceSheetBackend(workspaceId ?? "", sheetId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [backend?.key, workspaceId, sheetId]
  );
  const [data, setData] = useState<Sheet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  // Bumped to force a fresh Workbook mount after an explicit "Clear sheet".
  const [resetKey, setResetKey] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<Sheet[] | null>(null);
  // The workbook save version this editor is based on (WP-3.3): a save
  // after someone else's comes back 409 instead of overwriting them.
  const dataVersionRef = useRef<number | undefined>(undefined);
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
  const collab = useSheetCollabProvider(be);
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
    (sheets: Sheet[], attempt = 0): Promise<void> => {
      const celldataSheets = toCelldata(sheets);
      if (aliveRef.current) setSaveState("saving");
      return be
        .save({
          data: celldataSheets,
          content_text: flattenSheets(celldataSheets),
          data_version: dataVersionRef.current,
        })
        .then((saved) => {
          dataVersionRef.current = saved.data_version;
          if (aliveRef.current) setSaveState("saved");
        })
        .catch((err) => {
          const res = (err as { response?: { status?: number; data?: { detail?: StaleDetail } } })
            ?.response;
          const stale = res?.status === 409 && res.data?.detail?.code === "stale" ? res.data.detail : null;
          if (!stale) {
            if (aliveRef.current) setSaveState("error");
            return;
          }
          dataVersionRef.current = stale.data_version;
          // Someone saved in between. Cells and — since WP-6.3 — structure
          // (tabs, merges, widths…) reach this editor live, so its workbook
          // holds their change as well as ours: wait a moment for anything
          // still in flight, then save the current workbook on top of their
          // version. (Taking theirs used to throw away a tab added here.)
          if (attempt >= 3) {
            if (aliveRef.current) setSaveState("error");
            return;
          }
          return new Promise<void>((resolve) => window.setTimeout(resolve, 600 + attempt * 600)).then(() =>
            saveWorkbook(readSheets() ?? sheets, attempt + 1)
          );
        });
    },
    [be, readSheets]
  );

  // Set when the user's own edit removed cells — then an empty grid is
  // worth saving (R-171).
  const allowEmptyRef = useRef(false);
  const persist = useCallback(
    (sheets: Sheet[]) => {
      // Never autosave an empty workbook. Fortune-sheet fires an empty
      // ``onChange`` both as a mount echo (every time the editor opens) and
      // while tearing down on navigate-away; persisting either one clobbers
      // the real data with a blank grid. The only legit "all empty" is a
      // brand-new untouched sheet (nothing worth saving) or an explicit
      // "Clear sheet" (which goes through ``saveWorkbook`` directly).
      if (countCells(sheets) <= 0 && !allowEmptyRef.current) return;
      allowEmptyRef.current = false;
      void saveWorkbook(sheets);
    },
    [saveWorkbook]
  );

  // Formulas that arrived without a result (a script-written workbook, or
  // our own export) stay blank until Fortune-sheet calculates them — it
  // doesn't on load. Do it once per load, as an editor (WP-4.4).
  useEffect(() => {
    if (!canEdit || !data || !needsRecalc(data)) return;
    let tries = 0;
    let timer: number | null = null;
    const run = () => {
      const wb = workbookRef.current;
      if (!wb) {
        if (tries++ < 40) timer = window.setTimeout(run, 100);
        return;
      }
      try {
        wb.calculateFormula();
      } catch {
        /* a formula Fortune can't evaluate keeps its blank */
      }
    };
    timer = window.setTimeout(run, 150);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [data, resetKey, canEdit]);

  // A citation link: go to the cited tab and select the row, once loaded.
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusCell || focusedRef.current || !data?.length) return;
    const idx = focusCell.tab ? data.findIndex((sh) => sh.name === focusCell.tab) : 0;
    const sheet = data[Math.max(0, idx)];
    const r = Math.max(0, focusCell.row - 1);
    const lastCol = Math.max(
      0,
      ...((sheet?.celldata ?? []).filter((c) => c.r === r).map((c) => c.c) as number[])
    );
    let tries = 0;
    let timer: number | null = null;
    const run = () => {
      const wb = workbookRef.current;
      if (!wb) {
        if (tries++ < 40) timer = window.setTimeout(run, 100);
        return;
      }
      focusedRef.current = true;
      try {
        if (sheet?.id) wb.activateSheet({ id: sheet.id });
        window.setTimeout(() => {
          try {
            wb.setSelection([{ row: [r, r], column: [0, lastCol] }], sheet?.id ? { id: sheet.id } : undefined);
            wb.scroll({ targetRow: r });
          } catch {
            /* a row past the end — the sheet just opens at the top */
          }
        }, 50);
      } catch {
        /* unknown tab — open as usual */
      }
    };
    timer = window.setTimeout(run, 150);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, focusCell?.tab, focusCell?.row]);

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
    be
      .get()
      .then((s) => {
        if (cancelled) return;
        dataVersionRef.current = s.data_version;
        const sheets = (s.data as Sheet[] | null) ?? null;
        setData(
          sheets && sheets.length ? fillDisplayText(toCelldata(sheets), ssfFormat) : DEFAULT_SHEET
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
  }, [be]);

  const handleChange = useCallback(
    (next: Sheet[]) => {
      if (!canEdit) return;
      // Broadcast the edit to peers immediately (cheap diff vs. last sync);
      // remote echoes are suppressed inside the binding.
      const diff = onLocalChange(next);
      latest.current = next;
      // An echo of a teammate's edit: the room already has it, and the
      // editor who made it saves it. Every open copy used to PUT the whole
      // workbook for every remote edit (R-171).
      if (diff && diff.changed === 0 && diff.removed === 0 && !diff.struct) return;
      // The user deleted cells (possibly all of them): an empty workbook is
      // a real state to save now, not a mount/teardown echo.
      if (diff && diff.removed > 0) allowEmptyRef.current = true;
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
        "Remove all content from this sheet? You can get it back from Version history.",
      confirmLabel: "Clear sheet",
      danger: true,
    });
    if (!ok) return;
    try {
      await be.checkpoint("clear");
    } catch {
      /* the clear still goes ahead; the last autosave version remains */
    }
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
  }, [saveWorkbook, clearAll, be]);

  // Replace the whole workbook (an import or a restored version) in a way
  // that reaches everyone in the room: wipe the shared cells, remount with
  // the new data, push every cell, save (R-132).
  const loadWorkbook = useCallback(
    (incoming: Sheet[]) => {
      const sheets = fillDisplayText(incoming, ssfFormat);
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      latest.current = null;
      lastGoodRef.current = sheets;
      clearAll();
      const before = workbookRef.current;
      setData(sheets);
      setResetKey((k) => k + 1);
      let tries = 0;
      const push = () => {
        const wb = workbookRef.current;
        if ((!wb || wb === before) && tries++ < 40) {
          window.setTimeout(push, 100);
          return;
        }
        if (wb) onLocalChange(wb.getAllSheets());
        void saveWorkbook(sheets);
      };
      window.setTimeout(push, 100);
    },
    [clearAll, onLocalChange, saveWorkbook]
  );

  const importInput = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const handleImport = async (file: File | undefined) => {
    if (!file) return;
    const ok = await confirm({
      title: `Import "${file.name}"?`,
      message:
        "It replaces everything in this sheet for everyone. The current contents are kept in Version history.",
      confirmLabel: "Import",
    });
    if (!ok) return;
    setBusy("Importing…");
    try {
      const { data: sheets, notes } = await be.importFile(file);
      loadWorkbook(sheets as Sheet[]);
      if (notes.length) toast.info(`Imported ${file.name}. ${notes.join(" ")}`, { duration: 8000 });
      else toast.success(`Imported ${file.name}.`);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't import that file."));
    } finally {
      setBusy(null);
    }
  };
  const handleExport = async (format: "xlsx" | "csv") => {
    setBusy("Exporting…");
    try {
      // Save first so the export has the latest edit.
      const sheets = readSheets();
      if (sheets && canEdit && countCells(sheets) > 0) await saveWorkbook(sheets);
      const { blob, filename } = await be.exportFile(format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't export the sheet."));
    } finally {
      setBusy(null);
    }
  };
  const [historyOpen, setHistoryOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const comments = useDocComments(fileId, null, collab.provider);
  const [commentsOpen, setCommentsOpen] = useState(!!openCommentId);
  const askAi = useAskEditorAi();
  // What's selected, for the editor page's Ask panel.
  useRegisterEditorAi({ getSelection: () => describeSelection(workbookRef.current) });
  const restoreVersion = async (v: SheetVersion) => {
    const ok = await confirm({
      title: "Restore this version?",
      message: `The sheet goes back to how it was ${formatRelativeTime(v.created_at)} — for everyone. What's there now is kept as a version too.`,
      confirmLabel: "Restore",
    });
    if (!ok) return;
    setBusy("Restoring…");
    try {
      await be.checkpoint("restore");
      const sheets = (await be.version(v.id)) as Sheet[];
      loadWorkbook(sheets);
      setHistoryOpen(false);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't restore that version."));
    } finally {
      setBusy(null);
    }
  };

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
  const actionCls =
    "inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--text-muted)] transition hover:bg-[var(--hover)] hover:text-[var(--text)] disabled:opacity-50";
  const clearButton = (
    <span className="inline-flex items-center gap-0.5">
      {busy && (
        <span className="inline-flex items-center gap-1 px-1 text-[11px] text-[var(--text-muted)]">
          <Loader2 className="h-3 w-3 animate-spin" />
          {busy}
        </span>
      )}
      {canEdit && (
        <>
          <button
            type="button"
            onClick={() => importInput.current?.click()}
            disabled={!!busy}
            title="Replace this sheet with an .xlsx, .ods or .csv file"
            className={actionCls}
          >
            <Upload className="h-3.5 w-3.5" />
            Import
          </button>
          <input
            ref={importInput}
            type="file"
            accept=".xlsx,.xlsm,.ods,.csv,.tsv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.oasis.opendocument.spreadsheet"
            className="hidden"
            onChange={(e) => {
              void handleImport(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </>
      )}
      <button
        type="button"
        onClick={() => void handleExport("xlsx")}
        disabled={!!busy}
        title="Download as Excel (.xlsx), formulas included"
        className={actionCls}
      >
        <Download className="h-3.5 w-3.5" />
        .xlsx
      </button>
      <button
        type="button"
        onClick={() => void handleExport("csv")}
        disabled={!!busy}
        title="Download the first tab as .csv"
        className={actionCls}
      >
        .csv
      </button>
      {canEdit && fileId && (
        <button
          type="button"
          onClick={() => setAiOpen((o) => !o)}
          title="Fill a column, clean cells, build a tab or explain a formula with AI"
          aria-expanded={aiOpen}
          className={actionCls}
        >
          <Sparkles className="h-3.5 w-3.5" />
          AI
        </button>
      )}
      {fileId && (
        <button
          type="button"
          onClick={() => setCommentsOpen((o) => !o)}
          title="Comments on cells"
          aria-expanded={commentsOpen}
          className={actionCls}
        >
          <MessageSquare className="h-3.5 w-3.5" />
          {comments.openCount ? `Comments (${comments.openCount})` : "Comments"}
        </button>
      )}
      <button
        type="button"
        onClick={() => setHistoryOpen((o) => !o)}
        title="Version history"
        aria-expanded={historyOpen}
        className={actionCls}
      >
        <History className="h-3.5 w-3.5" />
        History
      </button>
      {canEdit && (
        <button
          type="button"
          onClick={() => void handleClear()}
          title="Clear all content from this sheet"
          className={actionCls}
        >
          <Eraser className="h-3.5 w-3.5" />
          Clear
        </button>
      )}
    </span>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ height: "100%" }}>
      {node && workspaceId ? (
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
        {commentsOpen && fileId && (
          <SheetComments
            fileId={fileId}
            workbookRef={workbookRef}
            comments={comments}
            onClose={() => setCommentsOpen(false)}
            openThreadId={openCommentId}
          />
        )}
        {aiOpen && fileId && (
          <SheetAiPanel
            fileId={fileId}
            workbookRef={workbookRef}
            onClose={() => setAiOpen(false)}
            onExplain={askAi ?? undefined}
          />
        )}
        {historyOpen && fileId && (
          <VersionHistoryPanel fileId={fileId} onClose={() => setHistoryOpen(false)} />
        )}
        {historyOpen && !fileId && (
          <SheetHistory
            backend={be}
            canRestore={canEdit}
            onRestore={(v) => void restoreVersion(v)}
            onClose={() => setHistoryOpen(false)}
          />
        )}
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

/** Version history (R-132): snapshots taken while the sheet is edited and
 *  before imports, restores and clears. */
function SheetHistory({
  backend,
  canRestore,
  onRestore,
  onClose,
}: {
  backend: SheetBackend;
  canRestore: boolean;
  onRestore: (v: SheetVersion) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<SheetVersion[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    backend
      .versions()
      .then(setRows)
      .catch((e) => setErr(apiErrorMessage(e, "Couldn't load the history.")));
  }, [backend]);
  const REASON: Record<SheetVersion["reason"], string> = {
    autosave: "Edited",
    import: "Before an import",
    restore: "Before a restore",
    clear: "Before clearing",
  };
  return (
    <aside
      aria-label="Version history"
      className="absolute right-2 top-2 z-30 flex max-h-[70%] w-72 flex-col overflow-hidden rounded-card border border-[var(--border)] bg-[var(--bg)] shadow-lg"
    >
      <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
        <span className="text-sm font-semibold text-[var(--text)]">Version history</span>
        <button type="button" onClick={onClose} className="text-xs text-[var(--text-muted)]">
          Close
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {err ? (
          <p className="p-3 text-xs text-[var(--danger)]">{err}</p>
        ) : rows === null ? (
          <p className="p-3 text-xs text-[var(--text-muted)]">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="p-3 text-xs text-[var(--text-muted)]">
            No earlier versions yet — they're kept as the sheet is edited.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {rows.map((v) => (
              <li key={v.id} className="flex items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-[var(--text)]" title={new Date(v.created_at).toLocaleString()}>
                    {formatRelativeTime(v.created_at)}
                  </div>
                  <div className="truncate text-[11px] text-[var(--text-muted)]">
                    {REASON[v.reason] ?? v.reason}
                    {v.author ? ` · ${v.author}` : ""} · {v.cell_count} cells
                  </div>
                </div>
                {canRestore && (
                  <button
                    type="button"
                    onClick={() => onRestore(v)}
                    className="shrink-0 text-xs font-medium text-[var(--accent-text)]"
                  >
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

interface StaleDetail {
  code: "stale";
  data_version: number;
  data: unknown[] | null;
}

/** The same tabs (names, in order) — cells sync live, tabs don't yet. */
