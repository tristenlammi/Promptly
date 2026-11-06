// M11 in the extension: codes from mail in the inline menu, new passwords while changing
// one, a short PIN, reading a QR code off the page, and fill on load when an item asks.
import { execFileSync } from "node:child_process";

import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";

const QRCode = createRequire(import.meta.url)("../../frontend/node_modules/qrcode");

import { BACKEND } from "../passwords-tests/helpers";
import { addItem, connect, launch, lockExt, makeUsers, MASTER, menuFrame, popupFor, type Rig, siteA, startSite, tabIdOf, unlockExt } from "./lib";

test.describe.configure({ mode: "serial", timeout: 120_000 });

let rig: Rig;
let site: { close: () => void };
let user: ReturnType<typeof makeUsers>[number];

function seedMail(subject: string, from: string, text: string) {
  execFileSync("docker", ["exec", "-i", BACKEND, "python"], {
    encoding: "utf8",
    input: `
import asyncio, uuid
from datetime import datetime, timezone
from sqlalchemy import select
import app.db_models
from app.database import SessionLocal
from app.mail.models import MailAccount, MailFolder, MailMessage
async def main():
    async with SessionLocal() as db:
        uid = uuid.UUID("${user.id}")
        acc = await db.scalar(select(MailAccount).where(MailAccount.user_id == uid))
        if acc is None:
            acc = MailAccount(user_id=uid, email=f"{uuid.uuid4().hex[:8]}@example.com", imap_host="localhost", imap_port=993, imap_security="ssl", smtp_host="localhost", smtp_port=465, smtp_security="ssl", username="x", secret_encrypted="x")
            db.add(acc)
            await db.flush()
            db.add(MailFolder(account_id=acc.id, path="INBOX", name="Inbox", role="inbox"))
            await db.flush()
        folder = await db.scalar(select(MailFolder).where(MailFolder.account_id == acc.id, MailFolder.role == "inbox"))
        db.add(MailMessage(account_id=acc.id, folder_id=folder.id, uid=int(datetime.now().timestamp()*1000) % 2000000000, thread_key=uuid.uuid4().hex, subject=${JSON.stringify(subject)}, from_name="Netflix", from_addr=${JSON.stringify(from)}, sent_at=datetime.now(timezone.utc), body_text=${JSON.stringify(text)}))
        await db.commit()
asyncio.run(main())
`,
  });
}

test.beforeAll(async () => {
  makeUsers(["root"], "admin");
  site = await startSite();
  rig = await launch();
  [user] = makeUsers(["extconn"]);
  await connect(rig, user);
  await unlockExt(rig);
});

test.afterAll(async () => {
  await rig?.close();
  site?.close();
});

async function openMenu(page: Page, selector: string) {
  await page.click(selector);
  await expect.poll(() => !!menuFrame(page), { timeout: 10_000 }).toBe(true);
  const f = menuFrame(page)!;
  await f.waitForLoadState();
  return f;
}

async function vaultPage(): Promise<Page> {
  const p = await rig.ctx.newPage();
  await p.goto(`chrome-extension://${rig.extId}/vault.html`);
  await expect(p.getByRole("navigation", { name: "Passwords" })).toBeVisible({ timeout: 30_000 });
  return p;
}

test("mail codes stay off until turned on, then fill from the menu as text", async () => {
  seedMail("Your verification code", "no-reply@netflix.com", "Your code is 482913");

  const off = await rig.ctx.newPage();
  await off.goto(siteA("otp.html"));
  const f0 = await openMenu(off, "#code");
  await expect(f0.getByText("No saved logins for this site.")).toBeVisible();
  await expect(f0.getByText(/Code from email/)).toHaveCount(0);
  await off.close();

  const v = await vaultPage();
  await v.getByRole("navigation", { name: "Passwords" }).getByText("Settings").click();
  await v.getByTestId("ext-settings").getByRole("checkbox", { name: /codes and sign-in links/ }).click();
  await expect(v.getByTestId("ext-settings").getByRole("checkbox", { name: /codes and sign-in links/ })).toBeChecked();
  await v.close();

  const page = await rig.ctx.newPage();
  await page.goto(siteA("otp.html"));
  const f = await openMenu(page, "#code");
  const row = f.getByRole("button", { name: /Fill code from netflix.com/ });
  await expect(row).toBeVisible();
  await expect(f.getByText("Code from email: 482913")).toBeVisible();
  // Localhost isn't netflix.com, and the menu says so.
  await expect(f.getByText(/from Netflix, .* Not from this site/)).toBeVisible();
  await page.waitForTimeout(500);
  await row.click();
  await expect.poll(() => page.evaluate(() => (window as any).__state())).toEqual({ code: "482913" });
  await page.close();
});

test("the page never gets mail codes, and they're not in the page's DOM", async () => {
  const page = await rig.ctx.newPage();
  await page.goto(siteA("otp.html"));
  await openMenu(page, "#code");
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  expect(html).not.toContain("482913");
  await page.close();
});

test("a code from a lookalike sender doesn't fill on one click, and only after a plain warning", async () => {
  await addItem(rig, { title: "Netflix real", url: "https://netflix.com", username: "ana", password: "Pw-1!" });
  seedMail("Your verification code", "no-reply@netfl1x.com", "Your code is 771204");
  const page = await rig.ctx.newPage();
  await page.goto(siteA("otp.html"));
  const f = await openMenu(page, "#code");
  const row = f.getByRole("button", { name: "Fill code from netfl1x.com", exact: true });
  await expect(row).toBeVisible();
  await page.waitForTimeout(500);
  await row.click();
  // One click gets a warning that names both, with the safe answer first, and nothing filled.
  await expect(f.getByText(/netfl1x.com, which looks like netflix.com/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).__state())).toEqual({ code: "" });
  await expect(f.getByRole("button").first()).toHaveAccessibleName("Don't fill");
  await f.getByRole("button", { name: "Don't fill" }).click();
  await expect(f.getByRole("button", { name: "Fill code from netfl1x.com", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__state())).toEqual({ code: "" });

  // A double click on the row can't answer the warning that appears under it.
  await f.getByRole("button", { name: "Fill code from netfl1x.com", exact: true }).click();
  await f.getByRole("button", { name: "Fill code from netfl1x.com anyway" }).click();
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).__state())).toEqual({ code: "" });

  // Asked for and answered: now it fills.
  await page.waitForTimeout(700);
  await f.getByRole("button", { name: "Fill code from netfl1x.com anyway" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__state())).toEqual({ code: "771204" });
  await page.close();
});

test("the background decides too: no confirmation, no fill, and a lookalike's link never opens", async () => {
  seedMail("Sign in to your account", "no-reply@netfl1x.com", "Sign in here: https://netfl1x.com/magic?code=abc");
  const page = await rig.ctx.newPage();
  await page.goto(siteA("otp.html"));
  const f = await openMenu(page, "#code");
  await expect(f.getByRole("button", { name: "Fill code from netflix.com", exact: true }).first()).toBeVisible();
  // There's no row for that link at all.
  await expect(f.getByRole("button", { name: /Open sign-in link from netfl1x.com/ })).toHaveCount(0);

  // The menu frame asking directly, past its own check.
  const rows = await f.evaluate(async () => (await chrome.runtime.sendMessage({ t: "menuList" })).r.mail as { id: string; domain: string; code: string | null; hasLink: boolean; lookalike: string | null }[]);
  const fake = rows.filter((r) => r.domain === "netfl1x.com");
  expect(fake.every((r) => r.lookalike === "netflix.com")).toBe(true);
  await page.waitForTimeout(500);
  const withCode = fake.find((r) => r.code)!;
  const code = await f.evaluate(async (id) => chrome.runtime.sendMessage({ t: "menuMailCode", id }), withCode.id);
  expect(code.r.ok).toBe(false);
  expect(code.r.reason).toBe("lookalike");
  expect(await page.evaluate(() => (window as any).__state())).toEqual({ code: "" });

  const before = page.url();
  const withLink = fake.find((r) => r.hasLink);
  expect(withLink, JSON.stringify(fake)).toBeTruthy();
  const link = await f.evaluate(async (id) => chrome.runtime.sendMessage({ t: "menuMailLink", id }), withLink!.id);
  expect(link.r.ok).toBe(false);
  await page.waitForTimeout(300);
  expect(page.url()).toBe(before);
  await page.close();
});

test("a real sender's code on a page that looks like a saved site gets the warning too", async () => {
  await addItem(rig, { title: "Lookalike home", url: "https://mybankingsite.localhost", username: "ana", password: "Pw-2!" });
  const page = await rig.ctx.newPage();
  await page.goto("http://mybank1ngsite.localhost:8111/otp.html");
  const f = await openMenu(page, "#code");
  const row = f.getByRole("button", { name: "Fill code from netflix.com", exact: true }).first();
  await expect(row).toBeVisible();
  await expect(f.getByRole("button", { name: /Open sign-in link/ })).toHaveCount(0);
  await page.waitForTimeout(500);
  await row.click();
  await expect(f.getByText(/This page looks like mybankingsite.localhost/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).__state())).toEqual({ code: "" });
  await page.close();
});

test("a pending new password fills the new boxes, and the old one the current box", async () => {
  await addItem(rig, { title: "Changer", url: "http://localhost:8111", username: "ana", password: "Old-Pass-1!" });
  const v = await vaultPage();
  await v.getByRole("navigation", { name: "Passwords" }).getByText("All items").click();
  await v.getByText("Changer").first().click();
  await v.getByRole("button", { name: "Change password" }).click();
  await v.getByTestId("change-flow").getByRole("button", { name: "Make a new password" }).click();
  await expect(v.getByTestId("change-flow").getByText("Your new password is saved")).toBeVisible();
  // The background sees the change through the shared copy.
  await v.waitForTimeout(1500);

  const page = await rig.ctx.newPage();
  await page.goto(siteA("change.html"));
  const pop = await popupFor(rig, page);
  await pop.getByRole("button", { name: "Fill Changer" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__state().current)).toBe("Old-Pass-1!");
  const s = await page.evaluate(() => (window as any).__state());
  expect(s.next).toBe(s.again);
  expect(s.next.length).toBeGreaterThanOrEqual(12);
  expect(s.next).not.toBe("Old-Pass-1!");
  await page.close();
  await pop.close().catch(() => undefined);

  // The site said yes: now it's the password, and the old one's in history.
  await v.getByTestId("change-flow").getByRole("button", { name: "Yes, it's changed" }).click();
  await v.getByRole("button", { name: "History" }).click();
  await expect(v.getByRole("heading", { name: "Earlier passwords" })).toBeVisible();
  await v.close();
});

test("a short PIN unlocks, and five wrong tries wipe it", async () => {
  const v = await vaultPage();
  await v.getByRole("navigation", { name: "Passwords" }).getByText("Settings").click();
  const s = v.getByTestId("ext-settings");
  await s.getByLabel("A short PIN for this browser").fill("4821");
  await s.getByRole("button", { name: "Set PIN" }).click();
  await expect(s.getByRole("button", { name: "Remove my PIN" })).toBeVisible({ timeout: 30_000 });
  await v.close();

  await lockExt(rig);
  const anchor = await rig.ctx.newPage();
  await anchor.goto(siteA("login.html"));
  let pop = await popupFor(rig, anchor);
  await pop.getByLabel("PIN", { exact: true }).fill("4821");
  await pop.getByRole("button", { name: "Use PIN" }).click();
  await expect(pop.getByLabel("Search your vault")).toBeVisible({ timeout: 30_000 });
  await pop.close();

  await lockExt(rig);
  pop = await popupFor(rig, anchor);
  for (let i = 0; i < 4; i++) {
    await pop.getByLabel("PIN", { exact: true }).fill("0000");
    await pop.getByRole("button", { name: "Use PIN" }).click();
    await expect(pop.getByText(`${4 - i} tries left`).or(pop.getByText("1 tries left"))).toBeVisible({ timeout: 30_000 });
  }
  await pop.getByLabel("PIN", { exact: true }).fill("0000");
  await pop.getByRole("button", { name: "Use PIN" }).click();
  await expect(pop.getByText("That was the last try")).toBeVisible({ timeout: 30_000 });
  await expect(pop.getByRole("button", { name: "Use PIN" })).toHaveCount(0);

  // The right PIN's no use now. Only the master password is.
  await pop.getByLabel("Master password").fill(MASTER);
  await pop.getByRole("button", { name: "Unlock" }).click();
  await expect(pop.getByLabel("Search your vault")).toBeVisible({ timeout: 30_000 });
  await pop.close();
  await anchor.close();
});

test("a QR code on the page becomes a 2FA code on the matching login", async () => {
  await addItem(rig, { title: "Qr site", url: "http://localhost:8111", username: "ana", password: "Pw-1!" });
  const uri = "otpauth://totp/Qr%20site:ana?secret=JBSWY3DPEHPK3PXP&issuer=Qr%20site";
  const data = await QRCode.toDataURL(uri, { width: 360, margin: 2 });
  const page = await rig.ctx.newPage();
  await page.goto(siteA("login.html"));
  await page.evaluate((src) => {
    const img = document.createElement("img");
    img.src = src;
    img.style.cssText = "position:fixed;top:10px;left:10px;width:360px;height:360px;z-index:9";
    document.body.appendChild(img);
  }, data);
  const tabId = await tabIdOf(rig, page);
  const helper = await rig.ctx.newPage();
  await helper.goto(`chrome-extension://${rig.extId}/popup.html`);
  await page.bringToFront();
  await page.waitForTimeout(300);
  const out = await helper.evaluate(async (id) => {
    const t = await chrome.tabs.get(id);
    await chrome.tabs.update(id, { active: true });
    const r = await chrome.runtime.sendMessage({ t: "scanTabQr", windowId: t.windowId });
    return r;
  }, tabId);
  expect(out.r?.uri, JSON.stringify(out)).toBe(uri);
  const saved = await helper.evaluate(async (u) => chrome.runtime.sendMessage({ t: "addTotp", itemId: null, uri: u, title: "Qr saved", url: "http://localhost:8111" }), uri);
  expect(saved.ok, JSON.stringify(saved)).toBe(true);
  await helper.close();
  await page.close();
});

test("fill on load only happens when the item asks", async () => {
  await addItem(rig, { title: "Onload", url: "http://localhost:8112", username: "ana", password: "Pw-Load-1!" });
  const site2 = "http://localhost:8112/login.html";
  const first = await rig.ctx.newPage();
  await first.goto(site2);
  await first.waitForTimeout(1500);
  expect(await first.evaluate(() => (window as any).__state().user)).toBe("");
  await first.close();

  const v = await vaultPage();
  await v.getByRole("navigation", { name: "Passwords" }).getByText("All items").click();
  await v.getByText("Onload").first().click();
  await v.getByRole("button", { name: "Edit" }).click();
  await v.getByRole("checkbox", { name: /page load|loads/i }).check();
  await v.getByRole("button", { name: "Save", exact: true }).click();
  await v.waitForTimeout(1500);
  await v.close();
  const second = await rig.ctx.newPage();
  await second.goto(site2);
  await expect.poll(() => second.evaluate(() => (window as any).__state().user), { timeout: 10_000 }).toBe("ana");
  await second.close();
});
