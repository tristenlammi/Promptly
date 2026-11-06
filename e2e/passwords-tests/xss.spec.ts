// Plan 13.5: hostile text wherever text can come from, in the real vault UI. Nothing here
// may run. Each payload tries to set a flag, and each screen it shows on is opened.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { BACKEND, makeUsers, onboard, signedIn } from "./helpers";

test.describe.configure({ timeout: 300_000 });

const P = (tag: string) => `<img src=x onerror="window.__xss=(window.__xss||[]).concat('${tag}')"><svg onload="window.__xss='${tag}'"><script>window.__xss='${tag}'</script>"'\`><a href="javascript:window.__xss='${tag}'">x</a>`;

async function nav(page: Page, name: string) {
  await page.getByRole("navigation", { name: "Passwords" }).getByText(name, { exact: true }).click();
}

async function clean(page: Page, where: string) {
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss), `script ran on ${where}`).toBeUndefined();
  // Rendered as text: no element made from the payload exists.
  expect(await page.locator("img[src='x'], svg[onload], a[href^='javascript:']").count(), `markup made on ${where}`).toBe(0);
}

test("payloads in every field of an item show as text on every screen", async ({ browser }) => {
  const [u] = makeUsers(["xss"]);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy/.test(m.text())) errors.push(m.text());
  });
  await onboard(page);

  for (const kind of ["Login", "Secure note", "Card", "Identity", "Wi-Fi", "API key", "SSH key", "Bank account", "Document"]) {
    const add = page.getByRole("button", { name: "New", exact: true });
    await add.click();
    const item = page.getByRole("menuitem", { name: new RegExp(kind, "i") }).first();
    if (!(await item.count())) {
      await page.keyboard.press("Escape");
      continue;
    }
    await item.click();
    // Every text box in the editor gets the payload.
    const form = page.locator("form").first();
    const boxes = form.locator("input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=date]):not([type=number]):not([type=range]), textarea");
    const n = await boxes.count();
    for (let i = 0; i < n; i++) {
      const box = boxes.nth(i);
      if (await box.isEditable()) await box.fill(P(`${kind}-${i}`)).catch(() => undefined);
    }
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(400);
    await clean(page, `the ${kind} view`);
    // The 2FA box or the like may refuse it. That's fine, so long as nothing runs.
    if (await page.getByRole("button", { name: "Cancel" }).count()) await page.getByRole("button", { name: "Cancel" }).first().click().catch(() => undefined);
  }

  for (const screen of ["All items", "Favourites", "Logins", "Cards", "Identities", "Secure notes", "Keys and documents", "2FA codes", "Security check", "Trash", "Archive", "Activity", "Devices", "Shared vaults", "Sends"]) {
    await nav(page, screen);
    await clean(page, screen);
  }

  // A vault name, and a folder name.
  await nav(page, "Shared vaults");
  await page.getByRole("button", { name: "New vault" }).click();
  await page.getByLabel("Name").fill(P("vault"));
  await page.getByRole("button", { name: "Make vault" }).click();
  await expect(page.getByTestId("shared-vault")).toBeVisible();
  await clean(page, "a shared vault");

  // The command palette searching those items.
  await nav(page, "All items");
  await page.getByLabel("Search your vault").fill("onerror");
  await clean(page, "search");
  await page.keyboard.press("Control+K");
  await page.waitForTimeout(200);
  await page.keyboard.type("onerror");
  await clean(page, "the palette");
  await page.keyboard.press("Escape");
  expect(errors, "CSP had to step in, meaning markup got into the page").toEqual([]);
});

test("a malicious import shows as text, and a hostile link is never live", async ({ browser }) => {
  const [u] = makeUsers(["xssimp"]);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  await onboard(page);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-xss-"));
  const file = path.join(dir, "chrome.csv");
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  fs.writeFileSync(
    file,
    `name,url,username,password,note\n${q(P("imp-name"))},${q("javascript:window.__xss='url'")},${q(P("imp-user"))},${q("Pw-1!")},${q(P("imp-note"))}\n${q("Bad url")},${q("data:text/html,<script>parent.__xss=1</script>")},u,p,n\n`,
  );
  await nav(page, "Import and export");
  await page.locator('input[type="file"]').first().setInputFiles(file);
  await page.waitForTimeout(800);
  await clean(page, "the import preview");
  const go = page.getByRole("button", { name: /^Import \d+$/ });
  await expect(go).toBeVisible({ timeout: 15_000 });
  await go.click();
  await expect(page.getByText("Delete the file you imported from")).toBeVisible({ timeout: 30_000 });
  await nav(page, "All items");
  await clean(page, "the list after importing");
  await page.getByText("Bad url").first().click();
  await clean(page, "the item");
  // Whatever's shown for those addresses, neither is a link you can click into a script.
  expect(await page.locator("a[href^='data:'], a[href^='javascript:']").count()).toBe(0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hostile mail stays text in the Security check", async ({ browser }) => {
  const [u] = makeUsers(["xssmail"]);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  await onboard(page);
  const subject = `Your password was changed ${P("mail-subject")}`;
  execFileSync("docker", ["exec", "-i", BACKEND, "python"], {
    encoding: "utf8",
    input: `
import asyncio, uuid
from datetime import datetime, timezone
import app.db_models
from app.database import SessionLocal
from app.mail.models import MailAccount, MailFolder, MailMessage
async def main():
    async with SessionLocal() as db:
        acc = MailAccount(user_id=uuid.UUID("${u.id}"), email=f"{uuid.uuid4().hex[:8]}@example.com", imap_host="localhost", imap_port=993, imap_security="ssl", smtp_host="localhost", smtp_port=465, smtp_security="ssl", username="x", secret_encrypted="x")
        db.add(acc)
        await db.flush()
        f = MailFolder(account_id=acc.id, path="INBOX", name="Inbox", role="inbox")
        db.add(f)
        await db.flush()
        db.add(MailMessage(account_id=acc.id, folder_id=f.id, uid=7, thread_key=uuid.uuid4().hex, subject=${JSON.stringify(subject)}, from_name=${JSON.stringify(P("mail-from"))}, from_addr="security@instagram.com", sent_at=datetime.now(timezone.utc), body_text="x"))
        await db.commit()
asyncio.run(main())
`,
  });
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Login" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Instagram");
  await page.getByLabel("Website 1", { exact: true }).fill("https://www.instagram.com/");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await nav(page, "Security check");
  await expect(page.getByTestId("mail-alerts")).toContainText("onerror");
  await clean(page, "a security email");
});

test("a Send's contents can't run on the public page", async ({ browser }) => {
  const [u] = makeUsers(["xsssend"]);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  await onboard(page);
  await nav(page, "Sends");
  await page.getByRole("button", { name: "New Send" }).click();
  await page.getByLabel("What is it?").fill(P("send-title"));
  await page.getByLabel("What to send").fill(P("send-text"));
  await page.getByRole("button", { name: "Make the link" }).click();
  const link = (await page.getByTestId("send-link").textContent())!.trim();
  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(link);
  await stranger.getByRole("button", { name: "Open" }).click();
  await expect(stranger.getByTestId("send-text")).toContainText("onerror");
  await clean(stranger, "the public Send page");
  // A hostile id or fragment reads as an incomplete link.
  const bad = await (await browser.newContext()).newPage();
  await bad.goto(`/passwords/send/${encodeURIComponent("<img src=x onerror=alert(1)>")}#<script>`);
  await expect(bad.getByText("This link is incomplete")).toBeVisible();
  await clean(bad, "a hostile Send link");
});
