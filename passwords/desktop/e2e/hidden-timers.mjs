// A one-off measure, not part of the suite: does a timer keep running in a hidden main window
// for longer than Chromium's 5-minute intensive throttling takes to kick in? VaultApp's sleep
// check reads a gap over 60 s as the machine having slept. Takes about 7 minutes.
//   MSEDGEDRIVER=... node e2e/hidden-timers.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Builder } from "selenium-webdriver";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "promptly-hidden-"));
const PORT = 4466;
const NATIVE = 4467;
// What the app passes in windows_ui.rs. The driver's own args replace the app's, so they're
// passed again here to measure the release configuration.
const ARGS = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,IntensiveWakeUpThrottling --disable-background-timer-throttling --disable-renderer-backgrounding";

const d = spawn("tauri-driver", ["--port", String(PORT), "--native-port", String(NATIVE), "--native-driver", process.env.MSEDGEDRIVER], { env: { ...process.env, PROMPTLY_PW_DATA_DIR: work, PROMPTLY_PW_NO_BROWSER: "1", PROMPTLY_PW_NO_REGISTRY: "1" }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2000));
const driver = await new Builder()
  .usingServer(`http://127.0.0.1:${PORT}/`)
  .withCapabilities({ browserName: "wry", "tauri:options": { application: path.join(root, "target/debug/promptly-passwords.exe"), webviewOptions: { userDataFolder: path.join(work, "webview"), additionalBrowserArguments: ARGS.split(" ") } } })
  .build();
await driver.manage().setTimeouts({ script: 60000 });
for (const h of await driver.getAllWindowHandles()) {
  await driver.switchTo().window(h);
  if ((await driver.getTitle()) === "Promptly Passwords") break;
}
await driver.executeScript(`
  window.__beat = Date.now(); window.__maxGap = 0;
  setInterval(() => { const n = Date.now(); window.__maxGap = Math.max(window.__maxGap, n - window.__beat); window.__beat = n; }, 5000);
`);
await driver.executeAsyncScript(`const done = arguments[0]; window.__TAURI_INTERNALS__.invoke("e2e_hide_main").then(() => done(), () => done());`);
const visibility = await driver.executeScript("return document.visibilityState");
await new Promise((r) => setTimeout(r, 7 * 60 * 1000));
const gap = await driver.executeScript("return window.__maxGap");
console.log(JSON.stringify({ visibility, maxGapMs: gap, falseSleepLockWouldFire: gap > 60000 }));
await driver.quit();
d.kill();
await new Promise((r) => setTimeout(r, 3000));
fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
