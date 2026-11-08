// The browser extension on the Install apps page: a signed Firefox add-on installs from a link,
// and without one the page keeps the temporary add-on's steps.
import { expect, test } from "@playwright/test";

import { makeUsers, signedIn } from "./helpers";

const INFO = {
  version: "0.1.0",
  chrome: { file: "promptly-passwords-chrome.zip", size_bytes: 1_556_307, sha256: "0".repeat(64) },
  firefox: { file: "promptly-passwords-firefox.zip", size_bytes: 1_555_602, sha256: "1".repeat(64) },
};

test("a signed Firefox add-on gets an install link, and an unsigned one the temporary steps", async ({ browser }) => {
  const [u] = makeUsers(["installapps"]);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  let info: Record<string, unknown> = INFO;
  await page.route("**/downloads/PromptlyPasswordsExtension.json", (r) => r.fulfill({ json: info }));

  await page.goto("/apps/install");
  await expect(page.getByText("Promptly Passwords browser extension")).toBeVisible();
  await expect(page.getByText("Load Temporary Add-on")).toBeVisible();
  await expect(page.getByTestId("firefox-install")).toHaveCount(0);

  info = { ...INFO, firefox_signed: { file: "promptly-passwords-firefox.xpi", size_bytes: 1_600_000, sha256: "2".repeat(64) } };
  await page.reload();
  const install = page.getByTestId("firefox-install");
  await expect(install).toBeVisible();
  await expect(install).toHaveAttribute("href", "/downloads/promptly-passwords-firefox.xpi");
  // A download attribute would save the file instead of letting Firefox install it.
  await expect(install).not.toHaveAttribute("download", /.*/);
  await expect(page.getByText("Load Temporary Add-on")).toHaveCount(0);
  await expect(page.getByText("updates itself")).toBeVisible();
  await ctx.close();
});
