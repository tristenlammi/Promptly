import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures";

/** Directions start from where you are, without asking, even if the phone hasn't
 *  found its location yet at the moment you tap. */

async function heldBackLocation(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __fix: () => void; __deny: () => void };
    const ok: PositionCallback[] = [];
    const bad: PositionErrorCallback[] = [];
    Object.defineProperty(navigator, "geolocation", {
      value: {
        watchPosition: (yes: PositionCallback, no: PositionErrorCallback) => {
          ok.push(yes);
          bad.push(no);
          return ok.length;
        },
        clearWatch: () => undefined,
        getCurrentPosition: () => undefined,
      },
    });
    w.__fix = () =>
      ok.forEach((f) =>
        f({ coords: { latitude: -33.87, longitude: 151.21, accuracy: 10 }, timestamp: Date.now() } as unknown as GeolocationPosition),
      );
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
  await page.getByRole("button", { name: /Test Destination/ }).first().click();
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
  await page.getByRole("button", { name: /Test Destination/ }).first().click();
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
