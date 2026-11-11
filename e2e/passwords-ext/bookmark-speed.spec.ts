// How long a bookmark takes to reach another browser, with nothing forced: no test hooks, only
// the extension's own triggers (the bookmark events, the live channel, the minute's alarm). Two
// Chrome profiles, one account. Prints each delay; fails if one takes over 10 s.
//   cd e2e && npx playwright test --config passwords-ext.config.ts passwords-ext/bookmark-speed.spec.ts
// Point PW_E2E_URL at 127.0.0.1, not localhost (see signInHere).
// PW_BM_DIST runs another build of the extension (the release before, to compare), and
// PW_BM_LIMIT_MS raises the limit for it.
import { expect, type Page, test } from "@playwright/test";

import { BASE, connect, launch, makeUsers, MASTER, type Rig, signIn, unlockExt } from "./lib";

const DIST = process.env.PW_BM_DIST || undefined;
const LIMIT_MS = Number(process.env.PW_BM_LIMIT_MS ?? 10_000);
const ROUNDS = Number(process.env.PW_BM_ROUNDS ?? 3);

let a: Rig;
let b: Rig;
const pages = new Map<Rig, Page>();
let user: ReturnType<typeof makeUsers>[number];

/** One extension page per browser, kept open, to read and change its bookmarks quickly. */
async function on<T>(rig: Rig, body: string, arg?: unknown): Promise<T> {
  let page = pages.get(rig);
  if (!page) {
    page = await rig.ctx.newPage();
    await page.goto(`chrome-extension://${rig.extId}/test.html`);
    pages.set(rig, page);
  }
  return page.evaluate(new Function("arg", `return (async () => { ${body} })()`) as (x: unknown) => Promise<T>, arg);
}

/** The lib signs in on "localhost". Run against 127.0.0.1 too: on Windows a new connection to
 *  "localhost" tries ::1 first and spends ~4 s being refused, which would be most of what this measures. */
async function signInHere(rig: Rig) {
  await signIn(rig, user);
  await rig.ctx.addCookies([{ name: "promptly_refresh", value: user.refresh, url: `${BASE}/api/auth`, httpOnly: true, sameSite: "Strict", expires: Math.floor(Date.now() / 1000) + 86400 }]);
}

async function join(rig: Rig, secret: string) {
  await signInHere(rig);
  const page = await rig.ctx.newPage();
  await page.goto(`chrome-extension://${rig.extId}/vault.html`);
  await page.getByLabel("Your server's address").fill(BASE);
  const approve = rig.ctx.waitForEvent("page");
  await page.getByRole("button", { name: "Connect" }).click();
  const tab = await approve;
  await tab.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(tab.getByText("Connected.")).toBeVisible();
  await tab.close();
  await page.getByRole("button", { name: "Use my recovery kit" }).click();
  await page.getByLabel("Secret Key").fill(secret);
  await page.getByLabel("Master password").fill(MASTER);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByText("Your vault is locked")).toBeVisible({ timeout: 60_000 });
  await page.close();
  await unlockExt(rig);
}

async function turnOn(rig: Rig) {
  const page = await rig.ctx.newPage();
  await page.goto(`chrome-extension://${rig.extId}/vault.html#/bookmarks`);
  const panel = page.getByTestId("bookmark-settings");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await panel.getByRole("checkbox", { name: /same in every browser/ }).click();
  await expect(panel.getByTestId("bookmark-status")).toBeVisible();
  await page.close();
}

const count = (rig: Rig, title: string) => on<number>(rig, `return (await chrome.bookmarks.search({ title: arg })).length;`, title);

/** Milliseconds from `act` until `seen` holds, checked every 100 ms. */
async function timed(act: () => Promise<unknown>, seen: () => Promise<boolean>, cap = 180_000): Promise<number> {
  const t0 = Date.now();
  await act();
  while (Date.now() - t0 < cap) {
    if (await seen()) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 100));
  }
  return Infinity;
}

const results: { what: string; ms: number }[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(600_000);
  [user] = makeUsers(["bmspeed"]);
  a = await launch(DIST);
  await signInHere(a);
  const secret = await connect(a, user);
  await unlockExt(a);
  b = await launch(DIST);
  await join(b, secret);
  await turnOn(a);
  await turnOn(b);
  // Both have run once and agree (an empty bar either side).
  await new Promise((r) => setTimeout(r, 5000));
});

test.afterAll(async () => {
  console.log(`bookmark delays (${DIST ? "build " + DIST : "this build"}):`);
  for (const r of results) console.log(`  ${r.what}: ${r.ms === Infinity ? "never (3 min)" : (r.ms / 1000).toFixed(1) + " s"}`);
  await b?.close();
  await a?.close();
});

test("a bookmark added in one browser shows in the other, both ways", async () => {
  test.setTimeout(ROUNDS * 2 * 200_000 + 60_000);
  for (let i = 0; i < ROUNDS; i++) {
    for (const [from, to, name] of [[a, b, "A→B"], [b, a, "B→A"]] as const) {
      const title = `Speed ${name} ${i} ${Date.now()}`;
      const ms = await timed(
        () => on(from, `await chrome.bookmarks.create({ parentId: "1", title: arg, url: "https://speed.example/" + encodeURIComponent(arg) });`, title),
        async () => (await count(to, title)) === 1,
      );
      results.push({ what: `add ${name} #${i + 1}`, ms });
      // A gap that isn't a whole minute, so the next one lands at another point of any alarm.
      await new Promise((r) => setTimeout(r, 7_000 + i * 3_000));
    }
  }
  for (const r of results) expect(r.ms, r.what).toBeLessThan(LIMIT_MS);
});

test("a rename and a deletion travel just as fast", async () => {
  test.setTimeout(500_000);
  const title = `Speed edit ${Date.now()}`;
  await on(a, `await chrome.bookmarks.create({ parentId: "1", title: arg, url: "https://speed.example/edit" });`, title);
  await expect.poll(() => count(b, title), { timeout: 180_000, intervals: [200] }).toBe(1);
  await new Promise((r) => setTimeout(r, 4_000));
  const renamed = `${title} renamed`;
  const rename = await timed(
    () => on(b, `const [x] = await chrome.bookmarks.search({ title: arg.from }); await chrome.bookmarks.update(x.id, { title: arg.to });`, { from: title, to: renamed }),
    async () => (await count(a, renamed)) === 1,
  );
  results.push({ what: "rename B→A", ms: rename });
  await new Promise((r) => setTimeout(r, 4_000));
  const del = await timed(
    () => on(a, `const [x] = await chrome.bookmarks.search({ title: arg }); await chrome.bookmarks.remove(x.id);`, renamed),
    async () => (await count(b, renamed)) === 0,
  );
  results.push({ what: "delete A→B", ms: del });
  expect(rename).toBeLessThan(LIMIT_MS);
  expect(del).toBeLessThan(LIMIT_MS);
  // And it stays deleted: nothing brings it back over the next sync.
  await new Promise((r) => setTimeout(r, 8_000));
  expect(await count(a, renamed)).toBe(0);
  expect(await count(b, renamed)).toBe(0);
});
