// Fixes to the spreadsheet library (@fortune-sheet 1.0.4), applied to the
// installed copy before every dev start and build (package.json "predev" /
// "prebuild"), and by the unit test before it checks them. The library is
// unmaintained upstream, so these live here:
//
//   selection  A sheet with no saved selection got {row:[0], column:[0]},
//              a range with no end, and the name box read "A1:NaN" until a
//              cell was clicked.
//   stats      The status bar's Sum / Average / Max / Min read a cell's
//              DISPLAY text, so "5,570" counted as 5 and "50%" as 50. They
//              now use the cell's number.
//   font       A cell with no font of its own was drawn in the first font
//              of the list (Times New Roman) and the toolbar said so. It
//              now gets the sheet's default sans-serif, and the toolbar
//              shows Arial.
//
// Each fix is an exact piece of the library's text and what replaces it.
// A piece that is neither there nor already replaced means the library
// changed (an upgrade): this fails loudly instead of shipping the bug back.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULES = path.resolve(here, "../node_modules");

export const FIXES = [
  {
    name: "selection",
    pkg: "react",
    // `api.` in the ES build, `core.api.` in the CommonJS one.
    find: /(api\.setSelection\(draftCtx, \[\{\s*row: )\[0\](,\s*column: )\[0\](\s*\}\], \{\}\);)/,
    replace: "$1[0, 0]$2[0, 0]$3",
    done: /api\.setSelection\(draftCtx, \[\{\s*row: \[0, 0\],\s*column: \[0, 0\]\s*\}\], \{\}\);/,
  },
  {
    name: "stats",
    pkg: "core",
    find: "var valueNumber = parseFloat(value);",
    replace: 'var valueNumber = typeof (data[r][c] || {}).v === "number" ? data[r][c].v : parseFloat(value); /* promptly: the number, not its display text */',
  },
  {
    name: "font",
    pkg: "core",
    find: 'fontSet = "".concat(fontarray[0], ",").concat(fontSet);',
    replace: "fontSet = String(fontSet); /* promptly: no font of its own means the default sans-serif */",
  },
  {
    name: "font-name",
    pkg: "react",
    find: "var current = fontarray[0];",
    replace: "var current = fontarray[1] || fontarray[0]; /* promptly: the default shows as Arial */",
  },
];

/** One build's text with every fix for its package applied. Throws when a
 *  fix has nothing to hold on to. */
export function applyFixes(code, pkg, file = pkg) {
  let changed = 0;
  for (const fix of FIXES.filter((f) => f.pkg === pkg)) {
    const already = fix.done ? fix.done.test(code) : code.includes(fix.replace);
    if (already) continue;
    const found = typeof fix.find === "string" ? code.includes(fix.find) : fix.find.test(code);
    if (!found) throw new Error(`patch-fortune-sheet: "${fix.name}" doesn't fit ${file}. Has @fortune-sheet changed? See frontend/scripts/patch-fortune-sheet.mjs`);
    code = code.replace(fix.find, fix.replace);
    changed += 1;
  }
  return { code, changed };
}

/** Patch the installed library in place. Returns how many fixes went in
 *  (0 when it was already done). */
export function patchInstalled(modules = MODULES) {
  let changed = 0;
  for (const pkg of ["core", "react"]) {
    for (const build of ["index.esm.js", "index.js"]) {
      const file = path.join(modules, "@fortune-sheet", pkg, "dist", build);
      const out = applyFixes(fs.readFileSync(file, "utf8"), pkg, file);
      if (out.changed) fs.writeFileSync(file, out.code);
      changed += out.changed;
    }
  }
  // Vite keeps its own pre-bundled copy of dependencies for the dev server.
  if (changed) fs.rmSync(path.join(modules, ".vite"), { recursive: true, force: true });
  return changed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const n = patchInstalled();
  console.log(n ? `patch-fortune-sheet: ${n} fixes applied` : "patch-fortune-sheet: already applied");
}
