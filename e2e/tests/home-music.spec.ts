// Music by name, in the real pages against a stand-in box (lib/fakeBox.ts):
// the home's owner links Tidal in Home → settings → Music (the page shows
// Tidal's own site and a code, never a password box), a member sees it's
// linked but can't change it, and in a chat "play Miles Davis in the lounge"
// reaches the box as one search and one play. Two albums with the name asked
// for is a question back, and nothing plays until the person says which.
//
// Home is off by default: the spec turns it on, and puts everything back.
import type { APIResponse, Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { FakeBox, readSetup } from "../lib/fakeBox";
import { BASE_URL, readRun } from "../lib/stack";

test.describe.configure({ mode: "serial" });

const shots = process.env.E2E_SHOTS_DIR;
const composer = (page: Page) => page.getByPlaceholder(/^Message Promptly/);
const lastReply = (page: Page) => page.locator(".promptly-message:not(.flex-row-reverse)").last();

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  return (await seen).headers()["authorization"];
}
const call = (page: Page, auth: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, data?: unknown): Promise<APIResponse> =>
  page.request.fetch(`/api${url}`, { method, headers: { Authorization: auth }, data });

async function ask(page: Page, text: string, fresh = true): Promise<void> {
  if (fresh) {
    await page.route("**/api/chat/conversations/*/messages", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const body = route.request().postDataJSON() as Record<string, unknown>;
      await route.continue({ postData: JSON.stringify({ ...body, tools_enabled: true }) });
    });
    await page.goto("/chat");
    await ready(page);
    await page.locator('button[aria-haspopup="listbox"]').first().click();
    await page.getByRole("option", { name: /E2E Mock Tools/ }).click();
  }
  await composer(page).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

async function openMusic(page: Page) {
  await page.goto("/home");
  await ready(page);
  await page.getByRole("button", { name: /settings/i }).first().click();
  const music = page.getByRole("region", { name: "Music" });
  await expect(music).toBeVisible({ timeout: 20_000 });
  await music.scrollIntoViewIfNeeded();
  return music;
}

test("music by name: the owner links Tidal on Tidal's own site, and the assistant plays only what was plainly asked for", async ({ alice, bob, dana }) => {
  test.setTimeout(240_000);
  const [aAuth, bAuth, dAuth] = [await bearer(alice), await bearer(bob), await bearer(dana)];
  const before = await (await call(dana, dAuth, "GET", "/admin/home/settings")).json();
  expect((await call(dana, dAuth, "PATCH", "/admin/home/settings", { enabled: true })).ok()).toBe(true);

  let box: FakeBox | null = null;
  let homeId = "";
  let bobId = "";
  const tidy = async () => {
    const boxes = ((await (await call(dana, dAuth, "GET", "/admin/home/boxes")).json()).boxes ?? []) as { id: string; label?: string }[];
    const ours = new Set(boxes.filter((b) => (b.label ?? "").startsWith("e2e-music ")).map((b) => b.id));
    const homes = ((await (await call(alice, aAuth, "GET", "/home")).json()).homes ?? []) as { id: string; boxes: { id: string }[] }[];
    for (const h of homes) {
      for (const b of h.boxes ?? []) if (ours.has(b.id)) await call(alice, aAuth, "DELETE", `/home/${h.id}/boxes/${b.id}`);
    }
    for (const id of ours) await call(dana, dAuth, "DELETE", `/admin/home/boxes/${id}`);
    if (homeId && bobId) await call(alice, aAuth, "DELETE", `/home/${homeId}/members/${bobId}`);
  };
  const asked = (op: string) => box!.asked.filter((q) => q.op === op).map((q) => q.args);
  try {
    await tidy();
    const made = await call(dana, dAuth, "POST", "/admin/home/boxes", { label: `e2e-music ${stamp}`, server_url: BASE_URL });
    expect(made.ok(), await made.text()).toBe(true);
    const prepared = await made.json();
    box = new FakeBox(
      readSetup(prepared.setup),
      [{ id: "lounge", name: "Lounge" }, { id: "kitchen", name: "Kitchen" }],
      [
        { id: "light.lamp", domain: "light", name: "Floor lamp", state: "on", area: "lounge" },
        { id: "media_player.lounge", domain: "media_player", name: "Lounge speaker", state: "idle", cls: "speaker", area: "lounge", x: { vol: 30, can: ["pause", "play", "next", "vol", "mute", "preset", "music"] } },
        { id: "media_player.tv", domain: "media_player", name: "Kitchen TV", state: "idle", area: "kitchen", x: { can: ["pause", "play"] } },
      ],
    );
    box.music = {
      linked: false,
      approved: false,
      finds: {
        "miles davis": [
          { uri: "tidal://artist/100", kind: "artist", name: "Miles Davis" },
          { uri: "tidal://album/200", kind: "album", name: "Kind of Blue", artist: "Miles Davis" },
          { uri: "tidal://playlist/abc-1", kind: "playlist", name: "Miles Davis Essentials", by: "TIDAL" },
        ],
        blue: [
          { uri: "tidal://album/300", kind: "album", name: "Blue", artist: "Joni Mitchell" },
          { uri: "tidal://album/301", kind: "album", name: "Blue", artist: "Weezer" },
        ],
      },
    };
    await box.up();
    const have = ((await (await call(alice, aAuth, "GET", "/home")).json()).homes ?? []) as { id: string; role: string }[];
    const mine = have.find((h) => h.role === "owner");
    const claimed = await call(alice, aAuth, "POST", "/home/claim", mine ? { code: prepared.claim_code, home_id: mine.id } : { code: prepared.claim_code, home_name: "E2E home" });
    expect(claimed.ok(), await claimed.text()).toBe(true);
    homeId = (await claimed.json()).home_id;
    await expect.poll(async () => JSON.stringify(await (await call(alice, aAuth, "GET", "/home")).json())).toContain("Lounge speaker");

    // ---- before anything is linked, asking for music says where to link it; nothing plays.
    await ask(alice, "play miles davis in the lounge");
    await expect(lastReply(alice)).toContainText("No music service is linked to this home yet", { timeout: 30_000 });
    expect(asked("music.play")).toEqual([]);
    await expect(alice.getByRole("button", { name: "Send message" })).toBeVisible();

    // ---- the owner links Tidal: Tidal's own site and a code, and no box to type a password into.
    const music = await openMusic(alice);
    await expect(music.getByText("Plays on: Lounge speaker.")).toBeVisible();
    if (shots) await alice.screenshot({ path: `${shots}/music-01-not-linked.png` });
    await music.getByRole("button", { name: "Link Tidal" }).click();
    const step = music.getByRole("group", { name: "Link Tidal" });
    await expect(step.getByText("E2EAB")).toBeVisible();
    await expect(step.getByRole("link", { name: /Open link\.tidal\.com/ })).toHaveAttribute("href", "https://link.tidal.com/E2EAB");
    await expect(step.getByText("Promptly never sees it")).toBeVisible();
    await expect(music.locator("input")).toHaveCount(0);
    if (shots) await alice.screenshot({ path: `${shots}/music-02-link-code.png` });
    // Approved on Tidal's site: the page notices by itself.
    box.music.approved = true;
    await expect(music.getByText("Tidal is linked.")).toBeVisible({ timeout: 20_000 });
    await expect(music.getByRole("button", { name: "Unlink" })).toBeVisible();
    await expect(music.getByRole("button", { name: "Link Tidal" })).toHaveCount(0);
    if (shots) await alice.screenshot({ path: `${shots}/music-03-linked.png` });
    await alice.keyboard.press("Escape");

    // ---- a member sees it's linked and can't change it; the server refuses too.
    const added = await call(alice, aAuth, "POST", `/home/${homeId}/members`, { username: readRun().users.bob.username });
    expect(added.ok(), await added.text()).toBe(true);
    const members = (((await (await call(alice, aAuth, "GET", "/home")).json()).homes as { id: string; members: { id: string; username: string }[] }[]).find((h) => h.id === homeId)?.members) ?? [];
    bobId = readRun().users.bob.id;
    void members;
    const theirs = await openMusic(bob);
    await expect(theirs.getByText("Linked")).toBeVisible();
    await expect(theirs.getByRole("button", { name: "Unlink" })).toHaveCount(0);
    const boxId = (await claimed.json()).box_id;
    expect((await call(bob, bAuth, "DELETE", `/home/${homeId}/boxes/${boxId}/music/sources/tidal--e2e`)).status()).toBe(403);
    expect((await call(bob, bAuth, "POST", `/home/${homeId}/boxes/${boxId}/music/link`, { brand: "tidal" })).status()).toBe(403);
    // The admin isn't in this home: not even a look.
    expect([403, 404]).toContain((await call(dana, dAuth, "GET", `/home/${homeId}/boxes/${boxId}/music`)).status());
    await bob.keyboard.press("Escape");

    // ---- typed: one search, one play, on the speaker in the room that was said.
    await ask(alice, "play miles davis in the lounge");
    await expect(lastReply(alice)).toContainText("Tool said: Done: Playing Miles Davis on Lounge speaker.", { timeout: 30_000 });
    expect(asked("music.search").at(-1)).toEqual({ q: "Miles Davis", kinds: ["artist", "album", "track", "playlist"], limit: 5 });
    expect(asked("music.play")).toEqual([{ entity: "media_player.lounge", uri: "tidal://artist/100", shuffle: false }]);
    await expect(alice.getByText(/looked for 1 piece of music/i).first()).toBeVisible();
    await expect(alice.getByRole("button", { name: "Send message" })).toBeVisible();
    if (shots) await alice.screenshot({ path: `${shots}/music-04-chat-plays.png` });

    // ---- two albums are called "Blue": it asks, and nothing plays until the person says which.
    await ask(alice, "play blue in the lounge");
    await expect(lastReply(alice)).toContainText("Which one did you mean: Blue, the album by Joni Mitchell or Blue, the album by Weezer?", { timeout: 30_000 });
    expect(asked("music.play").length).toBe(1);
    await expect(alice.getByRole("button", { name: "Send message" })).toBeVisible();
    if (shots) await alice.screenshot({ path: `${shots}/music-05-chat-asks-which.png` });
    await ask(alice, "the joni one", false);
    await expect(lastReply(alice)).toContainText("Tool said: Done: Playing Blue by Joni Mitchell on Lounge speaker.", { timeout: 30_000 });
    expect(asked("music.play").at(-1)).toEqual({ entity: "media_player.lounge", uri: "tidal://album/300", shuffle: false });
    await expect(alice.getByRole("button", { name: "Send message" })).toBeVisible();
    if (shots) await alice.screenshot({ path: `${shots}/music-05b-chat-plays-the-one-chosen.png` });

    // ---- the Home page shows what it started.
    await alice.goto("/home");
    await ready(alice);
    await expect(alice.getByText("Playing · Blue").first()).toBeVisible({ timeout: 20_000 });
    if (shots) await alice.screenshot({ path: `${shots}/music-06-home-playing.png` });

    // ---- unlinking takes it away again.
    const again = await openMusic(alice);
    alice.once("dialog", (d) => void d.accept());
    await again.getByRole("button", { name: "Unlink" }).click();
    await expect(again.getByRole("button", { name: "Link Tidal" })).toBeVisible({ timeout: 20_000 });
    expect(asked("music.unlink")).toEqual([{ source: "tidal--e2e" }]);
  } finally {
    box?.down();
    await tidy();
    await call(dana, dAuth, "PATCH", "/admin/home/settings", { enabled: !!before.enabled });
  }
});
