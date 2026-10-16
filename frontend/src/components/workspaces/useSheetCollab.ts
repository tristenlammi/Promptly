import { useCallback, useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import type { WorkbookInstance } from "@fortune-sheet/react";
import type { Sheet } from "@fortune-sheet/core";

import type { CollabTokenResponse } from "@/api/documents";
import { structEntries, sig as structSig } from "@/lib/sheetStructure";

import { applyStructure, tabsMissingFrom } from "./fortuneStructure";

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
 * Structure (WP-6.3): tabs, merges, frozen panes, widths, hidden rows and
 * columns, borders, images, conditional formats, links and validation live
 * in a second map (``struct``, see ``lib/sheetStructure``), keyed finely
 * enough that concurrent changes merge instead of the last save winning;
 * remote changes are applied by ``fortuneStructure``. The saved workbook
 * JSON is now a snapshot of the room, not where structure is shared.
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
  onLocalChange: (sheets: Sheet[]) => LocalDiff | null;
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
  // The same for the structure entries (WP-6.3).
  const structSnapRef = useRef<Map<string, string>>(new Map());
  const yStructRef = useRef<Y.Map<unknown> | null>(null);
  // Structure keys just applied from the room that the workbook may not show
  // yet (Fortune applies them on its next render) → until when to wait. An
  // onChange in between would otherwise read "the merge is gone" and delete
  // it for everyone — a loop between two windows.
  const pendingRef = useRef<Map<string, number>>(new Map());

  // ----- local -> Yjs (stable handler) ---------------------------------
  const onLocalChange = useCallback((sheets: Sheet[]): LocalDiff | null => {
    if (!readyRef.current || readOnlyRef.current) return null;
    const yCells = yCellsRef.current;
    const doc = yCells?.doc;
    if (!yCells || !doc) return null;

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
    // Structure: what differs from the last synced structure.
    const yStruct = yStructRef.current;
    const structSnap = structSnapRef.current;
    const struct = structEntries(sheets as unknown as Array<Record<string, unknown>>);
    const sChanged: string[] = [];
    const sRemoved: string[] = [];
    if (yStruct) {
      const pending = pendingRef.current;
      const now = Date.now();
      // Remote structure the workbook now shows is settled; anything still
      // waiting isn't a local change.
      const waiting = (key: string): boolean => {
        const until = pending.get(key);
        if (until === undefined) return false;
        const shown = struct.has(key) ? structSig(struct.get(key)) : undefined;
        if (shown === structSnap.get(key) || now > until) {
          pending.delete(key);
          return false;
        }
        return true;
      };
      for (const key of [...pending.keys()]) waiting(key);
      for (const [key, v] of struct) if (structSnap.get(key) !== structSig(v) && !waiting(key)) sChanged.push(key);
      for (const key of structSnap.keys()) if (!struct.has(key) && !waiting(key)) sRemoved.push(key);
    }
    if (yStruct && (sChanged.length || sRemoved.length)) {
      doc.transact(() => {
        for (const key of sChanged) {
          const v = struct.get(key);
          yStruct.set(key, clone(v));
          structSnap.set(key, structSig(v));
        }
        for (const key of sRemoved) {
          yStruct.delete(key);
          structSnap.delete(key);
        }
      }, LOCAL_ORIGIN);
    }
    const structCount = sChanged.length + sRemoved.length;
    if (!changed.length && !removed.length) {
      // No cell differs from the last synced state — the echo of a remote
      // edit we just applied (R-171), or a structure-only change.
      return { changed: 0, removed: 0, struct: structCount };
    }

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
    return { changed: changed.length, removed: removed.length, struct: structCount };
  }, []);

  const clearAll = useCallback(() => {
    const yCells = yCellsRef.current;
    const doc = yCells?.doc;
    if (!yCells || !doc) return;
    doc.transact(() => {
      yCells.clear();
      // The blank workbook's structure is pushed by the next change.
      yStructRef.current?.clear();
    }, LOCAL_ORIGIN);
    snapshotRef.current.clear();
    structSnapRef.current.clear();
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
    const yStruct = ydoc.getMap<unknown>("struct");
    const structSnap = structSnapRef.current;
    yStructRef.current = yStruct;
    const structNow = () => new Map(yStruct.entries());
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

    // Remote structure → workbook. The snapshot takes the remote values first
    // so the workbook's own onChange doesn't send them back.
    const applyStruct = (keys: Iterable<string>) => {
      const wb = workbookRef.current;
      if (!wb) return;
      const list = [...keys];
      const until = Date.now() + 3000;
      for (const key of list) {
        const v = yStruct.get(key);
        if (v === undefined) structSnap.delete(key);
        else structSnap.set(key, structSig(v));
        pendingRef.current.set(key, until);
      }
      applyStructure(wb, list, structNow());
    };
    const structObserver = (e: Y.YMapEvent<unknown>, txn: Y.Transaction) => {
      if (txn.origin === LOCAL_ORIGIN || !readyRef.current) return;
      applyStruct(e.keysChanged);
    };
    yStruct.observe(structObserver);
    unsubs.push(() => yStruct.unobserve(structObserver));

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
    // The room is the source of truth once it has ever been seeded. An
    // *empty* room used to look "never initialised", so opening a sheet
    // whose cells had all been deleted re-seeded it from the stale saved
    // snapshot — bringing the deleted data back for everyone (R-171).
    const meta = ydoc.getMap<unknown>("meta");
    const sync = (attempt = 0) => {
      const wb = workbookRef.current;
      // The workbook may not have mounted yet (provider synced before the
      // data loaded); retry briefly.
      if (!wb && attempt < 20) {
        const t = setTimeout(() => sync(attempt + 1), 150);
        unsubs.push(() => clearTimeout(t));
        return;
      }
      const seeded = meta.get("seeded") === true || yCells.size > 0;
      // A room from before WP-6.3 has cells but no structure yet: the first
      // editor in shares its workbook's structure; later ones take the room's.
      const structSeeded = meta.get("structSeeded") === true || yStruct.size > 0;
      if (structSeeded && wb) {
        // The room's tabs first, then drop local ones it doesn't have (so
        // "never delete the last tab" can't leave a stray one behind).
        const missing = tabsMissingFrom(wb, structNow());
        applyStruct([...yStruct.keys()]);
        for (const tab of missing) {
          try {
            wb.deleteSheet({ id: tab });
          } catch {
            /* last tab */
          }
        }
      } else if (!structSeeded) {
        ydoc.transact(() => meta.set("structSeeded", true), LOCAL_ORIGIN);
      }
      if (!seeded) {
        readyRef.current = true;
        if (wb) onLocalChange(wb.getAllSheets());
        ydoc.transact(() => meta.set("seeded", true), LOCAL_ORIGIN);
      } else {
        if (meta.get("seeded") !== true) {
          ydoc.transact(() => meta.set("seeded", true), LOCAL_ORIGIN);
        }
        // Cells the room no longer has were deleted by someone — drop
        // them locally instead of keeping (and later re-saving) them.
        if (wb) {
          const local = enumerateCells(wb.getAllSheets());
          const gone = [...local.keys()].filter((k) => !yCells.has(k));
          applyRemote(gone);
        }
        applyRemote([...yCells.keys()]);
        readyRef.current = true;
        // A first editor since WP-6.3 shares the structure now.
        if (!structSeeded && wb) onLocalChange(wb.getAllSheets());
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
      yStructRef.current = null;
      snapshot.clear();
      structSnap.clear();
      pendingRef.current.clear();
      readyRef.current = false;
      setReady(false);
      setPeers(0);
      setPeerUsers([]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ydoc, provider, user?.id, user?.name, user?.color, onLocalChange]);

  return { onLocalChange, clearAll, ready, peers, peerUsers };
}

/** What a local change sent to the room. */
export interface LocalDiff {
  changed: number;
  removed: number;
  /** Structure entries sent (WP-6.3) — a width, a merge, a new tab… */
  struct?: number;
}
