// Promptly Home in the real page, against a stand-in box (lib/fakeBox.ts:
// the box protocol, no Home Assistant). An admin prepares a box; its card's
// link adds it to a home; devices show by room; a tap switches one and a
// change at the device shows by itself; someone outside the home, and the
// admin, see none of it; and a box that drops off says so.
//
// Home is off by default, so the spec turns it on and puts the switch back.
// alice's home is reused between runs (a home can't be deleted yet, and a
// person can be in five), and the box is released and removed at the end.
import { type APIResponse, type Page } from "@playwright/test";

import { expect, stamp, test } from "../fixtures";
import { FakeBox, readSetup } from "../lib/fakeBox";
import { BASE_URL } from "../lib/stack";

test.describe.configure({ mode: "serial" });

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  return (await seen).headers()["authorization"];
}
const call = (page: Page, auth: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, data?: unknown): Promise<APIResponse> =>
  page.request.fetch(`/api${url}`, { method, headers: { Authorization: auth }, data });

test("a box is added from its card, its devices switch and update live, and nobody outside the home sees them", async ({ alice, bob, dana }) => {
  test.setTimeout(120_000);
  const [aAuth, bAuth, dAuth] = [await bearer(alice), await bearer(bob), await bearer(dana)];
  const before = await (await call(dana, dAuth, "GET", "/admin/home/settings")).json();
  expect((await call(dana, dAuth, "PATCH", "/admin/home/settings", { enabled: true })).ok()).toBe(true);

  let boxId = "";
  let homeId = "";
  let box: FakeBox | null = null;
  /** Take every box this spec ever prepared out of alice's homes, and remove it. */
  const tidy = async () => {
    const boxes = ((await (await call(dana, dAuth, "GET", "/admin/home/boxes")).json()).boxes ?? []) as { id: string; label?: string }[];
    const ours = new Set(boxes.filter((b) => (b.label ?? "").startsWith("e2e ")).map((b) => b.id));
    const homes = ((await (await call(alice, aAuth, "GET", "/home")).json()).homes ?? []) as { id: string; boxes: { id: string }[] }[];
    for (const h of homes) {
      for (const b of h.boxes ?? []) if (ours.has(b.id)) await call(alice, aAuth, "DELETE", `/home/${h.id}/boxes/${b.id}`);
    }
    for (const id of ours) await call(dana, dAuth, "DELETE", `/admin/home/boxes/${id}`);
  };
  try {
    await tidy(); // an earlier run that stopped halfway
    // The admin prepares a box: a setup string for the box, a code for the card.
    const made = await call(dana, dAuth, "POST", "/admin/home/boxes", { label: `e2e ${stamp}`, server_url: BASE_URL });
    expect(made.ok(), await made.text()).toBe(true);
    const prepared = await made.json();
    boxId = prepared.box.id;
    box = new FakeBox(
      readSetup(prepared.setup),
      [{ id: "lounge", name: "Lounge" }, { id: "kitchen", name: "Kitchen" }],
      [
        { id: "light.lamp", domain: "light", name: `Lamp ${stamp}`, state: "off", area: "lounge" },
        { id: "switch.kettle", domain: "switch", name: "Kettle", state: "off", area: "kitchen" },
        { id: "sensor.temp", domain: "sensor", name: "Temperature", state: "21.5", unit: "°C", cls: "temperature", area: "lounge" },
      ],
    );
    expect((await box.up()).claimed).toBe(false);

    // The card's link opens Home with the code filled in.
    await alice.goto(`/home#claim=${prepared.claim_code}`);
    const sheet = alice.getByRole("dialog", { name: "Add a home box" });
    await expect(sheet.getByLabel("Code on the card")).toHaveValue(prepared.claim_code, { timeout: 20_000 });
    const naming = sheet.getByLabel("Name your home");
    if (await naming.count()) await naming.fill("E2E home");
    await sheet.getByRole("button", { name: "Add this box" }).click();
    await expect(alice.getByRole("dialog", { name: "Box added" })).toContainText("It's connected");
    await alice.getByRole("button", { name: "Done" }).click();

    // Devices, by room.
    const lounge = alice.getByRole("region", { name: "Lounge" });
    const lamp = lounge.getByRole("switch", { name: `Lamp ${stamp}` });
    await expect(lamp).toBeVisible({ timeout: 20_000 });
    await expect(lamp).toContainText("Off");
    await expect(lounge).toContainText("21.5 °C");
    const kettle = alice.getByRole("region", { name: "Kitchen" }).getByRole("switch", { name: "Kettle", exact: true });
    await expect(kettle).toContainText("Off");

    // A tap switches it: the box is asked, and says it's on.
    await lamp.click();
    await expect.poll(() => box!.asked.filter((q) => q.op === "do").map((q) => q.args)).toEqual([{ entity: "light.lamp", action: "turn_on", value: null }]);
    await expect(lamp).toContainText("On");
    // Switched at the kettle itself: the page follows with no reload.
    box.change("switch.kettle", "on");
    await expect(kettle).toContainText("On", { timeout: 15_000 });

    // Nobody outside the home sees it: another person, or the admin.
    const mine = ((await (await call(alice, aAuth, "GET", "/home")).json()).homes ?? []) as { id: string; boxes: { id: string }[] }[];
    homeId = mine.find((h) => h.boxes.some((b) => b.id === boxId))!.id;
    for (const [page, auth] of [[bob, bAuth], [dana, dAuth]] as const) {
      const theirs = await (await call(page, auth, "GET", "/home")).text();
      expect(theirs).not.toContain(homeId);
      expect(theirs).not.toContain(`Lamp ${stamp}`);
      expect((await call(page, auth, "GET", `/home/${homeId}/state`)).status()).toBe(404);
      expect((await call(page, auth, "POST", `/home/${homeId}/act`, { box_id: boxId, entity_id: "light.lamp", action: "turn_off" })).status()).toBe(404);
    }
    const adminList = await (await call(dana, dAuth, "GET", "/admin/home/boxes")).text();
    expect(adminList).not.toContain(`Lamp ${stamp}`);
    expect(adminList).not.toContain("E2E home");
    await bob.goto("/home");
    await expect(bob.getByText(`Lamp ${stamp}`)).toHaveCount(0);

    // The box drops off: the page says so, and keeps what it last knew.
    box.down();
    await expect(alice.getByText("Your home box is offline")).toBeVisible({ timeout: 30_000 });
    await expect(lamp).toBeVisible();
  } finally {
    box?.down();
    await tidy();
    await call(dana, dAuth, "PATCH", "/admin/home/settings", { enabled: !!before.enabled });
  }
});
