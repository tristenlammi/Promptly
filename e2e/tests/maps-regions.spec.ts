import type { Page, Route } from "@playwright/test";

import { expect, ready, test } from "../fixtures";

/** Choosing this server's maps (Admin → App settings → Maps on this server).
 *  The maps container is played by this spec (the suite's stack has a stub
 *  map and no container), so every state can be shown: nothing chosen, the
 *  list with sizes, a build in progress, a second map, removing one, a map
 *  too big for the disk, a map set in .env. The real thing, with real
 *  downloads, is maps-regions-full.spec.ts. */

type Row = { id: string; name: string; state: "installed" | "building" | "waiting" | "removing" };

const CATALOG = {
  source: "geofabrik",
  fetched_at: 1,
  regions: [
    { id: "australia", name: "Australia", parent: null, parent_name: null, continent: "Australia and Oceania", kind: "country", download_mb: 1520, disk_mb: 12000, minutes: 65 },
    { id: "new-zealand", name: "New Zealand", parent: null, parent_name: null, continent: "Australia and Oceania", kind: "country", download_mb: 520, disk_mb: 2600, minutes: 25 },
    { id: "france", name: "France", parent: null, parent_name: null, continent: "Europe", kind: "country", download_mb: 6300, disk_mb: 34000, minutes: 215 },
    { id: "monaco", name: "Monaco", parent: null, parent_name: null, continent: "Europe", kind: "country", download_mb: 1614, disk_mb: 5, minutes: 9 },
    { id: "us", name: "United States of America", parent: null, parent_name: null, continent: "North America", kind: "country", download_mb: 14000, disk_mb: 84000, minutes: 520 },
    { id: "us/california", name: "California", parent: "us", parent_name: "United States of America", continent: "North America", kind: "part", download_mb: 4500, disk_mb: 9800, minutes: 70 },
    { id: "us/texas", name: "Texas", parent: "us", parent_name: "United States of America", continent: "North America", kind: "part", download_mb: 4100, disk_mb: 6900, minutes: 50 },
  ],
};

function state(over: Record<string, unknown> = {}) {
  return {
    available: true, managed: "ui", chosen: false, regions: [] as Row[], ready: false, building: false, failed: false,
    step: null, step_number: null, steps_total: null, detail: null, progress: null, built_at: null,
    disk: { free_bytes: 120_000_000_000, total_bytes: 250_000_000_000, maps_bytes: 0 }, offline: true,
    ...over,
  };
}

/** Stands in for the maps container. ``box.state`` is what the server says now. */
async function fakeMaps(page: Page, first: ReturnType<typeof state>) {
  const box = { state: first, sent: [] as { url: string; body: unknown }[], freeBytes: 120_000_000_000 };
  const json = (r: Route, body: unknown, status = 200) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/maps/regions/catalog*", (r) => json(r, CATALOG));
  await page.route("**/api/maps/regions/estimate", (r) => {
    const ids = r.request().postDataJSON().ids as string[];
    const mb = ids.reduce((sum, id) => sum + (CATALOG.regions.find((x) => x.id === id)?.disk_mb ?? 0), 0);
    const needed = mb * 1_600_000;
    return json(r, {
      complete: true, download_bytes: mb * 300_000, disk_after_bytes: mb * 1_000_000, disk_needed_bytes: needed,
      disk_live_bytes: 0, free_bytes: box.freeBytes, fits: needed * 1.1 < box.freeBytes, minutes: mb / 104,
    });
  });
  await page.route("**/api/maps/regions/add", (r) => {
    const ids = r.request().postDataJSON().ids as string[];
    box.sent.push({ url: "add", body: r.request().postDataJSON() });
    const added = ids.map((id) => ({ id, name: CATALOG.regions.find((x) => x.id === id)!.name, state: "building" as const }));
    box.state = state({
      ...box.state, chosen: true, building: true, step: "osm", step_number: 1, steps_total: 6, detail: added[0].name, progress: 0,
      regions: [...box.state.regions, ...added],
    });
    return json(r, box.state);
  });
  await page.route("**/api/maps/regions/remove", (r) => {
    const ids = r.request().postDataJSON().ids as string[];
    box.sent.push({ url: "remove", body: r.request().postDataJSON() });
    box.state = state({ ...box.state, building: true, step: "osm", step_number: 1, steps_total: 6, progress: 0, regions: box.state.regions.map((x) => (ids.includes(x.id) ? { ...x, state: "removing" as const } : x)) });
    return json(r, box.state);
  });
  await page.route("**/api/maps/regions/retry", (r) => {
    box.sent.push({ url: "retry", body: null });
    return json(r, { ok: true });
  });
  await page.route("**/api/maps/regions", (r) => json(r, box.state));
  return box;
}

async function openCard(page: Page) {
  await page.goto("/admin?tab=settings");
  await ready(page);
  const card = page.getByTestId("maps-regions-card");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.scrollIntoViewIfNeeded();
  return card;
}

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("nothing is chosen at first; choosing a country shows its size, then its progress", async ({ dana: page }) => {
  const box = await fakeMaps(page, state());
  const card = await openCard(page);
  await expect(card.getByTestId("maps-regions-none")).toContainText("No map chosen yet");
  await expect(card.getByTestId("maps-regions-none")).toContainText("Nothing has been downloaded");

  await card.getByTestId("maps-regions-add").click();
  const picker = card.getByTestId("map-region-picker");
  // Countries by continent, with a rough size each; parts of big ones are tucked away.
  await expect(picker.getByText("Australia and Oceania", { exact: true })).toBeVisible();
  await expect(picker.getByTestId("map-region-new-zealand")).toContainText("520 MB download");
  await expect(picker.getByTestId("map-region-us/california")).toHaveCount(0);
  await picker.getByRole("button", { name: "Show the parts of United States of America" }).click();
  await expect(picker.getByTestId("map-region-us/california")).toBeVisible();

  // Nothing ticked: nothing to download.
  await expect(card.getByTestId("maps-regions-confirm")).toBeDisabled();
  await picker.getByTestId("map-region-search").fill("zeal");
  await expect(picker.getByRole("option")).toHaveCount(1);
  await picker.getByTestId("map-region-new-zealand").click();
  const estimate = picker.getByTestId("map-region-estimate");
  await expect(estimate).toContainText("Download");
  await expect(estimate).toContainText("2.6 GB when it's done");
  await expect(estimate).toContainText("this server has 120 GB free");
  await expect(estimate).toContainText("about 25 minutes");

  await card.getByTestId("maps-regions-confirm").click();
  expect(box.sent).toEqual([{ url: "add", body: { ids: ["new-zealand"], force: false } }]);
  await expect(card.getByTestId("maps-region-row-new-zealand")).toHaveAttribute("data-state", "building");
  const progress = card.getByTestId("maps-regions-progress");
  await expect(progress).toContainText("Downloading the map: New Zealand");
  await expect(progress).toContainText("Step 1 of 6");
  await expect(progress).toContainText("you can close this page");
  await expect(card.getByTestId("map-region-picker")).toHaveCount(0);

  // The page keeps asking, and shows each step and the end.
  box.state = state({ ...box.state, step: "routing", step_number: 3, progress: 0.2, detail: null });
  await expect(progress).toContainText("Working out the roads for directions", { timeout: 15_000 });
  box.state = state({ chosen: true, ready: true, regions: [{ id: "new-zealand", name: "New Zealand", state: "installed" }], built_at: "2026-11-23T00:00:00Z", disk: { free_bytes: 117_000_000_000, total_bytes: 250_000_000_000, maps_bytes: 2_600_000_000 } });
  await expect(card.getByTestId("maps-region-row-new-zealand")).toHaveAttribute("data-state", "installed", { timeout: 15_000 });
  await expect(card.getByTestId("maps-regions-progress")).toHaveCount(0);
  await expect(card.getByTestId("maps-regions-disk")).toContainText("Your maps use 2.6 GB");
});

test("another map can be added and one removed, with the current maps kept working", async ({ dana: page }) => {
  const box = await fakeMaps(page, state({ chosen: true, ready: true, regions: [{ id: "australia", name: "Australia", state: "installed" }], disk: { free_bytes: 120_000_000_000, total_bytes: 250_000_000_000, maps_bytes: 12_000_000_000 } }));
  const card = await openCard(page);
  await expect(card.getByTestId("maps-region-row-australia")).toContainText("Ready");

  await card.getByTestId("maps-regions-add").click();
  const picker = card.getByTestId("map-region-picker");
  // The one already here is ticked, greyed and can't be picked again.
  await expect(picker.getByTestId("map-region-australia")).toBeDisabled();
  await expect(picker.getByTestId("map-region-australia")).toContainText("Already on this server");
  await picker.getByTestId("map-region-new-zealand").click();
  // All the maps are built together, so the estimate is for both.
  await expect(picker.getByTestId("map-region-estimate")).toContainText("15 GB when it's done");
  await expect(picker.getByTestId("map-region-estimate")).toContainText("all your maps together");
  await card.getByTestId("maps-regions-confirm").click();
  expect(box.sent.at(-1)).toEqual({ url: "add", body: { ids: ["new-zealand"], force: false } });
  await expect(card.getByTestId("maps-region-row-australia")).toHaveAttribute("data-state", "installed");
  await expect(card.getByTestId("maps-region-row-new-zealand")).toHaveAttribute("data-state", "building");
  await expect(card.getByTestId("maps-regions-progress")).toContainText("Your current maps keep working");

  // Removing asks first, and says what happens.
  box.state = state({ chosen: true, ready: true, regions: [{ id: "australia", name: "Australia", state: "installed" }, { id: "new-zealand", name: "New Zealand", state: "installed" }] });
  await expect(card.getByTestId("maps-region-row-new-zealand")).toHaveAttribute("data-state", "installed", { timeout: 15_000 });
  await card.getByRole("button", { name: "Remove New Zealand" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Remove New Zealand?");
  await expect(dialog).toContainText("Everything keeps working meanwhile");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(box.sent.filter((s) => s.url === "remove")).toEqual([]);
  await card.getByRole("button", { name: "Remove New Zealand" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await expect(card.getByTestId("maps-region-row-new-zealand")).toContainText("Being removed");
  expect(box.sent.at(-1)).toEqual({ url: "remove", body: { ids: ["new-zealand"] } });
});

test("a map too big for the disk can't be started; a stopped build can be tried again", async ({ dana: page }) => {
  const box = await fakeMaps(page, state());
  box.freeBytes = 30_000_000_000;
  const card = await openCard(page);
  await card.getByTestId("maps-regions-add").click();
  const picker = card.getByTestId("map-region-picker");
  await picker.getByTestId("map-region-search").fill("united states");
  await picker.getByTestId("map-region-us").click();
  await expect(picker.getByTestId("map-region-too-big")).toContainText("That won't fit");
  await expect(card.getByTestId("maps-regions-confirm")).toBeDisabled();
  // Part of it does fit.
  await picker.getByTestId("map-region-us").click();
  await picker.getByTestId("map-region-search").fill("texas");
  await expect(picker.getByTestId("map-region-us/texas")).toContainText("Texas · United States of America");
  await picker.getByTestId("map-region-us/texas").click();
  await expect(picker.getByTestId("map-region-too-big")).toHaveCount(0);
  await expect(card.getByTestId("maps-regions-confirm")).toBeEnabled();

  box.state = state({ chosen: true, failed: true, step: "osm", regions: [{ id: "us/texas", name: "Texas", state: "waiting" }] });
  await page.reload();
  await ready(page);
  const again = page.getByTestId("maps-regions-card");
  await expect(again.getByRole("alert")).toContainText("The map build stopped");
  await again.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => box.sent.at(-1)?.url).toBe("retry");
});

/** The browser says it is in New Zealand (its time zone), without any look-up. */
async function inNewZealand(page: Page) {
  await page.addInitScript(() => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function (this: Intl.DateTimeFormat) {
      return { ...real.call(this), timeZone: "Pacific/Auckland" };
    };
  });
}

/** The list as the server sends it now: each map says which countries it covers. */
const CODES: Record<string, string[]> = { australia: ["au"], "new-zealand": ["nz"], france: ["fr"], monaco: ["mc"], us: ["us"], "us/california": ["us"], "us/texas": ["us"] };
const withCodes = { ...CATALOG, regions: CATALOG.regions.map((r) => ({ ...r, codes: CODES[r.id] })) };

test("the picker offers your own country first, and is plain about addresses and shared downloads", async ({ dana: page }) => {
  await inNewZealand(page);
  await fakeMaps(page, state());
  await page.route("**/api/maps/regions/catalog*", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(withCodes) }));
  // Monaco: nearly all of the download is France's search file, which is read and not kept.
  await page.route("**/api/maps/regions/estimate", (r) => {
    const ids = r.request().postDataJSON().ids as string[];
    const monaco = ids.length === 1 && ids[0] === "monaco";
    return r.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        complete: true, download_bytes: monaco ? 1_614_000_000 : 520_000_000, streamed_bytes: monaco ? 1_610_000_000 : 110_000_000,
        disk_after_bytes: monaco ? 5_000_000 : 2_600_000_000, disk_needed_bytes: monaco ? 7_000_000 : 4_400_000_000, disk_live_bytes: 0,
        free_bytes: 120_000_000_000, fits: true, minutes: monaco ? 9 : 25,
      }),
    });
  });
  const card = await openCard(page);
  await card.getByTestId("maps-regions-add").click();
  const picker = card.getByTestId("map-region-picker");
  // First in the list, under its own heading, and still in its place below.
  await expect(picker.getByTestId("map-region-yours-group")).toContainText("Probably yours");
  await expect(picker.getByTestId("map-region-yours")).toHaveAttribute("data-region", "new-zealand");
  expect(await picker.getByRole("option").first().getAttribute("data-region")).toBe("new-zealand");
  await expect(picker.getByTestId("map-region-new-zealand")).toBeVisible();
  // Nothing about addresses until something is ticked.
  await expect(picker.getByTestId("map-region-addresses")).toHaveCount(0);
  await picker.getByTestId("map-region-yours").click();
  await expect(picker.getByTestId("map-region-new-zealand")).toHaveAttribute("aria-selected", "true");
  await expect(picker.getByTestId("map-region-addresses")).toContainText("depend on how well OpenStreetMap covers the country");
  await expect(picker.getByTestId("map-region-addresses")).toContainText("Australia also gets the full official address file");
  await expect(picker.getByTestId("map-region-estimate")).toContainText("Disk space");
  await expect(picker.getByTestId("map-region-shared")).toHaveCount(0);
  // Searching hides the suggestion: the list is what was asked for.
  await picker.getByTestId("map-region-search").fill("monaco");
  await expect(picker.getByTestId("map-region-yours-group")).toHaveCount(0);
  await picker.getByTestId("map-region-search").fill("");
  await picker.getByTestId("map-region-yours").click();
  await picker.getByTestId("map-region-monaco").click();
  await expect(picker.getByTestId("map-region-shared")).toContainText("1.6 GB of the download is a search file shared with neighbouring countries");
  await expect(picker.getByTestId("map-region-shared")).toContainText("not kept");
  // The whole of Australia has the official address file: no caveat for it alone.
  await picker.getByTestId("map-region-monaco").click();
  await picker.getByTestId("map-region-australia").click();
  await expect(picker.getByTestId("map-region-addresses")).toHaveCount(0);
});

test("the setup wizard's Maps step: several countries, nothing started when it won't fit, and Not now", async ({ dana: page }) => {
  await inNewZealand(page);
  const box = await fakeMaps(page, state());
  box.freeBytes = 30_000_000_000;
  await page.route("**/api/maps/regions/catalog*", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(withCodes) }));
  const chosen: unknown[] = [];
  await page.route("**/api/maps/regions", (r) => {
    if (r.request().method() !== "PUT") return r.fallback();
    const body = r.request().postDataJSON() as { ids: string[] };
    chosen.push(body);
    box.state = state({
      chosen: true, building: true, step: "osm", step_number: 1, steps_total: 6, progress: 0,
      regions: body.ids.map((id) => ({ id, name: CATALOG.regions.find((x) => x.id === id)!.name, state: "building" as const })),
    });
    return r.fulfill({ contentType: "application/json", body: JSON.stringify(box.state) });
  });

  await page.goto("/setup?step=maps");
  const step = page.getByTestId("maps-step");
  await expect(step).toBeVisible({ timeout: 20_000 });
  await expect(step).toContainText("Nothing is downloaded until you say so");
  await expect(step.getByTestId("map-region-yours")).toHaveAttribute("data-region", "new-zealand");
  // Nothing ticked: only "Not now" is offered.
  await expect(step.getByTestId("maps-step-download")).toHaveCount(0);
  await expect(step.getByTestId("maps-step-skip")).toContainText("Not now");

  // Too big for this disk: said so, and it can't be started.
  await step.getByTestId("map-region-search").fill("united states");
  await step.getByTestId("map-region-us").click();
  await expect(step.getByTestId("map-region-too-big")).toContainText("That won't fit");
  await expect(step.getByTestId("maps-step-download")).toBeDisabled();
  await step.getByTestId("map-region-us").click();

  // Two that do fit, chosen together.
  await step.getByTestId("map-region-search").fill("");
  await step.getByTestId("map-region-yours").click();
  await step.getByTestId("map-region-monaco").click();
  await expect(step.getByTestId("map-region-estimate")).toContainText("Disk space");
  const go = step.getByTestId("maps-step-download");
  await expect(go).toHaveText("Download 2 maps and continue");
  await expect(go).toBeEnabled();
  expect(chosen).toEqual([]);
  await go.click();
  await expect(page).toHaveURL(/\/admin\?tab=setup/, { timeout: 20_000 });
  expect(chosen).toEqual([{ ids: ["new-zealand", "monaco"], force: false }]);

  // Back on the step: what's chosen and how it's going; more can be added.
  await page.goto("/setup?step=maps");
  await expect(page.getByTestId("maps-step-chosen")).toContainText("New Zealand, Monaco");
  await expect(page.getByTestId("maps-step-chosen")).toContainText("being put together");
  await expect(page.getByTestId("map-region-new-zealand")).toBeDisabled();
  await expect(page.getByTestId("maps-step-continue")).toBeVisible();

  // A map set in .env: nothing to choose, said plainly.
  box.state = state({ managed: "env", chosen: true, ready: true, regions: [{ id: "custom", name: "Your own map (set in .env)", state: "installed" }] });
  await page.goto("/setup?step=maps");
  await expect(page.getByTestId("maps-step-nothing")).toContainText("Your map is set in .env");
  await expect(page.getByTestId("map-region-picker")).toHaveCount(0);
});

test("a map set in .env is shown but can't be changed here", async ({ dana: page }) => {
  await fakeMaps(page, state({ managed: "env", chosen: true, ready: true, regions: [{ id: "custom", name: "Your own map (set in .env)", state: "installed" }] }));
  const card = await openCard(page);
  await expect(card.getByTestId("maps-region-row-custom")).toContainText("Your own map");
  await expect(card.getByTestId("maps-regions-env")).toContainText(".env");
  await expect(card.getByTestId("maps-regions-add")).toHaveCount(0);
  await expect(card.getByRole("button", { name: /Remove/ })).toHaveCount(0);
});

test("with P Maps off the card isn't shown, and only admins can ask", async ({ dana: page, alice }) => {
  // The suite's stack has a stub map and no maps container.
  const real = await (await page.request.get("/api/maps/regions", { headers: { Authorization: await bearer(page) } })).json();
  test.skip(real.available === true, "this stack runs the real maps container");
  await page.goto("/admin?tab=settings");
  await ready(page);
  await expect(page.getByText("Live traffic", { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("maps-regions-card")).toHaveCount(0);

  const auth = { Authorization: await bearer(alice) };
  expect((await alice.request.get("/api/maps/regions", { headers: auth })).status()).toBe(403);
  expect((await alice.request.put("/api/maps/regions", { headers: auth, data: { ids: ["monaco"] } })).status()).toBe(403);
  expect((await alice.request.get("/api/maps/regions/catalog", { headers: auth })).status()).toBe(403);
});

test("the Maps screen says when no map has been chosen", async ({ dana: page, alice }) => {
  const config = { basemap: null, ready: false, building: false, step: null, failed: false, built_at: null, osm_data: null, attribution: "", traffic: false, bounds: null, unchosen: true };
  for (const p of [page, alice]) await p.route("**/api/maps/config", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(config) }));
  await page.goto("/maps");
  await expect(page.getByTestId("maps-not-chosen")).toContainText("No map chosen yet");
  await expect(page.getByTestId("maps-not-chosen").getByRole("link", { name: "Choose a map" })).toHaveAttribute("href", "/admin?tab=settings");
  await alice.goto("/maps");
  await expect(alice.getByTestId("maps-not-chosen")).toContainText("Ask them to pick one");
  await expect(alice.getByTestId("maps-not-chosen").getByRole("link")).toHaveCount(0);
});
