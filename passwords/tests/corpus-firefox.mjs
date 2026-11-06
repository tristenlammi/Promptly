// Autofill corpus on real Firefox, through Selenium and geckodriver.
//   cd e2e && node ../passwords/tests/corpus-firefox.mjs [filter]
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../e2e/package.json"));
const { Builder, By } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");

await import("./build-autofill-bundle.mjs");
const { runCorpus } = await import("./corpus-core.mjs");
const { start } = await import(pathToFileURL(path.resolve(here, process.env.PW_SITES ?? "../test-sites", "server.mjs")).href);

const bundle = fs.readFileSync(path.join(here, ".cache", "autofill.js"), "utf8");
const server = await start();
const options = new firefox.Options().addArguments("-headless");
const d = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();
await d.manage().window().setRect({ width: 1280, height: 860, x: 0, y: 0 });

async function enter(chain) {
  await d.switchTo().defaultContent();
  for (const sel of chain ?? []) {
    const deadline = Date.now() + 5000;
    for (;;) {
      const els = await d.findElements(By.css(sel));
      if (els.length) {
        await d.switchTo().frame(els[0]);
        break;
      }
      if (Date.now() > deadline) throw new Error(`no frame at ${sel}`);
      await d.sleep(50);
    }
  }
  // Selenium has no init-script hook here, so the helper goes in when needed.
  await d.executeScript(`if (!window.__af) { ${bundle} }`);
}

const asyncRun = (fn, ...args) => d.executeAsyncScript(`const done = arguments[arguments.length - 1]; (${fn})(...Array.from(arguments).slice(0, -1)).then(done, (e) => done({ __error: String(e) }));`, ...args);

const driver = {
  goto: (url) => d.get(url),
  settle: () => d.sleep(40),
  async waitFor(selector, chain) {
    const deadline = Date.now() + 6000;
    for (;;) {
      await enter(chain).catch(() => undefined);
      const ok = await d.executeScript("return window.__af && window.__af.exists(arguments[0])", selector).catch(() => false);
      if (ok) return;
      if (Date.now() > deadline) throw new Error(`wait failed for ${JSON.stringify(selector)}`);
      await d.sleep(50);
    }
  },
  async analyze(chain, expected, honeypots) {
    await enter(chain);
    return d.executeScript("return window.__af.analyze(arguments[0], arguments[1])", expected, honeypots);
  },
  async analyzeAllFrames() {
    const out = [];
    const visit = async (path, depth) => {
      await enter(path);
      out.push(await d.executeScript("return window.__af.analyze([], [])"));
      if (depth > 3) return;
      const frames = await d.findElements(By.css("iframe"));
      for (let i = 0; i < frames.length; i++) await visit([...path, `iframe:nth-of-type(${i + 1})`], depth + 1);
    };
    await visit([], 0).catch(() => undefined);
    await d.switchTo().defaultContent();
    return out;
  },
  async fill(chain, values) {
    await enter(chain);
    return asyncRun("(v) => window.__af.fill(v)", values);
  },
  async state(chain) {
    await enter(chain);
    let s = await d.executeScript("return window.__af.state()");
    if (s === null) {
      await enter(null);
      s = await d.executeScript("return window.__af.state()");
    }
    return s;
  },
  async click(selector, chain) {
    await enter(chain);
    await (await d.findElement(By.css(typeof selector === "string" ? selector : selector[0]))).click();
  },
};

const res = await runCorpus(driver, { filter: process.argv[2], port: Number(process.env.PW_SITES_PORT ?? 8101) });
await d.quit();
await server.close();
fs.writeFileSync(path.join(here, ".cache", "corpus-firefox.json"), JSON.stringify(res, null, 1));
process.exitCode = res.percent >= 95 && res.falseFills === 0 ? 0 : 1;
