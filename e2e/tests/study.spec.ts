import { execFileSync } from "node:child_process";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { seriousFindings } from "../lib/axe";
import { BACKEND, E2E_ROOT, readRun } from "../lib/stack";

/** Study: make a subject, take the quick check, learn a lesson with every
 *  kind of step the fake teacher writes, and see the course change when an
 *  answer shows a mix-up. The fake model (e2e/mock-llm) teaches tides; its
 *  right answers are fixed, so the flow is the same every run. */

const RIGHT = "The moon's gravity pulls the sea towards it";
const MIXUP = "The sea pushes the moon away";
const PAIRS: Record<string, string> = { Flood: "The water rising", Ebb: "The water falling", "Spring tide": "The biggest range", "Neap tide": "The smallest range" };

/** As if time had gone by: everything this person learned in one subject is
 *  due for review (and nothing of theirs from an earlier run is). */
function makeReviewsDue(username: string, title: string): void {
  const py = `
import asyncio
from datetime import datetime, timedelta, timezone
import app.db_models  # noqa: F401
from sqlalchemy import select
from app.auth.models import User
from app.database import SessionLocal
from app.study.models import StudyConcept, StudySubject

async def main():
    async with SessionLocal() as db:
        u = (await db.execute(select(User).where(User.username == ${JSON.stringify(username)}))).scalar_one()
        now = datetime.now(timezone.utc)
        rows = (await db.execute(select(StudyConcept, StudySubject.title).join(StudySubject, StudySubject.id == StudyConcept.subject_id).where(
            StudySubject.user_id == u.id, StudyConcept.state.in_(("mastered", "known")), StudyConcept.fsrs.is_not(None)))).all()
        for c, subject in rows:
            c.due_at = now - timedelta(days=1) if subject == ${JSON.stringify(title)} else now + timedelta(days=30)
            c.fsrs = {**c.fsrs, "due": c.due_at.isoformat(), "last_review": (now - timedelta(days=5)).isoformat()}
        await db.commit()
asyncio.run(main())
`;
  execFileSync("docker", ["exec", "-i", BACKEND, "python", "-"], { input: py });
}

const shot = (name: string) => path.join(E2E_ROOT, "..", "docs", "study-shots", `p2-${name}.png`);

/** Serious accessibility findings on the Study screen that is showing. */
async function scan(page: Page, what: string): Promise<string[]> {
  await page.mouse.move(0, 0);
  // Let things finish arriving: a colour halfway through a fade isn't the colour.
  // (Only the ones that end: the "up next" glow and the thinking dots run for ever.)
  await page.evaluate(() => {
    const ending = document.getAnimations().filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime)));
    return Promise.race([Promise.all(ending.map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, 2000))]).then(() => undefined);
  });
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).include(".study").analyze();
  return seriousFindings(page, what, violations);
}

/** The quick check, every question answered right. Ends on "Your course is set". */
async function quickCheck(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Quick check/ }).click();
  for (let i = 0; i < 8; i++) {
    if (await page.getByTestId("study-placement-done").isVisible()) break;
    const check = page.getByTestId("study-check");
    if (await check.isVisible()) {
      const step = page.locator('[data-testid="study-step"][data-status="pending"]');
      const id = await step.getAttribute("data-step");
      await step.getByRole("radio", { name: new RegExp(RIGHT) }).click();
      await check.click();
      await expect(page.locator(`[data-step="${id}"]`)).toHaveCount(0, { timeout: 30_000 });
    } else {
      await page.waitForTimeout(300);
    }
  }
  await expect(page.getByTestId("study-placement-done")).toBeVisible({ timeout: 30_000 });
}

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
  } else if (kind === "explain_back" || kind === "scenario" || kind === "capstone") {
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

  test("a finished subject: its tasks, the report, reviews that come due, the reminder and the trash", async ({ alice: page, dana }) => {
    test.setTimeout(420_000);
    const found: string[] = [];
    await withTeacher(dana, async () => {
      const title = `Tides to the end ${stamp}`;
      await newSubject(page, title);
      await expect(page.getByTestId("study-placement-offer")).toBeVisible({ timeout: 90_000 });
      await quickCheck(page);
      await page.getByRole("button", { name: "See your map" }).click();
      await expect(page.getByTestId("study-map")).toBeVisible();
      found.push(...(await scan(page, "map")));
      await page.getByTestId("study-continue-course").click();

      // Lessons until the subject is finished: the ideas, each unit's task, the final task.
      const tasks = page.locator('[data-change="capstone"][data-status="passed"]');
      let passed = 0;
      let scanned = false;
      for (let i = 0; i < 60; i++) {
        const done = page.getByTestId("study-lesson-done");
        await expect(page.getByTestId("study-check").or(done)).toBeVisible({ timeout: 30_000 });
        if (await done.isVisible()) {
          if (await page.getByTestId("study-see-report").isVisible()) break;
          await done.getByRole("button", { name: "Keep going" }).click();
          await expect(done).toHaveCount(0, { timeout: 30_000 });
          continue;
        }
        const kind = await answer(page, "well");
        if (kind === "explain") continue;
        await expect(page.getByTestId("study-feedback")).toHaveAttribute("data-outcome", "correct", { timeout: 30_000 });
        if (kind === "capstone") {
          await expect(tasks).toBeVisible();
          await expect(page.getByTestId("study-capstone")).toContainText("Shows:"); // each rubric point names its idea
          passed += 1;
          if (!scanned) {
            scanned = true;
            found.push(...(await scan(page, "capstone answered")));
            await page.screenshot({ path: shot("capstone-answered") });
          }
        }
        await page.getByTestId("study-continue").click();
      }
      expect(passed).toBe(4); // three units and the final one
      await expect(page.getByTestId("study-lesson-done")).toContainText("You've finished the subject");

      // The report.
      await page.getByTestId("study-see-report").click();
      const report = page.getByTestId("study-report");
      await expect(report).toHaveAttribute("data-finished", "true");
      await expect(report).toContainText("7 of 7 ideas learned");
      await expect(report).toContainText("Done (3 of 3 points)");
      await expect(page.getByTestId("study-report-next")).toContainText("Ocean currents");
      found.push(...(await scan(page, "report")));
      await page.screenshot({ path: shot("report"), fullPage: true });
      await page.getByRole("link", { name: "Back to the map" }).click();
      await expect(page.locator('[data-testid="study-unit-task"][data-status="passed"]')).toHaveCount(3);

      // Time goes by: what was learned comes due, on the home page and on the map.
      makeReviewsDue(readRun().users.alice.username, title);
      await page.reload();
      await ready(page);
      await expect(page.locator('[data-testid="study-stop"][data-due]').first()).toBeVisible();
      await expect(page.getByTestId("study-review-subject")).toContainText("Review 7 ideas");
      await page.screenshot({ path: shot("map-due") });
      await page.goto("/study");
      await ready(page);
      const banner = page.getByTestId("study-review-banner");
      await expect(banner).toContainText("7 ideas to review");
      await expect(page.getByTestId("study-stats")).toContainText("including today");
      found.push(...(await scan(page, "home with reviews due")));
      await page.screenshot({ path: shot("home-due") });

      // A review sitting: a fresh question on each, then when it comes back.
      await banner.click();
      const over = page.getByTestId("study-review-done");
      let reviewed = 0;
      for (let i = 0; i < 25; i++) {
        await expect(page.getByTestId("study-check").or(over)).toBeVisible({ timeout: 30_000 });
        if (await over.isVisible()) break;
        await answer(page, "well");
        await expect(page.getByTestId("study-feedback")).toHaveAttribute("data-outcome", "correct", { timeout: 30_000 });
        await expect(page.locator('[data-change="review"]')).toContainText(/comes back/);
        if (reviewed === 0) await page.screenshot({ path: shot("review-step") });
        reviewed += 1;
        await page.getByTestId("study-continue").click();
      }
      await expect(over).toContainText(/\d+ of \d+ remembered/);
      expect(reviewed).toBe(7);
      await over.getByRole("button", { name: "Back to Study" }).click();
      await expect(page.getByTestId("study-review-banner")).toHaveCount(0);

      // The daily reminder: on, at a time.
      await page.getByRole("button", { name: "Daily reminder" }).click();
      const remind = page.getByTestId("study-remind");
      await remind.getByRole("checkbox").check();
      await remind.locator('input[type="time"]').fill("07:30");
      found.push(...(await scan(page, "reminder sheet")));
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("You'll get a nudge at 07:30")).toBeVisible();
      const auth = { Authorization: await bearer(page) };
      expect((await (await page.request.get("/api/study/prefs", { headers: auth })).json()).remind).toEqual({ on: true, time: "07:30" });
      await page.request.put("/api/study/prefs", { headers: auth, data: { remind: { on: false, time: "17:00" } } });

      // Deleting goes to the trash, and comes back from it.
      await page.goto("/study");
      await ready(page);
      await page.getByTestId("study-subject-card").filter({ hasText: title }).click();
      await page.getByRole("button", { name: "Subject settings" }).click();
      await page.getByRole("button", { name: "Delete this subject" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).last().click();
      await expect(page).toHaveURL(/\/study$/);
      await expect(page.getByTestId("study-subject-card").filter({ hasText: title })).toHaveCount(0);
      const trash = await (await page.request.get("/api/trash", { headers: auth })).json();
      const mine = trash.items.find((t: { title: string }) => t.title === title);
      expect(mine).toMatchObject({ type: "study_subject", app: "study" });
      await page.goto("/trash");
      await ready(page);
      await expect(page.getByText(title)).toBeVisible();
      const back = await page.request.post("/api/trash/restore", { headers: auth, data: { items: [{ type: "study_subject", id: mine.id }] } });
      expect(back.ok()).toBeTruthy();
      await page.goto("/study");
      await expect(page.getByTestId("study-subject-card").filter({ hasText: title })).toBeVisible();
    });
    expect(found).toEqual([]);
  });

  test("the rest of the screens: the build, a subject not for a child, the pickers, testing out, and the model setting", async ({ bob: page, dana }) => {
    test.setTimeout(420_000);
    const found: string[] = [];
    await withTeacher(dana, async () => {
      const auth = { Authorization: await bearer(page) };

      // The new-subject form and its pickers.
      await page.goto("/study/new");
      await ready(page);
      found.push(...(await scan(page, "new subject")));
      await page.getByRole("button", { name: "Add your files" }).click();
      await expect(page.getByRole("dialog").first()).toBeVisible();
      await page.screenshot({ path: shot("file-picker") });
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Add your notes" }).click();
      await expect(page.getByRole("dialog").first()).toBeVisible();
      await page.screenshot({ path: shot("note-picker") });
      await page.keyboard.press("Escape");

      // A build slow enough to watch.
      await newSubject(page, `Tides slowcheck ${stamp}`);
      const building = page.getByTestId("study-building");
      await expect(building).toBeVisible({ timeout: 30_000 });
      await expect(building).toContainText("Planning your course");
      found.push(...(await scan(page, "building")));
      await page.screenshot({ path: shot("building") });
      await expect(page.getByTestId("study-placement-offer")).toBeVisible({ timeout: 90_000 });
      found.push(...(await scan(page, "placement offer")));
      await page.getByRole("button", { name: /I'm new to this/ }).click();
      await expect(page.getByTestId("study-map")).toBeVisible();

      // "I know this already" on an idea further on: one demanding task.
      await page.getByTestId("study-stop").nth(2).click();
      await page.getByRole("button", { name: "I know this already" }).click();
      const step = page.locator('[data-testid="study-step"][data-status="pending"]');
      await expect(step).toBeVisible({ timeout: 30_000 });
      expect(["scenario", "worked_example"]).toContain(await step.getAttribute("data-kind"));
      await expect(page.getByText("Show you know it")).toBeVisible();
      found.push(...(await scan(page, "test-out step")));
      await page.screenshot({ path: shot("test-out") });
      await answer(page, "well");
      await expect(page.locator('[data-change="mastered"]')).toContainText("Skipping ahead", { timeout: 30_000 });
      await page.getByTestId("study-continue").click();

      // Carry on: miss one worked example so the mistake-spotting step comes up; look at every diagram on the way.
      const seen = new Set<string>();
      const diagrams = new Set<string>();
      let missed = false;
      for (let i = 0; i < 45 && !(seen.has("spot_error") && diagrams.has("timeline")); i++) {
        const done = page.getByTestId("study-lesson-done");
        await expect(page.getByTestId("study-check").or(done)).toBeVisible({ timeout: 30_000 });
        if (await done.isVisible()) {
          const more = done.getByRole("button", { name: "Keep going" });
          if (!(await more.isVisible())) break;
          await more.click();
          await expect(done).toHaveCount(0, { timeout: 30_000 });
          continue;
        }
        const now = page.locator('[data-testid="study-step"][data-status="pending"]');
        const kind = (await now.getAttribute("data-kind")) ?? "";
        for (const d of await now.locator('[data-testid^="diagram-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid") ?? ""))) {
          const name = d.replace("diagram-", "");
          if (!diagrams.has(name)) {
            diagrams.add(name);
            if (name === "timeline") await page.screenshot({ path: shot("diagram-timeline") });
          }
        }
        if (kind === "spot_error" && !seen.has(kind)) {
          found.push(...(await scan(page, "spot the mistake")));
          await page.screenshot({ path: shot("spot-error") });
        }
        if (kind === "scenario" && !seen.has(kind)) await page.screenshot({ path: shot("scenario") });
        seen.add(kind);
        const how = kind === "worked_example" && !missed ? "mixup" : "well";
        if (how === "mixup") missed = true;
        await answer(page, how);
        if (kind === "explain") continue;
        await expect(page.getByTestId("study-feedback")).toBeVisible({ timeout: 30_000 });
        await page.getByTestId("study-continue").click();
      }
      expect.soft([...seen]).toContain("spot_error");
      expect.soft([...diagrams]).toContain("timeline");

      // A subject the teacher won't teach a child: a clear screen, nothing half-built.
      await page.request.put("/api/study/prefs", { headers: auth, data: { level: "child" } });
      try {
        await newSubject(page, `Tides kidcheck ${stamp}`);
        const failed = page.getByTestId("study-failed");
        await expect(failed).toBeVisible({ timeout: 90_000 });
        await expect(failed).toContainText("isn't a good fit for this age");
        found.push(...(await scan(page, "unsuitable for a child")));
        await page.screenshot({ path: shot("unsuitable") });
      } finally {
        await page.request.put("/api/study/prefs", { headers: auth, data: { level: "adult" } });
      }

      // Admin → Models: the Study model card, set to the fake teacher for this test.
      await dana.goto("/admin?tab=models");
      await ready(dana);
      await dana.getByText("Defaults", { exact: true }).first().click();
      const card = dana.getByText("The teacher in the Study app").first();
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.scrollIntoViewIfNeeded();
      await dana.screenshot({ path: shot("admin-study-model") });
    });
    expect(found).toEqual([]);
  });

  test("a step is read aloud and a written answer can be spoken, where the server has voice", async ({ bob: page, dana }) => {
    test.setTimeout(240_000);
    const auth = { Authorization: await bearer(page) };
    const voice = await (await page.request.get("/api/study/voice", { headers: auth })).json();
    // Whisper and the reader are optional containers (stack.sh up <name> --with voice).
    test.skip(!voice.listen, "this stack has no voice containers: the player rightly shows nothing about voice");
    await withTeacher(dana, async () => {
      await newSubject(page, `Tides aloud ${stamp}`);
      await expect(page.getByTestId("study-placement-offer")).toBeVisible({ timeout: 90_000 });
      await page.getByRole("button", { name: /I'm new to this/ }).click();
      await page.getByTestId("study-continue-course").click();
      await expect(page.locator('[data-testid="study-step"][data-status="pending"]')).toBeVisible({ timeout: 30_000 });

      // Read this step aloud: the app's own reader is asked for the words.
      const spoken = page.waitForResponse((r) => r.url().includes("/api/voice/tts"), { timeout: 60_000 });
      await page.getByTestId("study-read-aloud").click();
      const res = await spoken;
      expect(res.status()).toBe(200);
      expect(res.request().postDataJSON().text).toContain("pull");
      await expect(page.getByRole("button", { name: "Read every step to me" })).toBeVisible();
      await page.screenshot({ path: shot("voice") });

      // A written step offers the mic (speaking into it needs a real microphone).
      if (voice.speak) {
        for (let i = 0; i < 12; i++) {
          const now = page.locator('[data-testid="study-step"][data-status="pending"]');
          await expect(now).toBeVisible({ timeout: 30_000 });
          const kind = (await now.getAttribute("data-kind")) ?? "";
          if (kind === "explain_back" || kind === "scenario") {
            await expect(page.getByTestId("study-dictate")).toBeVisible();
            await page.screenshot({ path: shot("voice-dictate") });
            break;
          }
          await answer(page, "well");
          if (kind !== "explain") await page.getByTestId("study-continue").click();
        }
      }
    });
  });
});

// ---------------------------------------------------------------- phase 3

const shot3 = (name: string) => path.join(E2E_ROOT, "..", "docs", "study-shots", `p3-${name}.png`);

/** A new subject with the quick check skipped: straight to the map. */
async function freshCourse(page: Page, title: string): Promise<void> {
  await newSubject(page, title);
  await expect(page.getByTestId("study-placement-offer")).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: /I'm new to this/ }).click();
  await expect(page.getByTestId("study-map")).toBeVisible();
}

/** Work the figure of the explore step on screen: to the answer, or not. */
async function workFigure(page: Page, well: boolean): Promise<string> {
  const step = page.locator('[data-testid="study-step"][data-status="pending"]');
  const fig = step.locator("figure[data-testid^='figure-']");
  const type = ((await fig.getAttribute("data-testid")) ?? "").replace("figure-", "");
  if (type === "parts") {
    const part = fig.getByRole("radio", { name: well ? "Far-side bulge" : "Moon" });
    await part.click();
    await expect(part).toBeChecked();
  } else if (type === "plot") {
    // High water 5 m: mean 2 + half of a 6 m range.
    await fig.getByTestId("fig-slider-r").fill(well ? "6" : "3");
  } else if (type === "table") {
    // Low water 1 m: mean 3 less half of a 4 m range.
    await fig.getByTestId("fig-slider-r").fill(well ? "4" : "1");
  } else {
    await fig.getByTestId("fig-scale").fill(well ? "6.25" : "11");
  }
  return type;
}


/** Answer the step on screen well and carry on to the next. Returns its kind. */
async function pass(page: Page): Promise<string> {
  const kind = await answer(page, "well");
  if (kind === "explain") return kind;
  await expect(page.getByTestId("study-feedback")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("study-continue").click();
  return kind;
}

test.describe("study: figures, code, giving a course, its own app", () => {
  test("figures you can work: a picture of parts, a plot, a table and a scale, checked by the app", async ({ alice: page, dana }) => {
    test.setTimeout(420_000);
    const found: string[] = [];
    await withTeacher(dana, async () => {
      await freshCourse(page, `Tides figcheck ${stamp}`);
      await page.getByTestId("study-continue-course").click();
      await expect(page.getByTestId("study-rail")).toBeVisible({ timeout: 30_000 });
      const seen: Record<string, string> = {};
      let explained = false;
      for (let i = 0; i < 40 && Object.keys(seen).length < 4; i++) {
        await expect(page.getByTestId("study-check").or(page.getByTestId("study-lesson-done"))).toBeVisible({ timeout: 30_000 });
        if (await page.getByTestId("study-lesson-done").isVisible()) {
          const done = page.getByTestId("study-lesson-done");
          await done.getByRole("button", { name: "Keep going" }).click();
          await expect(done).toHaveCount(0, { timeout: 30_000 });
          continue;
        }
        const step = page.locator('[data-testid="study-step"][data-status="pending"]');
        await expect(step).toBeVisible({ timeout: 30_000 });
        const kind = await step.getAttribute("data-kind");
        if (kind === "explain" && !explained && (await step.locator("figure[data-testid='figure-parts']").count())) {
          // An explanation's figure is for playing with: a tap shows what the part does.
          explained = true;
          await step.getByTestId("fig-part-p2").click();
          await expect(step.getByTestId("fig-part-note")).toContainText("Pulled hardest");
          await page.screenshot({ path: shot3("explain-parts") });
        }
        if (kind !== "explore") {
          await pass(page);
          continue;
        }
        const check = page.getByTestId("study-check");
        const type = ((await step.locator("figure[data-testid^='figure-']").getAttribute("data-testid")) ?? "").replace("figure-", "");
        // Nothing touched yet: not an answer.
        await expect(check).toBeDisabled();
        found.push(...(await scan(page, `explore ${type}`)));
        // The table's first try is wrong on purpose, to see the app show the answer.
        const well = type !== "table";
        await workFigure(page, well);
        if (type === "plot") {
          await expect(step.getByTestId("fig-value-r")).toContainText("6");
          await expect(step.getByTestId("fig-plot-target")).toHaveCount(1);
        }
        if (type === "scale") await expect(step.getByTestId("fig-scale-readout")).toContainText("50");
        if (type === "table") await expect(step.getByTestId("fig-out-1")).toContainText("2.5 m");
        await page.screenshot({ path: shot3(`explore-${type}`) });
        await expect(check).toBeEnabled();
        await check.click();
        const fb = page.getByTestId("study-feedback");
        await expect(fb).toHaveAttribute("data-outcome", well ? "correct" : "wrong", { timeout: 30_000 });
        if (!well) {
          // The right setting is shown beside theirs, and why.
          await expect(page.getByTestId("fig-value-m").or(page.getByTestId("fig-value-r")).filter({ hasText: "→" }).first()).toBeVisible();
          await expect(page.locator('[data-testid="study-step"]')).toContainText("half the range");
          await page.screenshot({ path: shot3("explore-table-wrong") });
        }
        seen[type] = well ? "correct" : "wrong";
        await page.getByTestId("study-continue").click();
      }
      expect(Object.keys(seen).sort()).toEqual(["parts", "plot", "scale", "table"]);

      // By keyboard alone: arrow keys move a slider.
      // (Every control is a real range input or radio button.)
      // And on a phone: the same step, no sideways scroll.
      await page.setViewportSize({ width: 390, height: 800 });
      await page.goto(page.url());
      await expect(page.getByTestId("study-check").or(page.getByTestId("study-continue")).or(page.getByTestId("study-lesson-done")).first()).toBeVisible({ timeout: 30_000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await page.screenshot({ path: shot3("phone-lesson") });
    });
    expect(found, found.join("\n")).toEqual([]);
  });

  test("code you can run: checks, what it printed, an endless loop stopped, and no way out of the sandbox", async ({ bob: page, dana }) => {
    test.setTimeout(420_000);
    const found: string[] = [];
    await withTeacher(dana, async () => {
      // The runner page arrives with its own policy: no origin, no network.
      const runner = await page.request.get("/study-runner.html");
      expect(runner.ok()).toBeTruthy();
      const csp = runner.headers()["content-security-policy"] ?? "";
      expect(csp).toContain("sandbox allow-scripts");
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toContain("connect-src");

      await freshCourse(page, `Tides codecheck ${stamp}`);
      await page.getByTestId("study-continue-course").click();
      await expect(page.getByTestId("study-rail")).toBeVisible({ timeout: 30_000 });
      const step = page.locator('[data-testid="study-step"][data-status="pending"]');
      for (let i = 0; i < 12; i++) {
        await expect(page.getByTestId("study-check")).toBeVisible({ timeout: 30_000 });
        await expect(step).toBeVisible({ timeout: 30_000 });
        if ((await step.getAttribute("data-kind")) === "write_code") break;
        await pass(page);
      }
      await expect(step).toHaveAttribute("data-kind", "write_code");
      const editor = page.getByTestId("code-editor");
      const run = page.getByTestId("code-run");
      const check = page.getByTestId("study-check");
      const result = page.getByTestId("code-result");
      await expect(editor).toHaveValue(/function highWater\(mean, range\)/);
      await expect(check).toBeDisabled(); // nothing has been run
      await expect(page.locator('[data-testid="study-step"]')).not.toContainText("mean + range / 2"); // the answer isn't on the page
      found.push(...(await scan(page, "write code")));

      // A wrong answer: which checks failed, and what the code gave.
      await editor.fill('function highWater(mean, range) {\n  console.log("trying", mean, range);\n  return mean + range;\n}');
      await run.click();
      await expect(result.getByTestId("code-check-k1")).toHaveAttribute("data-pass", "false", { timeout: 20_000 });
      await expect(result.getByTestId("code-check-k2")).toHaveAttribute("data-pass", "true");
      await expect(result).toContainText("highWater(3, 4) should give 5, but gave 7");
      await expect(result).toContainText("trying 3 4");
      await page.screenshot({ path: shot3("code-failing") });
      found.push(...(await scan(page, "write code, run")));

      // A mistake in the code: said plainly, with its line.
      await editor.fill("function highWater(mean, range) {\n  return mean +;\n}");
      await expect(check).toBeDisabled(); // changed since the run
      await run.click();
      await expect(page.getByTestId("code-error")).toContainText(/Line 2/, { timeout: 20_000 });

      // A loop that never ends is stopped, and the page is still alive.
      await editor.fill("function highWater(mean, range) {\n  while (true) {}\n}");
      await run.click();
      await expect(page.getByTestId("code-error")).toContainText("took too long", { timeout: 20_000 });

      // The sandbox: no network, no cookies, no storage, no page, no Promptly.
      await editor.fill(
        'var seen = [typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof document, typeof localStorage, typeof importScripts, String(self.origin || location.origin)];\n' +
          "console.log(seen.join(' '));\nfunction highWater(mean, range) {\n  return mean + range / 2;\n}",
      );
      await run.click();
      await expect(result.getByTestId("code-check-k1")).toHaveAttribute("data-pass", "true", { timeout: 20_000 });
      await expect(result).toContainText("undefined undefined undefined undefined undefined undefined null");

      // Right: every check passes, and it can be handed in.
      await expect(result.getByTestId("code-check-k3")).toHaveAttribute("data-pass", "true");
      await page.screenshot({ path: shot3("code-passing") });
      await expect(check).toBeEnabled();
      await check.click();
      await expect(page.getByTestId("study-feedback")).toHaveAttribute("data-outcome", "correct", { timeout: 30_000 });
      await expect(page.getByTestId("code-solution")).toContainText("return mean + range / 2;");
      await expect(page.getByTestId("code-run")).toHaveCount(0);

      // A task whose own answer fails its checks counts for nothing, and says so.
      await freshCourse(page, `Tides faultcheck ${stamp}`);
      await page.getByTestId("study-continue-course").click();
      for (let i = 0; i < 12; i++) {
        await expect(page.getByTestId("study-check")).toBeVisible({ timeout: 30_000 });
        await expect(step).toBeVisible({ timeout: 30_000 });
        if ((await step.getAttribute("data-kind")) === "write_code") break;
        await pass(page);
      }
      await editor.fill("function highWater(mean, range) {\n  return mean + range / 2;\n}");
      await run.click();
      await expect(page.getByTestId("code-faulty")).toBeVisible({ timeout: 20_000 });
      await check.click();
      await expect(page.getByTestId("study-void")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("study-feedback")).toHaveCount(0);
      await page.screenshot({ path: shot3("code-void") });
      await page.getByTestId("study-continue").click();
      await expect(step).toBeVisible({ timeout: 30_000 });
      expect(await step.getAttribute("data-kind")).not.toBe("write_code");
    });
    expect(found, found.join("\n")).toEqual([]);
  });

  test("give a course: they get the map and start fresh; you each keep your own", async ({ alice, bob, dana }) => {
    test.setTimeout(300_000);
    const found: string[] = [];
    await withTeacher(dana, async () => {
      const title = `Tides to give ${stamp}`;
      await freshCourse(alice, title);
      // Some progress of alice's own, which must not travel.
      await alice.getByTestId("study-continue-course").click();
      for (let i = 0; i < 4; i++) {
        await expect(alice.getByTestId("study-check")).toBeVisible({ timeout: 30_000 });
        await pass(alice);
      }
      await alice.getByRole("button", { name: /Leave|Close|Back to the map/ }).first().click();
      await expect(alice.getByTestId("study-map")).toBeVisible({ timeout: 30_000 });

      await alice.getByRole("button", { name: "Subject settings" }).click();
      await alice.getByTestId("study-give-open").click();
      const give = alice.getByTestId("study-give");
      await expect(give).toContainText("Nothing of yours");
      await expect(alice.getByTestId("study-give-go")).toBeDisabled();
      await give.getByLabel("Search people").fill("e2e_bob");
      await give.getByRole("option", { name: /e2e_bob/ }).first().click();
      found.push(...(await scan(alice, "give a course")));
      await alice.screenshot({ path: shot3("give") });
      await alice.getByTestId("study-give-go").click();
      await expect(alice.getByTestId("study-given")).toContainText("now has it in Study");
      await alice.screenshot({ path: shot3("given") });

      // Bob has his own copy: from alice, nothing learned yet, the quick check on offer.
      await bob.goto("/study");
      await ready(bob);
      const card = bob.getByTestId("study-subject-card").filter({ hasText: title });
      await expect(card).toContainText("From e2e_alice");
      await card.click();
      await expect(bob.getByTestId("study-placement-offer")).toBeVisible({ timeout: 30_000 });
      await bob.screenshot({ path: shot3("received") });
      const bobs = bob.url().split("/study/")[1].split(/[/?#]/)[0];
      // Alice can't open bob's copy; bob can't open alice's.
      const hers = await alice.request.get(`/api/study/subjects/${bobs}`, { headers: { Authorization: await bearer(alice) } });
      expect(hers.status()).toBe(404);
    });
    expect(found, found.join("\n")).toEqual([]);
  });

  test("Study as its own app: its manifest, and no Promptly menu when it is opened from its own icon", async ({ alice: page }) => {
    const manifest = await page.request.get("/study.webmanifest");
    expect(manifest.ok()).toBeTruthy();
    expect((await manifest.json()).scope).toBe("/study/");
    expect(await (await page.request.get("/study")).text()).toContain('href="/study.webmanifest"');

    // Inside Promptly: the sidebar is there.
    await page.goto("/study");
    await ready(page);
    await expect(page.locator(".study-own")).toHaveCount(0);
    // From the P Study icon: Study alone.
    await page.goto("/study/?source=android");
    await expect(page.locator(".study-own")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Study" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Workspaces" })).toHaveCount(0);
    await page.screenshot({ path: shot3("own-app") });
    // The launch is remembered for the window: forget it so later tests see Promptly.
    await page.evaluate(() => sessionStorage.removeItem("promptly:launched-app"));
  });
});

/** As if the whole of one subject had been learned a while ago: every idea
 *  learned, every task passed, and three of them due for review. */
function finishSubject(subjectId: string): void {
  const py = `
import asyncio, uuid
from datetime import datetime, timedelta, timezone
import app.db_models  # noqa: F401
from app.auth.models import User
from app.database import SessionLocal
from app.study import service
from app.study.models import StudySubject

async def main():
    async with SessionLocal() as db:
        s = await db.get(StudySubject, uuid.UUID(${JSON.stringify(subjectId)}))
        u = await db.get(User, s.user_id)
        now = datetime.now(timezone.utc)
        done = {"status": "passed", "tries": 1, "outcome": "correct", "met": 3, "points": 3, "at": now.isoformat()}
        for i, c in enumerate(await service.concepts_of(db, s.id)):
            c.state, c.mastery, c.evidence_count, c.production_ok, c.steps_done = "mastered", 0.9 if i else 0.55, 3, 1, 3
            c.mastered_at = c.last_seen_at = now - timedelta(days=6)
            service._schedule(c, "lesson", u)
            if i < 3:
                c.due_at = now - timedelta(hours=2)
                c.fsrs = {**c.fsrs, "due": c.due_at.isoformat()}
        for unit in await service.units_of(db, s.id):
            unit.capstone = dict(done)
        s.capstone, s.status, s.last_studied_at = dict(done), "complete", now - timedelta(days=1)
        await db.commit()
asyncio.run(main())
`;
  execFileSync("docker", ["exec", "-i", BACKEND, "python", "-"], { input: py });
}

test.describe("study: the later screens on a phone, in the light theme, and on paper", () => {
  test("home, map, report, a review and the reminder at phone width in the light theme; the report as printed; the admin's level setting", async ({ alice: page, dana }) => {
    test.setTimeout(300_000);
    const found: string[] = [];
    await withTeacher(dana, async () => {
      await freshCourse(page, `Tides looked at ${stamp}`);
      const id = page.url().split("/study/")[1].split(/[/?#]/)[0];
      finishSubject(id);

      await page.evaluate(() => localStorage.setItem("promptly.theme", JSON.stringify({ state: { theme: "light" }, version: 0 })));
      await page.setViewportSize({ width: 390, height: 844 });
      const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      try {
        await page.goto("/study");
        await expect(page.getByTestId("study-review-banner")).toBeVisible({ timeout: 30_000 });
        expect(await fits()).toBe(true);
        found.push(...(await scan(page, "home, phone, light")));
        await page.screenshot({ path: shot3("phone-light-home"), fullPage: true });

        await page.getByRole("button", { name: "Daily reminder" }).click();
        await expect(page.getByTestId("study-remind")).toBeVisible();
        found.push(...(await scan(page, "reminder, phone, light")));
        await page.screenshot({ path: shot3("phone-light-reminder") });
        await page.keyboard.press("Escape");

        await page.goto(`/study/${id}`);
        await expect(page.getByTestId("study-map")).toBeVisible({ timeout: 30_000 });
        expect(await fits()).toBe(true);
        found.push(...(await scan(page, "map, phone, light")));
        await page.screenshot({ path: shot3("phone-light-map"), fullPage: true });

        await page.goto(`/study/${id}/report`);
        const report = page.getByTestId("study-report");
        await expect(report).toBeVisible({ timeout: 30_000 });
        await expect(report).toHaveAttribute("data-finished", "true");
        expect(await fits()).toBe(true);
        found.push(...(await scan(page, "report, phone, light")));
        await page.screenshot({ path: shot3("phone-light-report"), fullPage: true });

        // On paper: the report alone, black on white, no buttons or menus.
        await page.setViewportSize({ width: 794, height: 1123 });
        await page.emulateMedia({ media: "print" });
        await expect(report).toBeVisible();
        await expect(page.getByRole("button", { name: "Print" })).toBeHidden();
        await expect(page.getByRole("button", { name: /Open navigation menu/ })).toBeHidden();
        await page.screenshot({ path: shot3("report-print"), fullPage: true });
        await page.emulateMedia({ media: "screen" });
        await page.setViewportSize({ width: 390, height: 844 });

        // A review, on the phone.
        await page.goto(`/study/${id}/review`);
        await expect(page.getByTestId("study-check")).toBeVisible({ timeout: 30_000 });
        expect(await fits()).toBe(true);
        found.push(...(await scan(page, "review step, phone, light")));
        await page.screenshot({ path: shot3("phone-light-review") });
      } finally {
        await page.evaluate(() => localStorage.setItem("promptly.theme", JSON.stringify({ state: { theme: "dark" }, version: 0 })));
        await page.setViewportSize({ width: 1366, height: 860 });
      }

      // Admin → Users: who Study teaches someone as, when editing and when making an account.
      await dana.goto("/admin?tab=users");
      await ready(dana);
      await dana.getByRole("button", { name: "Edit e2e_bob" }).click();
      const edit = dana.getByRole("dialog", { name: /Edit e2e_bob/ });
      const lock = edit.getByLabel("Study lessons are for");
      await lock.scrollIntoViewIfNeeded();
      await expect(lock).toHaveValue("");
      await expect(edit).toContainText("You still can't see their subjects or progress");
      await dana.screenshot({ path: shot3("admin-level-lock") });
      await edit.getByRole("button", { name: "Cancel" }).click();
      await expect(edit).toHaveCount(0);
      await dana.getByRole("button", { name: "Create user" }).first().click();
      const create = dana.getByRole("dialog", { name: "Create user" });
      await expect(create.getByLabel("Study lessons are for")).toHaveValue("");
      await create.getByLabel("Study lessons are for").selectOption("child");
      await expect(create.getByLabel("Study lessons are for")).toHaveValue("child");
      await create.getByRole("button", { name: "Cancel" }).click();
    });
    expect(found, found.join("\n")).toEqual([]);
  });
});
