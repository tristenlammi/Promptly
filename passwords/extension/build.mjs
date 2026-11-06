// Builds the extension for one or both engines. A small manifest generator on esbuild
// rather than a framework: fewer dependencies in a password manager, and every line of
// what ships is ours or pinned. See passwords/DECISIONS.md.
//   node build.mjs chrome|firefox|all [--test]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { deflateSync, zipSync } from "../../frontend/node_modules/fflate/esm/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, "../../frontend");
const require = createRequire(path.join(frontend, "package.json"));
const esbuild = await import(pathToFileURL(require.resolve("esbuild")).href);

const target = process.argv[2] ?? "all";
const TEST = process.argv.includes("--test");
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
const COMMANDS = {
  "fill-last": { suggested_key: { default: "Ctrl+Shift+L" }, description: "Fill the login you used last on this site" },
  "open-menu": { suggested_key: { default: "Ctrl+Shift+Y" }, description: "Open the fill menu on the focused field" },
  generate: { suggested_key: { default: "Ctrl+Shift+G" }, description: "Generate a password into the focused field" },
};

function manifest(engine) {
  const base = {
    manifest_version: 3,
    name: "Promptly Passwords",
    version: pkg.version,
    description: "Your passwords, 2FA codes and passkeys, end-to-end encrypted, on your own Promptly server.",
    icons: { 16: "icons/16.png", 32: "icons/32.png", 48: "icons/48.png", 128: "icons/128.png" },
    action: { default_popup: "popup.html", default_title: "Promptly Passwords", default_icon: { 16: "icons/16.png", 32: "icons/32.png" } },
    permissions: ["storage", "activeTab", "scripting", "alarms", "contextMenus", "idle", "webNavigation", "clipboardWrite", "nativeMessaging"],
    optional_permissions: ["clipboardRead", "bookmarks"],
    optional_host_permissions: ["https://*/*", "http://*/*"],
    commands: COMMANDS,
    web_accessible_resources: [{ resources: ["menu.html", "save.html"], matches: ["<all_urls>"] }],
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';" },
  };
  if (TEST) base.host_permissions = ["<all_urls>"];
  // Chromium's prompt for this can't be clicked by a test, and the tests read the clipboard.
  if (TEST && engine === "chrome") {
    base.permissions = [...base.permissions, "clipboardRead", "bookmarks"];
    delete base.optional_permissions;
  }
  if (engine === "chrome") {
    return {
      ...base,
      minimum_chrome_version: "122",
      background: { service_worker: "background.js", type: "module" },
      permissions: [...base.permissions, "sidePanel", "offscreen"],
      side_panel: { default_path: "vault.html" },
      web_accessible_resources: [{ ...base.web_accessible_resources[0], use_dynamic_url: true }],
    };
  }
  return {
    ...base,
    background: { scripts: ["background.js"], type: "module" },
    sidebar_action: { default_panel: "vault.html", default_title: "Passwords", default_icon: { 16: "icons/16.png", 32: "icons/32.png" } },
    browser_specific_settings: { gecko: { id: "passwords@promptly.app", strict_min_version: "140.0", data_collection_permissions: { required: ["none"] } }, gecko_android: { strict_min_version: "142.0" } },
  };
}

function css(out) {
  // The same stylesheet as the vault page, trimmed to what the extension uses.
  const config = path.join(here, ".tailwind.extension.cjs");
  fs.writeFileSync(
    config,
    `const base = require(${JSON.stringify(path.join(frontend, "tailwind.config.ts"))});
module.exports = { ...(base.default ?? base), content: [${JSON.stringify(path.join(here, "src/**/*.{ts,tsx,html}").replace(/\\/g, "/"))}, ${JSON.stringify(path.join(frontend, "src/passwords/ui/**/*.tsx").replace(/\\/g, "/"))}] };`,
  );
  const bin = path.join(frontend, "node_modules", "tailwindcss", "lib", "cli.js");
  execFileSync(process.execPath, [bin, "-c", config, "-i", path.join(here, "src/styles.css"), "-o", out, "--minify"], { cwd: frontend, stdio: ["ignore", "ignore", "pipe"] });
  fs.rmSync(config);
}

async function buildEngine(engine) {
  const dist = path.join(here, "dist", TEST ? `${engine}-test` : engine);
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(path.join(dist, "icons"), { recursive: true });

  const common = {
    bundle: true,
    target: "es2022",
    logLevel: "warning",
    nodePaths: [path.join(frontend, "node_modules")],
    define: { __ENGINE__: JSON.stringify(engine), __TEST_BUILD__: JSON.stringify(TEST) },
    legalComments: "none",
    // --minify on a test build: to time a popup the same size as a release's.
    minify: !TEST || process.argv.includes("--minify"),
    loader: { ".json": "json" },
  };
  await esbuild.build({
    ...common,
    format: "esm",
    outdir: dist,
    entryPoints: {
      background: path.join(here, "src/background.ts"),
      popup: path.join(here, "src/popup.tsx"),
      vault: path.join(here, "src/vault.tsx"),
      menu: path.join(here, "src/menu.ts"),
      save: path.join(here, "src/save.ts"),
      passkey: path.join(here, "src/passkey.ts"),
      // Chromium's service worker has no document for the clipboard. Firefox's background does.
      ...(engine === "chrome" ? { offscreen: path.join(here, "src/offscreen.ts") } : {}),
    },
    splitting: false,
  });
  // Content scripts and the MAIN-world wrapper can't be ES modules.
  await esbuild.build({ ...common, format: "iife", outdir: dist, entryPoints: { content: path.join(here, "src/content.ts"), "passkey-main": path.join(here, "src/passkey-main.ts") } });

  for (const f of ["popup.html", "vault.html", "menu.html", "save.html", "passkey.html", ...(engine === "chrome" ? ["offscreen.html"] : [])]) fs.copyFileSync(path.join(here, "src", f), path.join(dist, f));
  // A blank extension page for tests to run privileged calls in.
  if (TEST) fs.writeFileSync(path.join(dist, "test.html"), "<!doctype html><title>Test</title>");
  // The rules pack and its signature, and never the test key beside them.
  fs.mkdirSync(path.join(dist, "rules"));
  for (const f of ["pack.json", "pack.sig"]) fs.copyFileSync(path.join(here, "rules", f), path.join(dist, "rules", f));
  css(path.join(dist, "ui.css"));
  for (const size of [16, 32, 48, 128]) fs.copyFileSync(path.join(here, "icons", `${size}.png`), path.join(dist, "icons", `${size}.png`));
  fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest(engine), null, 1));

  if (!TEST) {
    const files = {};
    const walk = (d) => {
      for (const name of fs.readdirSync(d)) {
        const p = path.join(d, name);
        if (fs.statSync(p).isDirectory()) walk(p);
        else files[path.relative(dist, p).replace(/\\/g, "/")] = new Uint8Array(fs.readFileSync(p));
      }
    };
    walk(dist);
    fs.writeFileSync(path.join(here, "dist", `promptly-passwords-${engine}-${pkg.version}.zip`), zipSync(files));
  }
  console.log(`built ${engine}${TEST ? " (test)" : ""}`);
}

void deflateSync;
for (const e of target === "all" ? ["chrome", "firefox"] : [target]) await buildEngine(e);
