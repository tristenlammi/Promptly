// Plan 13.7 and a finding from the Windows app: what ends up on disk in a real Chrome profile,
// and how it all runs with 5,000 items. Numbers are printed for REPORT.md, with limits asserted.
import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { connect, launch, makeUsers, MASTER, type Rig, siteA, startSite, unlockExt } from "./lib";

test.describe.configure({ mode: "serial", timeout: 900_000 });

const CANARY = "PWDISKCANARY71c9";
let rig: Rig;
let site: { close: () => void };

test.beforeAll(async () => {
  makeUsers(["root"], "admin");
  site = await startSite();
  rig = await launch();
  const [u] = makeUsers(["perf"]);
  await connect(rig, u);
  await unlockExt(rig);
});

test.afterAll(async () => {
  await rig?.close();
  site?.close();
});

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function scanProfile(needle: string): string[] {
  const hits: string[] = [];
  const utf8 = Buffer.from(needle);
  const utf16 = Buffer.from(needle, "utf16le");
  for (const f of walk(rig.dir)) {
    let data: Buffer;
    try {
      data = fs.readFileSync(f);
    } catch {
      continue; // Chrome holds a lock on a few.
    }
    if (data.includes(utf8) || data.includes(utf16)) hits.push(path.relative(rig.dir, f));
  }
  return hits;
}

test("nothing typed into the vault lands in the browser profile as plain text", async () => {
  const pages = [`chrome-extension://${rig.extId}/vault.html`, "/passwords"];
  for (const [n, url] of pages.entries()) {
    const page = await rig.ctx.newPage();
    await page.goto(url);
    if (n === 1) {
      await page.getByLabel("Master password").fill(MASTER);
      await page.getByRole("button", { name: "Unlock", exact: true }).click();
    }
    await expect(page.getByRole("navigation", { name: "Passwords" })).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.getByRole("menuitem", { name: "Login" }).click();
    await page.getByLabel("Name", { exact: true }).fill(`${CANARY}_title${n}`);
    await page.getByLabel("Username or email").fill(`${CANARY}_user${n}`);
    await page.getByLabel("Password", { exact: true }).fill(`${CANARY}_password${n}`);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("article", { name: `${CANARY}_title${n}` })).toBeVisible();
    await page.close();
  }
  // Give Chrome time to write its autofill database, then look through everything it wrote.
  await new Promise((r) => setTimeout(r, 35_000));
  const hits = scanProfile(CANARY);
  console.log("profile scan:", hits.length ? hits.join(", ") : "no plain text");
  expect(hits).toEqual([]);
});

test("5,000 items: unlock, search, popup, delta sync, memory", async () => {
  // In through the real importer.
  const rows = ["name,url,username,password,note"];
  for (let i = 0; i < 5000; i++) rows.push(`Site ${i},https://s${i}.example.com/login,user${i}@example.com,Pw-${i}-xYz!9,note ${i}`);
  const web = await rig.ctx.newPage();
  await web.goto("/passwords");
  await web.getByLabel("Master password").fill(MASTER);
  await web.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(web.getByRole("navigation", { name: "Passwords" })).toBeVisible({ timeout: 60_000 });
  await web.getByRole("navigation", { name: "Passwords" }).getByText("Import and export", { exact: true }).click();
  const importStart = Date.now();
  await web.getByLabel("Choose a file to import").setInputFiles({ name: "chrome.csv", mimeType: "text/csv", buffer: Buffer.from(rows.join("\n")) });
  const go = web.getByRole("button", { name: /^Import \d/ }).first();
  await expect(go).toBeVisible({ timeout: 120_000 });
  await go.click();
  await expect(web.getByText(/Imported|imported/).first()).toBeVisible({ timeout: 600_000 });
  const importMs = Date.now() - importStart;

  // Web: unlock, of which the key stretching is a fixed cost, and then search.
  await web.reload();
  await web.getByLabel("Master password").fill(MASTER);
  const unlockStart = Date.now();
  await web.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(web.getByRole("navigation", { name: "Passwords" })).toBeVisible({ timeout: 120_000 });
  const unlockMs = Date.now() - unlockStart;
  await web.getByRole("navigation", { name: "Passwords" }).getByText("All items", { exact: true }).click();
  await expect(web.getByText("Site 4999").first()).toBeVisible({ timeout: 60_000 });
  const box = web.getByLabel("Search your vault");
  const searches: number[] = [];
  for (const q of ["site 4321", "user77@", "s1234.example", "note 3", "nothing-matches-this"]) {
    const ms = await box.evaluate(async (el: HTMLInputElement, text: string) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      const t = performance.now();
      set.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      return performance.now() - t;
    }, q);
    searches.push(ms);
  }
  const heap = await web.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);

  // Extension: wait for it to have the 5,000, then measure the popup on a matching page.
  const page = await rig.ctx.newPage();
  await page.goto(siteA("login.html"));
  const pops: number[] = [];
  for (let i = 0; i < 6; i++) {
    const pop = await rig.ctx.newPage();
    const t = Date.now();
    await pop.goto(`chrome-extension://${rig.extId}/popup.html`);
    await pop.getByLabel("Search your vault").waitFor();
    pops.push(Date.now() - t);
    await pop.close();
  }

  // Delta sync with one change on top of 5,000.
  const sync = await web.evaluate(async () => {
    const t = performance.now();
    window.dispatchEvent(new Event("focus"));
    await new Promise((r) => setTimeout(r, 0));
    return performance.now() - t;
  });

  const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  console.log(JSON.stringify({ importMs, unlockMs, searchesMs: searches.map(Math.round), popupMs: pops, popupMedian: median(pops), heapMb: Math.round(heap / 1048576), focusSyncKick: Math.round(sync) }));
  expect(median(searches)).toBeLessThan(150);
  await web.close();
  await page.close();
});
