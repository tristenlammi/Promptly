// Calls WP-V1: an admin turns voice on in Admin → Calls, the checklist
// reflects reality, and Test calls proves a real connection to the stack's
// LiveKit from the browser, playing you back through it. Needs the calls
// service in the stack under test (scripts/stack.sh up <name> --with calls);
// without it these tests are skipped, not failed.
import { execFileSync } from "node:child_process";

import { expect, ready, test } from "../fixtures";
import { BACKEND } from "../lib/stack";

// A fake microphone and camera, and no permission prompt, in the installed
// Google Chrome: Playwright's default headless shell never gets a media path
// to the test stack's LiveKit (checked: Chrome connects, the shell's ICE
// times out), and Chrome is what people use.
test.use({
  channel: "chrome",
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
});

/** Sets voice on or off for the whole server straight in the database
 *  (cleanup between tests; the admin test turns it on through the UI), and
 *  clears the calls service's remembered test results. */
function voice(on: boolean): void {
  const script = `
import asyncio
import app.db_models  # noqa: F401  (every table, for the relationships)
from app.database import SessionLocal
from app.app_settings.models import AppSettings, SINGLETON_APP_SETTINGS_ID
from app.redis_client import redis
async def main():
    async with SessionLocal() as db:
        row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
        row.calls_enabled = ${on ? "True" : "False"}
        row.calls_group_ids = None
        await db.commit()
    for k in await redis.keys("calls:test:*"):
        await redis.delete(k)
    await redis.aclose()
asyncio.run(main())
`;
  execFileSync("docker", ["exec", "-i", BACKEND, "python", "-"], { input: script, encoding: "utf8" });
}

function livekitRunning(): boolean {
  try {
    const out = execFileSync(
      "docker",
      ["exec", BACKEND, "python", "-c", "import socket; socket.getaddrinfo('livekit', 7880); print('yes')"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.includes("yes");
  } catch {
    return false;
  }
}

test.describe("calls: admin and test calls", () => {
  test.beforeAll(() => {
    test.skip(!livekitRunning(), "this stack has no calls service (--with calls)");
    voice(false);
  });
  test.afterAll(() => {
    try {
      voice(false);
    } catch {
      /* the stack went away */
    }
  });

  /** An admin card (SettingsCard), found by its heading. */
  const card = (page: import("@playwright/test").Page, title: string) =>
    page.locator("section", { has: page.getByRole("heading", { name: title, exact: true }) });

  test("an admin turns voice on, tests a call, and the checklist shows it", async ({ dana: page }) => {
    await page.goto("/admin?tab=calls");
    await ready(page);
    const settings = card(page, "Voice channels");
    const checklist = card(page, "Set-up checklist");
    await expect(checklist.getByText("The calls service is answering.")).toBeVisible({ timeout: 30_000 });
    await expect(checklist.getByText("The calls service accepts this server's key.")).toBeVisible();
    await expect(checklist.getByText("Not tested from outside yet.")).toBeVisible();

    const on = settings.getByRole("checkbox", { name: /Voice is on/ });
    await expect(on).not.toBeChecked();
    await on.click();
    await expect(on).toBeChecked();
    await page.reload();
    await ready(page);
    await expect(card(page, "Voice channels").getByRole("checkbox", { name: /Voice is on/ })).toBeChecked();
    await expect(card(page, "Live usage").getByText("In voice now")).toBeVisible();

    // Test calls, from Account → Voice & video.
    await page.goto("/account/voice");
    await ready(page);
    const tc = page.getByRole("region", { name: "Test calls" });
    await expect(tc).toBeVisible();
    await tc.getByRole("button", { name: "Check my microphone" }).click();
    await expect(tc.getByRole("meter", { name: "Microphone level" })).toBeVisible();
    await expect(tc.getByLabel("Microphone", { exact: true })).toContainText("Fake");

    await tc.getByRole("button", { name: "Start test" }).click();
    const result = tc.getByRole("status").filter({ hasText: /Direct \(best\)|Fallback over TCP|Through a relay/ });
    await expect(result).toBeVisible({ timeout: 45_000 });
    await expect(result).toContainText("On your home network");
    await expect(result).toContainText(/Round trip \d+ ms/);
    await tc.getByRole("button", { name: "Stop" }).click();
    await expect(tc.getByRole("button", { name: "Test again" })).toBeVisible();

    // Back in Admin → Calls: LiveKit's webhooks arrived, and the test from
    // home is mentioned under "outside".
    await page.goto("/admin?tab=calls");
    await ready(page);
    const after = card(page, "Set-up checklist");
    await expect(after.getByText(/^Last message /)).toBeVisible({ timeout: 30_000 });
    await expect(after.getByText(/At home: (direct connection|fallback over TCP)/)).toBeVisible();
  });

  test("with voice off, people don't see Test calls", async ({ bob: page }) => {
    voice(false);
    await page.goto("/account/voice");
    await ready(page);
    await expect(page.locator("#section-voice")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Voice", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Test calls" })).toHaveCount(0);
  });
});
