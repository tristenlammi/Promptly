// Plan 13.7 and 1: the popup opens in under 150 ms with 5,000 items. A test build is
// unminified and three times the size of a release, so the number that counts comes from
// running this with the release popup.js copied over the test build's. See REPORT.
import { expect, test } from "@playwright/test";

import { addItem, connect, launch, makeUsers, popupFor, type Rig, siteA, startSite, testHook, unlockExt } from "./lib";

test.describe.configure({ mode: "serial", timeout: 300_000 });

let rig: Rig;
let site: { close: () => void };

test.beforeAll(async () => {
  makeUsers(["root"], "admin");
  site = await startSite();
  rig = await launch();
  const [u] = makeUsers(["perf"]);
  await connect(rig, u);
  await unlockExt(rig);
  await addItem(rig, { title: "Acme", url: "http://localhost:8111", username: "ana@example.com", password: "acme-Pass-1" });
});

test.afterAll(async () => {
  await rig?.close();
  site?.close();
});

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function openOnce(target: import("@playwright/test").Page) {
  const pop = await rig.ctx.newPage();
  await pop.addInitScript(() => {
    const seen: Record<string, number> = {};
    (window as any).__seen = seen;
    const look = () => {
      if (!seen.search && document.querySelector('[aria-label="Search your vault"]')) seen.search = performance.now();
      if (!seen.row && document.querySelector('[aria-label="Fill Acme"]')) seen.row = performance.now();
    };
    addEventListener("DOMContentLoaded", () => {
      look();
      new MutationObserver(look).observe(document.documentElement, { childList: true, subtree: true });
    });
  });
  const probe = await popupFor(rig, target);
  const url = probe.url();
  await probe.close();
  await pop.goto(url);
  await expect(pop.getByRole("button", { name: "Fill Acme" })).toBeVisible({ timeout: 60_000 });
  const seen = await pop.evaluate(() => (window as any).__seen as { search: number; row: number });
  await pop.close();
  return seen;
}

test("the popup with 5,000 items", async () => {
  const { total } = await testHook<{ total: number }>(rig, "seedItems", { count: 5000 });
  expect(total).toBeGreaterThanOrEqual(5000);
  const page = await rig.ctx.newPage();
  await page.goto(siteA("login.html"));

  const warm: { search: number; row: number }[] = [];
  for (let i = 0; i < 9; i++) warm.push(await openOnce(page));
  const search = median(warm.map((x) => x.search));
  const row = median(warm.map((x) => x.row));
  console.log(`popup with ${total} items, worker running: search box at ${search.toFixed(0)} ms, this site's row at ${row.toFixed(0)} ms (median of 9)`);

  // Chrome kills the worker whenever it likes, and the first open after that has to decrypt.
  const cdp = await rig.ctx.newCDPSession(page);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await new Promise((r) => setTimeout(r, 500));
  const cold = await openOnce(page);
  console.log(`first open after the worker was killed: search box at ${cold.search.toFixed(0)} ms, this site's row at ${cold.row.toFixed(0)} ms`);

  // Search over 5,000 items, through the background (plan: under 50 ms).
  const pop = await popupFor(rig, page);
  const searchMs = await pop.evaluate(async () => {
    const times: number[] = [];
    for (let i = 0; i < 9; i++) {
      const at = performance.now();
      await chrome.runtime.sendMessage({ t: "list", query: `seed${i}` });
      times.push(performance.now() - at);
    }
    return times.sort((a, b) => a - b)[4];
  });
  console.log(`search through the background: ${searchMs.toFixed(1)} ms (median of 9)`);
  await pop.close();
  await page.close();

  // A guard against something much worse, on any machine. The real target is in the report.
  expect(row).toBeLessThan(1500);
});
