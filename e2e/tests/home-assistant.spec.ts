// The home, through the assistant, in the real pages against a stand-in box
// (lib/fakeBox.ts). Typed in a chat: the model's home_control call reaches the
// box and shows as a tool card; it won't touch a lock. Spoken (Talk, a stack
// with `--with voice`): a plain "turn off the kitchen lights" is done from
// the home's own names and never reaches the model; "make the lounge cosy"
// does, and gets the home tools.
//
// Home is off by default: the spec turns it on, and puts everything back.
import { chromium, type APIResponse, type Browser, type Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { FakeBox, readSetup } from "../lib/fakeBox";
import { BASE_URL, lastModelRequest, storageStateFile } from "../lib/stack";
import { clip, fakeMic, say } from "../lib/talkSpeech";

test.describe.configure({ mode: "serial" });

const shots = process.env.E2E_SHOTS_DIR;
const composer = (page: Page) => page.getByPlaceholder(/^Message Promptly/);
const lastReply = (page: Page) => page.locator(".promptly-message:not(.flex-row-reverse)").last();
const panel = (page: Page) => page.getByRole("complementary", { name: "Talk to Promptly" }).or(page.getByRole("dialog", { name: "Talk to Promptly" }));

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  return (await seen).headers()["authorization"];
}
const call = (page: Page, auth: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, data?: unknown): Promise<APIResponse> =>
  page.request.fetch(`/api${url}`, { method, headers: { Authorization: auth }, data });

async function ask(page: Page, text: string): Promise<void> {
  await page.route("**/api/chat/conversations/*/messages", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue({ postData: JSON.stringify({ ...body, tools_enabled: true }) });
  });
  await page.goto("/chat");
  await ready(page);
  await page.locator('button[aria-haspopup="listbox"]').first().click();
  await page.getByRole("option", { name: /E2E Mock Tools/ }).click();
  await composer(page).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

async function talker(wav: string, viewport: { width: number; height: number }): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({ args: fakeMic(wav) });
  const context = await browser.newContext({ storageState: storageStateFile("alice"), viewport, permissions: ["microphone"] });
  await context.route("**/version.json*", (r) => r.abort());
  return { browser, page: await context.newPage() };
}

async function startTalk(page: Page): Promise<void> {
  // Phone width: the sidebar (and its New chat button) is tucked away.
  await page.goto("/chat");
  await expect(page.getByText("Loading Promptly...")).toHaveCount(0, { timeout: 20_000 });
  await page.getByRole("button", { name: "Talk to Promptly" }).first().click();
  await expect(panel(page)).toBeVisible();
}

test("the assistant switches your home: typed, and spoken without the model for a plain command", async ({ alice, bob, dana }) => {
  test.setTimeout(300_000);
  const [aAuth, bAuth, dAuth] = [await bearer(alice), await bearer(bob), await bearer(dana)];
  const before = await (await call(dana, dAuth, "GET", "/admin/home/settings")).json();
  expect((await call(dana, dAuth, "PATCH", "/admin/home/settings", { enabled: true })).ok()).toBe(true);

  let box: FakeBox | null = null;
  const tidy = async () => {
    const boxes = ((await (await call(dana, dAuth, "GET", "/admin/home/boxes")).json()).boxes ?? []) as { id: string; label?: string }[];
    const ours = new Set(boxes.filter((b) => (b.label ?? "").startsWith("e2e-assistant ")).map((b) => b.id));
    const homes = ((await (await call(alice, aAuth, "GET", "/home")).json()).homes ?? []) as { id: string; boxes: { id: string }[] }[];
    for (const h of homes) {
      for (const b of h.boxes ?? []) if (ours.has(b.id)) await call(alice, aAuth, "DELETE", `/home/${h.id}/boxes/${b.id}`);
    }
    for (const id of ours) await call(dana, dAuth, "DELETE", `/admin/home/boxes/${id}`);
  };
  const asked = (op: string) => box!.asked.filter((q) => q.op === op).map((q) => q.args);
  try {
    await tidy();
    const made = await call(dana, dAuth, "POST", "/admin/home/boxes", { label: `e2e-assistant ${stamp}`, server_url: BASE_URL });
    expect(made.ok(), await made.text()).toBe(true);
    const prepared = await made.json();
    box = new FakeBox(
      readSetup(prepared.setup),
      [{ id: "lounge", name: "Lounge" }, { id: "kitchen", name: "Kitchen" }, { id: "hall", name: "Hall" }],
      [
        { id: "light.lamp", domain: "light", name: "Floor lamp", state: "on", area: "lounge" },
        { id: "light.lounge_ceiling", domain: "light", name: "Lounge ceiling", state: "on", area: "lounge" },
        { id: "light.bench", domain: "light", name: "Bench", state: "on", area: "kitchen" },
        { id: "media_player.kitchen", domain: "media_player", name: "Kitchen speaker", state: "playing", cls: "speaker", area: "kitchen", x: { vol: 30, title: "A song", artist: "A band", can: ["pause", "play", "next", "vol", "mute"] } },
        { id: "lock.front", domain: "lock", name: "Front door", state: "locked", area: "hall" },
      ],
    );
    await box.up();
    // Into the home alice already has from an earlier run, if she has one (a home can't be deleted yet).
    const have = ((await (await call(alice, aAuth, "GET", "/home")).json()).homes ?? []) as { id: string; role: string }[];
    const mine = have.find((h) => h.role === "owner");
    const claimed = await call(alice, aAuth, "POST", "/home/claim", mine ? { code: prepared.claim_code, home_id: mine.id } : { code: prepared.claim_code, home_name: "E2E home" });
    expect(claimed.ok(), await claimed.text()).toBe(true);
    await expect.poll(async () => JSON.stringify(await (await call(alice, aAuth, "GET", "/home")).json())).toContain("Floor lamp");

    // ---- typed: the model calls home_control, the box is asked, the card says what changed.
    await ask(alice, "make the lounge cosy");
    await expect(lastReply(alice)).toContainText("Tool said: Done: Lounge lights at 20% and warm white.", { timeout: 30_000 });
    expect(asked("do").map((a) => JSON.stringify(a)).sort()).toEqual(
      [
        { entity: "light.lamp", action: "set", value: { bri: 20, k: 2700 } },
        { entity: "light.lounge_ceiling", action: "set", value: { bri: 20, k: 2700 } },
      ].map((a) => JSON.stringify(a)).sort(),
    );
    await expect(alice.getByText(/changed 1 thing at home/i).first()).toBeVisible();
    await expect(alice.getByRole("button", { name: "Send message" })).toBeVisible();
    if (shots) await alice.screenshot({ path: `${shots}/home3-01-chat-cosy.png` });

    // It won't touch a lock: nothing is asked of the box, and it says where to go.
    const doneBefore = box.asked.length;
    await ask(alice, "unlock the front door");
    await expect(lastReply(alice)).toContainText("I don't open, unlock or disarm things", { timeout: 30_000 });
    await expect(alice.getByRole("button", { name: "Send message" })).toBeVisible();
    expect(box.asked.length).toBe(doneBefore);
    if (shots) await alice.screenshot({ path: `${shots}/home3-02-chat-lock-refused.png` });

    // Someone outside the home is never offered the tools.
    await ask(bob, "make the lounge cosy");
    await expect(lastReply(bob)).toContainText(/Echo #?\d+/, { timeout: 30_000 });
    expect(box.asked.length).toBe(doneBefore);
    void bAuth;

    // ---- spoken (needs the stack's own speech).
    const voice = await call(alice, aAuth, "GET", "/talk/config");
    test.skip(!voice.ok() || !(await voice.json()).enabled, "this stack has no live speech (bring it up --with voice)");

    const modelBefore = JSON.stringify(lastModelRequest());
    const wav = clip("home-kitchen-off", [2.0, await say(alice.request, aAuth, "Turn off the kitchen lights."), 8]);
    const first = await talker(wav, { width: 390, height: 844 });
    try {
      await startTalk(first.page);
      await expect(panel(first.page).locator('[data-caption="you"]').first()).toContainText(/kitchen lights/i, { timeout: 40_000 });
      await expect(panel(first.page).locator('[data-caption="reply"]').first()).toContainText("Kitchen lights off.", { timeout: 30_000 });
      await expect.poll(() => asked("room.lights")).toEqual([{ area: "kitchen", action: "turn_off" }]);
      // The model was never asked about it.
      expect(JSON.stringify(lastModelRequest())).toBe(modelBefore);
      await expect(panel(first.page)).toHaveAttribute("data-talk-state", "listening", { timeout: 30_000 });
      if (shots) await first.page.screenshot({ path: `${shots}/home3-03-phone-kitchen-lights-off.png` });
      await panel(first.page).getByRole("button", { name: /^End$/ }).click();
      await expect(panel(first.page)).toHaveCount(0);
      if (shots) await first.page.screenshot({ path: `${shots}/home3-04-phone-chat-after.png` });
    } finally {
      await first.browser.close();
    }

    const wav2 = clip("home-pause", [2.0, await say(alice.request, aAuth, "Pause the music."), 8]);
    const second = await talker(wav2, { width: 390, height: 844 });
    try {
      await startTalk(second.page);
      await expect(panel(second.page).locator('[data-caption="reply"]').first()).toContainText("Paused on Kitchen speaker.", { timeout: 60_000 });
      await expect.poll(() => asked("do").at(-1)).toEqual({ entity: "media_player.kitchen", action: "pause", value: null });
      if (shots) await second.page.screenshot({ path: `${shots}/home3-05-phone-paused.png` });
      await panel(second.page).getByRole("button", { name: /^End$/ }).click();
    } finally {
      await second.browser.close();
    }
  } finally {
    box?.down();
    await tidy();
    await call(dana, dAuth, "PATCH", "/admin/home/settings", { enabled: !!before.enabled });
  }
});
