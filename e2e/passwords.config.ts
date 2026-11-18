// The vault's own browser suite: Chromium, Firefox and WebKit against the isolated
// stack, with service workers ON (the main suite blocks them).
//   cd e2e && npx playwright test --config passwords.config.ts
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices, firefox } from "@playwright/test";

/**
 * Where to start Firefox from. Normally Playwright's own copy (undefined here).
 *
 * On Windows, a program started by a packaged app (the Claude desktop app is
 * one) sees a private copy of AppData, which is where Playwright keeps its
 * browsers. Firefox loads one of its own libraries through Windows' side-by-side
 * lookup, which runs outside that private view and so can't find it: the launch
 * fails with "spawn UNKNOWN". Chromium and WebKit don't load anything that way.
 * When Playwright's Firefox won't start, a copy kept beside this file is used.
 */
function firefoxFrom(): string | undefined {
  if (process.platform !== "win32") return undefined;
  let own: string;
  try {
    own = firefox.executablePath();
  } catch {
    return undefined;
  }
  if (!fs.existsSync(own)) return undefined; // not installed: Playwright says how to get it
  if (spawnSync(own, ["--version"], { windowsHide: true, timeout: 30_000 }).status === 0) return undefined;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const build = path.basename(path.dirname(path.dirname(own))); // firefox-1543
  const copy = path.join(here, ".browsers", build, "firefox");
  const exe = path.join(copy, "firefox.exe");
  if (!fs.existsSync(exe)) fs.cpSync(path.dirname(own), copy, { recursive: true });
  return exe;
}
const FIREFOX = firefoxFrom();

const BASE_URL = process.env.PW_E2E_URL ?? "http://localhost:8092";

export default defineConfig({
  testDir: "./passwords-tests",
  globalSetup: "./passwords-tests/global-setup.ts",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  outputDir: "./test-results-passwords",
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-passwords" }]],
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 860 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    acceptDownloads: true,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 860 } } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], viewport: { width: 1280, height: 860 }, ...(FIREFOX ? { launchOptions: { executablePath: FIREFOX } } : {}) } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 860 } } },
  ],
});
