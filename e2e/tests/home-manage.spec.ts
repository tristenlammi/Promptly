// Who runs a home, in the real page, against a stand-in box (lib/fakeBox.ts).
// A member uses the home and is shown no setting-up controls; the owner makes
// them a co-owner and they get them; the owner passes the home on and stays as
// a co-owner; the new owner deletes the home, and its box forgets the brand
// that had been added to it. The server refuses each thing the page hides.
//
// Home is off by default, so the spec turns it on and puts the switch back.
// It makes its own home and deletes it, and removes its box at the end.
import { type APIResponse, type Page } from "@playwright/test";

import { expect, stamp, test } from "../fixtures";
import { FakeBox, readSetup } from "../lib/fakeBox";
import { BASE_URL, readRun } from "../lib/stack";

test.describe.configure({ mode: "serial" });

const shots = process.env.E2E_SHOTS_DIR;

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  return (await seen).headers()["authorization"];
}
const call = (page: Page, auth: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, data?: unknown): Promise<APIResponse> =>
  page.request.fetch(`/api${url}`, { method, headers: { Authorization: auth }, data });

test("a member uses a home, a co-owner sets it up, and the owner passes it on or deletes it", async ({ alice, bob, dana }) => {
  test.setTimeout(150_000);
  const [aAuth, bAuth, dAuth] = [await bearer(alice), await bearer(bob), await bearer(dana)];
  const before = await (await call(dana, dAuth, "GET", "/admin/home/settings")).json();
  expect((await call(dana, dAuth, "PATCH", "/admin/home/settings", { enabled: true })).ok()).toBe(true);
  const name = `Manage ${stamp}`;
  let homeId = "";
  let boxId = "";
  let box: FakeBox | null = null;
  try {
    const prepared = await (await call(dana, dAuth, "POST", "/admin/home/boxes", { label: `e2e manage ${stamp}`, server_url: BASE_URL })).json();
    boxId = prepared.box.id;
    box = new FakeBox(readSetup(prepared.setup), [{ id: "lounge", name: "Lounge" }], [{ id: "light.lamp", domain: "light", name: `Lamp ${stamp}`, state: "off", area: "lounge" }]);
    box.brands = [{ id: "entry1", brand: "hue", brand_name: "Philips Hue", title: "Hue bridge", state: "loaded" }];
    await box.up();
    const claimed = await call(alice, aAuth, "POST", "/home/claim", { code: prepared.claim_code, home_name: name });
    expect(claimed.ok(), await claimed.text()).toBe(true);
    homeId = (await claimed.json()).home_id;
    const bobName = readRun().users.bob.username;
    expect((await call(alice, aAuth, "POST", `/home/${homeId}/members`, { username: bobName })).ok()).toBe(true);
    const bobId = ((await (await call(alice, aAuth, "GET", "/home")).json()).homes as { id: string; members: { id: string; username: string }[] }[]).find((h) => h.id === homeId)!.members.find((m) => m.username === bobName)!.id;
    const open = async (page: Page) => {
      await page.goto("/home");
      await page.getByRole("tab", { name }).click({ timeout: 20_000 }).catch(() => undefined); // only shown with more than one home
      await expect(page.getByRole("switch", { name: `Lamp ${stamp}` })).toBeVisible({ timeout: 20_000 });
    };
    const settings = async (page: Page) => {
      await page.getByRole("button", { name: "Home settings" }).click();
      return page.getByRole("dialog", { name: "Home settings" });
    };

    // A member: the devices, and nothing for setting the home up.
    await open(bob);
    await expect(bob.getByRole("button", { name: "Add a device" })).toHaveCount(0);
    await expect(bob.getByRole("button", { name: "Rooms" })).toHaveCount(0);
    await bob.getByRole("switch", { name: `Lamp ${stamp}` }).click();
    await expect.poll(() => box!.asked.filter((q) => q.op === "do").length).toBe(1);
    let sheet = await settings(bob);
    await expect(sheet).toContainText("You can use everything in this home");
    await expect(sheet.getByLabel("Home's name")).toHaveCount(0);
    await expect(sheet.getByLabel("Username to add")).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Move or give away" })).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Leave this home" })).toBeVisible();
    if (shots) await bob.screenshot({ path: `${shots}/hmanage-01-member-settings.png` });
    // ...and the server refuses what the page doesn't offer.
    for (const [method, url, data] of [
      ["PATCH", `/home/${homeId}`, { name: "Mine" }],
      ["POST", `/home/${homeId}/boxes/${boxId}/setup`, { brand: "hue" }],
      ["DELETE", `/home/${homeId}/boxes/${boxId}/rooms/lounge`, undefined],
      ["DELETE", `/home/${homeId}/boxes/${boxId}`, undefined],
      ["DELETE", `/home/${homeId}`, undefined],
    ] as const) {
      expect((await call(bob, bAuth, method, url, data)).status(), `${method} ${url}`).toBe(403);
    }

    // The owner makes them a co-owner.
    await open(alice);
    sheet = await settings(alice);
    await expect(sheet).toContainText("You own this home");
    if (shots) await alice.screenshot({ path: `${shots}/hmanage-02-owner-people.png` });
    await sheet.getByRole("button", { name: /^Make .* a co-owner$/ }).click();
    await expect(sheet.getByRole("button", { name: /^Stop .* being a co-owner$/ })).toBeVisible({ timeout: 15_000 });
    await expect(sheet).toContainText("Co-owner");
    if (shots) await alice.screenshot({ path: `${shots}/hmanage-03-co-owner-made.png` });

    // The co-owner sets the home up, and can't take it.
    await open(bob);
    await expect(bob.getByRole("button", { name: "Add a device" })).toBeVisible();
    await expect(bob.getByRole("button", { name: "Rooms" })).toBeVisible();
    sheet = await settings(bob);
    await expect(sheet).toContainText("You're a co-owner");
    await expect(sheet.getByLabel("Home's name")).toBeVisible();
    await expect(sheet.getByRole("button", { name: /co-owner$/ })).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Leave or delete this home…" })).toHaveCount(0);
    if (shots) await bob.screenshot({ path: `${shots}/hmanage-04-co-owner-settings.png` });
    expect((await call(bob, bAuth, "PUT", `/home/${homeId}/owner`, { user_id: bobId })).status()).toBe(403);
    expect((await call(bob, bAuth, "DELETE", `/home/${homeId}`)).status()).toBe(403);

    // The owner goes: pass it on (staying as a co-owner), or delete it.
    await open(alice);
    sheet = await settings(alice);
    await sheet.getByRole("button", { name: "Leave or delete this home…" }).click();
    const going = sheet.getByRole("group", { name: "Leave or delete this home" });
    await expect(going).toContainText("A home always has an owner");
    await expect(going.getByRole("button", { name: "Delete this home" })).toBeDisabled();
    if (shots) await alice.screenshot({ path: `${shots}/hmanage-05-owner-leaving.png`, fullPage: true });
    await going.getByRole("button", { name: "Pass it on, stay as co-owner" }).click();
    await expect(alice.getByText(/You're a co-owner\.$/).first()).toBeVisible({ timeout: 15_000 });
    const roles = ((await (await call(alice, aAuth, "GET", "/home")).json()).homes as { id: string; role: string; members: { id: string; role: string }[] }[]).find((h) => h.id === homeId)!;
    expect(roles.role).toBe("coowner");
    expect(roles.members.find((m) => m.id === bobId)!.role).toBe("owner");
    expect(box.brands).toHaveLength(1); // passing it on touches nothing in it

    // The new owner deletes the home: its box forgets the brand that was added.
    await open(bob);
    sheet = await settings(bob);
    await sheet.getByRole("button", { name: "Leave or delete this home…" }).click();
    const deleting = sheet.getByRole("group", { name: "Leave or delete this home" });
    await deleting.getByLabel("Home's name, to delete it").fill(name);
    if (shots) await bob.screenshot({ path: `${shots}/hmanage-06-delete-home.png`, fullPage: true });
    await deleting.getByRole("button", { name: "Delete this home" }).click();
    await expect(bob.getByText(/is deleted, and its box has forgotten its devices/)).toBeVisible({ timeout: 30_000 });
    expect(box.brands).toHaveLength(0);
    expect(box.asked.some((q) => q.op === "entries.remove" && q.args.entry === "entry1")).toBe(true);
    for (const [page, auth] of [[alice, aAuth], [bob, bAuth]] as const) {
      expect(await (await call(page, auth, "GET", "/home")).text()).not.toContain(homeId);
      expect((await call(page, auth, "GET", `/home/${homeId}/state`)).status()).toBe(404);
    }
    homeId = "";
  } finally {
    box?.down();
    if (homeId) {
      // Whoever owns it by now deletes it.
      await call(alice, aAuth, "DELETE", `/home/${homeId}`);
      await call(bob, bAuth, "DELETE", `/home/${homeId}`);
    }
    if (boxId) await call(dana, dAuth, "DELETE", `/admin/home/boxes/${boxId}`);
    await call(dana, dAuth, "PATCH", "/admin/home/settings", { enabled: !!before.enabled });
  }
});
