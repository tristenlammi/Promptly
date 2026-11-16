import type { Page } from "@playwright/test";

import { expect, ready, test } from "../fixtures";

/** The Workout logger on a phone: the set-type chip, holding − / + to keep
 *  stepping, a second Finish under the last exercise, and the rest countdown
 *  over the whole screen. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("logging a set on a phone: type chip, hold to step, Finish at the bottom, full-screen rest", async ({ alice: page }) => {
  test.setTimeout(120_000);
  const headers = { Authorization: await bearer(page) };
  await page.request.post("/api/items/store/workout", { headers });
  const made = await page.request.post("/api/items", { headers, data: { kind: "workout" } });
  expect(made.ok()).toBe(true);
  const fileId = (await made.json()).file_id as string;
  try {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`/apps/workout/${fileId}`);
    // A new Workout app opens on its four set-up questions; one left by a run that
    // was cut short opens on its live workout.
    const skip = page.getByRole("button", { name: "Skip", exact: true });
    const empty = page.getByRole("button", { name: "Empty workout" });
    const live = page.getByText("Live workout");
    await expect(skip.or(empty).or(live).first()).toBeVisible({ timeout: 30_000 });
    if (await skip.isVisible()) await skip.click();
    await expect(empty.or(live).first()).toBeVisible();
    if (!(await live.isVisible())) {
      await empty.click();
      await page.getByRole("button", { name: "Add exercises" }).click();
      await page.getByRole("listbox", { name: "Exercises" }).getByRole("option").first().click();
      await page.getByRole("button", { name: "Add 1 exercise" }).click();
    }
    // With no plan behind it, an exercise starts with no sets.
    await page.getByRole("button", { name: "Add set" }).click();
    await page.getByRole("button", { name: "Add set" }).click();

    // No Finish at the bottom while a set is still open.
    const bottomFinish = page.getByTestId("workout-finish-bottom");
    await expect(bottomFinish).toHaveCount(0);

    // Open the first set's editor.
    const firstSet = page.getByRole("group", { name: /^Set 1/ }).first();
    await firstSet.click();
    const chip = page.getByTestId("set-type-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAccessibleName(/Set type: Working/);

    // The four types stay folded away until the chip is tapped; picking one folds them again.
    const types = page.getByRole("radiogroup", { name: "Set type" });
    await expect(types).toHaveCount(0);
    await chip.click();
    await types.getByRole("radio", { name: "To failure" }).click();
    await expect(types).toHaveCount(0);
    await expect(chip).toHaveAccessibleName(/Set type: To failure/);
    await chip.click();
    await types.getByRole("radio", { name: "Working" }).click();

    // A tap on + is one step; holding it keeps stepping.
    const reps = page.locator('[data-set-input$="-big-reps"]');
    await expect(reps).toBeVisible();
    const more = page.getByRole("button", { name: /^More / }).last();
    // An empty box shows a dash, and + starts it from nothing.
    const value = async () => Number(await reps.inputValue()) || 0;
    const start = await value();
    await more.click();
    await expect.poll(value).toBe(start + 1);
    const box = (await more.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(1_300);
    await page.mouse.up();
    const held = await value();
    expect(held).toBeGreaterThanOrEqual(start + 4);
    // Letting go stops it, and the release isn't one more step.
    await page.waitForTimeout(400);
    expect(await value()).toBe(held);

    // Tick every set: the rest countdown starts, and Finish is offered at the bottom too.
    // (A set needs its reps before it can be ticked; Done moves on to the next open set.)
    for (let i = 0; i < 12; i++) {
      if (!(await page.getByRole("button", { name: /^Done — / }).count())) break;
      if (!(await more.isVisible())) await page.getByRole("group", { name: /^Set \d+$/ }).first().click();
      await more.click();
      await page.getByRole("button", { name: "Done", exact: true }).click();
    }
    await expect(bottomFinish).toBeVisible();

    const expand = page.getByTestId("rest-expand");
    if (await expand.count()) {
      await expand.click();
      const full = page.getByTestId("rest-full");
      await expect(full).toBeVisible();
      const size = (await full.boundingBox())!;
      expect(size.width).toBeGreaterThanOrEqual(389);
      expect(size.height).toBeGreaterThanOrEqual(799);
      await expect(full.getByRole("button", { name: "Skip rest" })).toBeVisible();
      await full.getByRole("button", { name: "15 seconds more rest" }).click();
      await full.getByRole("button", { name: "Back to the workout" }).first().click();
      await expect(full).toHaveCount(0);
      // Still counting, back in its bar.
      await expect(expand).toBeVisible();
    }

    await bottomFinish.click();
    await expect(page.getByRole("button", { name: /Finish & save/ })).toBeVisible();
  } finally {
    await page.request.delete("/api/items/store/workout", { headers });
  }
});
