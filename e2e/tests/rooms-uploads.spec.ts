// Rooms uploads, in the real pages: a file too big for one request goes up
// in pieces (through the real tusd) and arrives for the other person; it
// shows in the sender's Files → Rooms uploads and counts in their storage;
// removing it there leaves "File removed" on the message for both; and one
// over the limit is refused with where to put it instead.
//
// Everything happens in the one conversation between alice and bob. Its
// messages stay between runs, so every assertion looks for this run's own
// names.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type Page } from "@playwright/test";

import { expect, run, stamp, test } from "../fixtures";

test.describe.configure({ mode: "serial" });

const log = (page: Page) => page.getByRole("log");
const box = (page: Page) => page.getByRole("textbox", { name: /^Message/ }).first();

/** The signed-in page's bearer token, from its own first API call. */
async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/rooms/");
  return (await seen).headers()["authorization"];
}

let dm = "";
let aAuth = "";
let policy: { max_bytes: number; direct_max_bytes: number; tus_endpoint: string | null } | null = null;
const big = path.join(os.tmpdir(), `e2e-big-${stamp}.bin`);
const bigName = path.basename(big);

async function setUp(alice: Page) {
  if (!aAuth) aAuth = await bearer(alice);
  if (!dm) {
    const r = await alice.request.post("/api/rooms/dms", { headers: { Authorization: aAuth }, data: { user_ids: [run.users.bob.id] } });
    expect(r.ok(), await r.text()).toBe(true);
    dm = (await r.json()).id;
  }
  if (!policy) {
    const r = await alice.request.get("/api/rooms/uploads/policy", { headers: { Authorization: aAuth } });
    expect(r.ok(), await r.text()).toBe(true);
    policy = await r.json();
  }
}

test.afterAll(() => {
  fs.rmSync(big, { force: true });
});

test("a file bigger than one request goes up in pieces and arrives", async ({ alice, bob }) => {
  await setUp(alice);
  test.skip(!policy!.tus_endpoint, "big uploads (tusd) aren't running on this stack");
  // Just over what one request may carry: it has to take the other road.
  fs.writeFileSync(big, Buffer.alloc(policy!.direct_max_bytes + 3 * 1024 * 1024, 7));

  await bob.goto(`/rooms/r/${dm}`);
  await alice.goto(`/rooms/r/${dm}`);
  const viaTus = alice.waitForRequest((r) => r.url().includes("/api/files/tus/") && r.method() === "POST");
  await alice.locator('input[type="file"]').first().setInputFiles(big);
  await viaTus;
  await expect(alice.getByRole("button", { name: `Remove ${bigName}` })).toBeVisible();
  const caption = `The big one ${stamp}`;
  await box(alice).fill(caption);
  const send = alice.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled({ timeout: 120_000 });
  await send.click();
  for (const page of [alice, bob]) {
    await expect(log(page).getByText(caption)).toBeVisible({ timeout: 30_000 });
    await expect(log(page).getByRole("link", { name: new RegExp(bigName.replace(/[.]/g, "\\.")) }).last()).toBeVisible();
  }
  // Bob can really fetch it (the start of it is enough).
  const href = await log(bob).getByRole("link", { name: new RegExp(bigName.replace(/[.]/g, "\\.")) }).last().getAttribute("href");
  const got = await bob.request.get(href!, { headers: { Range: "bytes=0-9" } });
  expect(got.status()).toBe(206);
  expect((await got.body()).length).toBe(10);
});

test("it shows in Files → Rooms uploads and counts in her storage, not his", async ({ alice, bob }) => {
  await setUp(alice);
  test.skip(!policy!.tus_endpoint, "big uploads (tusd) aren't running on this stack");
  await alice.goto("/files/rooms-uploads");
  await expect(alice.getByRole("heading", { name: "Rooms uploads" }).first()).toBeVisible();
  const row = alice.getByRole("listitem").filter({ hasText: bigName });
  await expect(row).toBeVisible();
  await expect(row).toContainText(run.users.bob.username);
  const q = await (await alice.request.get("/api/files/quota", { headers: { Authorization: aAuth } })).json();
  expect(q.rooms_bytes).toBeGreaterThanOrEqual(policy!.direct_max_bytes);
  expect(q.used_bytes).toBeGreaterThanOrEqual(q.rooms_bytes);
  // Not a Drive file: her files don't have it, and neither does search.
  const found = await (await alice.request.get(`/api/files/search?q=${encodeURIComponent(bigName)}`, { headers: { Authorization: aAuth } })).json();
  expect(found.hits).toEqual([]);
  // Bob sent nothing by that name: his list doesn't have it.
  await bob.goto("/files/rooms-uploads");
  await expect(bob.getByRole("heading", { name: "Rooms uploads" }).first()).toBeVisible();
  await expect(bob.getByText(bigName)).toHaveCount(0);
});

test("removing it there leaves File removed on the message for both", async ({ alice, bob }) => {
  await setUp(alice);
  test.skip(!policy!.tus_endpoint, "big uploads (tusd) aren't running on this stack");
  await bob.goto(`/rooms/r/${dm}`);
  await expect(log(bob).getByText(`The big one ${stamp}`)).toBeVisible();
  await alice.goto("/files/rooms-uploads");
  await alice.getByRole("button", { name: `Remove ${bigName}` }).click();
  await alice.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await expect(alice.getByRole("listitem").filter({ hasText: bigName })).toHaveCount(0);
  // Bob's open conversation hears about it with no reload.
  await expect(log(bob).getByText("File removed").last()).toBeVisible({ timeout: 20_000 });
  await expect(log(bob).getByText(`The big one ${stamp}`)).toBeVisible();
  await alice.goto(`/rooms/r/${dm}`);
  await expect(log(alice).getByText("File removed").last()).toBeVisible();
});

test("a file over the limit is refused with where to put it instead", async ({ alice }) => {
  await setUp(alice);
  // The page asks the server what it allows and checks before sending a
  // byte: tell it the limit is tiny, then attach an ordinary small file.
  await alice.route("**/api/rooms/uploads/policy", (route) =>
    route.fulfill({ json: { max_bytes: 1024 * 1024, direct_max_bytes: 1024 * 1024, tus_endpoint: null } }),
  );
  const told = alice.waitForResponse((r) => r.url().includes("/api/rooms/uploads/policy"));
  await alice.goto(`/rooms/r/${dm}`);
  await told;
  const name = `e2e-huge-${stamp}.bin`;
  const sent = { any: false };
  alice.on("request", (r) => {
    if (r.method() === "POST" && /\/attachments$|\/files\/tus\//.test(r.url())) sent.any = true;
  });
  await alice.locator('input[type="file"]').first().setInputFiles({ name, mimeType: "application/octet-stream", buffer: Buffer.alloc(2 * 1024 * 1024, 1) });
  await expect(alice.getByText(/the most a file can be in Rooms.*Send to/)).toBeVisible();
  await expect(alice.getByRole("button", { name: `Remove ${name}` })).toHaveCount(0);
  expect(sent.any).toBe(false);
});
