// Aliases on your own domain: set up a domain, make an alias from the item editor,
// see its mail counted, flagged and turned off. Mail is seeded straight into the
// mail-worker's arrival step (no real mail server on the stack).
import { execFileSync } from "node:child_process";

import { expect, type Page, test } from "@playwright/test";

import { BACKEND, makeUsers, onboard, signedIn, type User } from "./helpers";

test.describe.configure({ timeout: 240_000 });

const DOMAIN = "aliases-e2e.test";

function py(body: string): string {
  return execFileSync("docker", ["exec", "-i", BACKEND, "python"], { input: body, encoding: "utf8" });
}

function seedMailbox(u: User) {
  py(`
import asyncio, uuid
import app.db_models
from app.database import SessionLocal
from app.mail.models import MailAccount, MailFolder
async def main():
    async with SessionLocal() as db:
        acc = MailAccount(user_id=uuid.UUID("${u.id}"), email=f"box-{uuid.uuid4().hex[:8]}@example.com", imap_host="localhost", imap_port=993, imap_security="ssl", smtp_host="localhost", smtp_port=465, smtp_security="ssl", username="x", secret_encrypted="x")
        db.add(acc)
        await db.flush()
        for role, path in (("inbox", "INBOX"), ("trash", "Trash")):
            db.add(MailFolder(account_id=acc.id, path=path, name=path, role=role, last_uid=1))
        await db.commit()
asyncio.run(main())
`);
}

/** What the mail-worker does with a new email to this address. */
function arrive(u: User, to: string, from: string) {
  py(`
import asyncio, uuid
from email.message import EmailMessage
from sqlalchemy import select
import app.db_models
from app.database import SessionLocal
from app.mail import worker
from app.mail.models import MailAccount, MailFolder
async def main():
    async with SessionLocal() as db:
        acc = await db.scalar(select(MailAccount).where(MailAccount.user_id == uuid.UUID("${u.id}")))
        inbox = await db.scalar(select(MailFolder).where(MailFolder.account_id == acc.id, MailFolder.role == "inbox"))
    m = EmailMessage()
    m["From"] = ${JSON.stringify(from)}
    m["To"] = "undisclosed-recipients:;"
    m["X-Original-To"] = ${JSON.stringify(to)}
    m["Subject"] = "Hello"
    m["Message-ID"] = f"<{uuid.uuid4().hex}@e2e.example>"
    m["Date"] = "Mon, 02 Nov 2026 09:00:00 +0000"
    m.set_content("Hi")
    await worker._store(acc.id, inbox.id, [(uuid.uuid4().int % 2000000000, [], m.as_bytes())], announce=True)
asyncio.run(main())
`);
}

async function nav(page: Page, name: string) {
  await page.getByRole("navigation", { name: "Passwords" }).getByText(name, { exact: true }).click();
}

test("an alias made in the item editor is saved with the login, counted, flagged and turned off", async ({ browser }) => {
  const [u] = makeUsers(["alias"]);
  seedMailbox(u);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  await onboard(page);

  // Set up the domain.
  await nav(page, "Aliases");
  await page.getByLabel("Alias domain").fill(DOMAIN);
  await page.getByRole("button", { name: "Add domain" }).click();
  const card = page.getByTestId("alias-domain");
  await expect(card).toContainText(DOMAIN);
  await expect(card.getByTestId("domain-status")).toHaveText("Not checked yet");

  // Make an alias from the item editor: it becomes the username.
  await nav(page, "All items");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Login" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Shop");
  await page.getByLabel("Website 1", { exact: true }).fill("https://shop.example");
  await page.getByTestId("new-alias").click();
  const username = page.getByLabel("Username or email");
  await expect(username).toHaveValue(/^[a-z0-9]{3,9}\.[a-z2-9]{4}@aliases-e2e\.test$/);
  const address = await username.inputValue();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("article", { name: "Shop" })).toBeVisible();

  // Linked to the login, with no mail yet.
  await nav(page, "Aliases");
  const row = page.getByTestId("alias-row").filter({ hasText: address });
  await expect(row).toContainText("Shop");
  await expect(row).toContainText("0 emails");

  // Mail from the site, then from someone else.
  arrive(u, address, "Shop <hello@shop.example>");
  arrive(u, address, "Deals <win@cheap-pills.example>");
  // The screen reads them again when it opens.
  await nav(page, "Generator");
  await nav(page, "Aliases");
  await expect(row).toContainText("2 emails");
  await expect(row.getByTestId("alias-warning")).toContainText("cheap-pills.example");
  await expect(row.getByTestId("alias-warning")).toContainText("doesn't look like this login's site");

  // "This sender is fine" clears it; then the alias is turned off.
  await row.getByRole("button", { name: "This sender is fine" }).click();
  await expect(row.getByTestId("alias-warning")).toHaveCount(0);
  await row.getByLabel(`${address} is on`).uncheck();
  await expect(row.getByLabel(`${address} is on`)).not.toBeChecked();
  await expect(row).toContainText("off since");
  await ctx.close();
});
