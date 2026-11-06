// Autofill corpus in Chromium (or Edge or WebKit with PW_BROWSER), by Playwright.
//   cd e2e && node ../passwords/tests/corpus-chromium.mjs [filter]
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../e2e/package.json"));
const { chromium, webkit } = require("@playwright/test");

await import("./build-autofill-bundle.mjs");
const { runCorpus } = await import("./corpus-core.mjs");
const { start } = await import(pathToFileURL(path.resolve(here, "../test-sites/server.mjs")).href);

const bundle = fs.readFileSync(path.join(here, ".cache", "autofill.js"), "utf8");
const server = await start();
const engine = process.env.PW_BROWSER === "webkit" ? webkit : chromium;
const browser = await engine.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await ctx.addInitScript(bundle);
const page = await ctx.newPage();

async function frameOf(chain) {
  let frame = page.mainFrame();
  for (const sel of chain ?? []) {
    const el = await frame.waitForSelector(sel, { timeout: 5000, state: "attached" });
    frame = await el.contentFrame();
    if (!frame) throw new Error(`no frame at ${sel}`);
  }
  await frame.waitForFunction(() => !!window.__af, null, { timeout: 5000 });
  return frame;
}

const driver = {
  goto: (url) => page.goto(url, { waitUntil: "load", timeout: 15000 }),
  settle: () => page.waitForTimeout(40),
  async waitFor(selector, chain) {
    const frame = await frameOf(chain);
    await frame.waitForFunction((s) => window.__af.exists(s), selector, { timeout: 6000, polling: 50 });
  },
  async analyze(chain, expected, honeypots) {
    const frame = await frameOf(chain);
    return frame.evaluate(([e, h]) => window.__af.analyze(e, h), [expected, honeypots]);
  },
  async analyzeAllFrames() {
    const out = [];
    for (const frame of page.frames()) {
      try {
        out.push(await frame.evaluate(() => window.__af?.analyze([], [])));
      } catch {
        /* a detached frame */
      }
    }
    return out.filter(Boolean);
  },
  async fill(chain, values) {
    const frame = await frameOf(chain);
    return frame.evaluate((v) => window.__af.fill(v), values);
  },
  async state(chain) {
    // State usually lives in the frame with the form, sometimes on the top page.
    const frame = await frameOf(chain);
    return (await frame.evaluate(() => window.__af.state())) ?? (await page.mainFrame().evaluate(() => window.__af.state()));
  },
  async click(selector, chain) {
    const frame = await frameOf(chain);
    await frame.click(typeof selector === "string" ? selector : selector[0], { timeout: 5000 });
  },
};

const res = await runCorpus(driver, { filter: process.argv[2] });
await browser.close();
await server.close();
fs.mkdirSync(path.join(here, ".cache"), { recursive: true });
fs.writeFileSync(path.join(here, ".cache", `corpus-${process.env.PW_BROWSER ?? "chromium"}.json`), JSON.stringify(res, null, 1));
process.exitCode = res.percent >= 95 && res.falseFills === 0 ? 0 : 1;
