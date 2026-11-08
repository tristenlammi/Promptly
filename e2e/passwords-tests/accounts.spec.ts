// "Accounts not in your vault": sites from the person's own mail, compared with the vault
// in the browser. Add login, Not an account, and the delete-account helper with its
// draft in Mail. Mail rows are seeded straight into the stack's database.
import { execFileSync } from "node:child_process";

import { expect, type Page, test } from "@playwright/test";

import { addLogin, BACKEND, makeUsers, onboard, signedIn, unlock, type User } from "./helpers";

test.describe.configure({ timeout: 240_000 });

type Seed = { subject: string; from: string; days: number; html?: string };

/** One mailbox for the user, with these messages in its inbox. Prints the mailbox's address. */
function seedMail(u: User, mails: Seed[]): string {
  const out = execFileSync("docker", ["exec", "-i", BACKEND, "python"], {
    encoding: "utf8",
    input: `
import asyncio, json, uuid
from datetime import datetime, timedelta, timezone
from sqlalchemy import select
import app.db_models
from app.database import SessionLocal
from app.mail.models import MailAccount, MailFolder, MailMessage
MAILS = json.loads(${JSON.stringify(JSON.stringify(mails))})
async def main():
    async with SessionLocal() as db:
        uid = uuid.UUID("${u.id}")
        acc = MailAccount(user_id=uid, email=f"sam-{uuid.uuid4().hex[:8]}@example.com", imap_host="localhost", imap_port=993, imap_security="ssl", smtp_host="localhost", smtp_port=465, smtp_security="ssl", username="x", secret_encrypted="x", status="ok")
        db.add(acc)
        await db.flush()
        inbox = MailFolder(account_id=acc.id, path="INBOX", name="Inbox", role="inbox", uidvalidity=1)
        trash = MailFolder(account_id=acc.id, path="Trash", name="Trash", role="trash", uidvalidity=1)
        db.add_all([inbox, trash])
        await db.flush()
        for i, m in enumerate(MAILS):
            db.add(MailMessage(account_id=acc.id, folder_id=inbox.id, uid=i + 1, thread_key=uuid.uuid4().hex, subject=m["subject"], from_name="", from_addr=m["from"],
                               to_addrs=[{"name": "", "addr": acc.email}], sent_at=datetime.now(timezone.utc) - timedelta(days=m["days"]), body_html=m.get("html", "")))
        db.add(MailMessage(account_id=acc.id, folder_id=trash.id, uid=1, thread_key=uuid.uuid4().hex, subject="Welcome to Binned", from_addr="hi@binned.test", sent_at=datetime.now(timezone.utc)))
        await db.commit()
        print("PW_MAILBOX " + acc.email)
asyncio.run(main())
`,
  });
  const line = out.split(/\r?\n/).find((l) => l.startsWith("PW_MAILBOX "));
  if (!line) throw new Error(out);
  return line.slice("PW_MAILBOX ".length).trim();
}

async function nav(page: Page, name: string) {
  await page.getByRole("navigation", { name: "Passwords" }).getByText(name, { exact: true }).click();
}

test("accounts from mail: hides what's in the vault, Add login, Not an account, and deleting", async ({ browser }) => {
  const [u] = makeUsers(["accounts"]);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  await onboard(page);
  await addLogin(page, { title: "Netflix", username: "sam", password: "Some-Passw0rd!x", url: "https://www.netflix.com/" });
  const address = seedMail(u, [
    { subject: "Welcome to Netflix!", from: "info@mailer.netflix.com", days: 400 },
    { subject: "Your receipt from Acme", from: "billing@acme.test", days: 30 },
    { subject: "Verify your email", from: "bounce@sendgrid.net", days: 10, html: '<a href="https://app.widgetco.test/verify?t=1">Verify</a>' },
    { subject: "Reset your password", from: "no-reply@oldshop.test", days: 3 },
    { subject: "Fwd: Welcome to Hulu", from: "friend@gmail.com", days: 2 },
    { subject: "This week's newsletter", from: "news@paper.test", days: 1 },
  ]);

  await nav(page, "Security check");
  const panel = page.getByTestId("mail-accounts");
  await expect(panel.getByTestId("count-mail-accounts")).toHaveText("3");
  for (const d of ["acme.test", "widgetco.test", "oldshop.test"]) await expect(panel.getByTestId(`mail-account-${d}`)).toBeVisible();
  // In the vault already, forwarded, a newsletter, or in the Trash: not listed.
  for (const d of ["netflix.com", "gmail.com", "paper.test", "binned.test"]) await expect(panel.getByTestId(`mail-account-${d}`)).toHaveCount(0);
  await expect(panel.getByTestId("mail-account-acme.test")).toContainText(address);
  await expect(panel.getByTestId("mail-account-acme.test")).toContainText("receipt");

  // Add login: the editor opens with the site and the address it wrote to.
  await panel.getByTestId("mail-account-acme.test").getByRole("button", { name: "Add login" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Acme");
  await expect(dialog.getByLabel("Username or email")).toHaveValue(address);
  await expect(dialog.getByLabel("Website 1", { exact: true })).toHaveValue("https://acme.test");
  await dialog.getByLabel("Password", { exact: true }).fill("New-Passw0rd!acme");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByTestId("mail-account-acme.test")).toHaveCount(0);
  await expect(panel.getByTestId("count-mail-accounts")).toHaveText("2");

  // Not an account: gone, and still gone after a reload, since it's kept in the vault.
  await panel.getByTestId("mail-account-widgetco.test").getByRole("button", { name: "Not an account" }).click();
  await expect(panel.getByTestId("mail-account-widgetco.test")).toHaveCount(0);

  // Delete account: the helper, a draft in Mail, then marked until it's gone.
  await panel.getByTestId("mail-account-oldshop.test").getByRole("button", { name: "Delete account…" }).click();
  const help = page.getByTestId("delete-help");
  await expect(help.getByRole("link", { name: "Their account settings" })).toHaveAttribute("href", "https://oldshop.test/.well-known/change-password");
  const draft = help.getByRole("link", { name: "Write a deletion request in Mail" });
  await expect(draft).toHaveAttribute("href", /\/mail\?compose=1#to=privacy%40oldshop\.test&/);
  await expect(help).toContainText("privacy@oldshop.test is a guess");
  const href = (await draft.getAttribute("href"))!;
  await help.getByRole("button", { name: "Mark as deleting" }).click();
  const row = panel.getByTestId("mail-account-oldshop.test");
  await expect(row).toContainText("Deleting");

  // The draft opens in Mail, filled in and not sent.
  const mail = await ctx.newPage();
  await mail.goto(href);
  await expect(mail.getByLabel("To", { exact: true })).toHaveValue("privacy@oldshop.test");
  await expect(mail.getByLabel("Subject")).toHaveValue(new RegExp(`Request to delete my account and personal data \\(${address.replace(/[.+]/g, "\\$&")}\\)`));
  await expect(mail.getByText("Please delete my account with oldshop.test")).toBeVisible();
  expect(new URL(mail.url()).hash).toBe("");
  await mail.close();

  await page.reload();
  await unlock(page);
  await nav(page, "Security check");
  await expect(panel.getByTestId("mail-account-widgetco.test")).toHaveCount(0);
  await expect(panel.getByTestId("mail-account-oldshop.test")).toContainText("Deleting");
  await panel.getByTestId("mail-account-oldshop.test").getByRole("button", { name: "It's gone" }).click();
  await expect(panel.getByTestId("mail-account-oldshop.test")).toHaveCount(0);
  await expect(panel.getByTestId("count-mail-accounts")).toHaveText("0");
});

test("no mailbox, no panel; and another user's mail is never listed", async ({ browser }) => {
  const [a, b] = makeUsers(["acc-a", "acc-b"]);
  seedMail(b, [{ subject: "Welcome to Theirs", from: "hi@theirs.test", days: 1 }]);
  const ctx = await signedIn(browser, a);
  const page = await ctx.newPage();
  await onboard(page);
  await nav(page, "Security check");
  await expect(page.getByRole("heading", { name: "Security check" })).toBeVisible();
  await expect(page.getByTestId("mail-accounts")).toHaveCount(0);
});
