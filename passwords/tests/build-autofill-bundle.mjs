// Bundles the classifier and test helpers into one file to inject into fixture pages.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../frontend/package.json"));
const esbuild = await import(pathToFileURL(require.resolve("esbuild")).href);

export const OUT = path.join(here, ".cache", "autofill.js");

await esbuild.build({
  entryPoints: [path.join(here, "autofill-page.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: OUT,
  logLevel: "warning",
});
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log("built", OUT);
