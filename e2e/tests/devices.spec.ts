import { expect, ready, stamp, test } from "../fixtures";

/** Settings → Devices (WP-8.3): an app password per syncing device, shown
 *  once, works with Basic auth for what it was allowed, and stops the
 *  moment it's revoked. */

function basic(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

async function startUpload(page: import("@playwright/test").Page, auth: string) {
  return page.request.post("/api/files/tus/", {
    headers: {
      Authorization: auth,
      "Tus-Resumable": "1.0.0",
      "Upload-Length": "5",
      "Upload-Metadata": `filename ${Buffer.from("device.txt").toString("base64")},scope ${Buffer.from("mine").toString("base64")}`,
    },
  });
}

test("a device gets its own password once, and revoking it cuts it off", async ({ alice: page }) => {
  await page.goto("/account/devices");
  await ready(page);
  const panel = page.getByRole("region", { name: "Devices" });
  await expect(panel).toBeInViewport();

  const name = `E2E phone ${stamp}`;
  await panel.getByRole("button", { name: "Add a device" }).click();
  await panel.getByLabel("Device name").fill(name);
  await panel.getByLabel("Upload big files").check();
  await panel.getByRole("button", { name: "Make an app password" }).click();

  const ready_ = panel.getByRole("status");
  await expect(ready_).toContainText(`“${name}” is ready`);
  const password = (await ready_.getByLabel("Password", { exact: true }).textContent())!.trim();
  const username = (await ready_.getByLabel("Username", { exact: true }).textContent())!.trim();
  expect(password).toMatch(/^pmt_[0-9A-Za-z]{36}$/);
  await expect(ready_.getByLabel("Server (WebDAV)", { exact: true })).toHaveText(/\/dav\/$/);
  const row = panel.getByRole("listitem").filter({ hasText: name });
  await expect(row).toContainText(password.slice(0, 8));
  await expect(row).toContainText("not used yet");

  // It works as Basic auth for what it was allowed — the account password never would.
  expect((await startUpload(page, basic(username, password))).status()).toBe(201);
  expect((await startUpload(page, basic(username, "not-an-app-password"))).status()).toBe(401);

  // Shown once: after a reload only the hint is left, and the use is recorded.
  await page.reload();
  await ready(page);
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(panel).not.toContainText(password);
  await expect(row).toContainText("last used");

  await row.getByRole("button", { name: "Revoke" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Revoke" }).click();
  await expect(row).toHaveCount(0);
  expect((await startUpload(page, basic(username, password))).status()).toBe(401);
});
