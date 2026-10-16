import type { WorkbookInstance } from "@fortune-sheet/react";
import type { Sheet } from "@fortune-sheet/core";

import { parseStructKey, tabFromEntries, tabsInEntries } from "@/lib/sheetStructure";

/**
 * Applies shared sheet structure (``lib/sheetStructure``) to a live
 * Fortune-sheet workbook (WP-6.3) — the one place that knows Fortune's API,
 * so the structure model could sit behind another spreadsheet engine.
 *
 * For each tab a change touched: a tab that's gone from the shared entries
 * is deleted; a new one is added; otherwise the tab is rebuilt from the
 * shared entries on top of its current cells (``updateSheet``). Fortune
 * queues each call as a state update, so they apply in order.
 */
export function applyStructure(
  wb: WorkbookInstance,
  changedKeys: Iterable<string>,
  entries: Map<string, unknown>
): void {
  const touched = new Set<string>();
  for (const k of changedKeys) {
    const p = parseStructKey(k);
    if (p) touched.add(p.tab);
  }
  if (!touched.size) return;
  let local: Sheet[] = [];
  try {
    local = wb.getAllSheets();
  } catch {
    return; // not loaded yet — the initial sync applies everything
  }
  const localIds = new Set(local.map((s, i) => String(s.id ?? `#${i}`)));
  const shared = new Set(tabsInEntries(entries).map((t) => t.id));
  const updates: Sheet[] = [];
  for (const tab of touched) {
    if (tab.startsWith("#")) continue; // tabs without an id can't be addressed
    if (!shared.has(tab)) {
      // Removed by someone. Never delete the last tab.
      if (localIds.has(tab) && localIds.size > 1) {
        try {
          wb.deleteSheet({ id: tab });
          localIds.delete(tab);
        } catch {
          /* already gone */
        }
      }
      continue;
    }
    let base: Record<string, unknown> = { id: tab, celldata: [] };
    if (localIds.has(tab)) {
      try {
        base = wb.getSheet({ id: tab }) as unknown as Record<string, unknown>;
      } catch {
        /* fall back to an empty tab */
      }
    }
    const next = tabFromEntries(base, tab, entries);
    // ``updateSheet`` re-builds the tab from ``celldata``: hand it the cells
    // and none of Fortune's cached grid.
    delete next.data;
    if (!Array.isArray(next.celldata)) next.celldata = [];
    updates.push(next as unknown as Sheet);
  }
  if (updates.length) {
    try {
      wb.updateSheet(updates);
    } catch {
      /* a malformed entry — the next save brings everyone back in line */
    }
  }
}

/** Tabs in the editor that the shared entries don't have (to delete when
 *  joining a room whose structure is already shared). */
export function tabsMissingFrom(wb: WorkbookInstance, entries: Map<string, unknown>): string[] {
  const shared = new Set(tabsInEntries(entries).map((t) => t.id));
  try {
    return wb
      .getAllSheets()
      .map((s, i) => String(s.id ?? `#${i}`))
      .filter((id) => !id.startsWith("#") && !shared.has(id));
  } catch {
    return [];
  }
}
