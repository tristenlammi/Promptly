// Things a feature audit found missing or wired wrong, each proved in the real page.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

import { type BrowserContext, expect, type Page, test } from "@playwright/test";

import { addLogin, BACKEND, makeUsers, MASTER, onboard, signedIn, type User } from "./helpers";

const QRCode = createRequire(import.meta.url)("../../frontend/node_modules/qrcode");

test.describe.configure({ timeout: 300_000 });

async function nav(page: Page, name: string) {
  await page.getByRole("navigation", { name: "Passwords" }).getByText(name, { exact: true }).click();
}

async function person(browser: Parameters<typeof signedIn>[0], u: User): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  await onboard(page);
  return { ctx, page };
}

test("reloading before the kit's saved doesn't get round it", async ({ browser }) => {
  const [u] = makeUsers(["kitgate"]);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  await page.goto("/passwords");
  await page.getByText("I understand").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Master password").fill(MASTER);
  await page.getByLabel("Type it again").fill(MASTER);
  await page.getByRole("button", { name: "Create vault" }).click();
  const shown = page.getByTestId("secret-key");
  await expect(shown).toBeVisible({ timeout: 30_000 });
  const secret = (await shown.textContent())!.trim();

  await page.reload();
  await page.getByLabel("Master password").fill(MASTER);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  const gate = page.getByTestId("kit-gate");
  await expect(gate).toBeVisible({ timeout: 30_000 });
  await expect(gate.getByTestId("secret-key")).toHaveText(secret);
  await expect(gate.getByRole("button", { name: "Done" })).toBeDisabled();
  await gate.getByText("I've saved or printed it").click();
  await gate.getByLabel("Last group of your Secret Key").fill("WRONG");
  await gate.getByRole("button", { name: "Done" }).click();
  await expect(gate.getByText("not the last group")).toBeVisible();
  await gate.getByLabel("Last group of your Secret Key").fill(secret.slice(secret.lastIndexOf("-") + 1));
  await gate.getByRole("button", { name: "Done" }).click();
  await expect(gate).toHaveCount(0);
  // And it stays done.
  await page.reload();
  await page.getByLabel("Master password").fill(MASTER);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Passwords" })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1000);
  await expect(page.getByTestId("kit-gate")).toHaveCount(0);
});

test("reset is on the lock screen, for someone who can't unlock", async ({ browser }) => {
  const [u] = makeUsers(["lockreset"]);
  const { page } = await person(browser, u);
  await page.reload();
  await expect(page.getByLabel("Master password")).toBeVisible({ timeout: 20_000 });
  await page.getByText("I've lost my master password and my kit").click();
  await page.getByRole("button", { name: "Reset vault…" }).click();
  await page.getByLabel("Your Promptly sign-in password").fill(u.password);
  await page.getByLabel("Type DELETE MY VAULT").fill("DELETE MY VAULT");
  await page.getByRole("button", { name: "Destroy my vault" }).click();
  await expect(page.getByText("I understand")).toBeVisible({ timeout: 30_000 });
});

test("folders can be renamed and deleted, keeping their items; vaults get their own view", async ({ browser }) => {
  const [u] = makeUsers(["folders"]);
  const { page } = await person(browser, u);
  page.on("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Work");
  await page.getByRole("dialog").getByRole("button", { name: /Create|Save|Add/ }).click();
  await nav(page, "Work");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Login" }).click();
  await page.getByLabel("Name", { exact: true }).fill("In a folder");
  await page.locator("label", { hasText: "Folder" }).locator("select").selectOption({ label: "Work" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("article", { name: "In a folder" })).toBeVisible();

  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill("Office");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Office" })).toBeVisible();
  await page.getByRole("button", { name: "Delete folder" }).click();
  await expect(page.getByRole("navigation", { name: "Passwords" }).getByText("Office", { exact: true })).toHaveCount(0);
  await expect(page.getByText("In a folder").first()).toBeVisible();

  // A second vault: a section in the sidebar, its own list, and items say where they live.
  await nav(page, "Shared vaults");
  await page.getByRole("button", { name: "New vault" }).click();
  await page.getByLabel("Name").fill("Team");
  await page.getByRole("button", { name: "Make vault" }).click();
  await expect(page.getByTestId("shared-vault")).toBeVisible();
  await page.getByTestId("shared-vault").getByRole("button", { name: "Items" }).click();
  await expect(page.getByRole("heading", { name: "Team" })).toBeVisible();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Secure note" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Team note");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("article", { name: "Team note" })).toBeVisible();
  await expect(page.getByText("In a folder")).toHaveCount(0);
  await nav(page, "All items");
  await expect(page.getByText(/· Team/).first()).toBeVisible();
});

test("a new device joins through a QR, carrying the key it expects", async ({ browser }) => {
  const [u] = makeUsers(["qrjoin"]);
  const { ctx, page } = await person(browser, u);
  await addLogin(page, { title: "Before joining", username: "ana", password: "Pw-1!" });

  const other = await signedIn(browser, u);
  const fresh = await other.newPage();
  await fresh.goto("/passwords");
  await fresh.getByRole("button", { name: "Approve from another device" }).click();
  const qr = fresh.getByRole("img", { name: "QR code" });
  await expect(qr).toBeVisible({ timeout: 20_000 });
  const shot = await qr.screenshot();

  await nav(page, "Devices");
  await page.getByLabel("New device's QR image").setInputFiles({ name: "qr.png", mimeType: "image/png", buffer: shot });
  await expect(page.getByRole("heading", { name: /^Approve / })).toBeVisible({ timeout: 15_000 });
  const words = page.getByTestId("safety-words");
  await expect(words).toBeVisible({ timeout: 15_000 });
  await expect(fresh.getByTestId("safety-words")).toHaveText((await words.textContent())!, { timeout: 15_000 });
  await page.getByRole("button", { name: "The words match, approve" }).click();
  await fresh.getByLabel("Master password").fill(MASTER);
  await fresh.getByRole("button", { name: /Unlock|Finish|Continue/ }).click();
  await expect(fresh.getByRole("navigation", { name: "Passwords" })).toBeVisible({ timeout: 30_000 });
  await expect(fresh.getByText("Before joining").first()).toBeVisible({ timeout: 20_000 });

  // A QR for someone else's request, or a forged key, doesn't open anything.
  const forged = await QRCode.toBuffer("pwdev:00000000-0000-0000-0000-000000000000:abc");
  await page.getByLabel("New device's QR image").setInputFiles({ name: "x.png", mimeType: "image/png", buffer: forged });
  await expect(page.getByText("That request has gone")).toBeVisible({ timeout: 15_000 });
  await ctx.close();
});

test("a new device's request shows wherever you are, and reopening an approval works", async ({ browser }) => {
  const [u] = makeUsers(["reqnotice"]);
  const { page } = await person(browser, u);
  const other = await signedIn(browser, u);
  const fresh = await other.newPage();
  await fresh.goto("/passwords");
  await fresh.getByRole("button", { name: "Approve from another device" }).click();
  await expect(fresh.getByRole("img", { name: "QR code" })).toBeVisible({ timeout: 20_000 });
  await page.reload();
  await page.getByLabel("Master password").fill(MASTER);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByTestId("request-notice")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByTestId("safety-words")).toBeVisible({ timeout: 15_000 });
  const first = await page.getByTestId("safety-words").textContent();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByTestId("safety-words")).toBeVisible({ timeout: 15_000 });
  const again = await page.getByTestId("safety-words").textContent();
  expect(again).not.toEqual(first);
  await expect(fresh.getByTestId("safety-words")).toHaveText(again!, { timeout: 15_000 });
});

test("2FA codes ask first for a re-prompt item, and fill-only members see no secrets", async ({ browser }) => {
  const [a, b] = makeUsers(["rpa", "rpb"]);
  const { page: alice } = await person(browser, a);
  const { page: bob } = await person(browser, b);

  await alice.getByRole("button", { name: "New", exact: true }).click();
  await alice.getByRole("menuitem", { name: "Login" }).click();
  await alice.getByLabel("Name", { exact: true }).fill("Guarded");
  await alice.getByLabel("2FA secret or otpauth link").fill("JBSWY3DPEHPK3PXP");
  await alice.getByText("Ask for my master password before showing or filling this").click();
  await alice.getByRole("button", { name: "Save", exact: true }).click();
  await alice.waitForTimeout(800);
  // It asks for the master password straight away, which is the point of it.
  await alice.keyboard.press("Escape");
  await nav(alice, "2FA codes");
  await expect(alice.getByText("Guarded")).toBeVisible();
  await expect(alice.getByText(/^\d{3} ?\d{3}$/)).toHaveCount(0);
  await alice.getByRole("button", { name: "Show code" }).click();
  await alice.getByRole("dialog").getByRole("textbox").or(alice.getByRole("dialog").locator("input[type=password]")).first().fill(MASTER);
  await alice.getByRole("dialog").getByRole("button", { name: "Continue" }).click();
  await expect(alice.getByRole("button", { name: "Show code" })).toHaveCount(0, { timeout: 30_000 });

  // Fill-only.
  await nav(alice, "Shared vaults");
  await alice.getByRole("button", { name: "New vault" }).click();
  await alice.getByLabel("Name").fill("House");
  await alice.getByRole("button", { name: "Make vault" }).click();
  const card = alice.getByTestId("shared-vault");
  await card.getByTestId("add-person").selectOption({ label: b.username });
  await card.getByLabel("They can").selectOption("fill");
  await card.getByRole("button", { name: "Invite" }).click();
  await expect(card.getByTestId("member-row").filter({ hasText: b.username })).toBeVisible();
  await card.getByRole("button", { name: "Items" }).click();
  await alice.getByRole("button", { name: "New", exact: true }).click();
  await alice.getByRole("menuitem", { name: "Login" }).click();
  await alice.getByLabel("Name", { exact: true }).fill("Tv login");
  await alice.getByLabel("Password", { exact: true }).fill("Fill-Only-Secret-1!");
  await alice.getByLabel("2FA secret or otpauth link").fill("JBSWY3DPEHPK3PXP");
  await alice.getByRole("button", { name: "Save", exact: true }).click();
  await expect(alice.getByRole("article", { name: "Tv login" })).toBeVisible();

  await nav(bob, "Shared vaults");
  await bob.getByTestId("invitation").getByRole("button", { name: "Accept" }).click();
  await expect(bob.getByTestId("shared-vault")).toBeVisible();
  await nav(bob, "All items");
  await bob.getByText("Tv login").first().click();
  const view = bob.getByRole("article", { name: "Tv login" });
  await expect(view).toBeVisible();
  await expect(view.getByRole("button", { name: "History" })).toHaveCount(0);
  await nav(bob, "2FA codes");
  await expect(bob.getByText("Tv login")).toHaveCount(0);
});

test("an interrupted attachment upload resumes, and nothing's sent twice", async ({ browser }) => {
  const [u] = makeUsers(["resume"]);
  // On WebKit a service worker's requests never reach page.route, so nothing could be interrupted.
  const ctx = await signedIn(browser, u, { serviceWorkers: "block" });
  const page = await ctx.newPage();
  await onboard(page);
  await addLogin(page, { title: "With a file", username: "ana" });
  const view = page.getByRole("article", { name: "With a file" });
  const sent: number[] = [];
  let failed = false;
  await page.route(/\/attachments\/[^/]+\/chunks\/\d+$/, async (route) => {
    const n = Number(/chunks\/(\d+)$/.exec(route.request().url())![1]);
    if (route.request().method() === "PUT") {
      if (n === 1 && !failed) {
        failed = true;
        return route.abort();
      }
      sent.push(n);
    }
    return route.continue();
  });
  const buffer = Buffer.alloc(2 * 1024 * 1024 + 7000, 7);
  const file = { name: "big.bin", mimeType: "application/octet-stream", buffer };
  await view.getByLabel("Attach a file").setInputFiles(file);
  await expect.poll(() => failed, { timeout: 30_000 }).toBe(true);
  await page.waitForTimeout(800);
  await view.getByLabel("Attach a file").setInputFiles([]);
  await view.getByLabel("Attach a file").setInputFiles(file);
  await expect(view.getByRole("button", { name: "Download big.bin" })).toBeVisible({ timeout: 60_000 });
  expect([...sent].sort()).toEqual([0, 1, 2]);
});

test("a Google Authenticator transfer QR imports from a picture of it", async ({ browser }) => {
  const [u] = makeUsers(["migrate"]);
  const { page } = await person(browser, u);
  // One account, "acct", secret bytes "Hello!", made by hand per the published format.
  const secret = Buffer.from("Hello!\xde\xad\xbe\xef", "latin1");
  const name = Buffer.from("acct");
  const otp = Buffer.concat([Buffer.from([0x0a, secret.length]), secret, Buffer.from([0x12, name.length]), name, Buffer.from([0x20, 1, 0x28, 1, 0x30, 2])]);
  const payload = Buffer.concat([Buffer.from([0x0a, otp.length]), otp, Buffer.from([0x10, 1, 0x18, 1, 0x20, 0])]);
  const link = `otpauth-migration://offline?data=${encodeURIComponent(payload.toString("base64"))}`;
  const image = await QRCode.toBuffer(link, { width: 400 });
  await nav(page, "Import and export");
  await page.getByLabel("From a QR image").setInputFiles({ name: "qr.png", mimeType: "image/png", buffer: image });
  await expect(page.getByText(/acct/).first()).toBeVisible({ timeout: 15_000 });
});

test("the login to Promptly itself is offered, with its warning, and a Family vault when others exist", async ({ browser }) => {
  makeUsers(["someoneelse"]);
  const [u] = makeUsers(["family"]);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  await page.goto("/passwords");
  await page.getByText("I understand").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Master password").fill(MASTER);
  await page.getByLabel("Type it again").fill(MASTER);
  await page.getByRole("button", { name: "Create vault" }).click();
  const key = page.getByTestId("secret-key");
  await expect(key).toBeVisible({ timeout: 30_000 });
  const secret = (await key.textContent())!.trim();
  await page.getByText("I've saved my recovery kit").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Last group of your Secret Key").fill(secret.slice(secret.lastIndexOf("-") + 1));
  await page.getByRole("button", { name: "Finish" }).click();

  await page.getByTestId("family-offer").getByRole("button", { name: "Make a Family vault" }).click();
  await expect(page.getByText("Made a Family vault")).toBeVisible({ timeout: 15_000 });
  await page.getByText("Save your Promptly login here").click();
  await expect(page.getByText("the one login you need to reach your server")).toBeVisible();
  await page.getByLabel("Username or email").fill(u.username);
  await page.getByLabel("Promptly password").fill(u.password);
  await page.getByLabel("Promptly 2FA setup key").fill("JBSWY3DPEHPK3PXP");
  await page.getByRole("button", { name: "Save it" }).click();
  await expect(page.getByText("Saved your Promptly login")).toBeVisible();
  await page.getByRole("button", { name: "Open my vault" }).click();
  await page.getByText("Promptly").filter({ hasNotText: "Preview" }).first().waitFor();
});

test("a recovery reminder comes round after six months, not on day one", async ({ browser }) => {
  const [u] = makeUsers(["reminder"]);
  const { page } = await person(browser, u);
  await nav(page, "Security check");
  await expect(page.getByText("Do you still have your recovery kit")).toHaveCount(0);
  execFileSync("docker", ["exec", "-i", BACKEND, "python"], {
    encoding: "utf8",
    input: `
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
`,
  });
  await page.reload();
  await page.getByLabel("Master password").fill(MASTER);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await nav(page, "All items");
  await expect(page.getByText("Time to check you still have your recovery kit")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.getByTestId("survival")).toContainText("Do you still have your recovery kit");
});

test("a typed document can get its Calendar reminder too", async ({ browser }) => {
  const [u] = makeUsers(["docrem"]);
  const { page } = await person(browser, u);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Licence or ID" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Licence");
  await page.getByLabel("Expires").fill("2032-02-02");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const view = page.getByRole("article", { name: "Licence" });
  await view.getByRole("button", { name: "Remind me in Calendar" }).click();
  await expect(view.getByText("A reminder is on your Calendar")).toBeVisible({ timeout: 15_000 });
});
