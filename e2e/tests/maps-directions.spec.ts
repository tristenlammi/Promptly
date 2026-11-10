import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures";

/** Directions start from where you are, without asking, even if the phone hasn't
 *  found its location yet at the moment you tap. */

async function heldBackLocation(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __fix: () => void;
      __deny: () => void;
      __rough: () => void;
      __fail: (code: number, message: string) => void;
      __watches: number;
    };
    w.__watches = 0;
    const rough: PositionCallback[] = [];
    const ok: PositionCallback[] = [];
    const bad: PositionErrorCallback[] = [];
    Object.defineProperty(navigator, "geolocation", {
      value: {
        watchPosition: (yes: PositionCallback, no: PositionErrorCallback) => {
          ok.push(yes);
          bad.push(no);
          w.__watches++;
          return ok.length;
        },
        clearWatch: () => undefined,
        getCurrentPosition: (yes: PositionCallback) => rough.push(yes),
      },
    });
    w.__fix = () =>
      ok.forEach((f) =>
        f({ coords: { latitude: -33.87, longitude: 151.21, accuracy: 10 }, timestamp: Date.now() } as unknown as GeolocationPosition),
      );
    w.__rough = () =>
      rough.forEach((f) =>
        f({ coords: { latitude: -33.9, longitude: 151.1, accuracy: 900 }, timestamp: Date.now() } as unknown as GeolocationPosition),
      );
    w.__fail = (code, message) =>
      bad.forEach((f) => f({ code, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message } as unknown as GeolocationPositionError));
    w.__deny = () =>
      bad.forEach((f) => f({ code: 1, PERMISSION_DENIED: 1, message: "no" } as unknown as GeolocationPositionError));
  });
  await page.route("**/api/maps/search*", (r) =>
    r.fulfill({ json: { results: [{ kind: "place", name: "Test Destination", address: "Parramatta NSW", lat: -33.815, lon: 151.0 }] } }),
  );
}

async function directionsToTestPlace(page: Page) {
  await page.goto("/maps");
  await page.getByPlaceholder("Search for a place, address or person").fill("Test Destination");
  // The results are a list the arrow keys move through (options of the search box).
  await page.getByRole("listbox", { name: "Places found" }).getByRole("option", { name: /Test Destination/ }).first().click();
  await page.getByRole("button", { name: "Directions" }).click();
}

test("directions before a location fix wait for it, then start from you", async ({ alice: page }) => {
  await heldBackLocation(page);
  await directionsToTestPlace(page);

  await expect(page.getByPlaceholder("Start from where?")).toHaveCount(0);
  await expect(page.getByText("Finding your location…")).toBeVisible();

  const asked = page.waitForRequest((r) => r.method() === "POST" && r.url().includes("/api/maps/route"));
  await page.evaluate(() => (window as unknown as { __fix: () => void }).__fix());
  const body = (await asked).postDataJSON();
  expect(body.stops).toHaveLength(2);
  expect(body.stops[0].name).toBe("Your location");
  expect(body.stops[1].name).toBe("Test Destination");
  await expect(page.getByText("Finding your location…")).toHaveCount(0);
  await expect(page.getByPlaceholder("Start from where?")).toHaveCount(0);
});

test("with a location already, directions go straight to the route", async ({ alice: page }) => {
  await heldBackLocation(page);
  await page.goto("/maps");
  await expect(page.getByPlaceholder("Search for a place, address or person")).toBeVisible();
  await page.evaluate(() => (window as unknown as { __fix: () => void }).__fix());
  await page.getByPlaceholder("Search for a place, address or person").fill("Test Destination");
  await page.getByRole("listbox", { name: "Places found" }).getByRole("option", { name: /Test Destination/ }).first().click();
  const asked = page.waitForRequest((r) => r.method() === "POST" && r.url().includes("/api/maps/route"));
  await page.getByRole("button", { name: "Directions" }).click();
  expect((await asked).postDataJSON().stops[0].name).toBe("Your location");
  await expect(page.getByText("Finding your location…")).toHaveCount(0);
});

test("with location turned off, it asks where from", async ({ alice: page }) => {
  await heldBackLocation(page);
  await directionsToTestPlace(page);
  await page.evaluate(() => (window as unknown as { __deny: () => void }).__deny());
  await expect(page.getByPlaceholder("Start from where?")).toBeVisible();
});

test("while GPS searches, a rough location gets the route going", async ({ alice: page }) => {
  await heldBackLocation(page);
  await directionsToTestPlace(page);
  await expect(page.getByText("Finding your location…")).toBeVisible();

  const asked = page.waitForRequest((r) => r.method() === "POST" && r.url().includes("/api/maps/route"));
  await page.evaluate(() => (window as unknown as { __rough: () => void }).__rough());
  const body = (await asked).postDataJSON();
  expect(body.stops[0].name).toBe("Your location");
  expect(body.stops[0].lat).toBeCloseTo(-33.9);
  await expect(page.getByText("Finding your location…")).toHaveCount(0);
});

test("a phone that can't give a location says why, and can try again", async ({ alice: page }) => {
  await heldBackLocation(page);
  await directionsToTestPlace(page);
  const w = () => page.evaluate(() => (window as unknown as { __watches: number }).__watches);
  const before = await w();

  await page.evaluate(() => (window as unknown as { __fail: (c: number, m: string) => void }).__fail(2, "Failed to request location updates"));
  await expect(page.getByText(/Your phone isn't giving a location.*Failed to request location updates/)).toBeVisible();
  await expect(page.getByPlaceholder("Start from where?")).toHaveCount(0);

  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Finding your location…")).toBeVisible();
  expect(await w()).toBe(before + 1);

  await page.evaluate(() => (window as unknown as { __fail: (c: number, m: string) => void }).__fail(3, "Timeout expired"));
  await expect(page.getByText(/Can't find your location yet/)).toBeVisible();

  // It carries on listening: a fix still gets the route.
  const asked = page.waitForRequest((r) => r.method() === "POST" && r.url().includes("/api/maps/route"));
  await page.evaluate(() => (window as unknown as { __fix: () => void }).__fix());
  expect((await asked).postDataJSON().stops[0].name).toBe("Your location");
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
});
