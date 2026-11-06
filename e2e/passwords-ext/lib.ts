// Starts Chromium with the extension's test build, on local fixture pages.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type BrowserContext, chromium, expect, type Frame, type Page } from "@playwright/test";

import { BASE, makeUsers, MASTER, onboard, type User } from "../passwords-tests/helpers";

export { BASE, makeUsers, MASTER, onboard };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT = path.join(ROOT, "passwords", "extension", "dist", "chrome-test");
const SITE = path.join(ROOT, "passwords", "test-sites", "ext");

export const PORT_A = 8111;
export const PORT_B = 8112;

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json" };

export function startSite(): Promise<{ close: () => void }> {
  const servers = [PORT_A, PORT_B].map((port) =>
    http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const rel = url.pathname.replace(/^\/ext\//, "").replace(/^\//, "");
      const file = path.join(SITE, rel);
      if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "text/plain", "Cache-Control": "no-store" });
      fs.createReadStream(file).pipe(res);
    }).listen(port, "127.0.0.1"),
  );
  return Promise.all(servers.map((s) => new Promise((r) => s.listening ? r(null) : s.once("listening", r)))).then(() => ({ close: () => servers.forEach((s) => s.close()) }));
}

export type Rig = { ctx: BrowserContext; extId: string; dir: string; close: () => Promise<void> };

export async function launch(): Promise<Rig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-ext-"));
  // Playwright's own full Chromium won't start on this machine (a Windows side-by-side
  // error, logged in DECISIONS.md), and branded Chrome ignores --load-extension. It does
  // take the DevTools route, with a throwaway profile, so this tests the real browser.
  const channel = process.env.PW_EXT_CHANNEL ?? "chrome";
  const ctx = await chromium.launchPersistentContext(dir, {
    channel,
    headless: true,
    baseURL: BASE,
    ignoreDefaultArgs: ["--disable-extensions"],
    viewport: { width: 1280, height: 860 },
    args: ["--enable-unsafe-extension-debugging", "--disable-features=DisableLoadExtensionCommandLineSwitch"],
  });
  const browser = ctx.browser();
  if (!browser) throw new Error("No browser object for the persistent context");
  const cdp = await browser.newBrowserCDPSession();
  const loaded = (await cdp.send("Extensions.loadUnpacked" as never, { path: EXT } as never)) as unknown as { id: string };
  const extId = loaded.id;
  return {
    ctx,
    extId,
    dir,
    close: async () => {
      await ctx.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function signIn(rig: Rig, user: User) {
  await rig.ctx.addCookies([{ name: "promptly_refresh", value: user.refresh, domain: "localhost", path: "/api/auth", httpOnly: true, secure: false, sameSite: "Strict", expires: Math.floor(Date.now() / 1000) + 86400 }]);
}

/** A vault on the web, then this extension connected and given the Secret Key. */
export async function connect(rig: Rig, user: User): Promise<string> {
  await signIn(rig, user);
  const web = await rig.ctx.newPage();
  const secret = await onboard(web);
  await web.close();

  const page = await rig.ctx.newPage();
  await page.goto(`chrome-extension://${rig.extId}/vault.html`);
  await page.getByLabel("Your server's address").fill(BASE);
  const approve = rig.ctx.waitForEvent("page");
  await page.getByRole("button", { name: "Connect" }).click();
  const tab = await approve;
  await tab.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(tab.getByText("Connected.")).toBeVisible();
  await tab.close();

  await page.getByRole("button", { name: "Use my recovery kit" }).click();
  await page.getByLabel("Secret Key").fill(secret);
  await page.getByLabel("Master password").fill(MASTER);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  // The kit step finishes, then the page reloads into the locked vault.
  await expect(page.getByText("Your vault is locked")).toBeVisible({ timeout: 60_000 });
  await page.close();
  return secret;
}

export async function tabIdOf(rig: Rig, page: Page): Promise<number> {
  return bg<number>(rig, `const tabs = await chrome.tabs.query({}); return tabs.find((x) => x.url === arg)?.id ?? -1;`, page.url());
}

/** The popup page, opened in a tab and aimed at another tab (test builds only). */
export async function popupFor(rig: Rig, page: Page): Promise<Page> {
  const id = await tabIdOf(rig, page);
  const p = await rig.ctx.newPage();
  await p.goto(`chrome-extension://${rig.extId}/popup.html?tab=${id}`);
  return p;
}

/** Runs with the extension's privileges, in one of its own pages. */
export async function bg<T>(rig: Rig, fnBody: string, arg?: unknown): Promise<T> {
  const page = await rig.ctx.newPage();
  try {
    await page.goto(`chrome-extension://${rig.extId}/menu.html`);
    return await page.evaluate(new Function("arg", `return (async () => { ${fnBody} })()`) as (a: unknown) => Promise<T>, arg);
  } finally {
    await page.close();
  }
}

export async function unlockExt(rig: Rig) {
  const p = await rig.ctx.newPage();
  await p.goto(`chrome-extension://${rig.extId}/popup.html`);
  await p.getByLabel("Master password").fill(MASTER);
  await p.getByRole("button", { name: "Unlock" }).click();
  await expect(p.getByLabel("Search your vault")).toBeVisible({ timeout: 60_000 });
  await p.close();
}

export async function lockExt(rig: Rig) {
  const p = await rig.ctx.newPage();
  await p.goto(`chrome-extension://${rig.extId}/popup.html`);
  await p.getByRole("button", { name: "Lock" }).click();
  await p.close();
}

export async function addItem(rig: Rig, fields: { title: string; url: string; username: string; password: string }) {
  const p = await rig.ctx.newPage();
  await p.goto(`chrome-extension://${rig.extId}/popup.html`);
  await p.evaluate(async (f) => {
    await chrome.runtime.sendMessage({ t: "addLogin", title: f.title, url: f.url, username: f.username, password: f.password });
  }, fields);
  await p.close();
}

export function menuFrame(page: Page): Frame | undefined {
  return page.frames().find((f) => f.url().includes("/menu.html"));
}

export const siteA = (path_: string) => `http://localhost:${PORT_A}/${path_}`;
export const siteB = (path_: string) => `http://localhost:${PORT_B}/${path_}`;
