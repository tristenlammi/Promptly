import { chromium, type Browser, type Page } from "@playwright/test";

import { expect, ready, test } from "../fixtures";
import { storageStateFile } from "../lib/stack";
import { clip, fakeMic, say, type Pcm } from "../lib/talkSpeech";

/** Talk phase 2 (WP-T11, WP-T12) on a stack brought up with `--with voice
 *  --build-extras`: "Read me my day" on Today, and "send that to my phone"
 *  in a spoken conversation (the real Whisper and Kokoro, the e2e mock model:
 *  "dentist" adds an event, "phone" sends the latest thing). */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/today");
  await ready(page);
  return (await seen).headers()["authorization"];
}

let cachedAuth: string | null = null;
async function speech(page: Page, text: string): Promise<Pcm> {
  cachedAuth ??= await bearer(page);
  return say(page.request, cachedAuth, text);
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

const panel = (page: Page) => page.getByRole("complementary", { name: "Talk to Promptly" }).or(page.getByRole("dialog", { name: "Talk to Promptly" }));

test.describe("talk phase 2", () => {
  test.describe.configure({ mode: "serial" });

  test("Read me my day reads Today out loud, with captions", async ({ alice }) => {
    test.setTimeout(90_000);
    await alice.goto("/today");
    await ready(alice);
    const spoken = alice.waitForRequest((r) => r.url().includes("/api/voice/tts") && r.method() === "POST", { timeout: 30_000 });
    const briefing = alice.waitForResponse((r) => r.url().includes("/api/today/briefing"));
    await alice.getByRole("button", { name: "Read me my day" }).click();
    const body = await (await briefing).json();
    expect(body.script).toMatch(/That's it\.$/);
    const captions = alice.getByRole("region", { name: "Your day, read out" });
    await expect(captions).toBeVisible();
    await expect(captions).toContainText(/Good (morning|afternoon|evening)/);
    // It speaks what it shows.
    const tts = await spoken;
    expect(String(tts.postDataJSON()?.text ?? "")).toContain(body.script.split(".")[0]);
    await alice.screenshot({ path: test.info().outputPath("read-my-day.png") });
    await captions.getByRole("button", { name: "Close" }).click();
    await expect(captions).toHaveCount(0);
  });

  test("Account → Voice chooses what it reads", async ({ alice }) => {
    const auth = cachedAuth ?? (await bearer(alice));
    cachedAuth = auth;
    await alice.goto("/account");
    await ready(alice);
    const voiceTab = alice.getByRole("tab", { name: /Voice/ }).or(alice.getByRole("link", { name: /^Voice$/ })).first();
    if (await voiceTab.isVisible().catch(() => false)) await voiceTab.click();
    const mail = alice.getByRole("checkbox", { name: "How many unread emails" });
    await expect(mail).toBeVisible({ timeout: 15_000 });
    await mail.uncheck();
    await expect(mail).not.toBeChecked();
    await expect(mail).toBeEnabled();
    const r = await alice.request.get("/api/today/briefing", { headers: { Authorization: auth } });
    expect((await r.json()).sections.map((s: { key: string }) => s.key)).not.toContain("mail");
    await mail.check();
    await expect(mail).toBeChecked();
  });

  test("send that to my phone makes one notification", async ({ alice }) => {
    test.setTimeout(180_000);
    const auth = cachedAuth ?? (await bearer(alice));
    cachedAuth = auth;
    const before = await alice.request.get("/api/notifications/inbox?limit=100", { headers: { Authorization: auth } });
    const had = (await before.json()).items.filter((n: { category: string }) => n.category === "talk_followup").length;
    const wav = clip("send-to-phone", [
      2.0,
      await speech(alice, "Put the dentist in my calendar for next week."),
      12,
      await speech(alice, "Yes."),
      8,
      await speech(alice, "Send that to my phone."),
      25,
    ]);
    const { browser, page } = await talker(wav);
    try {
      await page.goto("/chat");
      await ready(page);
      await page.locator('button[aria-haspopup="listbox"]').first().click();
      await page.getByRole("option", { name: /E2E Mock Tools/ }).click();
      await page.getByRole("button", { name: "Talk to Promptly" }).first().click();
      await expect(panel(page)).toBeVisible();
      await expect
        .poll(
          async () => {
            const r = await page.request.get("/api/notifications/inbox?limit=100", { headers: { Authorization: auth } });
            return (await r.json()).items.filter((n: { category: string }) => n.category === "talk_followup");
          },
          { timeout: 120_000, intervals: [2000] },
        )
        .toHaveLength(had + 1);
      const r = await page.request.get("/api/notifications/inbox?limit=100", { headers: { Authorization: auth } });
      const row = (await r.json()).items.find((n: { category: string }) => n.category === "talk_followup");
      expect(row.title).toBe("From Talk");
      expect(row.url).toMatch(/^\/calendar\?event=/);
      await panel(page).getByRole("button", { name: /^End$/ }).click().catch(() => undefined);
    } finally {
      await browser.close();
    }
  });
});
