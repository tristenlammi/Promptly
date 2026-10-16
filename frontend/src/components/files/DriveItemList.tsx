import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { DriveItemRow, type DriveEntry } from "./DriveItemRow";
import { cn } from "@/utils/cn";

/**
 * A virtualised Drive list (WP-7.6, Part C §5.9): only the rows near the
 * viewport are in the DOM, so a 20,000-photo folder scrolls like a
 * 20-file one. List view windows rows; grid view windows rows of tiles
 * (as many columns as fit the tile size). Rows are measured, so a second
 * line (where a file was, a search snippet) is fine. Near the end it asks
 * for the next page.
 *
 * Rows come from {@link DriveItemRow} under the page's
 * ``DriveListProvider``.
 */

/** A full-width line between items (the "System" folders toggle). */
export interface DriveSection {
  kind: "section";
  key: string;
  node: ReactNode;
}

export type DriveListItem = DriveEntry | DriveSection;

export interface DriveItemListHandle {
  /** Scroll ``key`` into view and focus it (keyboard navigation). */
  reveal: (key: string) => void;
  /** Tiles per row in grid view (1 in list view). */
  columns: () => number;
}

const GAP = 12;

/** The nearest scrolling ancestor — the page's content pane. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  let p = el?.parentElement ?? null;
  while (p) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === "auto" || oy === "scroll") return p;
    p = p.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

export const DriveItemList = forwardRef<
  DriveItemListHandle,
  {
    items: DriveListItem[];
    layout: "list" | "grid";
    /** Minimum tile width in grid view. */
    gridTile?: number;
    isSelected?: (entry: DriveEntry) => boolean;
    selectionActive?: boolean;
    editingKey?: string | null;
    /** Sticky column header (list view). */
    header?: ReactNode;
    hasMore?: boolean;
    loadingMore?: boolean;
    onLoadMore?: () => void;
    /** The scrolling element, if known (else the nearest scroll parent). */
    scrollRef?: RefObject<HTMLElement | null>;
    className?: string;
  }
>(function DriveItemList(
  { items, layout, gridTile = 160, isSelected, selectionActive = false, editingKey, header, hasMore, loadingMore, onLoadMore, scrollRef, className },
  ref
) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    setScrollEl(scrollRef?.current ?? scrollParent(boxRef.current));
  }, [scrollRef]);

  // Where the list starts inside the scroller (things above it scroll too),
  // and how wide it is (grid columns).
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || !scrollEl) return;
    const measure = () => {
      const top = box.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
      setMargin((m) => (Math.abs(m - top) > 0.5 ? top : m));
      setWidth(box.clientWidth);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(scrollEl);
    return () => ro.disconnect();
  });

  const grid = layout === "grid";
  const cols = grid ? Math.max(1, Math.floor((width + GAP) / (gridTile + GAP))) : 1;

  // Grid: rows of up to ``cols`` tiles; a section takes a row to itself.
  const rows = useMemo(() => {
    if (!grid) return items.map((it) => [it]);
    const out: DriveListItem[][] = [];
    let cur: DriveListItem[] = [];
    for (const it of items) {
      if (it.kind === "section") {
        if (cur.length) out.push(cur);
        out.push([it]);
        cur = [];
        continue;
      }
      cur.push(it);
      if (cur.length === cols) {
        out.push(cur);
        cur = [];
      }
    }
    if (cur.length) out.push(cur);
    return out;
  }, [items, grid, cols]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: (i) => (rows[i]?.[0]?.kind === "section" ? 36 : grid ? gridTile + 96 : 49),
    overscan: grid ? 3 : 12,
    scrollMargin: margin,
    getItemKey: (i) => rows[i]?.[0]?.key ?? i,
  });
  const virtual = virtualizer.getVirtualItems();

  // The next page, as the end comes near.
  const last = virtual[virtual.length - 1]?.index ?? -1;
  useEffect(() => {
    if (hasMore && !loadingMore && onLoadMore && last >= rows.length - (grid ? 3 : 15)) onLoadMore();
  }, [last, rows.length, hasMore, loadingMore, onLoadMore, grid]);

  const reveal = useCallback(
    (key: string) => {
      const index = rows.findIndex((r) => r.some((it) => it.key === key));
      if (index < 0) return;
      virtualizer.scrollToIndex(index, { align: "auto" });
      // After it's rendered.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const el = boxRef.current?.querySelector<HTMLElement>(`[data-drive-item="${CSS.escape(key)}"]`);
          el?.focus();
        })
      );
    },
    [rows, virtualizer]
  );
  useImperativeHandle(ref, () => ({ reveal, columns: () => cols }), [reveal, cols]);

  const renderEntry = (it: DriveListItem, place?: { index: number; top: number }) =>
    it.kind === "section" ? null : (
      <DriveItemRow
        key={it.key}
        entry={it}
        selected={isSelected?.(it) ?? false}
        selectionActive={selectionActive}
        editing={editingKey === it.key}
        vIndex={place?.index}
        vTop={place?.top}
        vMeasure={place ? virtualizer.measureElement : undefined}
      />
    );

  const height = virtualizer.getTotalSize();
  const more =
    hasMore || loadingMore ? (
      <div className="py-3 text-center text-xs text-[var(--text-muted)]" role="status">
        Loading more…
      </div>
    ) : null;

  if (grid) {
    return (
      <div ref={boxRef} className={className}>
        <div style={{ height, position: "relative" }}>
          {virtual.map((v) => {
            const row = rows[v.index];
            const first = row[0];
            return (
              <div
                key={v.key}
                data-index={v.index}
                ref={virtualizer.measureElement}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${v.start - margin}px)` }}
              >
                {first.kind === "section" ? (
                  <div className="pb-3">{first.node}</div>
                ) : (
                  <ul className="grid pb-3" style={{ gap: GAP, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
                    {row.map((it) => renderEntry(it))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
        {more}
      </div>
    );
  }

  return (
    <div ref={boxRef} className={cn("rounded-card border border-[var(--border)] bg-[var(--surface)]", className)}>
      {header}
      <ul className="divide-y divide-[var(--border)]" style={{ height, position: "relative" }}>
        {virtual.map((v) => {
          const it = rows[v.index][0];
          const top = v.start - margin;
          return it.kind === "section" ? (
            <li
              key={v.key}
              data-index={v.index}
              ref={virtualizer.measureElement}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${top}px)` }}
            >
              {it.node}
            </li>
          ) : (
            renderEntry(it, { index: v.index, top })
          );
        })}
      </ul>
      {more}
    </div>
  );
});
