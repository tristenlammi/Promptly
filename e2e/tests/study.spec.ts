import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { readRun } from "../lib/stack";

/** Study: make a subject, take the quick check, learn a lesson with every
 *  kind of step the fake teacher writes, and see the course change when an
 *  answer shows a mix-up. The fake model (e2e/mock-llm) teaches tides; its
 *  right answers are fixed, so the flow is the same every run. */

const RIGHT = "The moon's gravity pulls the sea towards it";
const MIXUP = "The sea pushes the moon away";
const PAIRS: Record<string, string> = { Flood: "The water rising", Ebb: "The water falling", "Spring tide": "The biggest range", "Neap tide": "The smallest range" };

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

/** The teacher is the fake model for the length of a test. */
async function withTeacher(admin: Page, body: () => Promise<void>): Promise<void> {
  const auth = { Authorization: await bearer(admin) };
  const set = await admin.request.patch("/api/admin/app-settings", { headers: auth, data: { study_provider_id: readRun().provider_id, study_model_id: "e2e-mock-chat" } });
  expect(set.ok(), await set.text()).toBeTruthy();
  try {
    await body();
  } finally {
    await admin.request.patch("/api/admin/app-settings", { headers: auth, data: { study_provider_id: null, study_model_id: null } });
  }
}

async function newSubject(page: Page, title: string): Promise<void> {
  await page.goto("/study/new");
  await ready(page);
  await page.getByRole("textbox", { name: "What do you want to learn?" }).fill(title);
  await page.getByRole("radio", { name: /The big picture/ }).click();
  // The test stack has no search provider: teach from what the teacher knows.
  await page.getByRole("switch").uncheck();
  await page.getByTestId("study-build").click();
}

/** Put the rows of an order-the-steps list in order ("1. …" first) with the arrows. */
async function sortRows(page: Page): Promise<void> {
  for (let pass = 0; pass < 20; pass++) {
    const texts = await page.locator("ol > li").filter({ has: page.getByRole("button", { name: /^Move / }) }).locator(".study-md").allInnerTexts();
    const at = texts.findIndex((t, i) => i < texts.length - 1 && t.trim() > texts[i + 1].trim());
    if (at === -1) return;
    await page.getByRole("button", { name: /^Move .* down$/ }).nth(at).click();
  }
  throw new Error("the steps never came into order");
}

/** Answer the step on screen: well, or with the mix-up. Returns its kind. */
async function answer(page: Page, how: "well" | "mixup"): Promise<string> {
  const check = page.getByTestId("study-check");
  const step = page.locator('[data-testid="study-step"][data-status="pending"]');
  await expect(step).toBeVisible({ timeout: 30_000 });
  const id = await step.getAttribute("data-step");
  const kind = (await step.getAttribute("data-kind")) ?? "";
  if (kind === "explain") {
    await check.click();
    // Nothing to read afterwards: the next step (or the end) just arrives.
    await expect(page.locator(`[data-step="${id}"]`)).toHaveCount(0, { timeout: 30_000 });
    return kind;
  }
  if (kind === "teach_student") {
    await page.getByRole("textbox", { name: /Your explanation for/ }).fill(how === "well" ? "No Sam: the moon pulls the sea towards it." : "I am not sure, Sam.");
    await page.getByRole("button", { name: /Send to/ }).click();
    await expect(page.getByRole("log", { name: /Conversation with/ })).toContainText(how === "well" ? "I had it backwards" : "How can it not be pushing");
  } else if (kind === "explain_back" || kind === "scenario") {
    await page.getByRole("textbox", { name: "Your answer" }).fill(how === "well" ? "The moon's gravity pulls the sea, hardest on the near side." : "The sea pushes the moon away.");
  } else if (kind === "order_steps") {
    if (how === "well") await sortRows(page);
  } else if (kind === "match_pairs") {
    const names = Object.keys(PAIRS);
    for (const [i, left] of names.entries()) {
      await page.getByRole("button", { name: left, exact: true }).click();
      await page.getByRole("group", { name: "Goes with" }).getByRole("button", { name: how === "well" ? PAIRS[left] : PAIRS[names[(i + 1) % names.length]], exact: true }).click();
    }
  } else if (kind === "spot_error") {
    await page.getByRole("radio", { name: how === "well" ? /So the sea pushes the moon away and heaps up/ : /It pulls hardest on the side nearest/ }).click();
  } else {
    // mcq, predict and the blanks of a worked example: every group has the same choices.
    const groups = step.getByRole("radiogroup");
    const n = await groups.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) await groups.nth(i).getByRole("radio", { name: new RegExp(how === "well" ? RIGHT : MIXUP) }).click();
  }
  if (how === "mixup" && kind !== "teach_student") await page.getByRole("radio", { name: "Sure" }).click();
  await expect(check).toBeEnabled();
  await check.click();
  return kind;
}

test.describe("study", () => {
  test("make a subject, take the quick check, and learn a lesson", async ({ alice: page, dana }) => {
    test.setTimeout(300_000);
    await withTeacher(dana, async () => {
      const title = `How tides work ${stamp}`;
      await newSubject(page, title);

      // The build screen, then the offer to find out what you know.
      await expect(page.getByTestId("study-placement-offer")).toBeVisible({ timeout: 90_000 });
      await expect(page.getByTestId("study-placement-offer")).toContainText("7 ideas in 3 parts");
      await page.getByRole("button", { name: /Quick check/ }).click();

      // The check: a few questions, no feedback between them.
      for (let i = 0; i < 8; i++) {
        if (await page.getByTestId("study-placement-done").isVisible()) break;
        const check = page.getByTestId("study-check");
        if (await check.isVisible()) {
          const step = page.locator('[data-testid="study-step"][data-status="pending"]');
          const id = await step.getAttribute("data-step");
          await step.getByRole("radio", { name: new RegExp(RIGHT) }).click();
          await check.click();
          await expect(page.locator(`[data-step="${id}"]`)).toHaveCount(0, { timeout: 30_000 });
          await expect(page.getByTestId("study-feedback")).toHaveCount(0);
        } else {
          await page.waitForTimeout(300);
        }
      }
      await expect(page.getByTestId("study-placement-done")).toContainText(/already know \d+ of the 7 ideas/);
      await page.getByRole("button", { name: "See your map" }).click();

      // The map: every idea is a stop; what the check showed is marked as known.
      const map = page.getByTestId("study-map");
      await expect(map.getByTestId("study-stop")).toHaveCount(7);
      expect(await map.locator('[data-testid="study-stop"][data-band="known"]').count()).toBeGreaterThan(0);

      // A stop opens a sheet about the idea.
      await map.getByTestId("study-stop").last().click();
      const sheet = page.getByRole("dialog", { name: "Neap tides" });
      await expect(sheet).toContainText("By the end you");
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);

      // The lesson: answer everything well until it ends.
      await page.getByTestId("study-continue-course").click();
      await expect(page.getByTestId("study-rail")).toBeVisible({ timeout: 30_000 });
      const kinds = new Set<string>();
      let asked = false;
      for (let i = 0; i < 16; i++) {
        await expect(page.getByTestId("study-check").or(page.getByTestId("study-lesson-done"))).toBeVisible({ timeout: 30_000 });
        if (await page.getByTestId("study-lesson-done").isVisible()) break;
        const kind = await answer(page, "well");
        kinds.add(kind);
        if (kind === "explain") continue;
        await expect(page.getByTestId("study-feedback")).toHaveAttribute("data-outcome", "correct", { timeout: 30_000 });
        if (!asked) {
          // Ask the teacher, about this step.
          asked = true;
          await page.getByRole("button", { name: /Ask/ }).first().click();
          await page.getByRole("button", { name: "Say it more simply" }).click();
          await expect(page.getByRole("log", { name: "Your questions to the teacher" })).toContainText("Put simply");
          await page.keyboard.press("Escape");
        }
        await page.getByTestId("study-continue").click();
      }
      const done = page.getByTestId("study-lesson-done");
      await expect(done).toBeVisible({ timeout: 30_000 });
      await expect(done).toContainText("Learned");
      expect(kinds.size).toBeGreaterThan(2);

      // Back on the map, more is learned than before, and Today knows the subject.
      await done.getByRole("button", { name: "Back to the map" }).click();
      await expect(page.getByTestId("study-map")).toBeVisible();
      await expect(page.locator('[data-testid="study-stop"][data-band="mastered"]').first()).toBeVisible();
      await page.goto("/study");
      await expect(page.getByTestId("study-subject-card").filter({ hasText: title })).toBeVisible();
    });
  });

  test("a mix-up adds an idea to the map and says why; a build that fails can be retried", async ({ bob: page, dana }) => {
    test.setTimeout(240_000);
    await withTeacher(dana, async () => {
      await newSubject(page, `Tides again ${stamp}`);
      await expect(page.getByTestId("study-placement-offer")).toBeVisible({ timeout: 90_000 });
      await page.getByRole("button", { name: /I'm new to this/ }).click();
      await expect(page.getByTestId("study-map").getByTestId("study-stop")).toHaveCount(7);
      await page.getByTestId("study-continue-course").click();

      // Wrong in the same way, and sure of it: the course grows.
      const added = page.locator('[data-change="gap_added"]');
      for (let i = 0; i < 10 && !(await added.count()); i++) {
        await expect(page.getByTestId("study-check")).toBeVisible({ timeout: 30_000 });
        const kind = await answer(page, "mixup");
        if (kind === "explain") continue;
        await expect(page.getByTestId("study-feedback")).toBeVisible({ timeout: 30_000 });
        if (await added.count()) break;
        await page.getByTestId("study-continue").click();
      }
      await expect(added).toContainText("Added to your map: Which way gravity pulls");
      await expect(added).toContainText("we'll sort out which way gravity pulls first");

      // On the map it is marked as added, with the reason in its sheet.
      await page.getByRole("button", { name: /Leave and go back to the map/ }).click();
      const stop = page.locator('[data-testid="study-stop"][data-gap]');
      await expect(stop).toHaveCount(1);
      await expect(page.getByTestId("study-map").getByTestId("study-stop")).toHaveCount(8);
      await stop.click();
      await expect(page.getByTestId("study-concept-sheet")).toContainText("Added for you");
      await expect(page.getByTestId("study-concept-sheet")).toContainText("sort out which way gravity pulls");
      await page.keyboard.press("Escape");

      // A build the model can't manage ends on a clear screen with a way forward.
      await newSubject(page, `Tides failcheck ${stamp}`);
      await expect(page.getByTestId("study-failed")).toBeVisible({ timeout: 90_000 });
      await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
      page.once("dialog", (d) => void d.accept());
      await page.getByRole("button", { name: "Delete" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
      await expect(page).toHaveURL(/\/study$/);
    });
  });
});
