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
});
