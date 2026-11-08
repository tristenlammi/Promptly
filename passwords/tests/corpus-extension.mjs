// The autofill corpus through the extension's own content script, in Chromium. The other
// runners score the classifier; this one runs content.ts as it ships (its timing, its
// re-analysis, the strict report the toolbar uses, the fill guard, the inline menu
// opening on focus), with a stand-in for the background that answers like an unlocked
// vault with the inline menu on. Nothing here talks to a server.
//   cd e2e && node ../passwords/tests/corpus-extension.mjs [filter]
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../e2e/package.json"));
const { chromium } = require("@playwright/test");
const frontendRequire = createRequire(path.join(here, "../../frontend/package.json"));
const esbuild = await import(pathToFileURL(frontendRequire.resolve("esbuild")).href);

await import("./build-autofill-bundle.mjs");
const { runCorpus, startSites, SET_NAME } = await import("./corpus-core.mjs");
const { start } = await import(pathToFileURL(path.resolve(here, process.env.PW_SITES ?? "../test-sites", "server.mjs")).href);

const CONTENT = path.join(here, ".cache", "content-under-test.js");
await esbuild.build({
  entryPoints: [path.join(here, "../extension/src/content.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: CONTENT,
  logLevel: "warning",
});

// The background, as far as a content script can tell: hello says unlocked with the
// inline menu on, and the runner speaks for the popup by sending report and doFill.
const fakeBackground = `(() => {
  const listeners = [];
  const runtime = {
    id: "corpus",
    sendMessage: (m) => Promise.resolve(m && m.t === "hello" ? { r: { rule: null, pendingSave: false, unlocked: true, inlineMenu: true } } : null),
    onMessage: { addListener: (fn) => listeners.push(fn) },
    getURL: () => "about:blank",
  };
  // chrome.dom reaches closed shadow roots in the real extension; here the fixtures list theirs.
  const closedOf = (el) => Object.values(window.__closedRoots || {}).find((r) => r && r.host === el) || null;
  globalThis.browser = { runtime };
  globalThis.chrome = { runtime, dom: { openOrClosedShadowRoot: (el) => el.shadowRoot || closedOf(el) } };
  window.__ext = {
    send: (msg) => new Promise((resolve) => {
      let answered = false;
      for (const fn of listeners) {
        const async = fn(msg, { id: "corpus" }, (r) => { answered = true; resolve(r); });
        if (async === true) return;
      }
      if (!answered) resolve(undefined);
    }),
    menuOpen: () => [...document.documentElement.children].some((c) => c.tagName === "DIV" && c.getAttribute("popover") === "manual"),
  };
})();`;

const helper = fs.readFileSync(path.join(here, ".cache", "autofill.js"), "utf8");
const content = fs.readFileSync(CONTENT, "utf8");
const { server, port } = await startSites(start);
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await ctx.addInitScript(helper);
await ctx.addInitScript(fakeBackground);
await ctx.addInitScript(content);
const page = await ctx.newPage();

async function frameOf(chain) {
  let frame = page.mainFrame();
  for (const sel of chain ?? []) {
    const el = await frame.waitForSelector(sel, { timeout: 5000, state: "attached" });
    frame = await el.contentFrame();
    if (!frame) throw new Error(`no frame at ${sel}`);
  }
  await frame.waitForFunction(() => !!window.__af && !!window.__ext, null, { timeout: 5000 });
  return frame;
}

const ROLE_GROUP = { email: "username", "confirm-password": "new-password", "current-password": "password", "otp-digit": "otp" };
const grouped = (roles) => roles.map((r) => ROLE_GROUP[r] ?? r).sort().join(",");

const driver = {
  goto: (url) => page.goto(url, { waitUntil: "load", timeout: 15000 }),
  settle: () => page.waitForTimeout(40),
  async waitFor(selector, chain) {
    const frame = await frameOf(chain);
    await frame.waitForFunction((s) => window.__af.exists(s), selector, { timeout: 6000, polling: 50 });
  },
  async analyze(chain, expected, honeypots) {
    const frame = await frameOf(chain);
    const a = await frame.evaluate(([e, h]) => window.__af.analyze(e, h), [expected, honeypots]);
    if (!expected.length) return a;
    a.problems = [];
    // The inline menu: a person clicks the first box. A page that focused it on its own
    // has already had its chance, since a click on a focused box fires no focus event.
    const first = await frame.evaluateHandle((s) => window.__af.element(s), expected[0].selector);
    const el = first.asElement();
    if (el) {
      const focusedAlready = await frame.evaluate((x) => x.getRootNode().activeElement === x || document.activeElement === x, el);
      if (!focusedAlready) await el.click({ timeout: 3000 }).catch(() => undefined);
      // A box focused before the script knew it gets the menu at the next look, a moment later.
      const open = await frame.waitForFunction(() => window.__ext.menuOpen(), null, { timeout: 700, polling: 50 }).then(() => true, () => false);
      if (!open) a.problems.push(`no inline menu on ${JSON.stringify(expected[0].selector)}${focusedAlready ? " (the page focused it)" : ""}`);
      await frame.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    }
    // What the toolbar popup sees: the strict report, after a fresh look.
    const report = await frame.evaluate(() => window.__ext.send({ t: "report", fresh: true }));
    const want = expected.filter((e) => JSON.stringify(e.frame ?? null) === JSON.stringify(chain ?? null)).map((e) => e.role);
    // As the classifier runner allows: a name or a company on a sign-up form is what it asked for.
    if (report && a.kind === "signup") report.roles = report.roles.filter((r) => want.includes(r) || !["first-name", "last-name", "full-name", "company", "phone"].includes(r));
    if (!report) a.problems.push("no report from the content script");
    else if (grouped(report.roles) !== grouped(want)) a.problems.push(`the content script reports ${report.roles.join(",") || "nothing"}, wanted ${want.join(",")}`);
    return a;
  },
  async analyzeAllFrames() {
    const out = [];
    for (const frame of page.frames()) {
      try {
        const r = await frame.evaluate(() => window.__ext?.send({ t: "report", fresh: true }));
        if (r) out.push({ fillableForms: r.fieldCount, kinds: r.kinds });
      } catch {
        /* a detached frame */
      }
    }
    return out;
  },
  async fill(chain, values) {
    const frame = await frameOf(chain);
    return frame.evaluate((v) => window.__ext.send({ t: "doFill", values: v, origin: self.origin }), values);
  },
  async state(chain) {
    const frame = await frameOf(chain);
    return (await frame.evaluate(() => window.__af.state())) ?? (await page.mainFrame().evaluate(() => window.__af.state()));
  },
  async click(selector, chain) {
    const frame = await frameOf(chain);
    await frame.click(typeof selector === "string" ? selector : selector[0], { timeout: 5000 });
  },
};

const res = await runCorpus(driver, { filter: process.argv[2], port });
await browser.close();
await server.close();
fs.writeFileSync(path.join(here, ".cache", `corpus-${SET_NAME}-extension.json`), JSON.stringify(res, null, 1));
process.exitCode = res.percent >= 95 && res.falseFills === 0 ? 0 : 1;
