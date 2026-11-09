import type { Browser, Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { storageStateFile } from "../lib/stack";

/** Calendar's Location fills in as you type: your saved P Maps places,
 *  Contacts with an address, and P Maps search (addresses and businesses),
 *  near you. Free text still goes as typed, and with Maps search down it
 *  quietly suggests saved places only. The e2e stack's Maps is a stub with
 *  no Photon, so map search answers are faked here; the saved place is real. */

const PLACE = `Oil King Baringa ${stamp}`;
const BUNNINGS = { kind: "place", name: "Bunnings Caloundra", address: "Caloundra West QLD 4551", category: "hardware", lat: -26.7934, lon: 153.0712 };

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/calendar");
  await ready(page);
  return (await seen).headers()["authorization"];
}

/** A favourite in alice's P Maps, removed again afterwards. */
async function savePlace(page: Page, auth: string): Promise<string> {
  const r = await page.request.post("/api/maps/places", {
    headers: { Authorization: auth },
    data: { kind: "favourite", name: PLACE, address: "3 Main Dr, Baringa QLD 4551", lat: -26.8113, lon: 153.0841 },
  });
  expect(r.status()).toBe(201);
  return (await r.json()).id as string;
}

async function newEvent(page: Page) {
  await page.getByRole("button", { name: "New event" }).first().click();
  await expect(page.getByRole("dialog", { name: "New event" })).toBeVisible();
}

const locationBox = (page: Page) => page.getByRole("combobox", { name: "Location" });
const options = (page: Page) => page.getByRole("listbox", { name: "Suggested places" }).getByRole("option");

test("Location suggests your places and map results near you, and picking fills it in", async ({ alice }) => {
  test.setTimeout(90_000);
  const auth = await bearer(alice);
  const placeId = await savePlace(alice, auth);
  try {
    // You've already let the site have your location: search looks near you.
    await alice.context().grantPermissions(["geolocation"]);
    await alice.context().setGeolocation({ latitude: -26.8, longitude: 153.12 });
    const asked: URL[] = [];
    await alice.route("**/api/maps/search*", (r) => {
      const url = new URL(r.request().url());
      asked.push(url);
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      // Map search returns your saved place too (find_places merges it): it's shown once.
      const results = q.startsWith("oil")
        ? [{ kind: "favourite", id: placeId, name: PLACE, address: "3 Main Dr, Baringa QLD 4551", lat: -26.8113, lon: 153.0841 }]
        : q.startsWith("bunn")
          ? [BUNNINGS, { kind: "address", name: "12 Bunnings Way", address: "Caloundra QLD 4551", lat: -26.8, lon: 153.1 }]
          : [];
      return r.fulfill({ json: { results } });
    });
    await alice.reload();
    await ready(alice);
    await newEvent(alice);
    await alice.getByRole("textbox", { name: "Title" }).fill(`Car service ${stamp}`);

    const box = locationBox(alice);
    await box.click();
    // One letter suggests nothing.
    await box.pressSequentially("o");
    await alice.waitForTimeout(600);
    await expect(alice.getByRole("listbox", { name: "Suggested places" })).toHaveCount(0);
    await box.pressSequentially(`il king ${stamp}`, { delay: 30 });
    await expect(options(alice).filter({ hasText: PLACE })).toHaveCount(1);
    await expect(options(alice).first()).toHaveAttribute("data-kind", "favourite");
    // Superseded keystrokes were debounced: no request per letter.
    expect(asked.length).toBeLessThanOrEqual(3);

    // Escape closes the list, not the dialog, and keeps the text.
    await box.press("Escape");
    await expect(alice.getByRole("listbox", { name: "Suggested places" })).toHaveCount(0);
    await expect(alice.getByRole("dialog", { name: "New event" })).toBeVisible();
    await expect(box).toHaveValue(`oil king ${stamp}`);

    // A business from the map, picked with the keyboard.
    await box.fill("");
    await box.pressSequentially("bunnings cal", { delay: 30 });
    await expect(options(alice).filter({ hasText: "Bunnings Caloundra" })).toBeVisible();
    await expect(options(alice).filter({ hasText: "Bunnings Caloundra" })).toHaveAttribute("data-kind", "business");
    await expect(options(alice).filter({ hasText: "12 Bunnings Way" })).toHaveAttribute("data-kind", "address");
    const near = asked.filter((u) => u.searchParams.get("q") === "bunnings cal").at(-1)!;
    expect(Number(near.searchParams.get("lat"))).toBeCloseTo(-26.8, 2);
    expect(Number(near.searchParams.get("lon"))).toBeCloseTo(153.12, 2);
    await box.press("ArrowDown");
    await expect(options(alice).first()).toHaveAttribute("aria-selected", "true");
    await box.press("Enter");
    await expect(box).toHaveValue("Bunnings Caloundra, Caloundra West QLD 4551");
    await expect(alice.getByRole("listbox", { name: "Suggested places" })).toHaveCount(0);
    // Enter picked; it didn't save the event.
    await expect(alice.getByRole("dialog", { name: "New event" })).toBeVisible();

    // An address picked by tap: just the address.
    await box.fill("");
    await box.pressSequentially("bunnings way", { delay: 30 });
    await options(alice).filter({ hasText: "12 Bunnings Way" }).click();
    await expect(box).toHaveValue("12 Bunnings Way, Caloundra QLD 4551");

    // Saved place picked: "Name, address".
    await box.fill("");
    await box.pressSequentially(`oil king ${stamp}`, { delay: 30 });
    await options(alice).filter({ hasText: PLACE }).click();
    await expect(box).toHaveValue(`${PLACE}, 3 Main Dr, Baringa QLD 4551`);

    const saved = alice.waitForRequest((r) => r.method() === "POST" && /\/api\/calendar\/events$/.test(new URL(r.url()).pathname));
    await alice.getByRole("button", { name: "Save" }).click();
    expect((await saved).postDataJSON().location).toBe(`${PLACE}, 3 Main Dr, Baringa QLD 4551`);
  } finally {
    await alice.request.delete(`/api/maps/places/${placeId}`, { headers: { Authorization: auth } });
  }
});

test("with map search down, Location still suggests saved places and keeps free text, with no error", async ({ alice }) => {
  test.setTimeout(90_000);
  const auth = await bearer(alice);
  const placeId = await savePlace(alice, auth);
  try {
    await alice.route("**/api/maps/search*", (r) => r.fulfill({ status: 503, json: { detail: "Maps aren't ready on this server yet." } }));
    await newEvent(alice);
    const box = locationBox(alice);
    await box.click();
    await box.pressSequentially(`oil king ${stamp}`, { delay: 30 });
    await expect(options(alice).filter({ hasText: PLACE })).toBeVisible();
    await expect(alice.getByText("Maps aren't ready")).toHaveCount(0);

    // Typing anything and not picking keeps it as typed.
    await box.fill("");
    await box.pressSequentially("Back shed at Mum's", { delay: 20 });
    await alice.waitForTimeout(800);
    await box.press("Enter");
    await expect(box).toHaveValue("Back shed at Mum's");
    await expect(alice.getByText("Maps aren't ready")).toHaveCount(0);
  } finally {
    await alice.request.delete(`/api/maps/places/${placeId}`, { headers: { Authorization: auth } });
  }
});

test("an event's place opens in P Maps only when Maps works here", async ({ alice }) => {
  test.setTimeout(90_000);
  const auth = await bearer(alice);
  const where = `Bunnings Caloundra, Caloundra West QLD 4551 ${stamp}`;
  const r = await alice.request.post("/api/calendar/events", {
    headers: { Authorization: auth },
    data: { title: `Pick up timber ${stamp}`, start: "2026-12-12T00:00:00Z", end: "2026-12-12T01:00:00Z", location: where },
  });
  expect(r.status()).toBe(201);
  const eventId = (await r.json()).event.event_id as string;

  await alice.goto(`/calendar?event=${eventId}`);
  const link = alice.getByRole("link", { name: where });
  await expect(link).toHaveAttribute("href", `/maps?q=${encodeURIComponent(where)}`, { timeout: 20_000 });

  // Maps not set up on the server: the place is plain text.
  await alice.route("**/api/maps/config*", (rt) => rt.fulfill({ status: 503, json: { detail: "Maps aren't ready on this server yet." } }));
  await alice.goto(`/calendar?event=${eventId}`);
  await expect(alice.getByText(where)).toBeVisible({ timeout: 20_000 });
  await expect(alice.getByRole("link", { name: where })).toHaveCount(0);
  await alice.request.delete(`/api/calendar/events/${eventId}`, { headers: { Authorization: auth } });
});

/** Screenshots of the open list for review: light, dark and phone width.
 *  Written to the test's output folder (shots/ when SHOTS_DIR is set). */
test("the suggestion list, light, dark and on a phone", async ({ alice, browser }) => {
  test.setTimeout(120_000);
  const auth = await bearer(alice);
  const placeId = await savePlace(alice, auth);
  const dir = process.env.SHOTS_DIR;
  const shot = (name: string) => (dir ? `${dir}/${name}` : test.info().outputPath(name));
  const fake = async (page: Page) =>
    page.route("**/api/maps/search*", (r) =>
      r.fulfill({
        json: {
          results: [
            BUNNINGS,
            { kind: "place", name: "Caloundra Golf Club", address: "Caloundra QLD 4551", category: "golf_course", lat: -26.81, lon: 153.1 },
            { kind: "address", name: "1 Bulcock Street", address: "Caloundra QLD 4551", lat: -26.8031, lon: 153.1316 },
          ],
        },
      }),
    );
  try {
    await fake(alice);
    await newEvent(alice);
    const box = locationBox(alice);
    await box.click();
    await box.pressSequentially("ca", { delay: 30 });
    await expect(options(alice).first()).toBeVisible();
    await box.press("ArrowDown");
    // Whatever theme alice last picked: light, then dark.
    await alice.emulateMedia({ colorScheme: "light" });
    await alice.evaluate(() => document.documentElement.classList.remove("dark"));
    await alice.waitForTimeout(300);
    await alice.screenshot({ path: shot("location-light.png") });
    await alice.evaluate(() => document.documentElement.classList.add("dark"));
    await alice.emulateMedia({ colorScheme: "dark" });
    await alice.waitForTimeout(300);
    await alice.screenshot({ path: shot("location-dark.png") });
    await alice.evaluate(() => document.documentElement.classList.remove("dark"));
    await alice.emulateMedia({ colorScheme: "light" });

    await phone(browser, async (page) => {
      await fake(page);
      await page.goto("/calendar");
      // On a phone, New event is the quick box first; the full form is behind More options.
      await page.getByRole("button", { name: "New event" }).first().click();
      await page.getByRole("button", { name: "More options" }).click();
      const pbox = locationBox(page);
      await pbox.click();
      await pbox.pressSequentially(`oil king ${stamp}`, { delay: 30 });
      await expect(options(page).filter({ hasText: PLACE })).toBeVisible();
      await pbox.fill("ca");
      await expect(options(page).first()).toBeVisible();
      // Big enough to tap.
      expect((await options(page).first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.waitForTimeout(500);
      await page.screenshot({ path: shot("location-phone.png") });
      // With an on-screen keyboard taking the bottom of the screen (the
      // viewport shrunk to what's left), the list stays where it can be seen.
      await page.setViewportSize({ width: 390, height: 470 });
      await pbox.fill("cal");
      await expect(options(page).first()).toBeVisible();
      await page.waitForTimeout(500);
      const lb = (await page.getByRole("listbox", { name: "Suggested places" }).boundingBox())!;
      expect(lb.y).toBeGreaterThanOrEqual(0);
      expect(lb.y + lb.height).toBeLessThanOrEqual(470);
      await page.screenshot({ path: shot("location-phone-keyboard.png") });
    });
    await phone(browser, async (page) => {
      await fake(page);
      await page.goto("/calendar");
      await page.getByRole("button", { name: "New event" }).first().click();
      await page.getByRole("button", { name: "More options" }).click();
      await locationBox(page).click();
      await locationBox(page).pressSequentially("ca", { delay: 30 });
      await expect(options(page).first()).toBeVisible();
      await page.waitForTimeout(500);
      await page.screenshot({ path: shot("location-phone-dark.png") });
    }, "dark");
  } finally {
    await alice.request.delete(`/api/maps/places/${placeId}`, { headers: { Authorization: auth } });
  }
});

async function phone(browser: Browser, run: (page: Page) => Promise<void>, theme: "light" | "dark" = "light") {
  const ctx = await browser.newContext({ storageState: storageStateFile("alice"), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.route("**/version.json*", (r) => r.abort());
  // The theme from the start, whatever alice last picked.
  await ctx.addInitScript((t) => localStorage.setItem("promptly.theme", JSON.stringify({ state: { theme: t }, version: 0 })), theme);
  try {
    await run(await ctx.newPage());
  } finally {
    await ctx.close();
  }
}
