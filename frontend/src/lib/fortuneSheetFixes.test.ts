/** The fixes to the spreadsheet library (scripts/patch-fortune-sheet.mjs):
 *  that they still fit the installed version, and that they do what they say. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

type Fixes = {
  FIXES: { name: string; pkg: string }[];
  applyFixes: (code: string, pkg: string, file?: string) => { code: string; changed: number };
  patchInstalled: () => number;
};
type Core = {
  calcSelectionInfo: (ctx: unknown, lang: string) => { sum: string; average: string; max: string; min: string; numberC: number };
  getFontSet: (format: unknown, size: number, ctx?: unknown) => string;
};

const script = path.resolve(__dirname, "../../scripts/patch-fortune-sheet.mjs");
let fixes: Fixes;
let core: Core;

beforeAll(async () => {
  fixes = (await import(/* @vite-ignore */ pathToFileURL(script).href)) as Fixes;
  fixes.patchInstalled();
  core = (await import("@fortune-sheet/core")) as unknown as Core;
});

function sheetWith(cells: unknown[]) {
  return {
    lang: "en",
    currentSheetId: "s1",
    config: {},
    luckysheetfile: [{ id: "s1", name: "Sheet1", data: [cells] }],
    luckysheet_select_save: [{ row: [0, 0], column: [0, cells.length - 1] }],
  };
}

describe("the spreadsheet library fixes", () => {
  it("fit the installed library, and applying them twice changes nothing", () => {
    expect(fixes.patchInstalled()).toBe(0);
    for (const build of ["index.esm.js", "index.js"]) {
      const react = fs.readFileSync(path.resolve(__dirname, "../../node_modules/@fortune-sheet/react/dist", build), "utf8");
      // A sheet with no saved selection starts on a whole cell, A1 (it was a
      // range with no end, which the name box showed as "A1:NaN").
      expect(react).toMatch(/api\.setSelection\(draftCtx, \[\{\s*row: \[0, 0\],\s*column: \[0, 0\]\s*\}\], \{\}\);/);
      expect(react).not.toMatch(/api\.setSelection\(draftCtx, \[\{\s*row: \[0\],/);
      expect(react).toContain("var current = fontarray[1] || fontarray[0];");
    }
  });

  it("say so when the library no longer has the text a fix replaces", () => {
    expect(() => fixes.applyFixes("nothing of the kind", "core")).toThrow(/doesn't fit/);
  });

  it("add up the numbers in the status bar, not their display text", () => {
    const n = (v: number, m: string) => ({ v, m, ct: { fa: "#,##0", t: "n" } });
    const info = core.calcSelectionInfo(sheetWith([n(5570, "5,570"), n(1200, "1,200"), { v: "Total", m: "Total", ct: { fa: "General", t: "g" } }]), "en");
    expect(info.numberC).toBe(2);
    expect(info.sum).toBe("6770.00"); // was 6.00: parseFloat("5,570") is 5
    expect(info.average).toBe("3385.00");
    expect(info.max).toBe("5570.00");
    expect(info.min).toBe("1200.00");
  });

  it("read a percentage as its value", () => {
    const info = core.calcSelectionInfo(sheetWith([{ v: 0.5, m: "50%", ct: { fa: "0%", t: "n" } }]), "en");
    expect(info.sum).toBe("0.50");
  });

  it("still count plain numbers typed as text the way the library did", () => {
    const info = core.calcSelectionInfo(sheetWith([{ v: "12", m: "12", ct: { fa: "General", t: "g" } }]), "en");
    expect(info.sum).toBe("12.00");
  });

  it("draw a cell with no font of its own in the default sans-serif, not Times New Roman", () => {
    const ctx = { lang: "en" };
    expect(core.getFontSet({}, 10, ctx)).not.toContain("Times New Roman");
    expect(core.getFontSet({ bl: 1 }, 10, ctx)).toMatch(/bold 10pt "Helvetica Neue", Helvetica, Arial/);
    // A font the cell does name is still used.
    expect(core.getFontSet({ ff: "Verdana" }, 10, ctx)).toContain("Verdana,");
    expect(core.getFontSet({ ff: 0 }, 10, ctx)).not.toContain("Times New Roman"); // 0 has always meant "none"
    expect(core.getFontSet({ ff: "0" }, 10, ctx)).toContain("Times New Roman");
  });
});
