import AxeBuilder from "@axe-core/playwright";
import { chromium, type Browser, type Page } from "@playwright/test";

import { expect, ready, test } from "../fixtures";
import { storageStateFile } from "../lib/stack";
import { clip, fakeMic, say, type Pcm } from "../lib/talkSpeech";

/** Talk (Voice Phase 3, WP-T4): a live spoken conversation in a chat, over
 *  /api/talk/ws, with the real Whisper (/live) and Kokoro of a stack brought
 *  up with `--with voice --build-extras`. The microphone is Chrome's fake
 *  device playing a WAV made by the stack's own TTS; the model is the e2e
 *  mock (spoken triggers: "long story", "dentist"). Each test has its own
 *  browser, because the fake microphone's file is a launch flag. */

const latencies: number[] = [];

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/chat");
  await ready(page);
  return (await seen).headers()["authorization"];
}

let cachedAuth: string | null = null;
async function speech(page: Page, text: string): Promise<Pcm> {
  cachedAuth ??= await bearer(page);
  return say(page.request, cachedAuth, text);
}

async function talker(
  wav: string,
  viewport = { width: 1366, height: 860 }
): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({ args: fakeMic(wav) });
  const context = await browser.newContext({
    storageState: storageStateFile("alice"),
    viewport,
    permissions: ["microphone"],
  });
  await context.route("**/version.json*", (r) => r.abort());
  const page = await context.newPage();
  return { browser, page };
}

const panel = (page: Page) => page.getByRole("complementary", { name: "Talk to Promptly" }).or(page.getByRole("dialog", { name: "Talk to Promptly" }));
const yourWords = (page: Page) => panel(page).locator('[data-caption="you"]');
const itsWords = (page: Page) => panel(page).locator('[data-caption="reply"]');

async function startTalk(page: Page, model?: RegExp): Promise<void> {
  await page.goto("/chat");
  await ready(page);
  if (model) {
    // The talk tools need a model that takes tools.
    await page.locator('button[aria-haspopup="listbox"]').first().click();
    await page.getByRole("option", { name: model }).click();
    await expect(page.locator('button[aria-haspopup="listbox"]').first()).toContainText(model);
  }
  await page.getByRole("button", { name: "Talk to Promptly" }).first().click();
  await expect(panel(page)).toBeVisible();
}

/** End the conversation before the browser goes: a socket that just drops
 *  is kept for 30 s to be resumed, and holds one of the server's two live
 *  slots meanwhile. */
async function endTalk(page: Page): Promise<void> {
  const end = panel(page).getByRole("button", { name: /^End$/ });
  if (await end.isVisible().catch(() => false)) {
    await end.click();
    await expect(panel(page)).toHaveCount(0);
  }
}

async function lastLatency(page: Page, count = 1): Promise<number> {
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { __promptlyTalk?: { latencies: number[] } }).__promptlyTalk?.latencies.length ?? 0), {
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(count);
  const all = await page.evaluate(() => (window as unknown as { __promptlyTalk: { latencies: number[] } }).__promptlyTalk.latencies);
  return all[all.length - 1];
}

async function conversation(page: Page): Promise<any> {
  const id = page.url().match(/\/chat\/([0-9a-f-]{36})/)?.[1];
  expect(id).toBeTruthy();
  const r = await page.request.get(`/api/chat/conversations/${id}`, { headers: { Authorization: cachedAuth! } });
  expect(r.ok()).toBe(true);
  return r.json();
}

test.describe("talk", () => {
  test.describe.configure({ mode: "serial" });

  test("ask a question out loud and hear the answer, with captions", async ({ alice }) => {
    test.setTimeout(120_000);
    const wav = clip("question", [2.0, await speech(alice, "What's on today?"), 8]);
    const { browser, page } = await talker(wav);
    try {
      await startTalk(page);
      // Your words, then its words as it says them.
      await expect(yourWords(page).first()).toContainText(/on today/i, { timeout: 30_000 });
      await expect(itsWords(page).first()).toContainText(/Echo #?\d+/, { timeout: 30_000 });
      const ms = await lastLatency(page);
      latencies.push(ms);
      test.info().annotations.push({ type: "latency", description: `question → first sound ${ms} ms` });
      console.log(`[talk] end of speech → first sound of the answer: ${ms} ms`);
      // A new chat was made for it, and the spoken turns are in it.
      await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}/);
      await expect(page.locator(".promptly-message").filter({ hasText: /on today/i }).first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Spoken", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
      const conv = await conversation(page);
      const said = conv.messages.filter((m: any) => m.voice?.spoken);
      expect(said.length).toBeGreaterThanOrEqual(2);
      await expect(panel(page)).toHaveAttribute("data-talk-state", "listening", { timeout: 30_000 });
      await page.screenshot({ path: test.info().outputPath("talk-desktop.png") });
      await panel(page).getByRole("button", { name: /^End$/ }).click();
      await expect(panel(page)).toHaveCount(0);
    } finally {
      await endTalk(page).catch(() => undefined);
      await browser.close();
    }
  });

  test("talking over the answer stops it, and the chat keeps what was heard", async ({ alice }) => {
    test.setTimeout(150_000);
    const wav = clip("interrupt", [
      2.0,
      await speech(alice, "Tell me a long story."),
      10,
      await speech(alice, "Okay, stop. That's enough."),
      6,
    ]);
    const { browser, page } = await talker(wav);
    try {
      await startTalk(page);
      await expect(itsWords(page).first()).toContainText(/lighthouse/i, { timeout: 30_000 });
      await expect(panel(page)).toHaveAttribute("data-talk-state", "speaking", { timeout: 20_000 });
      latencies.push(await lastLatency(page));
      // The barge-in: it stops, mid-story, and says so.
      await expect(panel(page).getByText("Interrupted", { exact: true })).toBeVisible({ timeout: 40_000 });
      await expect(panel(page)).toHaveAttribute("data-talk-state", "listening", { timeout: 10_000 });
      await page.screenshot({ path: test.info().outputPath("talk-interrupted.png") });
      // Saved cut back to what was heard, marked interrupted.
      await expect
        .poll(async () => {
          const conv = await conversation(page);
          const reply = [...conv.messages].reverse().find((m: any) => m.role === "assistant");
          return reply?.voice?.interrupted === true ? reply.content.length : 0;
        }, { timeout: 15_000 })
        .toBeGreaterThan(0);
      const conv = await conversation(page);
      const reply = [...conv.messages].reverse().find((m: any) => m.role === "assistant");
      expect(reply.content).not.toContain("never once let the lamp go out");
      // The chat shows it was cut off, and only what was heard.
      await expect(page.getByText("Spoken · interrupted")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/never once let the lamp go out/)).toHaveCount(0);
      // "Okay, stop" isn't a new question: nothing answered it.
      expect(conv.messages.filter((m: any) => m.role === "user")).toHaveLength(1);
    } finally {
      await endTalk(page).catch(() => undefined);
      await browser.close();
    }
  });

  test("a change asks first, and Yes runs it", async ({ alice }) => {
    test.setTimeout(150_000);
    const wav = clip("dentist", [2.0, await speech(alice, "Put the dentist in my calendar for next week."), 30]);
    const { browser, page } = await talker(wav);
    try {
      await startTalk(page, /E2E Mock Tools/);
      const ask = panel(page).getByRole("group", { name: "Waiting for a yes" });
      await expect(ask).toBeVisible({ timeout: 40_000 });
      await expect(ask).toContainText(/Dentist/);
      // Nothing has happened yet: the chat's card is waiting too.
      let conv = await conversation(page);
      const held = conv.messages.flatMap((m: any) => m.tool_calls ?? []).find((c: any) => c.name === "calendar_add_event");
      expect(held?.meta?.approval).toBe("pending");
      await page.screenshot({ path: test.info().outputPath("talk-ask.png") });
      await ask.getByRole("button", { name: "Yes" }).click();
      await expect(ask).toHaveCount(0);
      await expect
        .poll(async () => {
          conv = await conversation(page);
          return conv.messages.flatMap((m: any) => m.tool_calls ?? []).find((c: any) => c.name === "calendar_add_event")?.meta?.approval;
        }, { timeout: 20_000 })
        .toBe("approved");
      // And it says what it did.
      await expect(itsWords(page).last()).toContainText(/added|calendar/i, { timeout: 20_000 });
    } finally {
      await endTalk(page).catch(() => undefined);
      await browser.close();
    }
  });

  test("a reload in the middle of an answer picks the conversation up again", async ({ alice }) => {
    test.setTimeout(150_000);
    // Silent microphone: the question is typed (Type instead), so the
    // reload's fresh microphone doesn't ask it again.
    const wav = clip("silence", [60]);
    void alice;
    const { browser, page } = await talker(wav);
    try {
      await startTalk(page);
      await expect(panel(page)).toHaveAttribute("data-talk-state", "listening", { timeout: 20_000 });
      await panel(page).getByRole("button", { name: "Type instead" }).click();
      await panel(page).getByRole("textbox", { name: "Type instead" }).fill("Tell me a long story.");
      await panel(page).getByRole("button", { name: "Send" }).click();
      await expect(panel(page)).toHaveAttribute("data-talk-state", "speaking", { timeout: 30_000 });
      await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}/);
      const before = await conversation(page);

      await page.reload();
      await ready(page);
      // Back in the same conversation, still answering the same question.
      await expect(panel(page)).toBeVisible({ timeout: 20_000 });
      await expect(panel(page)).toHaveAttribute("data-talk-state", /speaking|thinking/, { timeout: 20_000 });
      await expect(itsWords(page).first()).toContainText(/lighthouse/i, { timeout: 20_000 });
      await expect(panel(page).getByText(/Say that again/)).toHaveCount(0);
      // Stop works on the resumed answer.
      await panel(page).getByRole("button", { name: "Stop", exact: true }).click();
      await expect(panel(page)).toHaveAttribute("data-talk-state", "listening", { timeout: 10_000 });
      const after = await conversation(page);
      expect(after.messages.filter((m: any) => m.role === "user")).toHaveLength(
        before.messages.filter((m: any) => m.role === "user").length
      );
    } finally {
      await endTalk(page).catch(() => undefined);
      await browser.close();
    }
  });

  test("on a phone it's full screen, and it passes an accessibility scan", async ({ alice }) => {
    test.setTimeout(120_000);
    void alice;
    const wav = clip("silence-phone", [40]);
    const { browser, page } = await talker(wav, { width: 390, height: 844 });
    try {
      await page.goto("/chat");
      await expect(page.getByText("Loading Promptly...")).toHaveCount(0, { timeout: 20_000 });
      await page.getByRole("button", { name: "Talk to Promptly" }).first().click();
      const dialog = page.getByRole("dialog", { name: "Talk to Promptly" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute("data-talk-state", "listening", { timeout: 20_000 });
      const box = await dialog.boundingBox();
      expect(box?.width).toBe(390);
      // Nothing wider than the screen.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await expect(dialog.getByRole("button", { name: "What's on today?" })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("talk-phone.png") });

      await page.mouse.move(0, 0);
      const { violations } = await new AxeBuilder({ page })
        .include('[role="dialog"][aria-label="Talk to Promptly"]')
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const accent = (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent"))).trim().toLowerCase();
      const bad = violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        // The accent buttons' contrast is the app's brand colour, tracked on its own.
        .map((v) => (v.id === "color-contrast" ? { ...v, nodes: v.nodes.filter((n) => !n.any.some((c) => c.message.includes(`background color: ${accent}`))) } : v))
        .filter((v) => v.nodes.length)
        .map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
      expect(bad).toEqual([]);

      // Esc ends it.
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
    } finally {
      await endTalk(page).catch(() => undefined);
      await browser.close();
    }
  });

  test.afterAll(() => {
    if (latencies.length) console.log(`[talk] latencies (ms): ${latencies.join(", ")}`);
  });
});
