// Home automations, in the real pages against a stand-in box (lib/fakeBox.ts).
// The home's owner makes "Movie time" in the flow editor on the Home page
// (a room's lights off, pause the speaker), gives it a phrase and runs it;
// a lock can't be picked as a step. A member sees it and runs it and can't
// change it. Typed in a chat, the model's home_automation call runs it;
// said out loud (a stack with `--with voice`), the exact phrase runs it and
// the model is never asked. And the old Automations page is now "AI tasks".
//
// Home is off by default: the spec turns it on, and puts everything back.
import { chromium, type APIResponse, type Browser, type Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { FakeBox, readSetup } from "../lib/fakeBox";
import { BASE_URL, lastModelRequest, readRun, storageStateFile } from "../lib/stack";
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
const call = (page: Page, auth: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, data?: unknown): Promise<APIResponse> =>
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

test("a home automation: made in the flow editor, run by its button, its phrase and the assistant", async ({ alice, bob, dana }) => {
  test.setTimeout(360_000);
  const [aAuth, bAuth, dAuth] = [await bearer(alice), await bearer(bob), await bearer(dana)];
  const before = await (await call(dana, dAuth, "GET", "/admin/home/settings")).json();
  expect((await call(dana, dAuth, "PATCH", "/admin/home/settings", { enabled: true })).ok()).toBe(true);

  let box: FakeBox | null = null;
  let homeId = "";
  const tidy = async () => {
    const homes = ((await (await call(alice, aAuth, "GET", "/home")).json()).homes ?? []) as { id: string; boxes: { id: string }[]; members: { id: string; username: string }[] }[];
    const boxes = ((await (await call(dana, dAuth, "GET", "/admin/home/boxes")).json()).boxes ?? []) as { id: string; label?: string }[];
    const ours = new Set(boxes.filter((b) => (b.label ?? "").startsWith("e2e-automations ")).map((b) => b.id));
    for (const h of homes) {
      const autos = ((await (await call(alice, aAuth, "GET", `/home/${h.id}/automations`)).json()).automations ?? []) as { id: string; name: string }[];
      for (const a of autos) if (/^(Movie time|Morning routine)/.test(a.name)) await call(alice, aAuth, "DELETE", `/home/${h.id}/automations/${a.id}`);
      for (const m of h.members ?? []) if (m.username === readRun().users.bob.username) await call(alice, aAuth, "DELETE", `/home/${h.id}/members/${m.id}`);
      for (const b of h.boxes ?? []) if (ours.has(b.id)) await call(alice, aAuth, "DELETE", `/home/${h.id}/boxes/${b.id}`);
    }
    for (const id of ours) await call(dana, dAuth, "DELETE", `/admin/home/boxes/${id}`);
  };
  const asked = (op: string) => box!.asked.filter((q) => q.op === op).map((q) => q.args);
  try {
    await tidy();
    const made = await call(dana, dAuth, "POST", "/admin/home/boxes", { label: `e2e-automations ${stamp}`, server_url: BASE_URL });
    expect(made.ok(), await made.text()).toBe(true);
    const prepared = await made.json();
    box = new FakeBox(
      readSetup(prepared.setup),
      [{ id: "lounge", name: "Lounge" }, { id: "kitchen", name: "Kitchen" }, { id: "hall", name: "Hall" }],
      [
        { id: "light.lamp", domain: "light", name: "Floor lamp", state: "on", area: "lounge" },
        { id: "light.lounge_ceiling", domain: "light", name: "Lounge ceiling", state: "on", area: "lounge" },
        { id: "media_player.kitchen", domain: "media_player", name: "Kitchen speaker", state: "playing", cls: "speaker", area: "kitchen", x: { vol: 30, title: "A song", artist: "A band", can: ["pause", "play", "next", "vol", "mute"] } },
        { id: "lock.front", domain: "lock", name: "Front door", state: "locked", area: "hall" },
      ],
    );
    await box.up();
    const have = ((await (await call(alice, aAuth, "GET", "/home")).json()).homes ?? []) as { id: string; role: string }[];
    const mine = have.find((h) => h.role === "owner");
    const claimed = await call(alice, aAuth, "POST", "/home/claim", mine ? { code: prepared.claim_code, home_id: mine.id } : { code: prepared.claim_code, home_name: "E2E home" });
    expect(claimed.ok(), await claimed.text()).toBe(true);
    homeId = (await claimed.json()).home_id;
    await expect.poll(async () => JSON.stringify(await (await call(alice, aAuth, "GET", "/home")).json())).toContain("Floor lamp");
    expect((await call(alice, aAuth, "POST", `/home/${homeId}/members`, { username: readRun().users.bob.username })).ok()).toBe(true);

    // ---- the owner makes it, on the Home page.
    await alice.setViewportSize({ width: 1440, height: 900 });
    await alice.goto("/home");
    await ready(alice);
    const section = alice.getByRole("region", { name: "Automations" });
    await expect(section).toBeVisible();
    if (shots) await alice.screenshot({ path: `${shots}/hauto-01-home-no-automations.png` });
    await section.getByRole("button", { name: "New automation" }).click();
    await section.getByLabel("Name").fill("Movie time");
    await section.getByRole("button", { name: "Make it" }).click();
    await expect(alice).toHaveURL(/\/home\/automations\//);
    await expect(alice.getByText("Someone asks: a phrase, or the Run button")).toBeVisible();

    // A room's lights, off.
    await alice.getByRole("button", { name: "Add a step" }).click();
    await alice.getByRole("menuitem", { name: /A room's lights/ }).click();
    const step = alice.getByRole("complementary", { name: "This step" });
    await step.getByLabel("Room").selectOption({ label: "Lounge" });
    await step.getByLabel("Turn them").selectOption("off");
    await expect(alice.getByText("Turn off the Lounge lights").first()).toBeVisible();
    // The speaker: pause. A lock is never on the list.
    await alice.getByRole("button", { name: "Add a step" }).click();
    await alice.getByRole("menuitem", { name: /^A device/ }).click();
    await expect(step.getByLabel("Device").locator("option", { hasText: "Front door" })).toHaveCount(0);
    await step.getByLabel("Device").selectOption({ label: "Kitchen speaker" });
    await step.getByLabel("Do this").selectOption({ label: "Pause" });
    await expect(alice.getByText("Pause Kitchen speaker").first()).toBeVisible();
    // What to say.
    const about = alice.getByRole("complementary", { name: "About this automation" });
    await about.getByLabel("A phrase").fill("It's movie time");
    await about.getByRole("button", { name: "Add" }).click();
    await about.getByLabel("A phrase").fill("movie time");
    await about.getByRole("button", { name: "Add" }).click();
    await alice.getByRole("button", { name: "Save", exact: true }).click();
    await expect(alice.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
    if (shots) await alice.screenshot({ path: `${shots}/hauto-02-editor-movie-time.png` });
    if (shots) await about.screenshot({ path: `${shots}/hauto-03-phrases.png` });

    // Run it from the editor: the box is asked for both, in order.
    await alice.getByRole("button", { name: "Run it now" }).click();
    await expect(alice.getByText("Okay, Movie time is done.").first()).toBeVisible({ timeout: 20_000 });
    expect(box.asked.slice(-2)).toEqual([
      { op: "room.lights", args: { area: "lounge", action: "turn_off" } },
      { op: "do", args: { entity: "media_player.kitchen", action: "pause", value: null } },
    ]);
    await expect(about.getByText("Lounge lights: turned off")).toBeVisible();
    await expect(about.getByText("Kitchen speaker: paused")).toBeVisible();
    if (shots) await alice.screenshot({ path: `${shots}/hauto-04-editor-after-run.png` });

    // A phrase another automation already has is refused, in words.
    const other = await (await call(alice, aAuth, "POST", `/home/${homeId}/automations`, { name: "Movie time two" })).json();
    const clash = await call(alice, aAuth, "PUT", `/home/${homeId}/automations/${other.id}`, { phrases: ["Hey Promptly, movie time!"] });
    expect(clash.status()).toBe(422);
    expect((await clash.json()).detail).toContain("already what runs “Movie time”");
    await call(alice, aAuth, "DELETE", `/home/${homeId}/automations/${other.id}`);

    // ---- a fuller one, with a time, a check and a wait (made through the API; looked at in the editor).
    const boxId = prepared.box.id as string;
    const morning = await (await call(alice, aAuth, "POST", `/home/${homeId}/automations`, { name: "Morning routine" })).json();
    const at = (x: number, y: number) => ({ x, y });
    const saved = await call(alice, aAuth, "PUT", `/home/${homeId}/automations/${morning.id}`, {
      phrases: ["It's morning time", "Good morning"],
      graph: {
        version: 1,
        mode: "advanced",
        nodes: [
          { id: "trigger", type: "trigger.schedule", position: at(0, 0), data: { frequency: "weekly", hour: 6, minute: 30, weekdays: [0, 1, 2, 3, 4], weekday: 0, timezone: "Australia/Brisbane" } },
          { id: "lights", type: "home.lights", position: at(0, 130), data: { box: boxId, area: "lounge", on: true } },
          { id: "playing", type: "control.home_state", position: at(0, 260), data: { box: boxId, entity: "media_player.kitchen", state: "on" } },
          { id: "music", type: "home.music", position: at(150, 390), data: { box: boxId, entity: "media_player.kitchen", query: "jazz", volume: 25 } },
          { id: "wait", type: "flow.delay", position: at(150, 520), data: { seconds: 600 } },
          { id: "lamp", type: "home.device", position: at(150, 650), data: { box: boxId, entity: "light.lamp", action: "set", value: { bri: 40, k: 2700 } } },
        ],
        edges: [
          { source: "trigger", target: "lights" },
          { source: "lights", target: "playing" },
          { source: "playing", target: "music", source_handle: "false" },
          { source: "music", target: "wait" },
          { source: "wait", target: "lamp" },
        ],
      },
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    expect((await saved.json()).trigger).toEqual({ kind: "schedule", words: "Weekdays at 6:30 am" });
    await alice.goto(`/home/automations/${homeId}/${morning.id}`);
    await ready(alice);
    await expect(alice.getByText("It's 6:30 am, weekdays")).toBeVisible();
    await expect(alice.getByText("Play some jazz on Kitchen speaker")).toBeVisible();
    await alice.getByText("Play some jazz on Kitchen speaker").click();
    await expect(alice.getByRole("complementary", { name: "This step" }).getByLabel("What kind")).toHaveValue("jazz");
    if (shots) await alice.screenshot({ path: `${shots}/hauto-09-editor-morning-routine.png` });

    // ---- on the Home page: the list, and its Run button.
    await alice.goto("/home");
    await ready(alice);
    const row = alice.getByRole("region", { name: "Automations" }).getByRole("listitem").filter({ hasText: "Movie time" });
    await expect(row).toContainText("Say “It's movie time”");
    await expect(row).toContainText(/Worked .*run by hand/);
    if (shots) await alice.screenshot({ path: `${shots}/hauto-05-home-list.png` });
    const n = box.asked.length;
    await row.getByRole("button", { name: "Run Movie time" }).click();
    await expect.poll(() => box!.asked.length).toBe(n + 2);

    // ---- a member: sees it, runs it, can't change it.
    await bob.setViewportSize({ width: 1440, height: 900 });
    await bob.goto("/home");
    await ready(bob);
    const theirs = bob.getByRole("region", { name: "Automations" });
    await expect(theirs.getByRole("listitem").filter({ hasText: "Movie time" })).toBeVisible();
    await expect(theirs.getByRole("button", { name: "New automation" })).toHaveCount(0);
    await expect(theirs.getByRole("link", { name: "Change Movie time" })).toHaveCount(0);
    await theirs.getByRole("button", { name: "Run Movie time" }).click();
    await expect.poll(() => box!.asked.length).toBe(n + 4);
    const autos = (await (await call(bob, bAuth, "GET", `/home/${homeId}/automations`)).json()).automations as { id: string }[];
    expect((await call(bob, bAuth, "PUT", `/home/${homeId}/automations/${autos[0].id}`, { name: "Bob's now" })).status()).toBe(403);
    expect((await call(bob, bAuth, "DELETE", `/home/${homeId}/automations/${autos[0].id}`)).status()).toBe(403);
    // The admin isn't in the home: nothing.
    expect((await call(dana, dAuth, "GET", `/home/${homeId}/automations`)).status()).toBe(404);

    // ---- typed in a chat: the model calls home_automation.
    const typedBefore = box.asked.length;
    await ask(alice, "movie time");
    await expect(lastReply(alice)).toContainText("Tool said: Done: Okay, Movie time is done.", { timeout: 30_000 });
    expect(box.asked.length).toBe(typedBefore + 2);
    await expect(alice.getByText(/ran 1 home automation/i).first()).toBeVisible();
    await expect(alice.getByRole("button", { name: "Send message" })).toBeVisible();
    if (shots) await alice.screenshot({ path: `${shots}/hauto-06-chat-run.png` });

    // ---- the AI tasks page: one simple form, with places to start.
    await bob.goto("/tasks");
    await ready(bob);
    await expect(bob.getByRole("tab", { name: "AI tasks" })).toHaveAttribute("aria-selected", "true");
    await expect(bob.getByRole("heading", { name: "No AI tasks yet" })).toBeVisible();
    await expect(bob.getByRole("button", { name: /Morning news/ })).toBeVisible();
    if (shots) await bob.screenshot({ path: `${shots}/hauto-08-ai-tasks.png` });

    // ---- said out loud (needs the stack's own speech): no model.
    const voice = await call(alice, aAuth, "GET", "/talk/config");
    test.skip(!voice.ok() || !(await voice.json()).enabled, "this stack has no live speech (bring it up --with voice)");
    const modelBefore = JSON.stringify(lastModelRequest());
    const spokenBefore = box.asked.length;
    const wav = clip("home-movie-time", [2.0, await say(alice.request, aAuth, "It's movie time."), 8]);
    const first = await talker(wav, { width: 390, height: 844 });
    try {
      await first.page.goto("/chat");
      await expect(first.page.getByText("Loading Promptly...")).toHaveCount(0, { timeout: 20_000 });
      await first.page.getByRole("button", { name: "Talk to Promptly" }).first().click();
      await expect(panel(first.page)).toBeVisible();
      await expect(panel(first.page).locator('[data-caption="you"]').first()).toContainText(/movie time/i, { timeout: 40_000 });
      await expect(panel(first.page).locator('[data-caption="reply"]').first()).toContainText("Okay, Movie time is done.", { timeout: 30_000 });
      await expect.poll(() => box!.asked.length).toBe(spokenBefore + 2);
      expect(JSON.stringify(lastModelRequest())).toBe(modelBefore);
      if (shots) await first.page.screenshot({ path: `${shots}/hauto-07-talk-phrase.png` });
      await panel(first.page).getByRole("button", { name: /^End$/ }).click();
    } finally {
      await first.browser.close();
    }
  } finally {
    box?.down();
    await tidy();
    await call(dana, dAuth, "PATCH", "/admin/home/settings", { enabled: !!before.enabled });
  }
});
