import { expect, test } from "@playwright/test";

import { fillDisplayText, needsRecalc } from "../../frontend/src/lib/sheetDisplay";

// WP-4.4: a formatted number with no display text gets one; formulas that
// came in without a result are spotted for recalculation.
const fmt = (fa: string, v: unknown) => `${fa}:${String(v)}`;

test("fills display text only where a formatted number has none", () => {
  const sheets = [
    {
      name: "S",
      celldata: [
        { r: 0, c: 0, v: { v: 46112, ct: { fa: "yyyy-mm-dd", t: "d" } } },
        { r: 0, c: 1, v: { v: 5, m: "five", ct: { fa: "0.00", t: "n" } } },
        { r: 0, c: 2, v: { v: 7, ct: { fa: "General", t: "n" } } },
        { r: 0, c: 3, v: { v: "text", ct: { fa: "General", t: "g" } } },
        { r: 0, c: 4, v: { v: "12.5", ct: { fa: "0.0", t: "n" } } },
        { r: 0, c: 5, v: { bg: "#fff" } },
      ],
    },
  ];
  const [out] = fillDisplayText(sheets, fmt) as typeof sheets;
  const m = out.celldata.map((c) => (c.v as { m?: string }).m);
  expect(m).toEqual(["yyyy-mm-dd:46112", "five", undefined, undefined, "0.0:12.5", undefined]);
  // Untouched tabs come back as the same object.
  const plain = [{ name: "P", celldata: [{ r: 0, c: 0, v: { v: 1, m: "1" } }] }];
  expect(fillDisplayText(plain, fmt)[0]).toBe(plain[0]);
});

test("a formatter that throws or returns nothing leaves the cell alone", () => {
  const sheets = [{ celldata: [{ r: 0, c: 0, v: { v: 1, ct: { fa: "0.00", t: "n" } } }] }];
  expect((fillDisplayText(sheets, () => { throw new Error("x"); })[0].celldata[0].v as { m?: string }).m).toBeUndefined();
  expect((fillDisplayText(sheets, () => "")[0].celldata[0].v as { m?: string }).m).toBeUndefined();
});

test("spots formulas with no result", () => {
  expect(needsRecalc([{ celldata: [{ r: 0, c: 0, v: { f: "=SUM(A1:A2)" } }] }])).toBe(true);
  expect(needsRecalc([{ celldata: [{ r: 0, c: 0, v: { f: "=SUM(A1:A2)", v: "" } }] }])).toBe(true);
  expect(needsRecalc([{ celldata: [{ r: 0, c: 0, v: { f: "=SUM(A1:A2)", v: 3 } }] }])).toBe(false);
  expect(needsRecalc([{ celldata: [{ r: 0, c: 0, v: { v: 3 } }] }, { name: "empty" }])).toBe(false);
});
