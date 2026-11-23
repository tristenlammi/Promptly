import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

import { expect, ready, test } from "../fixtures";

/** Choosing maps for real: a fresh server with the maps container and no map,
 *  then Monaco is chosen in the admin panel and built from real downloads (a
 *  few MB of OpenStreetMap, plus search picked out of France's file), and
 *  the map, search and directions are used in the browser. Liechtenstein is
 *  added (Monaco keeps working), Monaco is removed, then the last one.
 *
 *  Not part of the everyday suite: it needs a stack with the real container
 *  and nothing chosen, downloads about 2 GB and takes 20-40 minutes.
 *
 *    scripts/stack.sh up mapsreg --with maps-full --build-extras
 *    MAPS_REGIONS_FULL=1 scripts/stack.sh e2e mapsreg tests/maps-regions-full.spec.ts
 *
 *  Screenshots go to docs/maps-regions-shots/. */

const SHOTS = fileURLToPath(new URL("../../docs/maps-regions-shots", import.meta.url));
const BUILD_MS = 40 * 60_000;

// Monte-Carlo's casino and the port; Vaduz and Schaan.
const CASINO = { lat: 43.7392, lon: 7.4277 };
const PORT = { lat: 43.7347, lon: 7.4211 };
const VADUZ = { lat: 47.1411, lon: 9.5215 };
const SCHAAN = { lat: 47.1651, lon: 9.5088 };

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

type State = { available: boolean; chosen: boolean; building: boolean; ready: boolean; failed: boolean; regions: { id: string; state: string }[] };

async function openCard(page: Page) {
  await page.goto("/admin?tab=settings");
  await ready(page);
  const card = page.getByTestId("maps-regions-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.scrollIntoViewIfNeeded();
  return card;
}

test("a fresh server builds the chosen map, adds a second and removes one", async ({ dana: page }) => {
  test.skip(!process.env.MAPS_REGIONS_FULL, "set MAPS_REGIONS_FULL=1 on a stack with the real maps container and no map chosen");
  test.setTimeout(3 * BUILD_MS);
  let auth = { Authorization: await bearer(page) };
  // Sign-in tokens are short-lived and a build isn't: read a new one before each check.
  const fresh = async () => (auth = { Authorization: await bearer(page) });
  const state = async (): Promise<State> => (await page.request.get("/api/maps/regions", { headers: auth })).json();
  const route = async (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
    page.request.post("/api/maps/route", { headers: auth, data: { stops: [a, b], mode: "drive", avoid_tolls: false, avoid_highways: false, avoid_ferries: false } });
  const settled = async (want: string[]) => {
    await expect
      .poll(
        async () => {
          await fresh();
          const s = await state();
          if (s.failed) throw new Error("the map build failed: see the maps container's log");
          return s.building ? "building" : s.regions.map((r) => `${r.id}:${r.state}`).sort().join(",");
        },
        { timeout: BUILD_MS, intervals: [10_000] },
      )
      .toBe(want.map((id) => `${id}:installed`).sort().join(","));
  };

  // ---- 1. Nothing chosen: nothing downloaded, and the app says so.
  const first = await state();
  expect(first.available).toBe(true);
  test.skip(first.chosen, "this stack already has a map chosen: start from an empty one");
  expect(first.ready).toBe(false);
  expect((await (await page.request.get("/api/maps/config", { headers: auth })).json()).unchosen).toBe(true);
  let card = await openCard(page);
  await expect(card.getByTestId("maps-regions-none")).toContainText("No map chosen yet");
  await shot(page, "01-admin-no-map-chosen");
  await page.goto("/maps");
  await expect(page.getByTestId("maps-not-chosen")).toBeVisible({ timeout: 20_000 });
  await shot(page, "02-maps-no-map-chosen");

  // ---- 2. Choose Monaco: the real list, a real estimate, then the build.
  card = await openCard(page);
  await card.getByTestId("maps-regions-add").click();
  const picker = card.getByTestId("map-region-picker");
  await expect(picker.getByTestId("map-region-australia")).toBeVisible({ timeout: 30_000 });
  await picker.scrollIntoViewIfNeeded();
  await shot(page, "03-picker-list");
  await picker.getByTestId("map-region-search").fill("monaco");
  await picker.getByTestId("map-region-monaco").click();
  await expect(picker.getByTestId("map-region-estimate")).toContainText("when it's done", { timeout: 30_000 });
  await card.getByTestId("maps-regions-confirm").scrollIntoViewIfNeeded();
  await shot(page, "04-picker-monaco-estimate");
  await card.getByTestId("maps-regions-confirm").click();
  await expect(card.getByTestId("maps-region-row-monaco")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId("maps-regions-progress")).toBeVisible({ timeout: 60_000 });
  await shot(page, "05-building-monaco");
  await settled(["monaco"]);
  card = await openCard(page);
  await expect(card.getByTestId("maps-region-row-monaco")).toHaveAttribute("data-state", "installed");
  await shot(page, "06-monaco-installed");

  // ---- 3. It works: search, a route, and the map itself.
  const config = await (await page.request.get("/api/maps/config", { headers: auth })).json();
  expect(config.ready).toBe(true);
  expect(config.unchosen).toBe(false);
  expect(config.attribution).not.toContain("G-NAF");
  expect(config.bounds[0]).toBeGreaterThan(7.3);
  expect(config.bounds[2]).toBeLessThan(7.7);
  await expect
    .poll(async () => (await page.request.get("/api/maps/search", { headers: auth, params: { q: "Casino de Monte-Carlo", lat: CASINO.lat, lon: CASINO.lon } })).status(), { timeout: 120_000 })
    .toBe(200);
  const found = (await (await page.request.get("/api/maps/search", { headers: auth, params: { q: "Casino de Monte-Carlo", lat: CASINO.lat, lon: CASINO.lon } })).json()).results as { name: string; lat: number; lon: number }[];
  expect(found.some((r) => /casino/i.test(r.name) && Math.abs(r.lat - CASINO.lat) < 0.02)).toBe(true);
  // France's places were in the same file and must not have come along.
  const paris = (await (await page.request.get("/api/maps/search", { headers: auth, params: { q: "Tour Eiffel" } })).json()).results as { lat: number }[];
  expect(paris.filter((r) => Math.abs(r.lat - 48.858) < 0.05)).toEqual([]);
  await expect.poll(async () => (await route(PORT, CASINO)).status(), { timeout: 120_000 }).toBe(200);
  const trip = (await (await route(PORT, CASINO)).json()).routes[0];
  expect(trip.km).toBeGreaterThan(0.2);
  expect(trip.km).toBeLessThan(6);

  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: PORT.lat, longitude: PORT.lon });
  await page.goto("/maps");
  await expect(page.getByRole("region", { name: "Map" }).locator("canvas")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(6_000); // tiles
  await shot(page, "07-map-opens-on-monaco");
  await page.getByPlaceholder("Search for a place, address or person").fill("Casino de Monte-Carlo");
  await expect(page.getByRole("listbox", { name: "Places found" }).getByRole("option").first()).toBeVisible({ timeout: 20_000 });
  await shot(page, "08-search-monaco");
  await page.goto(`/maps?to=${CASINO.lat},${CASINO.lon},Casino%20de%20Monte-Carlo&go=1`);
  await expect(page.getByText(/\d+ min/).first()).toBeVisible({ timeout: 40_000 });
  await page.waitForTimeout(5_000);
  await shot(page, "09-route-in-monaco");

  // ---- 4. Add Liechtenstein: Monaco keeps working while both are built.
  card = await openCard(page);
  await card.getByTestId("maps-regions-add").click();
  await card.getByTestId("map-region-search").fill("liechtenstein");
  await card.getByTestId("map-region-liechtenstein").click();
  await expect(card.getByTestId("map-region-estimate")).toContainText("all your maps together", { timeout: 30_000 });
  await card.getByTestId("maps-regions-confirm").scrollIntoViewIfNeeded();
  await shot(page, "10-adding-liechtenstein");
  await card.getByTestId("maps-regions-confirm").click();
  await expect(card.getByTestId("maps-region-row-liechtenstein")).toHaveAttribute("data-state", /building|waiting/, { timeout: 60_000 });
  await expect(card.getByTestId("maps-region-row-monaco")).toHaveAttribute("data-state", "installed");
  await expect(card.getByTestId("maps-regions-progress")).toContainText("Your current maps keep working", { timeout: 60_000 });
  await shot(page, "11-building-second-map");
  // Mid-build, Monaco still answers.
  expect((await route(PORT, CASINO)).status()).toBe(200);
  await settled(["liechtenstein", "monaco"]);
  await expect.poll(async () => (await route(VADUZ, SCHAAN)).status(), { timeout: 180_000 }).toBe(200);
  expect((await route(PORT, CASINO)).status()).toBe(200);
  const vaduz = (await (await page.request.get("/api/maps/search", { headers: auth, params: { q: "Vaduz" } })).json()).results as { name: string; lat: number }[];
  expect(vaduz.some((r) => Math.abs(r.lat - VADUZ.lat) < 0.05)).toBe(true);
  card = await openCard(page);
  await shot(page, "12-two-maps-installed");
  await page.context().setGeolocation({ latitude: VADUZ.lat, longitude: VADUZ.lon });
  await page.goto(`/maps?to=${SCHAAN.lat},${SCHAAN.lon},Schaan&go=1`);
  await expect(page.getByText(/\d+ min/).first()).toBeVisible({ timeout: 40_000 });
  await page.waitForTimeout(5_000);
  await shot(page, "13-route-in-liechtenstein");

  // ---- 5. Remove Monaco: Liechtenstein carries on, Monaco stops routing.
  card = await openCard(page);
  await card.getByRole("button", { name: "Remove Monaco" }).click();
  await expect(page.getByRole("dialog")).toContainText("Remove Monaco?");
  await shot(page, "14-remove-confirm");
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await expect(card.getByTestId("maps-region-row-monaco")).toContainText("Being removed", { timeout: 30_000 });
  await settled(["liechtenstein"]);
  await expect.poll(async () => (await route(VADUZ, SCHAAN)).status(), { timeout: 180_000 }).toBe(200);
  expect((await route(PORT, CASINO)).status()).not.toBe(200);
  card = await openCard(page);
  await expect(card.getByTestId("maps-region-row-monaco")).toHaveCount(0);
  await shot(page, "15-monaco-removed");

  // ---- 6. Remove the last one: back to "no map chosen", data gone.
  await card.getByRole("button", { name: "Remove Liechtenstein" }).click();
  await expect(page.getByRole("dialog")).toContainText("This is your only map");
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await expect
    .poll(async () => { await fresh(); const s = await state(); return `${s.chosen}:${s.ready}:${s.regions.length}`; }, { timeout: 180_000, intervals: [5_000] })
    .toBe("false:false:0");
  card = await openCard(page);
  await expect(card.getByTestId("maps-regions-none")).toBeVisible();
  await shot(page, "16-no-map-again");
});
