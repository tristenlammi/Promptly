import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import type { WorkbookInstance } from "@fortune-sheet/react";
import type { Sheet } from "@fortune-sheet/core";

import type { CollabTokenResponse } from "@/api/documents";

/**
 * Binds a Fortune-sheet workbook to a Y.Doc for live multi-user editing —
 * the spreadsheet analogue of ``useExcalidrawCanvas``'s Yjs binding.
 *
 * State-based, per-cell CRDT: each non-empty cell lives in a Y.Map keyed by
 * ``<sheetId>!<r>,<c>`` → the cell object (``{ v, m, ct, … }``). Local edits
 * diff against a snapshot and write only the deltas; remote changes are
 * applied back through the workbook API (``setCellValue`` / ``clearCell``),
 * with the snapshot updated first so the resulting ``onChange`` doesn't echo.
 *
 * Seeding: the first client into an empty room pushes the locally-loaded
 * workbook into the Y.Doc; later clients load the room's cells instead. Both
 * are idempotent (same key → same value), so a simultaneous seed converges.
 *
 * Scope (MVP): cell values + formatting across the workbook's existing sheet
 * tabs. Adding/removing/reordering tabs and row/column structural ops aren't
 * specially modelled — cell deltas still reconcile, but tab structure is
 * best-effort.
 */
const LOCAL_ORIGIN = "sheet-local";

interface CellEntry {
  [k: string]: unknown;
}

function sig(cell: unknown): string {
  return JSON.stringify(cell);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** All non-empty cells in the workbook, keyed ``<sheetId>!<r>,<c>``. */
function enumerateCells(sheets: Sheet[]): Map<string, CellEntry> {
  const out = new Map<string, CellEntry>();
  sheets.forEach((s, idx) => {
    const sheet = s as {
      id?: string;
      celldata?: { r: number; c: number; v: unknown }[];
      data?: unknown[][];
    };
    const sid = sheet.id ?? `#${idx}`;
    if (Array.isArray(sheet.celldata) && sheet.celldata.length) {
      for (const { r, c, v } of sheet.celldata) {
        if (v != null) out.set(`${sid}!${r},${c}`, v as CellEntry);
      }
      return;
    }
    const grid = sheet.data;
    if (!Array.isArray(grid)) return;
    for (let r = 0; r < grid.length; r++) {
      const row = grid[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        if (row[c] != null) out.set(`${sid}!${r},${c}`, row[c] as CellEntry);
      }
    }
  });
  return out;
}

function parseKey(key: string): { sheetId: string; r: number; c: number } | null {
  const bang = key.lastIndexOf("!");
  if (bang < 0) return null;
  const sheetId = key.slice(0, bang);
  const [rs, cs] = key.slice(bang + 1).split(",");
  const r = Number(rs);
  const c = Number(cs);
  if (!Number.isInteger(r) || !Number.isInteger(c)) return null;
  return { sheetId, r, c };
}

/** A connected peer, straight from the awareness channel. */
export interface SheetPeer {
  id: string;
  name: string;
  color: string;
  avatar: string | null;
}

export interface UseSheetCollabResult {
  /** Feed every Fortune-sheet ``onChange`` here to broadcast local edits. */
  onLocalChange: (sheets: Sheet[]) => void;
  /** Broadcast an explicit "clear sheet" — wipes the shared cell map. */
  clearAll: () => void;
  /** True once the initial sync (seed or load) has completed. */
  ready: boolean;
  /** Other connected editors (excludes self). */
  peers: number;
  /** Who those peers are — drives the presence chips in the pane header. */
  peerUsers: SheetPeer[];
}

export function useSheetCollab({
  workbookRef,
  ydoc,
  provider,
  user,
  readOnly,
}: {
  workbookRef: React.MutableRefObject<WorkbookInstance | null>;
  ydoc: Y.Doc | null;
  provider: HocuspocusProvider | null;
  user: CollabTokenResponse["user"] | null;
  readOnly: boolean;
}): UseSheetCollabResult {
  const [ready, setReady] = useState(false);
  const [peers, setPeers] = useState(0);
  const [peerUsers, setPeerUsers] = useState<SheetPeer[]>([]);

  const readyRef = useRef(false);
  const readOnlyRef = useRef(readOnly);
  useEffect(() => {
    readOnlyRef.current = readOnly;
  }, [readOnly]);

  // Last-known cell signatures, used to detect real local changes and to
  // suppress the echo from applying remote ops.
  const snapshotRef = useRef<Map<string, string>>(new Map());
  const yCellsRef = useRef<Y.Map<unknown> | null>(null);

  // ----- local -> Yjs (stable handler) ---------------------------------
  const onLocalChange = useCallback((sheets: Sheet[]) => {
    if (!readyRef.current || readOnlyRef.current) return;
    const yCells = yCellsRef.current;
    const doc = yCells?.doc;
    if (!yCells || !doc) return;

    const snapshot = snapshotRef.current;
    const current = enumerateCells(sheets);
    const changed: string[] = [];
    for (const [key, cell] of current) {
      if (snapshot.get(key) !== sig(cell)) changed.push(key);
    }
    const removed: string[] = [];
    for (const key of snapshot.keys()) {
      if (!current.has(key)) removed.push(key);
    }
    if (!changed.length && !removed.length) return;

    doc.transact(() => {
      for (const key of changed) {
        const cell = current.get(key)!;
        yCells.set(key, clone(cell));
        snapshot.set(key, sig(cell));
      }
      for (const key of removed) {
        yCells.delete(key);
        snapshot.delete(key);
      }
    }, LOCAL_ORIGIN);
  }, []);

  const clearAll = useCallback(() => {
    const yCells = yCellsRef.current;
    const doc = yCells?.doc;
    if (!yCells || !doc) return;
    doc.transact(() => yCells.clear(), LOCAL_ORIGIN);
    snapshotRef.current.clear();
  }, []);

  useEffect(() => {
    if (!ydoc || !provider) {
      readyRef.current = false;
      setReady(false);
      return;
    }

    const yCells = ydoc.getMap<unknown>("cells");
    yCellsRef.current = yCells;
    const snapshot = snapshotRef.current;
    const awareness = provider.awareness;
    const unsubs: Array<() => void> = [];

    // ----- Yjs -> workbook ---------------------------------------------
    const applyRemote = (keys: Iterable<string>) => {
      const wb = workbookRef.current;
      if (!wb) return;
      for (const key of keys) {
        const parsed = parseKey(key);
        if (!parsed) continue;
        const { sheetId, r, c } = parsed;
        const opts = sheetId.startsWith("#") ? undefined : { id: sheetId };
        const v = yCells.get(key);
        try {
          if (v == null) {
            wb.clearCell(r, c, opts);
            snapshot.delete(key);
          } else {
            // ``setCellValue`` copies ``ct`` (format) from an object value.
            wb.setCellValue(r, c, v, opts);
            snapshot.set(key, sig(v));
          }
        } catch {
          /* a cell outside the current grid bounds — skip */
        }
      }
    };

    const observer = (e: Y.YMapEvent<unknown>, txn: Y.Transaction) => {
      if (txn.origin === LOCAL_ORIGIN) return;
      applyRemote(e.keysChanged);
    };
    yCells.observe(observer);
    unsubs.push(() => yCells.unobserve(observer));

    // ----- presence ------------------------------------------------------
    if (awareness && user) {
      awareness.setLocalStateField("user", {
        id: user.id,
        name: user.name,
        color: user.color,
        avatar: user.avatar ?? null,
      });
      const onAwareness = () => {
        const others: SheetPeer[] = [];
        awareness.getStates().forEach((state, clientId) => {
          if (clientId === awareness.clientID) return;
          const u = state.user as
            | {
                id?: string;
                name?: string;
                color?: string;
                avatar?: string | null;
              }
            | undefined;
          others.push({
            id: u?.id ?? String(clientId),
            name: u?.name ?? "Anonymous",
            color: u?.color ?? "#D97757",
            avatar: u?.avatar ?? null,
          });
        });
        setPeers(others.length);
        setPeerUsers(others);
      };
      awareness.on("change", onAwareness);
      onAwareness();
      unsubs.push(() => awareness.off("change", onAwareness));
    }

    // ----- initial sync (seed empty room, or load existing) ------------
    const sync = (attempt = 0) => {
      const wb = workbookRef.current;
      if (yCells.size === 0) {
        // Empty room → seed from the locally-loaded workbook. The workbook
        // may not have mounted yet (provider synced before data loaded);
        // retry briefly so the existing cells reach the shared doc without
        // waiting for the first edit.
        if (!wb && attempt < 20) {
          const t = setTimeout(() => sync(attempt + 1), 150);
          unsubs.push(() => clearTimeout(t));
          return;
        }
        readyRef.current = true;
        if (wb) onLocalChange(wb.getAllSheets());
      } else {
        applyRemote([...yCells.keys()]);
        readyRef.current = true;
      }
      setReady(true);
    };

    if (provider.isSynced) {
      sync();
    } else {
      const onSynced = () => {
        provider.off("synced", onSynced);
        sync();
      };
      provider.on("synced", onSynced);
      unsubs.push(() => provider.off("synced", onSynced));
    }

    return () => {
      unsubs.forEach((fn) => {
        try {
          fn();
        } catch {
          /* best-effort teardown */
        }
      });
      try {
        awareness?.setLocalState(null);
      } catch {
        /* ignore */
      }
      yCellsRef.current = null;
      snapshot.clear();
      readyRef.current = false;
      setReady(false);
      setPeers(0);
      setPeerUsers([]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ydoc, provider, user?.id, user?.name, user?.color, onLocalChange]);

  return { onLocalChange, clearAll, ready, peers, peerUsers };
}
