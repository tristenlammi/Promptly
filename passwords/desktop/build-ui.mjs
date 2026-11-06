// Builds the shared vault UI for the desktop app: esbuild plus Tailwind from `frontend`, the
// same way the extension does. Everything ends up as local files in ui-dist, which Tauri
// embeds in the exe, so the app never loads code from anywhere else.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, "../../frontend");
const extension = path.resolve(here, "../extension");
const require = createRequire(path.join(frontend, "package.json"));
const esbuild = await import(pathToFileURL(require.resolve("esbuild")).href);

const dist = path.join(here, "ui-dist");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "item-icons"), { recursive: true });

await esbuild.build({
  bundle: true,
  target: "es2022",
  format: "esm",
  logLevel: "warning",
  legalComments: "none",
  minify: true,
  splitting: false,
  outdir: dist,
  nodePaths: [path.join(frontend, "node_modules"), path.join(here, "node_modules")],
  loader: { ".json": "json" },
  entryPoints: { main: path.join(here, "src/main.tsx"), overlay: path.join(here, "src/overlay.ts") },
});

// The same stylesheet as the extension's vault page, trimmed to what these files use.
const config = path.join(here, ".tailwind.desktop.cjs");
fs.writeFileSync(
  config,
  `const base = require(${JSON.stringify(path.join(frontend, "tailwind.config.ts"))});
module.exports = { ...(base.default ?? base), content: [${JSON.stringify(path.join(here, "src/**/*.{ts,tsx,html}").replace(/\\/g, "/"))}, ${JSON.stringify(path.join(frontend, "src/passwords/ui/**/*.tsx").replace(/\\/g, "/"))}] };`,
);
try {
  const bin = path.join(frontend, "node_modules", "tailwindcss", "lib", "cli.js");
  execFileSync(process.execPath, [bin, "-c", config, "-i", path.join(extension, "src/styles.css"), "-o", path.join(dist, "ui.css"), "--minify"], { cwd: frontend, stdio: ["ignore", "ignore", "pipe"] });
} finally {
  fs.rmSync(config);
}

for (const f of ["index.html", "overlay.html", "overlay.css"]) fs.copyFileSync(path.join(here, "src", f), path.join(dist, f));
fs.copyFileSync(path.join(frontend, "public/item-icons/passwords-192.png"), path.join(dist, "item-icons/passwords-192.png"));
console.log("built ui-dist");
