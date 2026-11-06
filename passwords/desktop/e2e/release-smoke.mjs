// The release exe, with none of the e2e feature, driven just far enough to show it renders from
// its embedded files under the real CSP, with no test hooks in it. Its data goes to a throwaway
// folder through LOCALAPPDATA. Holds Ctrl+Shift+Space for the few seconds it runs.
//   MSEDGEDRIVER=... node e2e/release-smoke.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Builder, By } from "selenium-webdriver";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "promptly-release-"));
const d = spawn("tauri-driver", ["--port", "4476", "--native-port", "4477", "--native-driver", process.env.MSEDGEDRIVER], { env: { ...process.env, LOCALAPPDATA: work }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2000));
const driver = await new Builder()
  .usingServer("http://127.0.0.1:4476/")
  .withCapabilities({ browserName: "wry", "tauri:options": { application: path.join(root, "target/release/promptly-passwords.exe"), webviewOptions: { userDataFolder: path.join(work, "org.promptly.passwords", "webview") } } })
  .build();
try {
  await driver.manage().setTimeouts({ script: 30000 });
  for (const h of await driver.getAllWindowHandles()) {
    await driver.switchTo().window(h);
    if ((await driver.getTitle()) === "Promptly Passwords") break;
  }
  await driver.wait(async () => (await driver.findElement(By.css("body")).getText()).includes("Connect to your Promptly"), 15000);
  const r = await driver.executeAsyncScript(`
    const done = arguments[0];
    (async () => {
      const out = {};
      out.eval = await new Promise((r) => setTimeout(() => { try { (0, eval)("1+1"); r("allowed"); } catch { r("blocked"); } }, 0));
      try { await fetch("https://example.com/"); out.remote = "allowed"; } catch { out.remote = "blocked"; }
      const call = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a).then(() => "exists", (e) => String(e));
      out.e2eClipboard = await call("e2e_clipboard");
      out.e2eOverlay = await call("e2e_open_overlay");
      out.updater = await call("updater_status");
      done(out);
    })();
  `);
  console.log(JSON.stringify(r));
  assert.equal(r.eval, "blocked");
  assert.equal(r.remote, "blocked");
  assert.match(r.e2eClipboard, /not found/);
  assert.match(r.e2eOverlay, /not found/);
  console.log("release smoke: ok");
} finally {
  await driver.quit();
  d.kill();
  await new Promise((r) => setTimeout(r, 1500));
  fs.rmSync(work, { recursive: true, force: true });
}
