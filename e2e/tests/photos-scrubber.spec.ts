import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures";

/** The Photos date scrubber, on a made-up library shaped like a real one: lots
 *  of recent photos and a few old years, which used to pile up at the bottom. */

const months: { month: string; count: number }[] = [];
for (let y = 2026; y >= 2017; y--) {
  const recent = y >= 2023;
  for (let m = recent ? 12 : 3; m >= 1; m--) {
    months.push({ month: `${y}-${String(m).padStart(2, "0")}`, count: recent ? 120 : 2 });
  }
}

async function fakeLibrary(page: Page) {
  await page.route("**/api/photos/buckets*", (r) =>
    r.fulfill({ json: { buckets: months, total: months.reduce((a, b) => a + b.count, 0) } }),
  );
  await page.route("**/api/photos/timeline*", (r) => {
    const month = new URL(r.request().url()).searchParams.get("month") ?? "2026-12";
    const count = months.find((b) => b.month === month)?.count ?? 0;
    const items = Array.from({ length: count }, (_, i) => ({
      id: `${month}-${i}`,
      filename: `${i}.jpg`,
      mime: "image/jpeg",
      kind: "image",
      taken_at: `${month}-01T10:00:00Z`,
      taken_local: `${month}-${String((i % 27) + 1).padStart(2, "0")}T10:00:00`,
      width: 400,
      height: 300,
      duration_ms: null,
      thumbhash: null,
      live: false,
      favorite: false,
      archived: false,
      thumb: null,
      state: null,
      mine: true,
    }));
    return r.fulfill({ json: { items, next_cursor: null } });
  });
}

const scrollTop = (page: Page) => page.locator("[data-photos-scroller]").evaluate((el) => el.scrollTop);
const markerY = async (page: Page) => (await page.locator("[data-scrubber-marker]").boundingBox())!.y;

test("the date scrubber is readable, shows where you are, and follows a drag", async ({ alice: page }) => {
  await fakeLibrary(page);
  await page.goto("/photos");
  const rail = page.getByRole("slider", { name: "Jump to a date" });
  await expect(rail).toBeVisible();
  await expect(rail).toHaveAttribute("aria-valuetext", /December 2026/);
  const box = (await rail.boundingBox())!;

  // Every year labelled, and no two touching.
  const labels = rail.locator("span").filter({ hasText: /^20\d\d$/ });
  await expect(labels).toHaveCount(10);
  const ys = await labels.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
  for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(16);

  // The browser's own scrollbar isn't underneath it.
  const bar = await page.locator("[data-photos-scroller]").evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth);
  expect(bar).toBe(0);

  // Dragging moves the page and the marker with it, and shows the month.
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + box.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(x, box.y + box.height * 0.3, { steps: 3 });
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(1000);
  const first = await scrollTop(page);
  await page.mouse.move(x, box.y + box.height * 0.6, { steps: 8 });
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(first);
  expect(Math.abs((await markerY(page)) - (box.y + box.height * 0.6))).toBeLessThan(6);
  await expect(rail.locator("span.shadow")).toHaveText(/20\d\d/);
  await page.mouse.up();
  await page.mouse.move(box.x - 300, box.y + 100);

  // The marker follows ordinary scrolling, and the wheel works over the rail.
  const before = await markerY(page);
  await page.mouse.move(x, box.y + 40);
  const at = await scrollTop(page);
  await page.mouse.wheel(0, 3000);
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(at);
  await expect.poll(() => markerY(page)).toBeGreaterThan(before);

  // The oldest year is reachable, from the keyboard too.
  await rail.focus();
  await rail.press("End");
  await expect(rail).toHaveAttribute("aria-valuetext", /January 2017/);
  await rail.press("Home");
  await expect(rail).toHaveAttribute("aria-valuetext", /December 2026/);
  await expect.poll(() => scrollTop(page)).toBe(0);
});
