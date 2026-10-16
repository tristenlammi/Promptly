/**
 * A justified photo grid (WP-9.2): rows of photos at their own shapes, each
 * row scaled so it fills the width exactly — the last row of a group keeps
 * the target height rather than blowing up a lone photo. Pure, so the
 * Photos page can lay out a month before drawing it.
 */

export interface JustifyInput {
  /** width / height; anything missing or silly is drawn square. */
  aspect: number | null | undefined;
}

export interface JustifiedRow {
  /** Indexes into the input. */
  items: number[];
  /** Pixel widths, same order. */
  widths: number[];
  height: number;
}

const MIN_ASPECT = 0.4;
const MAX_ASPECT = 3;

export function safeAspect(a: number | null | undefined): number {
  if (!a || !Number.isFinite(a) || a <= 0) return 1;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, a));
}

export function justify(
  inputs: JustifyInput[],
  opts: { width: number; targetHeight: number; gap: number; maxHeight?: number },
): JustifiedRow[] {
  const { width, targetHeight, gap } = opts;
  const maxHeight = opts.maxHeight ?? targetHeight * 1.6;
  const rows: JustifiedRow[] = [];
  if (width <= 0) return rows;
  let start = 0;
  let sum = 0; // aspects in the current row
  for (let i = 0; i < inputs.length; i++) {
    sum += safeAspect(inputs[i].aspect);
    const count = i - start + 1;
    const natural = sum * targetHeight + gap * (count - 1);
    if (natural >= width) {
      const height = Math.min((width - gap * (count - 1)) / sum, maxHeight);
      rows.push(build(inputs, start, i, height, width, gap));
      start = i + 1;
      sum = 0;
    }
  }
  if (start < inputs.length) {
    // The last row: the target height, left-aligned (never stretched).
    rows.push(build(inputs, start, inputs.length - 1, targetHeight, null, gap));
  }
  return rows;
}

function build(inputs: JustifyInput[], from: number, to: number, height: number, fill: number | null, gap: number): JustifiedRow {
  const items: number[] = [];
  const widths: number[] = [];
  for (let i = from; i <= to; i++) {
    items.push(i);
    widths.push(safeAspect(inputs[i].aspect) * height);
  }
  if (fill !== null) {
    // Round to whole pixels and give the remainder to the last photo, so
    // every row ends exactly at the edge.
    const rounded = widths.map((w) => Math.floor(w));
    const used = rounded.reduce((a, b) => a + b, 0) + gap * (rounded.length - 1);
    rounded[rounded.length - 1] += Math.max(0, Math.round(fill - used));
    return { items, widths: rounded, height: Math.round(height) };
  }
  return { items, widths: widths.map((w) => Math.round(w)), height: Math.round(height) };
}

/** Height of a group laid out with ``justify``. */
export function rowsHeight(rows: JustifiedRow[], gap: number): number {
  return rows.reduce((h, r) => h + r.height, 0) + gap * Math.max(rows.length - 1, 0);
}
