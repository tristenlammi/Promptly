// Calls WP-D4: history and missed calls. The Calls tab in Rooms (missed
// calls in red, the badge, details, removing a call only for you, calling
// back), Call / Video call on the person page and in Contacts, Ctrl+K
// "Call Mum" / "Video call bob", blocked people never offered (and refused
// anyway), the phone layout, and axe. Screenshots land in
// .stacks/calls-history/ (gitignored). Needs the calls service in the stack
// (scripts/stack.sh up <name> --with calls); skipped without it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { chromium, type APIRequestContext, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";

import { expect, run, stamp, test } from "../fixtures";
import { writeSpeechWav } from "../lib/speech";
import { BACKEND, BASE_URL, E2E_ROOT, storageStateFile } from "../lib/stack";

const speech = writeSpeechWav(path.join(os.tmpdir(), "promptly-e2e-calls-history-speech.wav"), 20);
const CHROME_ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  `--use-file-for-fake-audio-capture=${speech}`,
  "--autoplay-policy=no-user-gesture-required",
];
test.use({ channel: "chrome", launchOptions: { args: CHROME_ARGS } });
test.describe.configure({ mode: "serial" });

const browsers: Browser[] = [];
async function person(who: Who, opts: BrowserContextOptions = {}): Promise<Page> {
  const b = await chromium.launch({ channel: "chrome", args: CHROME_ARGS });
  browsers.push(b);
  const ctx = await b.newContext({
    storageState: storageStateFile(who),
    baseURL: BASE_URL,
    viewport: { width: 1366, height: 860 },
    serviceWorkers: "block",
    ...opts,
  });
  await ctx.route("**/version.json*", (r) => r.abort());
  return ctx.newPage();
}
test.afterEach(async () => {
  for (const b of browsers.splice(0)) await b.close().catch(() => undefined);
});

const SHOTS = process.env.CALL_SHOTS ?? path.join(E2E_ROOT, "..", ".stacks", "calls-history");
fs.mkdirSync(SHOTS, { recursive: true });

function py(script: string): string {
  return execFileSync("docker", ["exec", "-i", BACKEND, "python", "-"], { input: script, encoding: "utf8" });
}

function callsOn(on: boolean): void {
  py(`
import asyncio
import app.db_models  # noqa: F401
from app.database import SessionLocal
from app.app_settings.models import AppSettings, SINGLETON_APP_SETTINGS_ID
async def main():
    async with SessionLocal() as db:
        row = await db.get(AppSettings, SINGLETON_APP_SETTINGS_ID)
        row.calls_enabled = ${on ? "True" : "False"}
        row.calls_group_ids = None
        await db.commit()
asyncio.run(main())
`);
}

function livekitRunning(): boolean {
  try {
    const out = execFileSync("docker", ["exec", BACKEND, "python", "-c", "import socket; socket.getaddrinfo('livekit', 7880); print('yes')"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.includes("yes");
  } catch {
    return false;
  }
}

/** The 45-second ring timeout, run now (what the arq job does then). */
function ringTimeoutNow(callId: string): string {
  return py(`
import asyncio, uuid
import app.db_models  # noqa: F401
from sqlalchemy import func, select
from app.database import SessionLocal
from app.calls import dm
from app.calls.models import CallParticipant
from app.redis_client import redis
async def main():
    async with SessionLocal() as db:
        at = (await db.execute(select(func.max(CallParticipant.rung_at)).where(CallParticipant.call_id == uuid.UUID("${callId}")))).scalar()
    print("RESULT", await dm.ring_timeout("${callId}", at.isoformat()))
    try:
        await redis.aclose()
    except Exception:
        pass
asyncio.run(main())
`)
    .split(/\r?\n/)
    .find((l) => l.startsWith("RESULT"))!
    .slice(7);
}

/** Alice's Contacts: Bob as "Margaret Lee", nickname Mum. Returns the file id. */
function aliceContacts(): string {
  return py(`
import asyncio, uuid
import app.db_models  # noqa: F401
from app.auth.models import User
from app.database import SessionLocal
from app.items import service as items
async def main():
    async with SessionLocal() as db:
        alice = await db.get(User, uuid.UUID("${run.users.alice.id}"))
        data = {
            "contacts": [{"id": "mum", "first": "Margaret", "last": "Lee", "nickname": "Mum",
                          "promptly_user_id": "${run.users.bob.id}", "promptly_username": "${run.users.bob.username}"}],
        }
        try:
            row, _ = await items.create_item(db, alice, "contacts", installed_check=False, title="Family ${stamp}", data=data)
        except items.ItemExists as e:  # Alice has her Contacts already (one file per app): add Mum to it
            row, doc = e.args
            d = dict(doc.data or {})
            d["contacts"] = [c for c in d.get("contacts", []) if c.get("id") != "mum"] + data["contacts"]
            await items.save_data(db, alice, row, doc, d, base_revision=None)
        await db.commit()
        print("FILE", row.id)
asyncio.run(main())
`)
    .split(/\r?\n/)
    .find((l) => l.startsWith("FILE"))!
    .slice(5)
    .trim();
}

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/rooms/");
  return (await seen).headers()["authorization"];
}

type Who = "alice" | "bob" | "dana";
const name = (w: Who) => run.users[w].username;

function setTheme(page: Page, theme: "light" | "dark") {
  return page.addInitScript((t) => {
    window.localStorage.setItem("promptly.theme", JSON.stringify({ state: { theme: t }, version: 0 }));
  }, theme);
}

async function shot(page: Page, file: string) {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, file) });
}

async function axe(page: Page, what: string, include?: string): Promise<string[]> {
  await page.mouse.move(0, 0);
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  if (include) builder = builder.include(include);
  const { violations } = await builder.analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${what}: ${v.id} (${v.impact}) — ${v.help} — ${v.nodes.slice(0, 4).map((n) => n.target.join(" ")).join(" | ")}`);
}

async function api(req: APIRequestContext, auth: string, method: "GET" | "POST" | "DELETE" | "PUT", url: string, data?: unknown) {
  const r = await req.fetch(url, { method, headers: { Authorization: auth }, data });
  return r;
}

const incoming = (page: Page) => page.getByTestId("incoming-call");
const screen = (page: Page) => page.getByTestId("call-screen");
const status = (page: Page) => page.getByTestId("call-status");
const rows = (page: Page) => page.getByTestId("calls-row");
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/** Bob turns down a ringing call (in whichever page rings). */
async function decline(page: Page) {
  await incoming(page).getByRole("button", { name: "Decline" }).click({ timeout: 20_000 });
  await expect(incoming(page)).toHaveCount(0, { timeout: 15_000 });
}

test.describe("Call history and missed calls", () => {
  const ids = { dm: "", contacts: "" };
  const auth: Partial<Record<Who, string>> = {};
  const axeProblems: string[] = [];

  test.beforeAll(async ({ browser }) => {
    test.skip(!livekitRunning(), "this stack has no calls service (--with calls)");
    callsOn(true);
    for (const who of ["alice", "bob", "dana"] as Who[]) {
      const ctx = await browser.newContext({ storageState: storageStateFile(who) });
      const page = await ctx.newPage();
      auth[who] = await bearer(page);
      if (who === "alice") {
        const dm = await api(page.request, auth.alice!, "POST", "/api/rooms/dms", { user_ids: [run.users.bob.id] });
        expect(dm.ok()).toBe(true);
        ids.dm = (await dm.json()).id;
      }
      // A clean list for everyone (it only hides their own rows).
      expect((await api(page.request, auth[who]!, "DELETE", "/api/calls/history")).ok()).toBe(true);
      await ctx.close();
    }
    ids.contacts = aliceContacts();
  });

  test.afterAll(() => {
    try {
      callsOn(false);
    } catch {
      /* the stack went away */
    }
  });

  test("the Calls tab: missed calls in red, the badge, details, removing one, calling back", async ({ browser }) => {
    test.setTimeout(240_000);
    const A = name("alice");
    // History to look at: an answered call, then a missed video call (made
    // through the API, with no pages open to ring).
    const ctx = await browser.newContext();
    const req = ctx.request;
    const base = BASE_URL;
    const c1 = await (await api(req, auth.alice!, "POST", `${base}/api/calls`, { room_id: ids.dm, media: "audio" })).json();
    expect((await api(req, auth.bob!, "POST", `${base}/api/calls/${c1.call.id}/join`, { device: "web" })).ok()).toBe(true);
    expect((await api(req, auth.alice!, "POST", `${base}/api/calls/${c1.call.id}/leave`, {})).ok()).toBe(true);
    const c2 = await (await api(req, auth.alice!, "POST", `${base}/api/calls`, { room_id: ids.dm, media: "video" })).json();
    expect(ringTimeoutNow(c2.call.id)).toBe("missed");
    await ctx.close();

    const alice = await person("alice");
    const bob = await person("bob");
    await setTheme(bob, "light");
    await alice.goto("/calendar");
    await bob.goto("/rooms/dm");

    // The badge on the Calls button, before Bob looks.
    const callsBtn = bob.getByRole("navigation", { name: "Spaces" }).getByRole("button", { name: /^Calls/ });
    await expect(callsBtn).toHaveAccessibleName("Calls, 1 missed", { timeout: 20_000 });
    await callsBtn.click();
    await expect(bob).toHaveURL(/\/rooms\/calls$/);
    await expect(rows(bob)).toHaveCount(2, { timeout: 15_000 });
    const missed = rows(bob).first();
    await expect(missed).toHaveAttribute("data-missed", "true");
    await expect(missed).toHaveAttribute("data-new", "true");
    await expect(missed).toContainText(A);
    await expect(missed).toContainText("Missed video call");
    await expect(rows(bob).nth(1)).toContainText("Incoming call");
    await expect(rows(bob).nth(1)).not.toHaveAttribute("data-missed", "true");
    // Looking clears the badge (on every device).
    await expect(callsBtn).toHaveAccessibleName("Calls", { timeout: 15_000 });
    await expect(bob.getByText("Pick a call on the left", { exact: false })).toBeVisible();
    await shot(bob, "calls-tab-desktop-light.png");
    axeProblems.push(...(await axe(bob, "calls list", "nav[aria-label=Calls]")));

    // Missed only.
    await bob.getByRole("radio", { name: "Missed" }).click();
    await expect(rows(bob)).toHaveCount(1);
    await bob.getByRole("radio", { name: "All" }).click();

    // Details: every call with Alice, and Call / Video call / Message.
    await missed.getByRole("link").click();
    const detail = bob.getByTestId("call-detail");
    await expect(detail).toContainText(`Calls with ${A}`);
    await expect(bob.getByTestId("call-detail-entry")).toHaveCount(2);
    await expect(bob.getByTestId("call-detail-call")).toBeEnabled();
    await shot(bob, "call-detail-desktop-light.png");
    axeProblems.push(...(await axe(bob, "call details", "[data-testid=call-detail]")));

    // Remove the missed call: gone from Bob's list, still in Alice's.
    await bob.getByTestId("call-detail-remove").click();
    await expect(bob).toHaveURL(/\/rooms\/calls$/);
    await expect(rows(bob)).toHaveCount(1);
    await expect(rows(bob).first()).toContainText("Incoming call");
    const aliceHist = await (await api(alice.request, auth.alice!, "GET", "/api/calls/history")).json();
    expect(aliceHist.calls.map((c: { id: string }) => c.id)).toContain(c2.call.id);

    // Dark, for the screenshot.
    await setTheme(bob, "dark");
    await bob.reload();
    await expect(rows(bob)).toHaveCount(1, { timeout: 20_000 });
    await shot(bob, "calls-tab-desktop-dark.png");
    axeProblems.push(...(await axe(bob, "calls list (dark)", "nav[aria-label=Calls]")));

    // Call back from the row: Alice's page rings; she declines.
    await bob.waitForTimeout(1000);
    await rows(bob).first().getByTestId("calls-call-back").click();
    await expect(screen(bob)).toBeVisible({ timeout: 15_000 });
    await expect(status(bob)).toHaveText("Calling…", { timeout: 20_000 });
    await expect(incoming(alice)).toContainText(name("bob"), { timeout: 20_000 });
    await decline(alice);
    await expect(bob.getByTestId("call-ended")).toContainText("No answer", { timeout: 15_000 });
    await expect(screen(bob)).toHaveCount(0, { timeout: 15_000 });
    // ...and the list has it on top.
    await expect(rows(bob).first()).toContainText("Outgoing call", { timeout: 15_000 });
    await expect(rows(bob).first()).toContainText("No answer");
  });

  test("Call and Video call on the person page and in Contacts", async () => {
    test.setTimeout(180_000);
    const alice = await person("alice");
    const bob = await person("bob");
    await setTheme(alice, "light");
    await bob.goto("/calendar");

    await alice.goto(`/people/u/${run.users.bob.id}`);
    await expect(alice.getByTestId("person-call")).toBeVisible({ timeout: 20_000 });
    await expect(alice.getByTestId("person-video-call")).toBeVisible();
    await shot(alice, "person-hub-call-buttons-desktop-light.png");
    axeProblems.push(...(await axe(alice, "person page", "main")));
    await alice.getByTestId("person-call").click();
    await expect(status(alice)).toHaveText("Calling…", { timeout: 20_000 });
    await expect(incoming(bob)).toContainText("Incoming call", { timeout: 20_000 });
    await decline(bob);
    await expect(screen(alice)).toHaveCount(0, { timeout: 20_000 });

    await alice.goto(`/apps/contacts/${ids.contacts}?c=mum`);
    const buttons = alice.getByTestId("contact-promptly-call");
    await expect(buttons).toBeVisible({ timeout: 20_000 });
    await shot(alice, "contact-call-buttons-desktop-light.png");
    await buttons.getByRole("button", { name: /^Video call Mum/ }).click();
    await expect(status(alice)).toHaveText("Calling…", { timeout: 20_000 });
    await expect(incoming(bob)).toContainText("Incoming video call", { timeout: 20_000 });
    await decline(bob);
    await expect(screen(alice)).toHaveCount(0, { timeout: 20_000 });
  });

  test("Ctrl+K: Call Mum, Video call bob; blocked people aren't offered and are refused", async () => {
    test.setTimeout(180_000);
    const alice = await person("alice");
    const bob = await person("bob");
    await alice.goto("/calendar");
    await bob.goto("/calendar");
    await alice.waitForTimeout(1000);

    await alice.keyboard.press("Control+k");
    await alice.keyboard.type("call mum");
    const mum = alice.getByRole("button", { name: /^Call Mum Margaret Lee/ });
    await expect(mum).toBeVisible({ timeout: 15_000 });
    await shot(alice, "palette-call-mum-desktop-light.png");
    await alice.keyboard.press("Enter");
    await expect(status(alice)).toHaveText("Calling…", { timeout: 20_000 });
    await expect(incoming(bob)).toBeVisible({ timeout: 20_000 });
    await decline(bob);
    await expect(screen(alice)).toHaveCount(0, { timeout: 20_000 });

    await alice.keyboard.press("Control+k");
    await alice.keyboard.type("video call bob");
    // Bob is "Margaret Lee" in Alice's Contacts: the row says so, with his username.
    await expect(alice.getByRole("button", { name: new RegExp(`^Video call Margaret Lee @${name("bob")}`) })).toBeVisible({ timeout: 15_000 });
    await alice.keyboard.press("Enter");
    await expect(incoming(bob)).toContainText("Incoming video call", { timeout: 20_000 });
    await decline(bob);
    await expect(screen(alice)).toHaveCount(0, { timeout: 20_000 });

    // Alice blocks Dana: Dana isn't offered, her page has no call buttons,
    // and a call is refused anyway.
    const blocked = await api(alice.request, auth.alice!, "PUT", `/api/people/blocks/${run.users.dana.id}`);
    expect(blocked.ok()).toBe(true);
    try {
      await alice.keyboard.press("Control+k");
      await alice.keyboard.type("call dana");
      await expect(alice.getByRole("button", { name: /No one called “dana” you can call/ })).toBeVisible({ timeout: 15_000 });
      await expect(alice.getByRole("button", { name: new RegExp(`^Call ${name("dana")}`) })).toHaveCount(0);
      await alice.keyboard.press("Escape");
      await alice.goto(`/people/u/${run.users.dana.id}`);
      await expect(alice.getByText(`You've blocked`)).toBeVisible({ timeout: 20_000 });
      await expect(alice.getByTestId("person-call")).toHaveCount(0);
      const r = await api(alice.request, auth.alice!, "POST", "/api/calls/dm", { user_ids: [run.users.dana.id], media: "audio" });
      expect(r.status()).toBe(403);
      // Dana doesn't find Alice either, and isn't told why.
      const d = await (await api(alice.request, auth.dana!, "GET", `/api/calls/people?q=${encodeURIComponent(name("alice"))}`)).json();
      expect(d.people).toEqual([]);
      const r2 = await api(alice.request, auth.dana!, "POST", "/api/calls/dm", { user_ids: [run.users.alice.id], media: "audio" });
      expect(r2.status()).toBe(403);
      expect(JSON.stringify(await r2.json()).toLowerCase()).not.toContain("block");
    } finally {
      await api(alice.request, auth.alice!, "DELETE", `/api/people/blocks/${run.users.dana.id}`);
    }
  });

  test("on a phone: Spaces · Messages · Calls, details, New call", async () => {
    test.setTimeout(120_000);
    const phone = await person("bob", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await setTheme(phone, "light");
    await phone.goto("/rooms/dm");
    const tab = phone.getByRole("radio", { name: /^Calls/ });
    await expect(tab).toBeVisible({ timeout: 20_000 });
    await expect(phone.getByRole("radio", { name: /^Spaces/ })).toBeVisible();
    await tab.tap();
    await expect(phone).toHaveURL(/\/rooms\/calls$/);
    await expect(rows(phone).first()).toBeVisible({ timeout: 15_000 });
    expect(await noHScroll(phone)).toBe(true);
    await phone.screenshot({ path: path.join(SHOTS, "calls-tab-phone-light.png") });
    axeProblems.push(...(await axe(phone, "phone calls list", "nav[aria-label=Calls]")));

    await rows(phone).first().getByRole("link").tap();
    await expect(phone.getByTestId("call-detail")).toBeVisible();
    expect(await noHScroll(phone)).toBe(true);
    await phone.screenshot({ path: path.join(SHOTS, "call-detail-phone-light.png") });
    await phone.getByRole("button", { name: "Back to calls" }).tap();
    await expect(phone).toHaveURL(/\/rooms\/calls$/);

    await phone.getByRole("button", { name: "New call" }).tap();
    await phone.getByTestId("new-call-search").fill("alice");
    await expect(phone.getByTestId("new-call-person").first()).toContainText(name("alice"), { timeout: 15_000 });
    expect(await noHScroll(phone)).toBe(true);
    await phone.screenshot({ path: path.join(SHOTS, "new-call-phone-light.png") });
    axeProblems.push(...(await axe(phone, "new call sheet", "[role=dialog]")));
    await phone.keyboard.press("Escape");

    expect(axeProblems).toEqual([]);
  });
});
