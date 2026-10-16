// A pure-function check run by the Playwright runner (the frontend has no
// unit-test runner of its own): the Photos grid's justified rows (WP-9.2).
import { expect, test } from "@playwright/test";

import { justify, rowsHeight, safeAspect } from "../../frontend/src/lib/justify";

test("full rows end exactly at the edge, the last row isn't stretched", () => {
  const photos = [1.5, 1.5, 0.75, 1, 1.78, 1.33, 1.5, 0.66].map((aspect) => ({ aspect }));
  const rows = justify(photos, { width: 1000, targetHeight: 200, gap: 4 });
  expect(rows.flatMap((r) => r.items)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  for (const r of rows.slice(0, -1)) {
    const used = r.widths.reduce((a, b) => a + b, 0) + 4 * (r.widths.length - 1);
    expect(used).toBe(1000);
    expect(r.height).toBeGreaterThan(150);
    expect(r.height).toBeLessThanOrEqual(320);
  }
  const last = rows[rows.length - 1];
  expect(last.height).toBe(200);
  expect(rowsHeight(rows, 4)).toBe(rows.reduce((h, r) => h + r.height, 0) + 4 * (rows.length - 1));
});

test("odd shapes and missing sizes don't break the grid", () => {
  expect(safeAspect(null)).toBe(1);
  expect(safeAspect(0)).toBe(1);
  expect(safeAspect(40)).toBe(3); // a panorama, capped
  expect(safeAspect(0.01)).toBe(0.4);
  const rows = justify([{ aspect: 40 }, { aspect: null }, { aspect: 0.01 }], { width: 600, targetHeight: 150, gap: 2 });
  expect(rows.flatMap((r) => r.items)).toEqual([0, 1, 2]);
  expect(justify([{ aspect: 1 }], { width: 0, targetHeight: 100, gap: 2 })).toEqual([]);
});
