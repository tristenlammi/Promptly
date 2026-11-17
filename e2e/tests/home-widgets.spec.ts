// Your own Home page, in the real page against a stand-in box (lib/fakeBox.ts).
// Until it's customised the page is the rooms as always. "Customise this page"
// makes each room a widget; a device, a group and music are added, sized, and
// dragged (with the mouse, a finger-sized pointer, and the keyboard); "Done"
// saves it for this person in this home, so it's there after a reload and
// nobody else's page changes. A device that leaves the home says so on its
// widget; "Reset" brings the page back as it came.
//
// Home is off by default, so the spec turns it on and puts the switch back.
// alice's home is reused between runs, so her layout is cleared before and after.
import fs from "node:fs";
import path from "node:path";

import { type APIResponse, type Locator, type Page } from "@playwright/test";

import { expect, stamp, test } from "../fixtures";
import { FakeBox, readSetup } from "../lib/fakeBox";
import { BASE_URL } from "../lib/stack";

test.describe.configure({ mode: "serial" });

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  return (await seen).headers()["authorization"];
}
const call = (page: Page, auth: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, data?: unknown): Promise<APIResponse> =>
  page.request.fetch(`/api${url}`, { method, headers: { Authorization: auth }, data });

/** Pictures for a person to look at, when SHOTS_DIR says where (never part of pass or fail). */
async function shot(page: Page, name: string) {
  const dir = process.env.SHOTS_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, name), fullPage: true });
}

/** The widgets on the board, top to bottom, by what they are. */
const kinds = (page: Page) => page.getByTestId("home-board").locator(":scope > [data-widget]").evaluateAll((els) => els.map((e) => e.getAttribute("data-widget")));
/** The names on the handles while customising, in order. */
const handles = (page: Page) => page.getByRole("button", { name: /^Move / }).evaluateAll((els) => els.map((e) => (e.getAttribute("aria-label") ?? "").replace(/^Move /, "")));

/** Drag ``from`` onto ``to`` with a pointer, in small steps as a hand does. */
async function drag(page: Page, from: Locator, to: Locator) {
  await from.scrollIntoViewIfNeeded();
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2 + 8, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 15 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 - 2, { steps: 3 });
  await page.mouse.up();
}

test("the Home page is laid out your own way, saved for you alone, and reset puts it back", async ({ alice, bob, dana, browser }) => {
  test.setTimeout(180_000);
  const [aAuth, bAuth, dAuth] = [await bearer(alice), await bearer(bob), await bearer(dana)];
  const before = await (await call(dana, dAuth, "GET", "/admin/home/settings")).json();
  expect((await call(dana, dAuth, "PATCH", "/admin/home/settings", { enabled: true })).ok()).toBe(true);

  let homeId = "";
  let box: FakeBox | null = null;
  const tidy = async () => {
    const boxes = ((await (await call(dana, dAuth, "GET", "/admin/home/boxes")).json()).boxes ?? []) as { id: string; label?: string }[];
    const ours = new Set(boxes.filter((b) => (b.label ?? "").startsWith("e2e ")).map((b) => b.id));
    const homes = ((await (await call(alice, aAuth, "GET", "/home")).json()).homes ?? []) as { id: string; boxes: { id: string }[] }[];
    for (const h of homes) {
      await call(alice, aAuth, "DELETE", `/home/${h.id}/layout`);
      for (const b of h.boxes ?? []) if (ours.has(b.id)) await call(alice, aAuth, "DELETE", `/home/${h.id}/boxes/${b.id}`);
    }
    for (const id of ours) await call(dana, dAuth, "DELETE", `/admin/home/boxes/${id}`);
  };
  try {
    await tidy(); // an earlier run that stopped halfway
    const made = await call(dana, dAuth, "POST", "/admin/home/boxes", { label: `e2e ${stamp}`, server_url: BASE_URL });
    expect(made.ok(), await made.text()).toBe(true);
    const prepared = await made.json();
    const lampName = `Lamp ${stamp}`;
    box = new FakeBox(
      readSetup(prepared.setup),
      [{ id: "lounge", name: "Lounge" }, { id: "kitchen", name: "Kitchen" }],
      [
        { id: "light.lamp", domain: "light", name: lampName, state: "on", area: "lounge", x: { modes: ["brightness"] } },
        { id: "light.strip", domain: "light", name: "Strip", state: "off", area: "lounge", x: { modes: ["onoff"] } },
        { id: "switch.kettle", domain: "switch", name: "Kettle", state: "off", area: "kitchen" },
        { id: "sensor.temp", domain: "sensor", name: "Temperature", state: "21.5", unit: "°C", cls: "temperature", area: "lounge" },
        { id: "scene.cosy", domain: "scene", name: "Cosy", state: "2026-01-01T00:00:00+00:00", area: "lounge" },
        { id: "media_player.speaker", domain: "media_player", name: "Speaker", state: "playing", cls: "speaker", area: "kitchen", x: { vol: 30, title: "A song", artist: "A band", can: ["pause", "play", "next", "vol"] } },
        { id: "lock.front", domain: "lock", name: "Front door", state: "locked" },
      ],
    );
    await box.up();
    // Into alice's home (her first, or a new one), with the code on its card.
    const first = (((await (await call(alice, aAuth, "GET", "/home")).json()).homes ?? []) as { id: string }[])[0];
    const claimed = await call(alice, aAuth, "POST", "/home/claim", { code: prepared.claim_code, ...(first ? { home_id: first.id } : { home_name: "E2E home" }) });
    expect(claimed.ok(), await claimed.text()).toBe(true);
    homeId = (await claimed.json()).home_id;
    expect(await (await call(alice, aAuth, "GET", `/home/${homeId}/layout`)).json()).toEqual({ widgets: null });

    // ---- the page as it comes: every room, as always
    await alice.goto("/home");
    const lounge = alice.getByRole("region", { name: "Lounge" });
    await expect(lounge.getByRole("switch", { name: lampName })).toBeVisible({ timeout: 30_000 });
    await expect(alice.getByRole("region", { name: "Kitchen" }).getByRole("switch", { name: "Kettle", exact: true })).toBeVisible();
    expect(await kinds(alice)).toEqual(["rest"]);
    await shot(alice, "hwidgets-01-default-desktop.png");

    // ---- customising: a widget a room, then everything else
    await alice.getByRole("button", { name: "Customise this page" }).click();
    await expect(alice.getByRole("region", { name: "Customise this page" })).toBeVisible();
    expect(await handles(alice)).toEqual(["Lounge", "Kitchen", "Everything else"]);
    // Nothing on the page can be switched by accident while it's being arranged.
    await expect(alice.getByRole("switch", { name: lampName })).toHaveCount(0);

    // Add the lamp as a widget of its own, and make it medium: its brightness shows.
    await alice.getByRole("button", { name: "Add a widget" }).first().click();
    let sheet = alice.getByRole("dialog", { name: "Add a widget" });
    await sheet.getByRole("button", { name: /^A device/ }).click();
    await alice.getByRole("dialog", { name: "Which device?" }).getByRole("button", { name: new RegExp(`^${lampName}`) }).click();
    expect(await handles(alice)).toEqual(["Lounge", "Kitchen", lampName, "Everything else"]);
    await alice.getByRole("button", { name: `${lampName}: size small. Change size` }).click();
    await expect(alice.getByRole("button", { name: `${lampName}: size medium. Change size` })).toBeVisible();

    // Favourites: a group picked by hand. The lock can go in; the group's one switch never touches it.
    await alice.getByRole("button", { name: "Add a widget" }).first().click();
    sheet = alice.getByRole("dialog", { name: "Add a widget" });
    await sheet.getByRole("button", { name: /^Favourites/ }).click();
    const pick = alice.getByRole("dialog", { name: "Which devices?" });
    await expect(pick.getByLabel("Name")).toHaveValue("Favourites");
    for (const name of ["Kettle", "Strip", "Front door"]) await pick.getByRole("checkbox", { name, exact: true }).check();
    await pick.getByRole("button", { name: "Add 3" }).click();
    // Music, with what's playing.
    await alice.getByRole("button", { name: "Add a widget" }).first().click();
    await alice.getByRole("dialog", { name: "Add a widget" }).getByRole("button", { name: /^Music/ }).click();
    expect(await handles(alice)).toEqual(["Lounge", "Kitchen", lampName, "Favourites", "Music", "Everything else"]);
    await shot(alice, "hwidgets-02-edit-desktop.png");

    // Drag with the pointer: the lamp to the top.
    await drag(alice, alice.getByRole("button", { name: `Move ${lampName}` }), alice.getByRole("button", { name: "Move Lounge" }));
    await expect.poll(() => handles(alice)).toEqual([lampName, "Lounge", "Kitchen", "Favourites", "Music", "Everything else"]);
    // ...and with the keyboard: Music up two places (Space picks it up, arrows move it, Space puts it down).
    const music = alice.getByRole("button", { name: "Move Music" });
    await music.focus();
    await alice.keyboard.press("Space");
    await alice.keyboard.press("ArrowUp");
    await alice.waitForTimeout(150);
    await alice.keyboard.press("Space");
    const afterKeys = await handles(alice);
    expect(afterKeys.indexOf("Music")).toBeLessThan(5);
    expect(afterKeys.indexOf("Music")).not.toBe(4);
    // Take the kitchen off: it isn't lost, it goes back under everything else.
    await alice.getByRole("button", { name: "Remove Kitchen" }).click();
    const order = await handles(alice);
    expect(order).not.toContain("Kitchen");

    await alice.getByRole("button", { name: "Done" }).first().click();
    await expect(alice.getByRole("button", { name: "Customise this page" })).toBeVisible();

    // ---- the page, their way
    const lamp = alice.locator('[data-widget="device"]').getByRole("switch", { name: lampName });
    await expect(lamp).toBeVisible();
    await expect(alice.locator('[data-widget="device"]').getByLabel("Brightness")).toBeVisible();
    const favourites = alice.getByRole("region", { name: "Favourites" });
    await expect(favourites.getByRole("button", { name: "Front door, Locked" })).toBeVisible();
    await expect(alice.getByRole("region", { name: "Music" })).toContainText("A song");
    await expect(alice.getByRole("region", { name: "Kitchen" })).toBeVisible(); // under everything else
    expect((await kinds(alice))[0]).toBe("device");
    await shot(alice, "hwidgets-03-custom-desktop.png");

    // The widgets work: one switch for the favourites (never the lock), and pause from the music widget.
    await favourites.getByRole("switch", { name: "Everything in Favourites" }).click();
    await expect
      .poll(() => box!.asked.filter((q) => q.op === "do").map((q) => `${q.args.entity} ${q.args.action}`).sort())
      .toEqual(["light.strip turn_on", "switch.kettle turn_on"]);
    await alice.getByRole("region", { name: "Music" }).getByRole("button", { name: "Pause" }).click();
    await expect.poll(() => box!.asked.some((q) => q.op === "do" && q.args.entity === "media_player.speaker" && q.args.action === "pause")).toBe(true);
    // The lock is still its tile, which opens its controls and asks before it lets anyone in.
    await favourites.getByRole("button", { name: /^Front door/ }).click();
    const door = alice.getByRole("dialog", { name: "Front door" });
    await door.getByRole("button", { name: "Unlock" }).click();
    await expect(door.getByRole("alertdialog", { name: "Unlock Front door?" })).toBeVisible();
    await door.getByRole("button", { name: "No" }).click();
    await door.getByRole("button", { name: "Close" }).last().click();
    expect(box.asked.some((q) => q.op === "do" && q.args.entity === "lock.front")).toBe(false);

    // ---- saved on the server, for alice alone
    const saved = (await (await call(alice, aAuth, "GET", `/home/${homeId}/layout`)).json()).widgets as { type: string }[];
    expect(await kinds(alice)).toEqual(saved.map((w) => w.type));
    expect(saved[0].type).toBe("device");
    await alice.reload();
    await expect(alice.locator('[data-widget="device"]').getByRole("switch", { name: lampName })).toBeVisible({ timeout: 30_000 });
    expect((await kinds(alice))[0]).toBe("device");
    for (const [page, auth] of [[bob, bAuth], [dana, dAuth]] as const) {
      expect((await call(page, auth, "GET", `/home/${homeId}/layout`)).status()).toBe(404);
      expect((await call(page, auth, "PUT", `/home/${homeId}/layout`, { widgets: [] })).status()).toBe(404);
    }

    // ---- on a phone: two columns, a finger drags a widget by its handle
    const phoneCtx = await browser.newContext({ storageState: await alice.context().storageState(), viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const phone = await phoneCtx.newPage();
    try {
      await phone.goto("/home");
      await expect(phone.locator('[data-widget="device"]').getByRole("switch", { name: lampName })).toBeVisible({ timeout: 30_000 });
      await shot(phone, "hwidgets-04-custom-phone.png");
      await phone.getByRole("button", { name: "Customise this page" }).click();
      const was = await handles(phone);
      await shot(phone, "hwidgets-05-edit-phone.png");
      // A touch drag, as the browser reports a finger: pointer events of type "touch".
      const from = phone.getByRole("button", { name: `Move ${was[1]}` });
      const to = phone.getByRole("button", { name: `Move ${was[0]}` });
      await from.scrollIntoViewIfNeeded();
      const a = (await from.boundingBox())!;
      const b = (await to.boundingBox())!;
      const client = await phoneCtx.newCDPSession(phone);
      const touch = (type: string, x: number, y: number) => client.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
      await touch("touchStart", a.x + 20, a.y + a.height / 2);
      for (let i = 1; i <= 12; i++) await touch("touchMove", a.x + 20 + ((b.x - a.x) * i) / 12, a.y + a.height / 2 + ((b.y - a.y - 6) * i) / 12);
      await touch("touchEnd", 0, 0);
      await expect.poll(() => handles(phone)).toEqual([was[1], was[0], ...was.slice(2)]);
      // No sideways scroll: nothing is wider than the phone.
      expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await phone.getByRole("button", { name: "Cancel" }).click(); // not saved
      expect((await kinds(phone))[0]).toBe("device");
    } finally {
      await phoneCtx.close();
    }

    // ---- the lamp leaves the home: its widget says so, and can be taken off there and then
    box.entities = box.entities.filter((e) => e.id !== "light.lamp");
    box.snapshot();
    const goneCard = alice.locator('[data-widget="device"]');
    await expect(goneCard).toContainText("This device is no longer in this home.", { timeout: 20_000 });
    await expect(goneCard).toContainText(lampName);
    await shot(alice, "hwidgets-06-gone-desktop.png");
    await goneCard.getByRole("button", { name: "Remove" }).click();
    await expect(alice.locator('[data-widget="device"]')).toHaveCount(0);
    await expect.poll(async () => ((await (await call(alice, aAuth, "GET", `/home/${homeId}/layout`)).json()).widgets as { type: string }[]).some((w) => w.type === "device")).toBe(false);

    // ---- reset: the page as it came
    await alice.getByRole("button", { name: "Customise this page" }).click();
    await alice.getByRole("button", { name: "Reset" }).click();
    await alice.getByRole("alertdialog", { name: "Reset your page?" }).getByRole("button", { name: "Reset" }).click();
    await expect(alice.getByRole("button", { name: "Customise this page" })).toBeVisible();
    expect(await kinds(alice)).toEqual(["rest"]);
    await expect(alice.getByRole("region", { name: "Favourites" })).toHaveCount(0);
    expect(await (await call(alice, aAuth, "GET", `/home/${homeId}/layout`)).json()).toEqual({ widgets: null });
  } finally {
    box?.down();
    await tidy();
    await call(dana, dAuth, "PATCH", "/admin/home/settings", { enabled: !!before.enabled });
  }
});
