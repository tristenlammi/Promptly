import AxeBuilder from "@axe-core/playwright";
import { chromium, type Browser, type Page } from "@playwright/test";

import { expect, ready, test } from "../fixtures";
import { storageStateFile } from "../lib/stack";
import { clip, fakeMic, say } from "../lib/talkSpeech";

/** Admin → Talk (WP-T6): usage shows up after a spoken turn (timings only),
 *  switching Talk off hides the orb and every way in falls back to the
 *  tap-to-talk voice mode, and the page works at phone width (axe).
 *  Needs a stack with `--with voice --build-extras` (real Whisper /live and
 *  Kokoro); the model is the e2e mock. */

async function bearer(page: Page, path = "/chat"): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto(path);
  await ready(page);
  return (await seen).headers()["authorization"];
}

async function talker(wav: string): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({ args: fakeMic(wav) });
  const context = await browser.newContext({
    storageState: storageStateFile("alice"),
    viewport: { width: 1366, height: 860 },
    permissions: ["microphone"],
  });
  await context.route("**/version.json*", (r) => r.abort());
  return { browser, page: await context.newPage() };
}

const panel = (page: Page) =>
  page.getByRole("complementary", { name: "Talk to Promptly" }).or(page.getByRole("dialog", { name: "Talk to Promptly" }));

async function setTalk(page: Page, auth: string, body: Record<string, unknown>): Promise<void> {
  const r = await page.request.patch("/api/admin/talk", { headers: { Authorization: auth }, data: body });
  expect(r.ok(), await r.text()).toBe(true);
}

function seriousViolations(violations: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"], accent: string): string[] {
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    // The accent buttons' contrast is the app's brand colour, tracked on its own.
    .map((v) =>
      v.id === "color-contrast"
        ? { ...v, nodes: v.nodes.filter((n) => !n.any.some((c) => c.message.includes(`background color: ${accent}`))) }
        : v
    )
    .filter((v) => v.nodes.length)
    .map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test.describe("talk admin", () => {
  test.describe.configure({ mode: "serial" });

  test("Admin → Talk shows how fast it was after a spoken turn", async ({ alice, dana }) => {
    test.setTimeout(150_000);
    const aliceAuth = await bearer(alice);
    const danaAuth = await bearer(dana, "/admin");
    await setTalk(dana, danaAuth, { enabled: true, group_ids: [] });

    // Alice asks something out loud.
    const wav = clip("admin-question", [2.0, await say(alice.request, aliceAuth, "What's on today?"), 8]);
    const { browser, page } = await talker(wav);
    try {
      await page.goto("/chat");
      await ready(page);
      await page.getByRole("button", { name: "Talk to Promptly" }).first().click();
      await expect(panel(page)).toBeVisible();
      await expect(panel(page).locator('[data-caption="reply"]').first()).toContainText(/Echo #?\d+/, { timeout: 40_000 });
      await expect(panel(page)).toHaveAttribute("data-talk-state", "listening", { timeout: 30_000 });
      await panel(page).getByRole("button", { name: /^End$/ }).click();
      await expect(panel(page)).toHaveCount(0);
    } finally {
      await browser.close();
    }

    // Dana sees it on Admin → Talk: numbers, never words.
    await dana.goto("/admin?tab=talk");
    await expect(dana.getByRole("heading", { name: "Talk", exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(dana.getByRole("checkbox", { name: /Talk is on/ })).toBeChecked();
    await expect(dana.getByText(/Whisper\s+base\s+for Talk/)).toBeVisible();
    await expect(dana.getByText("Kokoro-82M")).toBeVisible();
    const usage = dana.getByTestId("talk-usage");
    await expect(usage).toBeVisible({ timeout: 20_000 });
    await expect(usage).toContainText(/\d+ spoken answers? in \d+ conversations? from \d+ (person|people)/);
    const firstSound = usage.locator('tr[data-step="first_audio"] td').first();
    await expect(firstSound).toHaveText(/^\d+(\.\d+)? (ms|s)$/);
    await expect(usage.locator('tr[data-step="transcript"] td').first()).toHaveText(/^\d+(\.\d+)? (ms|s)$/);
    await expect(usage).not.toContainText(/on today/i);
    await dana.screenshot({ path: test.info().outputPath("admin-talk.png"), fullPage: true });
    await usage.screenshot({ path: test.info().outputPath("admin-talk-speed.png") });

    // The API behind it has no words either.
    const body = await (await dana.request.get("/api/admin/talk/usage?days=1", { headers: { Authorization: danaAuth } })).text();
    expect(body).not.toMatch(/today/i);
    expect(JSON.parse(body).all.turns).toBeGreaterThan(0);
  });

  test("Talk off hides the orb, and every way in opens the tap-to-talk voice mode", async ({ alice, dana }) => {
    test.setTimeout(90_000);
    const danaAuth = await bearer(dana, "/admin");
    try {
      // Switched off on Admin → Talk.
      await dana.goto("/admin?tab=talk");
      const on = dana.getByRole("checkbox", { name: /Talk is on/ });
      await expect(on).toBeChecked({ timeout: 20_000 });
      await on.click();
      await expect(on).not.toBeChecked();
      await expect(dana.getByRole("radio", { name: "Everyone" })).toBeDisabled();

      await alice.goto("/chat");
      await ready(alice);
      await expect(alice.getByRole("textbox").first()).toBeVisible();
      await expect(alice.getByRole("button", { name: "Talk to Promptly" })).toHaveCount(0);
      // The + menu offers the simpler voice mode instead.
      await alice.getByRole("button", { name: "Add to message" }).first().click();
      await alice.getByRole("menuitem", { name: "Voice mode (tap to talk)" }).click();
      await expect(alice.getByRole("button", { name: "Close voice mode" })).toBeVisible();
      await expect(panel(alice)).toHaveCount(0);
      await alice.getByRole("button", { name: "Close voice mode" }).click();

      // Today, Ctrl+K and the shortcut land on /chat?talk=1: voice mode too.
      await alice.goto("/chat?talk=1");
      await ready(alice);
      await expect(alice.getByRole("button", { name: "Close voice mode" })).toBeVisible({ timeout: 15_000 });
      await expect(panel(alice)).toHaveCount(0);
      await alice.getByRole("button", { name: "Close voice mode" }).click();

      // On a phone there's no + menu: the empty send slot opens voice mode.
      await alice.setViewportSize({ width: 390, height: 844 });
      await alice.goto("/chat");
      await expect(alice.getByText("Loading Promptly...")).toHaveCount(0, { timeout: 20_000 });
      await expect(alice.getByRole("button", { name: "Talk to Promptly" })).toHaveCount(0);
      await alice.getByRole("button", { name: "Voice mode (tap to talk)" }).click();
      await expect(alice.getByRole("button", { name: "Close voice mode" })).toBeVisible();
      await alice.getByRole("button", { name: "Close voice mode" }).click();
      await alice.setViewportSize({ width: 1366, height: 860 });
    } finally {
      await setTalk(dana, danaAuth, { enabled: true });
    }
    // On again: the orb is back.
    await alice.goto("/chat");
    await ready(alice);
    await expect(alice.getByRole("button", { name: "Talk to Promptly" }).first()).toBeVisible({ timeout: 15_000 });
  });

  test("Admin → Talk at phone width, with an accessibility scan", async ({ dana }) => {
    test.setTimeout(60_000);
    await dana.setViewportSize({ width: 390, height: 844 });
    await dana.goto("/admin?tab=talk");
    await expect(dana.getByRole("heading", { name: "How fast it's been" })).toBeVisible({ timeout: 20_000 });
    await expect(dana.getByRole("spinbutton", { name: "People talking at once" })).toBeVisible();
    expect(await dana.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // Limiting to groups shows the groups (or how to make one).
    await dana.getByRole("radio", { name: "Only people in some groups" }).check();
    await expect(dana.getByText(/Tick at least one group|There are no groups yet/)).toBeVisible();
    await dana.getByRole("radio", { name: "Everyone" }).check();
    await dana.screenshot({ path: test.info().outputPath("admin-talk-phone.png"), fullPage: true });

    await dana.mouse.move(0, 0);
    const { violations } = await new AxeBuilder({ page: dana })
      .include('[role="tabpanel"], main')
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const accent = (await dana.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent"))).trim().toLowerCase();
    expect(seriousViolations(violations, accent)).toEqual([]);
  });
});
