import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";

/** P Maps offline areas on the web (maps-offline WP-M8): save the map's view
 *  with its size shown, see what each phone has of it, rename it, leave out
 *  house numbers, delete it; save a route's roads; on a phone-sized screen
 *  too, with no serious accessibility problems and nothing fetched from
 *  anywhere else. The stack's stub map has an offline index of a few squares
 *  around Dubbo, Sydney and Canberra (scripts/stack-render.py). */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

async function clearAreas(page: Page, auth: { Authorization: string }) {
  const got = await (await page.request.get("/api/maps/offline", { headers: auth })).json();
  for (const a of got.areas as { id: string }[]) await page.request.delete(`/api/maps/offline/areas/${a.id}`, { headers: auth });
}

/** The map around Dubbo, with a place's panel closed again, and no location
 *  (the browser has no fix). The stub map has no Photon, so the name comes from here. */
async function mapAtDubbo(page: Page) {
  await page.route("**/api/maps/reverse*", (r) =>
    r.fulfill({ json: { kind: "place", name: "Macquarie Street", address: "Dubbo NSW 2830", lat: -32.25, lon: 148.6 } }),
  );
  await page.goto("/maps?to=-32.25,148.6,Dubbo");
  await expect(page.getByRole("region", { name: "Map" }).locator("canvas")).toBeVisible({ timeout: 20_000 });
  // The link opens Dubbo's panel; back to the home panel.
  const dubbo = page.getByRole("heading", { name: "Dubbo", exact: true });
  await expect(dubbo).toBeVisible({ timeout: 10_000 });
  await dubbo.locator("xpath=../..").getByRole("button", { name: "Close", exact: true }).click();
}

async function scan(page: Page, what: string): Promise<string[]> {
  await page.mouse.move(0, 0);
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .include("[data-testid=offline-panel]")
    .analyze();
  const accent = (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent"))).trim().toLowerCase();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    // The accent buttons' contrast is the app's brand colour, tracked on its own.
    .map((v) => (v.id === "color-contrast" ? { ...v, nodes: v.nodes.filter((n) => !n.any.some((c) => c.message.includes(`background color: ${accent}`))) } : v))
    .filter((v) => v.nodes.length)
    .map((v) => `${what}: ${v.id} (${v.impact}) — ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test("save the map's view for offline, see it on a phone, rename it and delete it", async ({ bob: page }) => {
  test.setTimeout(120_000);
  const auth = { Authorization: await bearer(page) };
  await clearAreas(page, auth);
  const external: string[] = [];
  page.on("request", (r) => {
    const url = r.url();
    if (!url.startsWith(new URL(page.url()).origin) && !url.startsWith("data:") && !url.startsWith("blob:")) external.push(url);
  });

  await mapAtDubbo(page);
  await page.getByRole("button", { name: /Offline areas/ }).click();
  const panel = page.getByTestId("offline-panel");
  await expect(panel.getByRole("heading", { name: "Offline areas", exact: true })).toBeVisible();
  await expect(panel.getByText("No offline areas yet")).toBeVisible();

  // The size of what's on screen, before saving.
  const size = panel.getByTestId("offline-estimate");
  await expect(size).toHaveText(/About \d+ MB · \d+ squares?/, { timeout: 15_000 });
  // House numbers' share is shown, and leaving them out asks for the smaller size.
  await expect(panel.getByLabel("House numbers")).toBeChecked();
  await expect(panel.getByText(/\(\+\d+ (MB|KB)\)/)).toBeVisible();
  const without = page.waitForResponse((r) => r.url().includes("/api/maps/offline/estimate") && r.url().includes("addresses=false"));
  await panel.getByLabel("House numbers").uncheck();
  const est = await (await without).json();
  expect(est.bytes).toBeLessThan(est.bytes + est.addresses_bytes);
  expect(est.addresses_bytes).toBeGreaterThan(0);
  await expect(size).toHaveText(/About \d+ MB/);
  await panel.getByLabel("House numbers").check();
  await expect(panel.getByLabel("Name")).toHaveValue("Dubbo");
  const found = await scan(page, "offline panel");

  const name = `Dubbo ${stamp}`;
  await panel.getByLabel("Name").fill(name);
  await panel.getByRole("button", { name: "Save for offline" }).click();
  await expect(page.getByText(new RegExp(`Saved ${name} for offline \\(about \\d+ MB\\)\\. Your phone downloads it`))).toBeVisible();
  const row = panel.getByTestId("offline-area").filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row.getByText("Not on a phone yet")).toBeVisible();
  await expect(row.getByText(/Area · \d+ MB/)).toBeVisible();

  // A phone says it has it.
  const area = ((await (await page.request.get("/api/maps/offline", { headers: auth })).json()).areas as { id: string; name: string; cells: string[] }[]).find((a) => a.name === name)!;
  expect(area.cells).toContain("148_-33");
  const put = await page.request.put(`/api/maps/offline/areas/${area.id}/device`, {
    headers: auth,
    data: { device_id: "e2e-pixel", name: "Pixel 9", state: "ready", build: "stub", bytes: 21_000_000 },
  });
  expect(put.ok()).toBe(true);
  await page.request.put(`/api/maps/offline/areas/${area.id}/device`, {
    headers: auth,
    data: { device_id: "e2e-tablet", name: "Tab S9", state: "downloading", build: "stub", bytes: 5_000_000 },
  });
  await page.reload();
  await page.getByRole("button", { name: /Offline areas/ }).click();
  // With the day it said so, in the browser's own date style ("9 Nov", "Nov 9").
  await expect(row.getByText(/^Ready on Pixel 9 · \S+ \S+$/)).toBeVisible();
  await expect(row.getByText(/^Downloading on Tab S9 · \d+%/)).toBeVisible();

  // Rename it.
  const renamed = `Mudgee ${stamp}`;
  await row.getByRole("button", { name: `Rename ${name}` }).click();
  await panel.getByLabel(`New name for ${name}`).fill(renamed);
  await page.keyboard.press("Enter");
  const row2 = panel.getByTestId("offline-area").filter({ hasText: renamed });
  await expect(row2).toBeVisible();

  // Leave out house numbers.
  await row2.getByLabel(/House numbers/).uncheck();
  await expect.poll(async () => {
    const got = await (await page.request.get("/api/maps/offline", { headers: auth })).json();
    return (got.areas as { id: string; name: string; with_addresses: boolean }[]).find((a) => a.id === area.id);
  }).toMatchObject({ name: renamed, with_addresses: false });

  // Delete it.
  await row2.getByRole("button", { name: `Delete ${renamed}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(panel.getByText("No offline areas yet")).toBeVisible();
  expect((await (await page.request.get("/api/maps/offline", { headers: auth })).json()).areas).toEqual([]);

  expect(found, found.join("\n")).toEqual([]);
  expect(external, external.join("\n")).toEqual([]);
});

/** Polyline6, as the server sends a route's legs. */
function polyline6(points: [number, number][]): string {
  let out = "";
  let prev = [0, 0];
  for (const [lat, lon] of points) {
    const cur = [Math.round(lat * 1e6), Math.round(lon * 1e6)];
    for (const d of [cur[0] - prev[0], cur[1] - prev[1]]) {
      let v = d < 0 ? ~(d << 1) : d << 1;
      while (v >= 0x20) {
        out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
        v >>= 5;
      }
      out += String.fromCharCode(v + 63);
    }
    prev = cur;
  }
  return out;
}

test("a route's roads saved for offline, and the panel at phone width", async ({ bob: page }) => {
  test.setTimeout(120_000);
  const auth = { Authorization: await bearer(page) };
  await clearAreas(page, auth);
  // The stub map has no router: Dubbo to Orange, the way the server would send it.
  const shape = polyline6([[-32.25, 148.6], [-32.6, 148.9], [-33.0, 149.05], [-33.28, 149.1]]);
  await page.route("**/api/maps/route", (r) =>
    r.fulfill({
      json: {
        order: [0, 1],
        routes: [{ km: 150, seconds: 6600, toll: false, highway: false, ferry: false, via_name: "Mitchell Highway", legs: [{ shape, km: 150, seconds: 6600, steps: [] }] }],
      },
    }),
  );
  await page.goto("/maps?route=-32.25,148.6,Dubbo;-33.28,149.1,Orange");
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Save for offline" }).click();
  await expect(page.getByText(/Saved Dubbo to Orange for offline \(about \d+ MB\)/)).toBeVisible();
  const areas = (await (await page.request.get("/api/maps/offline", { headers: auth })).json()).areas as { kind: string; name: string; cells: string[]; shape: string }[];
  expect(areas).toHaveLength(1);
  expect(areas[0]).toMatchObject({ kind: "route", name: "Dubbo to Orange" });
  // Squares within 10 km of the road: Dubbo's and Orange's (the stub has no others there).
  expect(areas[0].cells).toEqual(expect.arrayContaining(["148_-33", "149_-34"]));

  // At phone width: the panel rises from the bottom, nothing runs off the side.
  await page.setViewportSize({ width: 390, height: 844 });
  await mapAtDubbo(page);
  await page.getByRole("button", { name: /Offline areas/ }).click();
  const panel = page.getByTestId("offline-panel");
  await expect(panel.getByTestId("offline-estimate")).toHaveText(/About \d+ MB/, { timeout: 15_000 });
  await expect(panel.getByTestId("offline-area").filter({ hasText: "Dubbo to Orange" })).toBeVisible();
  await expect(panel.getByTestId("offline-area").filter({ hasText: "Dubbo to Orange" }).getByText(/^Route · \d+ MB/)).toBeVisible();
  await panel.getByRole("button", { name: "Save for offline" }).scrollIntoViewIfNeeded();
  await expect(panel.getByRole("button", { name: "Save for offline" })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const found = await scan(page, "offline panel, phone");
  expect(found, found.join("\n")).toEqual([]);
  await clearAreas(page, auth);
});

test("admins see the offline packs' state and disk use", async ({ dana: page }) => {
  await page.goto("/admin?tab=settings");
  await ready(page);
  const card = page.getByTestId("maps-offline-status");
  await expect(card).toBeVisible({ timeout: 20_000 });
  // The stub map's index: nine squares.
  await expect(card).toContainText("Ready");
  await expect(card).toContainText("9 squares");
  await expect(card).toContainText(/\d+ MB for all of Australia/);
  await expect(card).toContainText(/saved by|No one has saved/);
});
