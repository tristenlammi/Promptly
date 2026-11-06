// M4: import, export, Security check, attachments, in the browser.
import { execFileSync } from "node:child_process";

import { expect, test } from "@playwright/test";

import { addLogin, BACKEND, makeUsers, onboard, signedIn, MASTER } from "./helpers";

const nav = (page: import("@playwright/test").Page, name: string) => page.getByRole("navigation", { name: "Passwords" }).getByRole("button", { name, exact: true });

test("import a browser CSV with preview and dedupe, export encrypted, re-import in a new account", async ({ browser }) => {
  const [u, u2] = makeUsers(["imp", "imp2"]);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  await onboard(page);
  await nav(page, "Import and export").click();

  const csv = "name,url,username,password,note\nGitHub,https://github.com/login,ana,gh-Pass-1,hello\nBank,https://bank.example,me,bank-Pass-2,\nBank,https://bank.example,me,bank-Pass-2,\n";
  await page.getByLabel("Choose a file to import").setInputFiles({ name: "passwords.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.getByTestId("import-summary")).toContainText("Browser: 2 to import, 1 already here");
  await page.getByRole("button", { name: "Import 2" }).click();
  await expect(page.getByText("Delete the file you imported from")).toBeVisible({ timeout: 30_000 });

  // The same file again adds nothing.
  await page.getByLabel("Choose a file to import").setInputFiles({ name: "passwords.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.getByTestId("import-summary")).toContainText("0 to import, 3 already here");
  await page.getByRole("button", { name: "Cancel" }).click();

  // A file nobody can read says so.
  await page.getByLabel("Choose a file to import").setInputFiles({ name: "cat.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff, 0xfe]) });
  await expect(page.getByText("We can't read that file")).toBeVisible();

  // Encrypted export.
  await page.getByLabel("Your master password").fill(MASTER);
  await page.getByLabel("Password for this file").fill("export-file-password");
  await page.getByLabel("Type it again").fill("export-file-password");
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export encrypted file" }).click();
  const file = await (await dl).createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of file) chunks.push(c as Buffer);
  const exported = Buffer.concat(chunks);
  const text = exported.toString("utf8");
  expect(text).toContain("promptly-pw-export");
  expect(text).not.toContain("gh-Pass-1");
  expect(text).not.toContain("github");

  // The plain one needs typing EXPORT.
  await page.getByRole("button", { name: "Export without encryption…" }).click();
  await expect(page.getByRole("button", { name: "Logins as CSV" })).toBeDisabled();
  await page.getByLabel("Type EXPORT to go on").fill("EXPORT");
  const dl2 = page.waitForEvent("download");
  await page.getByRole("button", { name: "Logins as CSV" }).click();
  expect((await dl2).suggestedFilename()).toMatch(/\.csv$/);

  // Activity notes the export, with no names.
  await nav(page, "Activity").click();
  await expect(page.getByText("Vault exported").first()).toBeVisible();
  await ctx.close();

  // Opens in another account with the file's own password.
  const ctx2 = await signedIn(browser, u2);
  const p2 = await ctx2.newPage();
  await onboard(p2);
  await nav(p2, "Import and export").click();
  await p2.getByLabel("Choose a file to import").setInputFiles({ name: "vault.json", mimeType: "application/json", buffer: exported });
  await p2.getByLabel(/This Promptly file has a password/).fill("wrong one");
  await p2.getByRole("button", { name: "Open it" }).click();
  await expect(p2.getByText("didn't open")).toBeVisible({ timeout: 30_000 });
  await p2.getByLabel("Choose a file to import").setInputFiles({ name: "vault.json", mimeType: "application/json", buffer: exported });
  await p2.getByLabel(/This Promptly file has a password/).fill("export-file-password");
  await p2.getByRole("button", { name: "Open it" }).click();
  await expect(p2.getByTestId("import-summary")).toContainText("Promptly: 2 to import", { timeout: 30_000 });
  await p2.getByRole("button", { name: "Import 2" }).click();
  await nav(p2, "All items").click();
  await expect(p2.getByRole("list", { name: "Items" }).getByRole("button", { name: /GitHub/ })).toBeVisible();
  await ctx2.close();
});

test("Security check finds weak, reused and breached, through the server's proxy", async ({ browser }) => {
  const [u] = makeUsers(["sec"]);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  await onboard(page);
  await addLogin(page, { title: "Weak One", password: "password" });
  await addLogin(page, { title: "Reused A", password: "same-Long-Passw0rd-xyz-1!" });
  await addLogin(page, { title: "Reused B", password: "same-Long-Passw0rd-xyz-1!" });

  const toHibp: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith("http://localhost")) toHibp.push(r.url());
  });
  let sent = "";
  page.on("request", (r) => {
    if (r.url().endsWith("/breach/range")) sent = r.postData() ?? "";
  });

  await nav(page, "Security check").click();
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByText("Checked 3 logins.")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("count-Weak")).toHaveText("1");
  await expect(page.getByTestId("count-Reused")).toHaveText("2");
  await expect(page.getByTestId("count-Breached")).not.toHaveText("0");
  expect(JSON.parse(sent).prefix).toHaveLength(5);
  // The browser itself never talked to the breach service.
  expect(toHibp).toEqual([]);
  await page.getByRole("button", { name: "Open" }).first().click();
  await expect(page.getByRole("article")).toBeVisible();
  await ctx.close();
});

test("attachments: encrypted upload, download to another device, delete", async ({ browser }) => {
  const [u] = makeUsers(["att"]);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  const secret = await onboard(page);
  await addLogin(page, { title: "With File" });
  const payload = Buffer.alloc(2_500_000, "CANARYATTACHMENT");
  await page.getByLabel("Attach a file").setInputFiles({ name: "passport.pdf", mimeType: "application/pdf", buffer: payload });
  await expect(page.getByText("passport.pdf")).toBeVisible({ timeout: 60_000 });
  // On the server it's chunks of noise, with the name nowhere near them.
  const onDisk = execFileSync("docker", ["exec", BACKEND, "sh", "-c", "find /app/uploads/passwords -name '*.bin' | wc -l; grep -rl CANARYATTACHMENT /app/uploads/passwords | wc -l; find /app/uploads -name '*passport*' | wc -l"], { encoding: "utf8" }).trim().split(/\s+/);
  expect(Number(onDisk[0])).toBeGreaterThanOrEqual(3);
  expect(onDisk[1]).toBe("0");
  expect(onDisk[2]).toBe("0");

  const ctx2 = await signedIn(browser, u);
  const p2 = await ctx2.newPage();
  await p2.goto("/passwords");
  await p2.getByRole("button", { name: "Use my recovery kit" }).click();
  await p2.getByLabel("Secret Key").fill(secret);
  await p2.getByLabel("Master password").fill("correct horse battery staple 7!");
  await p2.getByRole("button", { name: "Unlock", exact: true }).click();
  await p2.getByRole("list", { name: "Items" }).getByRole("button", { name: /With File/ }).click();
  const dl = p2.waitForEvent("download");
  await p2.getByRole("button", { name: "Download passport.pdf" }).click();
  const stream = await (await dl).createReadStream();
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(c as Buffer);
  expect(Buffer.concat(parts).equals(payload)).toBe(true);
  await ctx2.close();

  await page.getByRole("button", { name: "Remove passport.pdf" }).click();
  await expect(page.getByText("passport.pdf")).toHaveCount(0);
  await ctx.close();
});
