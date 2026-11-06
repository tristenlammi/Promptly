// The release build itself, as far as a test can take it. A browser's prompt for host
// access can't be clicked by a test, so this can't get as far as filling: see the report.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { launch, type Rig } from "./lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "..", "..", "passwords", "extension", "dist", "chrome");

test.describe.configure({ mode: "serial" });

let rig: Rig;

test.beforeAll(async () => {
  test.skip(!fs.existsSync(path.join(DIST, "background.js")), "Needs a release build: node build.mjs all");
  rig = await launch(DIST);
});

test.afterAll(async () => {
  await rig?.close();
});

test("loads, asks to connect, and holds no standing access", async () => {
  const page = await rig.ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`chrome-extension://${rig.extId}/popup.html`);
  await expect(page.getByText("Connect to your Promptly")).toBeVisible();
  const facts = await page.evaluate(async () => ({
    manifest: chrome.runtime.getManifest() as unknown as { permissions: string[]; optional_permissions: string[]; host_permissions?: string[] },
    scripts: (await chrome.scripting.getRegisteredContentScripts()).length,
    allSites: await chrome.permissions.contains({ origins: ["https://*/*"] }),
    clipboard: await chrome.permissions.contains({ permissions: ["clipboardRead"] }),
  }));
  expect(facts.manifest.host_permissions).toBeUndefined();
  expect(facts.manifest.permissions).toContain("offscreen");
  expect(facts.manifest.permissions).not.toContain("clipboardRead");
  expect(facts.manifest.optional_permissions).toContain("clipboardRead");
  expect(facts.scripts).toBe(0);
  expect(facts.allSites).toBe(false);
  expect(facts.clipboard).toBe(false);
  expect(errors).toEqual([]);
  await page.close();
});

test("test hooks answer nothing, and the test key isn't there", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(`chrome-extension://${rig.extId}/popup.html`);
  const out = await page.evaluate(async () => {
    const hook = await chrome.runtime.sendMessage({ t: "test", op: "items" });
    const key = await fetch(chrome.runtime.getURL("rules/test-key.jwk.json")).then((r) => r.status, () => "gone");
    const pack = await fetch(chrome.runtime.getURL("rules/pack.json")).then((r) => r.ok, () => false);
    return { hook, key, pack };
  });
  expect(out.hook?.r).toBeUndefined();
  expect(out.key).not.toBe(200);
  expect(out.pack).toBe(true);
  await page.close();
});

test("the menu and save pages, framed with no token, say nothing", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(`chrome-extension://${rig.extId}/menu.html`);
  await expect(page.locator("#root")).not.toContainText("@");
  const reply = await page.evaluate(() => chrome.runtime.sendMessage({ t: "menuList" }));
  expect(reply === undefined || reply?.r === null || reply?.r?.candidates?.length === 0 || reply?.ok === true).toBe(true);
  await page.close();
});
