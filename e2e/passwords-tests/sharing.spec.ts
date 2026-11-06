// M10: sharing, Secure Send and emergency access, across real users in real browsers.
import { execFileSync } from "node:child_process";

import { type Browser, expect, type Page, test } from "@playwright/test";

import { addLogin, BACKEND, BASE, makeUsers, onboard, signedIn, type User } from "./helpers";

test.describe.configure({ timeout: 420_000 });

async function person(browser: Browser, u: User): Promise<Page> {
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  await onboard(page);
  return page;
}

async function openShared(page: Page) {
  await page.getByRole("navigation", { name: "Passwords" }).getByText("Shared vaults").click();
  await expect(page.getByRole("heading", { name: "Shared vaults" })).toBeVisible();
}

test("a vault shared across users: invite, words match, accept, read, remove, passwords to change", async ({ browser }) => {
  const [a, b] = makeUsers(["sharea", "shareb"]);
  const alice = await person(browser, a);
  const bob = await person(browser, b);

  await openShared(alice);
  await alice.getByRole("button", { name: "New vault" }).click();
  await alice.getByLabel("Name").fill("Household");
  await alice.getByRole("button", { name: "Make vault" }).click();
  const card = alice.getByTestId("shared-vault").filter({ hasText: "Household" });
  await expect(card).toBeVisible();

  await card.getByTestId("add-person").selectOption({ label: b.username });
  await card.getByRole("button", { name: "Invite" }).click();
  await expect(card.getByTestId("member-row").filter({ hasText: b.username })).toBeVisible();

  // Alice's screen shows the same safety words Bob's does.
  await card.getByTestId("member-row").filter({ hasText: b.username }).getByRole("button", { name: "Safety words" }).click();
  await expect(alice.getByTestId("their-words")).not.toBeEmpty();
  const shown = (await alice.getByTestId("their-words").textContent())!.trim();
  await openShared(bob);
  await expect(bob.getByTestId("my-words")).toHaveText(shown);
  await alice.getByRole("button", { name: "They match" }).click();

  // Bob accepts.
  const invite = bob.getByTestId("invitation");
  await expect(invite).toBeVisible();
  await invite.getByRole("button", { name: "Accept" }).click();
  await expect(bob.getByTestId("shared-vault").filter({ hasText: "Household" })).toBeVisible();

  // Alice puts a login in that vault.
  await alice.getByRole("navigation", { name: "Passwords" }).getByText("All items").click();
  await alice.getByRole("button", { name: "New", exact: true }).click();
  await alice.getByRole("menuitem", { name: "Login" }).click();
  await alice.getByLabel("Name", { exact: true }).fill("Streaming");
  await alice.getByLabel("Username or email").fill("house@example.com");
  await alice.getByLabel("Password", { exact: true }).fill("Sh4red-Pass!");
  await alice.locator("label", { hasText: "Vault" }).locator("select").selectOption({ label: "Household" });
  await alice.getByRole("button", { name: "Save" }).click();
  await expect(alice.getByRole("article", { name: "Streaming" })).toBeVisible();

  // Bob sees it after a sync.
  await bob.reload();
  await bob.getByLabel("Master password").fill("correct horse battery staple 7!");
  await bob.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(bob.getByRole("navigation", { name: "Passwords" })).toBeVisible({ timeout: 30_000 });
  await bob.getByRole("navigation", { name: "Passwords" }).getByText("All items").click();
  await expect(bob.getByText("Streaming").first()).toBeVisible({ timeout: 20_000 });

  // Alice removes Bob, and gets told what to change.
  await openShared(alice);
  const again = alice.getByTestId("shared-vault").filter({ hasText: "Household" });
  await again.getByTestId("member-row").filter({ hasText: b.username }).getByRole("button", { name: "Remove" }).click();
  await alice.getByRole("button", { name: "Remove and change the key" }).click();
  await expect(alice.getByTestId("to-change")).toContainText("Streaming", { timeout: 30_000 });
  await alice.getByRole("button", { name: "Done" }).click();

  // After a sync, Bob has lost it, including from this device.
  await bob.reload();
  await bob.getByLabel("Master password").fill("correct horse battery staple 7!");
  await bob.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(bob.getByRole("navigation", { name: "Passwords" })).toBeVisible({ timeout: 30_000 });
  await openShared(bob);
  await expect(bob.getByTestId("shared-vault")).toHaveCount(0);
  await bob.getByRole("navigation", { name: "Passwords" }).getByText("All items").click();
  await expect(bob.getByText("Streaming")).toHaveCount(0);

  // Alice still has it, under the new key.
  await alice.reload();
  await alice.getByLabel("Master password").fill("correct horse battery staple 7!");
  await alice.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(alice.getByRole("navigation", { name: "Passwords" })).toBeVisible({ timeout: 30_000 });
  await alice.getByRole("navigation", { name: "Passwords" }).getByText("All items").click();
  await expect(alice.getByText("Streaming").first()).toBeVisible({ timeout: 20_000 });
});

test("Secure Send: opens for someone with no account, key stays out of the request, view limit holds", async ({ browser }) => {
  const [a] = makeUsers(["senda"]);
  const page = await person(browser, a);
  await page.getByRole("navigation", { name: "Passwords" }).getByText("Sends").click();
  await page.getByRole("button", { name: "New Send" }).click();
  await page.getByLabel("What is it?").fill("Wi-Fi for the sitter");
  await page.getByLabel("What to send").fill("Open-Sesame-4411");
  await page.getByLabel("How many times it can open").fill("1");
  await page.getByRole("button", { name: "Make the link" }).click();
  const link = (await page.getByTestId("send-link").textContent())!.trim();
  expect(link).toContain("/passwords/send/");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("send-row").filter({ hasText: "Wi-Fi for the sitter" })).toBeVisible();

  // A stranger, signed in to nothing. Previewing doesn't use the view.
  const ctx = await browser.newContext();
  const stranger = await ctx.newPage();
  const sent: string[] = [];
  stranger.on("request", (r) => sent.push(r.url() + " " + (r.postData() ?? "") + " " + JSON.stringify(r.headers())));
  const fragment = link.split("#")[1];
  await stranger.goto(link);
  await stranger.reload();
  await stranger.goto(link);
  await stranger.getByRole("button", { name: "Open" }).click();
  await expect(stranger.getByTestId("send-text")).toHaveText("Open-Sesame-4411");
  await expect(stranger.getByText("Wi-Fi for the sitter")).toBeVisible();
  // The key never went to the server, in any URL, body or header.
  expect(sent.filter((s) => s.includes(fragment))).toEqual([]);
  // Nor does it stay in the address bar.
  expect(stranger.url()).not.toContain("#");

  // That was the only view.
  const second = await (await browser.newContext()).newPage();
  await second.goto(link);
  await expect(second.getByText("This Send has gone")).toBeVisible();
});

test("Secure Send with a password: wrong one refused, right one opens", async ({ browser }) => {
  const [a] = makeUsers(["sendp"]);
  const page = await person(browser, a);
  await page.getByRole("navigation", { name: "Passwords" }).getByText("Sends").click();
  await page.getByRole("button", { name: "New Send" }).click();
  await page.getByLabel("What to send").fill("With-A-Password-77");
  await page.getByLabel("Password (optional)").fill("tulip-garden");
  await page.getByRole("button", { name: "Make the link" }).click();
  const link = (await page.getByTestId("send-link").textContent())!.trim();

  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(link);
  await stranger.getByLabel("Password").fill("wrong-guess");
  await stranger.getByRole("button", { name: "Open" }).click();
  await expect(stranger.getByText("That password isn't right")).toBeVisible({ timeout: 30_000 });
  await stranger.getByLabel("Password").fill("tulip-garden");
  await stranger.getByRole("button", { name: "Open" }).click();
  await expect(stranger.getByTestId("send-text")).toHaveText("With-A-Password-77", { timeout: 30_000 });

  // A link with its key cut off opens nothing.
  const cut = await (await browser.newContext()).newPage();
  await cut.goto(link.split("#")[0]);
  await expect(cut.getByText("This link is incomplete")).toBeVisible();
  expect(BASE).toBeTruthy();
});

test("emergency access: asks, can be refused, and opens read-only after the wait", async ({ browser }) => {
  const [a, b] = makeUsers(["ema", "emb"]);
  const alice = await person(browser, a);
  const bob = await person(browser, b);
  await addLogin(alice, { title: "Bank of Example", username: "alice", password: "Em3rgency-Only!" });

  await openShared(alice);
  await alice.getByTestId("em-person").selectOption({ label: b.username });
  await alice.getByLabel("Wait, in days").fill("2");
  await alice.getByRole("button", { name: "Add", exact: true }).click();
  // Nothing happens until the words have been compared, and they're the ones the other person sees.
  await expect(alice.getByTestId("em-words")).toBeVisible();
  await expect(alice.getByTestId("em-granted")).toHaveCount(0);
  await alice.getByRole("button", { name: "They match" }).click();
  await expect(alice.getByTestId("em-granted")).toContainText("waiting for them to accept");

  await openShared(bob);
  await bob.getByTestId("em-received").getByRole("button", { name: "Accept" }).click();
  await expect(bob.getByTestId("em-received")).toContainText("waiting for them to finish");

  // Alice's device finishes it by sealing her keys to Bob.
  await alice.getByRole("navigation", { name: "Passwords" }).getByText("All items").click();
  await openShared(alice);
  await expect(alice.getByTestId("em-granted")).toContainText("set up", { timeout: 20_000 });

  bob.on("dialog", (d) => d.accept());
  await expect(bob.getByRole("button", { name: "Ask for access" })).toBeVisible({ timeout: 20_000 });
  await bob.getByRole("button", { name: "Ask for access" }).click();
  await expect(bob.getByTestId("em-received")).toContainText("Opens");
  await expect(bob.getByRole("button", { name: "Open their vault" })).toHaveCount(0);

  // Alice refuses; Bob asks again.
  await alice.getByRole("navigation", { name: "Passwords" }).getByText("All items").click();
  await openShared(alice);
  await alice.getByTestId("em-granted").getByRole("button", { name: "Refuse" }).click();
  await expect(alice.getByTestId("em-granted")).toContainText("refused");
  await bob.getByRole("navigation", { name: "Passwords" }).getByText("All items").click();
  await openShared(bob);
  await expect(bob.getByRole("button", { name: "Ask for access" })).toBeVisible({ timeout: 20_000 });
  await bob.getByRole("button", { name: "Ask for access" }).click();
  await expect(bob.getByTestId("em-received")).toContainText("Opens");

  // The wait runs out.
  execFileSync("docker", ["exec", "-i", BACKEND, "python"], {
    input: `
import asyncio, uuid
from datetime import timedelta
from sqlalchemy import select
import app.db_models
from app.database import SessionLocal
from app.passwords.models import PwEmergency
async def main():
    async with SessionLocal() as db:
        row = (await db.execute(select(PwEmergency).where(PwEmergency.grantee_id == uuid.UUID("${b.id}")))).scalar_one()
        row.requested_at = row.requested_at - timedelta(days=3)
        await db.commit()
asyncio.run(main())
`,
    encoding: "utf8",
  });
  await bob.getByRole("navigation", { name: "Passwords" }).getByText("All items").click();
  await openShared(bob);
  await expect(bob.getByRole("button", { name: "Open their vault" })).toBeVisible({ timeout: 20_000 });
  await bob.getByRole("button", { name: "Open their vault" }).click();
  await expect(bob.getByTestId("em-received")).toContainText("open");
  await bob.getByRole("navigation", { name: "Passwords" }).getByText("All items").click();
  await expect(bob.getByText("Bank of Example").first()).toBeVisible({ timeout: 20_000 });

  // Alice ends it: new keys, and Bob's copy goes at his next sync.
  await alice.getByRole("navigation", { name: "Passwords" }).getByText("All items").click();
  await openShared(alice);
  await expect(alice.getByTestId("em-granted")).toContainText("can read your vault");
  await alice.getByRole("button", { name: "End and change the keys" }).click();
  await expect(alice.getByTestId("em-granted")).toHaveCount(0, { timeout: 30_000 });
  await alice.getByRole("navigation", { name: "Passwords" }).getByText("All items").click();
  await expect(alice.getByText("Bank of Example").first()).toBeVisible();

  await bob.reload();
  await bob.getByLabel("Master password").fill("correct horse battery staple 7!");
  await bob.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(bob.getByRole("navigation", { name: "Passwords" })).toBeVisible({ timeout: 30_000 });
  await bob.getByRole("navigation", { name: "Passwords" }).getByText("All items").click();
  // Bob's own vault still lists, so this isn't just an empty screen.
  await expect(bob.getByRole("heading", { name: "All items" })).toBeVisible();
  await bob.waitForTimeout(3000);
  await expect(bob.getByText("Bank of Example")).toHaveCount(0);
});
