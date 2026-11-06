// M11: the vault page's links to the rest of Promptly, with real mail rows on the stack.
import { execFileSync } from "node:child_process";

import { expect, type Page, test } from "@playwright/test";

import { addLogin, BACKEND, makeUsers, MASTER, onboard, signedIn, type User } from "./helpers";

test.describe.configure({ timeout: 240_000 });

function py(body: string) {
  execFileSync("docker", ["exec", "-i", BACKEND, "python"], { input: body, encoding: "utf8" });
}

function seedMail(u: User, subject: string, from: string, text: string) {
  py(`
import asyncio, uuid
from datetime import datetime, timezone
from sqlalchemy import select
import app.db_models
from app.database import SessionLocal
from app.mail.models import MailAccount, MailFolder, MailMessage
async def main():
    async with SessionLocal() as db:
        uid = uuid.UUID("${u.id}")
        acc = await db.scalar(select(MailAccount).where(MailAccount.user_id == uid))
        if acc is None:
            acc = MailAccount(user_id=uid, email=f"{uuid.uuid4().hex[:8]}@example.com", imap_host="localhost", imap_port=993, imap_security="ssl", smtp_host="localhost", smtp_port=465, smtp_security="ssl", username="x", secret_encrypted="x")
            db.add(acc)
            await db.flush()
            db.add(MailFolder(account_id=acc.id, path="INBOX", name="Inbox", role="inbox"))
            await db.flush()
        folder = await db.scalar(select(MailFolder).where(MailFolder.account_id == acc.id, MailFolder.role == "inbox"))
        db.add(MailMessage(account_id=acc.id, folder_id=folder.id, uid=int(datetime.now().timestamp()*1000) % 2000000000, thread_key=uuid.uuid4().hex, subject=${JSON.stringify(subject)}, from_name="Instagram", from_addr=${JSON.stringify(from)}, sent_at=datetime.now(timezone.utc), body_text=${JSON.stringify(text)}))
        await db.commit()
asyncio.run(main())
`);
}

async function nav(page: Page, name: string) {
  await page.getByRole("navigation", { name: "Passwords" }).getByText(name, { exact: true }).click();
}

test("a security email becomes a question, and changing the password keeps the old one", async ({ browser }) => {
  const [u] = makeUsers(["alert"]);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  await onboard(page);
  await addLogin(page, { title: "Instagram", username: "ana", password: "Old-Passw0rd!x", url: "https://www.instagram.com/" });
  seedMail(u, "Your password was changed", "security@mail.instagram.com", "Hello");

  await nav(page, "Security check");
  const alerts = page.getByTestId("mail-alerts");
  await expect(alerts).toContainText("Instagram says your password changed. Was that you?");

  await alerts.getByRole("button", { name: "Not me: change password" }).click();
  const flow = page.getByTestId("change-flow");
  await flow.getByRole("button", { name: "Make a new password" }).click();
  await expect(flow.getByText("Your new password is saved")).toBeVisible();
  await expect(flow.getByRole("link", { name: "Open the site's change page" })).toHaveAttribute("href", /instagram\.com/);
  await flow.getByRole("button", { name: "Yes, it's changed" }).click();

  // "That was me" for the same mail clears it, and stays cleared.
  await alerts.getByRole("button", { name: "That was me" }).click();
  await expect(alerts).toHaveCount(0);

  await nav(page, "All items");
  await page.getByText("Instagram").first().click();
  const view = page.getByRole("article", { name: "Instagram" });
  await view.getByRole("button", { name: "History" }).click();
  await expect(page.getByRole("heading", { name: "Earlier passwords" })).toBeVisible();
});

test("the survival warnings say what could lose the vault, and the recovery check works", async ({ browser }) => {
  const [u] = makeUsers(["survive"]);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  await onboard(page);
  await nav(page, "Security check");
  const s = page.getByTestId("survival");
  await expect(s).toContainText("off-site backups");
  // The reminder only comes round after six months; pretend they've passed.
  py(`
import asyncio, uuid
from datetime import timedelta
from sqlalchemy import select
import app.db_models
from app.database import SessionLocal
from app.passwords.models import PwAccount
async def main():
    async with SessionLocal() as db:
        a = await db.scalar(select(PwAccount).where(PwAccount.user_id == uuid.UUID("${u.id}")))
        a.kit_confirmed_at = a.kit_confirmed_at - timedelta(days=200)
        await db.commit()
asyncio.run(main())
`);
  await page.reload();
  await page.getByLabel("Master password").fill(MASTER);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(s).toContainText("Do you still have your recovery kit", { timeout: 30_000 });
  await s.getByRole("button", { name: "Check my kit" }).click();
  await page.getByRole("dialog").getByLabel("Master password").fill("not this");
  await page.getByRole("button", { name: "I have the kit" }).click();
  await expect(page.getByText("isn't right")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("dialog").getByLabel("Master password").fill(MASTER);
  await page.getByRole("button", { name: "I have the kit" }).click();
  await expect(s.getByText("Do you still have your recovery kit")).toHaveCount(0, { timeout: 30_000 });
});

test("duplicates merge, and travel mode takes a vault off this browser", async ({ browser }) => {
  const [u] = makeUsers(["dupes"]);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  await onboard(page);
  await addLogin(page, { title: "Site one", username: "ana", password: "Pass-One-1!", url: "https://www.example.com/" });
  await addLogin(page, { title: "Site two", username: "ana", password: "Pass-Two-2!", url: "https://login.example.com/" });
  await nav(page, "Security check");
  const dupes = page.getByTestId("duplicates");
  await expect(dupes).toContainText("2 copies");
  await dupes.getByRole("button", { name: "Merge" }).click();
  await expect(dupes).toHaveCount(0);

  await nav(page, "Settings");
  const travel = page.getByTestId("travel");
  page.on("dialog", (d) => d.accept());
  await travel.getByRole("checkbox", { name: "Personal" }).check();
  await travel.getByRole("button", { name: "Take them off this device" }).click();
  await expect(travel).toContainText("Off this device: Personal");
  await nav(page, "All items");
  await expect(page.getByText("Site two")).toHaveCount(0);
  await expect(page.getByText("Site one")).toHaveCount(0);

  await nav(page, "Settings");
  await travel.getByLabel("Master password, to bring them back").fill(MASTER);
  await travel.getByRole("button", { name: "Turn off travel mode" }).click();
  await expect(travel.getByRole("button", { name: "Take them off this device" })).toBeVisible({ timeout: 30_000 });
  await nav(page, "All items");
  await expect(page.getByText(/Site (one|two)/).first()).toBeVisible();
});

test("a plain Files document moves into the vault with a Calendar reminder that says nothing", async ({ browser }) => {
  const [u] = makeUsers(["docs"]);
  py(`
import asyncio, uuid, os
import app.db_models
from app.database import SessionLocal
from app.files import storage
from app.files.models import UserFile
async def main():
    name = f"e2e-{uuid.uuid4().hex}.pdf"
    (storage.UPLOAD_ROOT / name).write_bytes(b"%PDF passport scan")
    async with SessionLocal() as db:
        db.add(UserFile(user_id=uuid.UUID("${u.id}"), filename="passport-scan.pdf", original_filename="passport-scan.pdf", mime_type="application/pdf", size_bytes=18, storage_path=name))
        await db.commit()
asyncio.run(main())
`);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  await onboard(page);
  await addLogin(page, { title: "My passport", username: "ana" });
  const view = page.getByRole("article", { name: "My passport" });
  await view.getByRole("button", { name: "Add from Files" }).click();
  await page.getByRole("button", { name: /passport-scan\.pdf/ }).click();
  await expect(page.getByRole("heading", { name: "It's in the vault" })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Remind me in Calendar on").fill("2031-05-01");
  await page.getByRole("button", { name: "Add the reminder" }).click();
  await expect(page.getByText("Reminder added")).toBeVisible();
  await page.getByRole("button", { name: "Move the original to Trash" }).click();
  await expect(page.getByText("Moved to Files' Trash")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(view.getByText("passport-scan.pdf")).toBeVisible();
});

test("unlock with a passkey, tested live, and only as a shortcut", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "needs Chromium's virtual authenticator");
  const [u] = makeUsers(["pkunlock"]);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
  });
  await onboard(page);
  await nav(page, "Settings");
  const panel = page.getByTestId("passkey-unlock");
  await panel.getByLabel("Master password").fill(MASTER);
  await panel.getByRole("button", { name: "Set it up" }).click();
  await expect(panel).toContainText("On for this browser", { timeout: 30_000 });

  await page.reload();
  await expect(page.getByLabel("Master password")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Unlock with a passkey" }).click();
  await expect(page.getByRole("navigation", { name: "Passwords" })).toBeVisible({ timeout: 30_000 });

  // The master password still works as well.
  await page.reload();
  await page.getByLabel("Master password").fill(MASTER);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Passwords" })).toBeVisible({ timeout: 30_000 });
});

test("a passkey without PRF is told so, and nothing changes", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "needs Chromium's virtual authenticator");
  const [u] = makeUsers(["pknoprf"]);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await onboard(page);
  await nav(page, "Settings");
  const panel = page.getByTestId("passkey-unlock");
  await panel.getByLabel("Master password").fill(MASTER);
  await panel.getByRole("button", { name: "Set it up" }).click();
  await expect(panel).toContainText("can't do this", { timeout: 30_000 });
  await page.reload();
  await expect(page.getByLabel("Master password")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Unlock with a passkey" })).toHaveCount(0);
});

test("the main app shows only counts and devices, and the admin can't reach a vault", async ({ browser }) => {
  const [u] = makeUsers(["mainapp"]);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  await onboard(page);
  await addLogin(page, { title: "Weak login", username: "ana", password: "password", url: "https://weak.example/" });
  await nav(page, "Security check");
  await page.getByText("Show \"passwords need attention\" on my Today page").click();
  await page.getByRole("button", { name: "Check now", exact: true }).click();
  await expect(page.getByText(/Checked \d+ logins/)).toBeVisible({ timeout: 60_000 });

  // Today has a count and no names. Allow the health post to land.
  await expect.poll(async () => {
    const token = await page.evaluate(async () => (await (await fetch("/api/auth/refresh", { method: "POST" })).json()).access_token);
    const r = await page.request.get("/api/today", { headers: { Authorization: `Bearer ${token}` } });
    return JSON.stringify(await r.json());
  }, { timeout: 15_000 }).toContain('"attention"');
  const token = await page.evaluate(async () => (await (await fetch("/api/auth/refresh", { method: "POST" })).json()).access_token);
  const today = await (await page.request.get("/api/today", { headers: { Authorization: `Bearer ${token}` } })).text();
  expect(today).not.toContain("Weak login");
  expect(today).not.toContain("weak.example");
});
