// Find stray passwords: a password sitting in Mail is found, saved into the vault through
// the item editor, and the original goes to Mail's Trash. A .env in Files is ignored for good.
import { execFileSync } from "node:child_process";

import { expect, type Page, test } from "@playwright/test";

import { BACKEND, makeUsers, onboard, signedIn, type User } from "./helpers";

test.describe.configure({ timeout: 240_000 });

const SECRET = "Kq7#vR2pLm-e2e";

function py(body: string): string {
  return execFileSync("docker", ["exec", "-i", BACKEND, "python"], { input: body, encoding: "utf8" });
}

function seed(u: User) {
  py(`
import asyncio, os, uuid
from datetime import datetime, timezone
import app.db_models
from app.database import SessionLocal
from app.files import storage
from app.files.models import UserFile
from app.mail.models import MailAccount, MailFolder, MailMessage
async def main():
    async with SessionLocal() as db:
        uid = uuid.UUID("${u.id}")
        acc = MailAccount(user_id=uid, email=f"{uuid.uuid4().hex[:8]}@example.com", imap_host="localhost", imap_port=993, imap_security="ssl", smtp_host="localhost", smtp_port=465, smtp_security="ssl", username="x", secret_encrypted="x")
        db.add(acc)
        await db.flush()
        inbox = MailFolder(account_id=acc.id, path="INBOX", name="Inbox", role="inbox")
        trash = MailFolder(account_id=acc.id, path="Trash", name="Trash", role="trash")
        db.add_all([inbox, trash])
        await db.flush()
        db.add(MailMessage(account_id=acc.id, folder_id=inbox.id, uid=101, thread_key=uuid.uuid4().hex, subject="Your new Acme account", from_name="Acme IT", from_addr="it@accounts.acme-mail.com", sent_at=datetime.now(timezone.utc), body_text="Hi,\\n\\nUsername: ana.e2e\\nTemporary password: ${SECRET}\\n\\nPlease change it when you first sign in."))
        db.add(MailMessage(account_id=acc.id, folder_id=inbox.id, uid=102, thread_key=uuid.uuid4().hex, subject="Reset your password", from_name="Acme", from_addr="no-reply@acme-mail.com", sent_at=datetime.now(timezone.utc), body_text="Click here to reset your password: https://acme-mail.com/reset/8f7d6s5a4b3c"))
        name = f"stray-e2e-{uuid.uuid4().hex}.env"
        data = b"DB_PASSWORD=Hq7-zz-91x-e2e\\n"
        (storage.UPLOAD_ROOT / name).write_bytes(data)
        db.add(UserFile(user_id=uid, filename=".env", original_filename=".env", mime_type="application/octet-stream", size_bytes=len(data), storage_path=name))
        await db.commit()
asyncio.run(main())
`);
}

function folderOf(u: User): string {
  return py(`
import asyncio, uuid
from sqlalchemy import select
import app.db_models
from app.database import SessionLocal
from app.mail.models import MailAccount, MailFolder, MailMessage
async def main():
    async with SessionLocal() as db:
        row = (await db.execute(select(MailFolder.role).join(MailMessage, MailMessage.folder_id == MailFolder.id).join(MailAccount, MailAccount.id == MailMessage.account_id).where(MailAccount.user_id == uuid.UUID("${u.id}"), MailMessage.subject == "Your new Acme account"))).first()
        print("PW_FOLDER", row[0] if row else None)
asyncio.run(main())
`)
    .split(/\r?\n/)
    .find((l) => l.startsWith("PW_FOLDER "))!
    .slice("PW_FOLDER ".length);
}

async function nav(page: Page, name: string) {
  await page.getByRole("navigation", { name: "Passwords" }).getByText(name, { exact: true }).click();
}

test("a password left in Mail is saved into the vault, then the email goes to Trash", async ({ browser }) => {
  const [u] = makeUsers(["stray"]);
  seed(u);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  await onboard(page);
  await nav(page, "Security check");

  const panel = page.getByTestId("stray");
  await panel.getByRole("button", { name: "Find stray passwords" }).click();
  const rows = panel.getByTestId("stray-row");
  await expect(rows).toHaveCount(2, { timeout: 90_000 });
  await expect(panel.getByTestId("stray-count")).toHaveText("2");
  // The reset email talks about a password and holds none, so it isn't here.
  await expect(panel).not.toContainText("Reset your password");
  const mailRow = rows.filter({ hasText: "Your new Acme account" });
  // A hint only: the list never holds the password itself.
  await expect(mailRow).toContainText("Kq••••2e");
  await expect(panel).not.toContainText(SECRET);

  await mailRow.getByRole("button", { name: "Save to vault" }).click();
  const editor = page.getByRole("dialog", { name: "Save to vault" });
  await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("acme-mail.com", { timeout: 30_000 });
  await expect(editor.getByLabel("Username or email")).toHaveValue("ana.e2e");
  await expect(editor.getByLabel("Password", { exact: true })).toHaveValue(SECRET);
  await expect(editor.getByLabel("Website 1", { exact: true })).toHaveValue("https://acme-mail.com");
  await editor.getByRole("button", { name: "Save" }).click();

  const ask = page.getByRole("dialog", { name: "It's in your vault" });
  await expect(ask).toContainText("Mail's Trash");
  await ask.getByRole("button", { name: "Move the original to Trash" }).click();
  await expect(ask).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await expect(panel.getByTestId("stray-count")).toHaveText("1");
  expect(folderOf(u)).toBe("trash");

  // The .env: hidden for good, and a fresh check doesn't bring it back.
  page.once("dialog", (d) => d.accept());
  await rows.filter({ hasText: ".env" }).getByRole("button", { name: "Ignore" }).click();
  await expect(rows).toHaveCount(0);
  await expect(panel).toContainText("1 ignored");
  await panel.getByRole("button", { name: "Find stray passwords" }).click();
  await expect(panel.getByRole("button", { name: "Find stray passwords" })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Find stray passwords" })).toBeEnabled({ timeout: 90_000 });
  await expect(rows).toHaveCount(0);
  await expect(panel.getByTestId("stray-count")).toHaveText("0");

  // The login is in the vault, encrypted like any other.
  await nav(page, "All items");
  await page.getByText("acme-mail.com", { exact: true }).first().click();
  await expect(page.getByRole("article", { name: "acme-mail.com" })).toBeVisible();
  await ctx.close();
});
