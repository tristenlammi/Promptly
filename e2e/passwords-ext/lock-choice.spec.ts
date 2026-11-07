// How long the browser stays unlocked, up to Never, tried with real browser restarts, and passkeys
// working from an unlocked vault with no password.
import crypto from "node:crypto";
import fs from "node:fs";

import { expect, type Page, test } from "@playwright/test";
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";

import { addItem, bg, connect, launch, lockExt, makeUsers, MASTER, popupFor, type Rig, siteA, startSite, testHook, unlockExt } from "./lib";

test.describe.configure({ mode: "serial" });

const BROWSER = process.env.PW_LOCK_BROWSER;
const LABEL = "Lock this browser's vault";
const ORIGIN = "http://localhost:8111";
const b64u = (b: Buffer) => b.toString("base64url");

let rig: Rig;
let site: { close: () => void };
let credential: { id: string; publicKey: Uint8Array; counter: number };

const launchHere = (dir?: string) => launch(undefined, { ...(BROWSER ? { executablePath: BROWSER } : {}), ...(dir ? { dir } : {}) });

test.beforeAll(async () => {
  makeUsers(["root"], "admin");
  site = await startSite();
  rig = await launchHere();
  const [u] = makeUsers(["stays"]);
  await connect(rig, u);
  await unlockExt(rig);
  await addItem(rig, { title: "Staying", url: "http://localhost:8111", username: "ana", password: "Stay-Pw-1" });
});

test.afterAll(async () => {
  await rig?.close();
  site?.close();
});

/** The browser really closes and really starts again, on the same profile. */
async function restart() {
  const { dir } = rig;
  await rig.ctx.close();
  expect(fs.existsSync(dir)).toBe(true);
  rig = await launchHere(dir);
}

const unlocked = () => bg<boolean>(rig, `return (await chrome.runtime.sendMessage({ t: "state" })).r.unlocked;`);
const kept = () => testHook<{ kept: boolean; sealed: boolean }>(rig, "kept");
const alarm = () => bg<number | null>(rig, `return (await chrome.alarms.get("autolock"))?.scheduledTime ?? null;`);

async function more(): Promise<Page> {
  const p = await rig.ctx.newPage();
  await p.goto(`chrome-extension://${rig.extId}/popup.html`);
  await p.getByRole("button", { name: "More", exact: true }).click();
  await expect(p.getByLabel(LABEL)).toBeVisible();
  return p;
}

async function choose(value: string) {
  const p = await more();
  await p.getByLabel(LABEL).selectOption(value);
  if (value === "never") await p.getByRole("button", { name: "Never lock" }).click();
  await expect(p.getByLabel(LABEL)).toHaveValue(value);
  await p.waitForTimeout(200);
  await p.close();
}

async function passkeyWindow() {
  const p = await rig.ctx.waitForEvent("page", { predicate: (x) => x.url().includes("/passkey.html"), timeout: 15_000 });
  await p.waitForLoadState();
  return p;
}

test("the panel warns before Never, and Cancel changes nothing", async () => {
  const p = await more();
  await expect(p.getByLabel(LABEL)).toHaveValue("15");
  await p.getByLabel(LABEL).selectOption("never");
  await expect(p.getByRole("alert")).toContainText("Anyone who can open this browser");
  expect((await bg<{ when: unknown }>(rig, `return (await chrome.runtime.sendMessage({ t: "lockChoice" })).r;`)).when).toBe(15);
  await p.getByRole("button", { name: "Cancel" }).click();
  await expect(p.getByRole("alert")).toHaveCount(0);
  await expect(p.getByLabel(LABEL)).toHaveValue("15");
  expect((await kept()).kept).toBe(false);
  await p.close();
});

test("a number of minutes sets the timer, and nothing's kept on the disk", async () => {
  await choose("60");
  const inMinutes = ((await alarm())! - Date.now()) / 60_000;
  expect(inMinutes).toBeGreaterThan(59);
  expect(inMinutes).toBeLessThanOrEqual(60.1);
  expect((await kept()).kept).toBe(false);
});

test("the vault page's Settings shows the same setting, and changing it there counts", async () => {
  const v = await rig.ctx.newPage();
  await v.goto(`chrome-extension://${rig.extId}/vault.html#/settings`);
  await expect(v.getByLabel(LABEL)).toHaveValue("60");
  await expect(v.getByText("Lock after this many idle minutes")).toHaveCount(0);
  await v.getByLabel(LABEL).selectOption("5");
  await expect.poll(async () => (((await alarm()) ?? 0) - Date.now()) / 60_000).toBeLessThanOrEqual(5.1);
  await v.close();
});

test("before Never: a passkey with no password asked for, and a real library accepts it", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("webauthn.html"));
  const challenge = b64u(crypto.randomBytes(32));
  const run = page.evaluate((o) => (window as any).__register(o), { rpId: "localhost", userId: b64u(Buffer.from("stay-1")), userName: "stay@example.com", challenge, uv: "required" });
  const prompt = await passkeyWindow();
  await prompt.getByRole("button", { name: "Save as a new item" }).click();
  const r = await run;
  expect(r.error).toBeUndefined();
  const v = await verifyRegistrationResponse({ response: r, expectedChallenge: challenge, expectedOrigin: ORIGIN, expectedRPID: "localhost", requireUserVerification: true });
  expect(v.registrationInfo?.userVerified).toBe(true);
  credential = { id: v.registrationInfo!.credential.id, publicKey: v.registrationInfo!.credential.publicKey, counter: v.registrationInfo!.credential.counter };
  await page.close();
});

test("Never: no timer, sleep doesn't lock it, and the secret's kept sealed", async () => {
  await choose("never");
  expect(await alarm()).toBeNull();
  expect(await kept()).toEqual({ kept: true, sealed: true });
  await testHook(rig, "idle", { state: "locked" });
  expect(await unlocked()).toBe(true);
  await testHook(rig, "sleepGap", { ms: 60 * 60 * 1000 });
  expect(await unlocked()).toBe(true);
});

test("Never: after a real restart, the panel, the vault page, filling and a passkey all work with no password", async () => {
  await restart();
  await expect.poll(unlocked, { timeout: 15_000 }).toBe(true);

  const pop = await rig.ctx.newPage();
  await pop.goto(`chrome-extension://${rig.extId}/popup.html`);
  await expect(pop.getByLabel("Search your vault")).toBeVisible({ timeout: 15_000 });
  await expect(pop.getByLabel("Master password")).toHaveCount(0);
  await pop.close();

  const v = await rig.ctx.newPage();
  await v.goto(`chrome-extension://${rig.extId}/vault.html`);
  await expect(v.getByRole("navigation", { name: "Passwords" })).toBeVisible({ timeout: 30_000 });
  await expect(v.getByText("Your vault is locked")).toHaveCount(0);
  await v.close();

  const login = await rig.ctx.newPage();
  await login.goto(siteA("login.html"));
  const filling = await popupFor(rig, login);
  await filling.getByRole("button", { name: "Fill Staying" }).click();
  await expect.poll(() => login.evaluate(() => (window as any).__state().pass), { timeout: 10_000 }).toBe("Stay-Pw-1");
  await login.close();

  // The server still has a session for it, a new one made since the restart.
  await bg(rig, `return (await chrome.runtime.sendMessage({ t: "sync" })).ok;`);
  expect(await bg<string | null>(rig, `return (await chrome.storage.session.get("vaultSession")).vaultSession ?? null;`)).toBeTruthy();

  const page = await rig.ctx.newPage();
  await page.goto(siteA("webauthn.html"));
  const challenge = b64u(crypto.randomBytes(32));
  const run = page.evaluate((o) => (window as any).__auth(o), { rpId: "localhost", challenge, uv: "required" });
  const prompt = await passkeyWindow();
  await prompt.getByRole("button", { name: /stay@example.com/ }).click();
  const r = await run;
  expect(r.error).toBeUndefined();
  const ok = await verifyAuthenticationResponse({ response: r, expectedChallenge: challenge, expectedOrigin: ORIGIN, expectedRPID: "localhost", credential: { id: credential.id, publicKey: credential.publicKey as Uint8Array<ArrayBuffer>, counter: credential.counter }, requireUserVerification: true });
  expect(ok.verified).toBe(true);
  expect(ok.authenticationInfo.userVerified).toBe(true);
  await page.close();
});

test("Never: pressing Lock means it. The secret goes, and a restart asks. Unlocking brings Never back.", async () => {
  await lockExt(rig);
  expect(await unlocked()).toBe(false);
  expect((await kept()).kept).toBe(false);
  await restart();
  expect(await unlocked()).toBe(false);
  await unlockExt(rig);
  expect(await kept()).toEqual({ kept: true, sealed: true });
  await restart();
  await expect.poll(unlocked, { timeout: 15_000 }).toBe(true);
});

test("leaving Never takes the secret off the disk at once, and a restart asks", async () => {
  await choose("240");
  expect((await kept()).kept).toBe(false);
  expect(await alarm()).toBeGreaterThan(Date.now());
  await restart();
  expect(await unlocked()).toBe(false);
  await unlockExt(rig);
});

test("When the browser closes: no timer, sleep still follows its own box, and a restart asks", async () => {
  await choose("browser");
  expect(await alarm()).toBeNull();
  expect((await kept()).kept).toBe(false);

  const p = await more();
  await p.getByRole("checkbox", { name: "Also lock when the computer sleeps" }).setChecked(false);
  await expect(p.getByRole("checkbox", { name: "Also lock when the computer sleeps" })).not.toBeChecked();
  await testHook(rig, "idle", { state: "locked" });
  expect(await unlocked()).toBe(true);
  await p.getByRole("checkbox", { name: "Also lock when the computer sleeps" }).setChecked(true);
  await expect(p.getByRole("checkbox", { name: "Also lock when the computer sleeps" })).toBeChecked();
  await p.close();
  await testHook(rig, "idle", { state: "locked" });
  expect(await unlocked()).toBe(false);

  await unlockExt(rig);
  await restart();
  expect(await unlocked()).toBe(false);
  await unlockExt(rig);
});

test("a page that fills on load doesn't postpone the lock", async () => {
  await choose("60");
  const items = await testHook<{ id: string; title: string }[]>(rig, "items");
  const item = items.find((i) => i.title === "Staying")!;
  await testHook(rig, "patchItem", { id: item.id, patch: { autofillOnLoad: true } });
  await choose("60");
  const before = await alarm();
  await new Promise((r) => setTimeout(r, 1500));
  const page = await rig.ctx.newPage();
  await page.goto(siteA("login.html"));
  await expect.poll(() => page.evaluate(() => (window as any).__state().pass), { timeout: 10_000 }).toBe("Stay-Pw-1");
  await page.close();
  expect(await alarm()).toBe(before);
  await testHook(rig, "patchItem", { id: item.id, patch: { autofillOnLoad: false } });
});

test("a secret that no longer opens the vault locks an open vault page too", async () => {
  const v = await rig.ctx.newPage();
  await v.goto(`chrome-extension://${rig.extId}/vault.html`);
  await expect(v.getByRole("navigation", { name: "Passwords" })).toBeVisible({ timeout: 30_000 });
  expect((await testHook<{ unlocked: boolean }>(rig, "staleSecret")).unlocked).toBe(false);
  await expect(v.getByLabel("Master password")).toBeVisible({ timeout: 15_000 });
  await expect(v.getByRole("navigation", { name: "Passwords" })).toHaveCount(0);
  await v.close();
  await unlockExt(rig);
});

test("Lock in the vault page takes hold even when the server doesn't answer", async () => {
  await choose("never");
  const v = await rig.ctx.newPage();
  let held = 0;
  await v.route("**/api/passwords/session", (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    held++; // and no answer, ever
  });
  await v.goto(`chrome-extension://${rig.extId}/vault.html`);
  await expect(v.getByRole("navigation", { name: "Passwords" })).toBeVisible({ timeout: 30_000 });
  await v.getByRole("button", { name: "Lock", exact: true }).click();
  await expect.poll(unlocked, { timeout: 10_000 }).toBe(false);
  expect((await kept()).kept).toBe(false);
  expect(held).toBe(1);
  await v.close();
  await restart();
  expect(await unlocked()).toBe(false);
  await unlockExt(rig);
});

async function changePassword(from: string, to: string) {
  const v = await rig.ctx.newPage();
  await v.goto(`chrome-extension://${rig.extId}/vault.html#/settings`);
  await v.getByTestId("settings-advanced").locator("summary").click();
  await v.getByLabel("Current master password").fill(from);
  await v.getByLabel("New master password").fill(to);
  await v.getByLabel("Type it again").fill(to);
  await v.getByRole("button", { name: "Change it" }).click();
  await expect(v.getByLabel("Current master password")).toHaveValue("", { timeout: 60_000 });
  await v.close();
}

test("changing the master password in the vault page: Never carries on, and only the new one opens it", async () => {
  await choose("never");
  const NEW = "Different-Master-Pw-27!";
  await changePassword(MASTER, NEW);
  expect(await kept()).toEqual({ kept: true, sealed: true });
  await bg(rig, `return (await chrome.runtime.sendMessage({ t: "sync" })).ok;`);
  expect(await unlocked()).toBe(true);

  await restart();
  await expect.poll(unlocked, { timeout: 15_000 }).toBe(true);
  await bg(rig, `return (await chrome.runtime.sendMessage({ t: "sync" })).ok;`);
  await new Promise((r) => setTimeout(r, 1000));
  expect(await unlocked()).toBe(true);
  expect((await kept()).kept).toBe(true);

  await lockExt(rig);
  await expect.poll(unlocked).toBe(false);
  const p = await rig.ctx.newPage();
  await p.goto(`chrome-extension://${rig.extId}/popup.html`);
  await p.getByLabel("Master password").fill(MASTER);
  await p.getByRole("button", { name: "Unlock" }).click();
  await expect(p.getByRole("alert")).toBeVisible({ timeout: 60_000 });
  await p.getByLabel("Master password").fill(NEW);
  await p.getByRole("button", { name: "Unlock" }).click();
  await expect(p.getByLabel("Search your vault")).toBeVisible({ timeout: 60_000 });
  await p.close();

  await changePassword(NEW, MASTER);
  await lockExt(rig);
  await expect.poll(unlocked).toBe(false);
  await unlockExt(rig);
});

test("Never: removing this device from elsewhere locks it and takes the secret away", async () => {
  await choose("never");
  expect((await kept()).kept).toBe(true);
  const web = await rig.ctx.newPage();
  await web.goto("/passwords");
  const status = await web.evaluate(async () => {
    const refreshed = await fetch("/api/auth/refresh", { method: "POST", credentials: "include" });
    const token = (await refreshed.json()).access_token as string;
    const headers = { Authorization: `Bearer ${token}` };
    const devices = (await (await fetch("/api/passwords/devices", { headers })).json()) as { id: string; platform: string }[];
    const theirs = devices.filter((d) => d.platform === "chromium");
    let last = 0;
    for (const d of theirs) last = (await fetch(`/api/passwords/devices/${d.id}`, { method: "DELETE", headers })).status;
    return last;
  });
  await web.close();
  expect(status).toBe(204);
  await bg(rig, `return (await chrome.runtime.sendMessage({ t: "sync" })).ok;`);
  await expect.poll(unlocked, { timeout: 15_000 }).toBe(false);
  expect((await kept()).kept).toBe(false);
  await restart();
  expect(await unlocked()).toBe(false);
  const pop = await rig.ctx.newPage();
  await pop.goto(`chrome-extension://${rig.extId}/popup.html`);
  await expect(pop.getByLabel("Master password")).toBeVisible();
  await pop.close();
});

test("Never: a vault reset elsewhere locks it and takes the secret away", async () => {
  await rig.close();
  rig = await launchHere();
  const [u] = makeUsers(["stays2"]);
  await connect(rig, u);
  await unlockExt(rig);
  await choose("never");
  expect((await kept()).kept).toBe(true);

  const web = await rig.ctx.newPage();
  await web.goto("/passwords");
  await expect(web.getByLabel("Master password")).toBeVisible({ timeout: 20_000 });
  await web.getByText("I've lost my master password and my kit").click();
  await web.getByRole("button", { name: "Reset vault…" }).click();
  await web.getByLabel("Your Promptly sign-in password").fill(u.password);
  await web.getByLabel("Type DELETE MY VAULT").fill("DELETE MY VAULT");
  await web.getByRole("button", { name: "Destroy my vault" }).click();
  await expect(web.getByText("I understand")).toBeVisible({ timeout: 30_000 });
  await web.close();

  await bg(rig, `return (await chrome.runtime.sendMessage({ t: "sync" })).ok;`);
  await expect.poll(unlocked, { timeout: 15_000 }).toBe(false);
  expect((await kept()).kept).toBe(false);
});
