import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";

/** Storage health and guards (WP-7.2). */

async function bearer(page: Page, path = "/files"): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto(path);
  await ready(page);
  return (await seen).headers()["authorization"];
}

function sidOf(auth: string): string {
  const payload = JSON.parse(Buffer.from(auth.replace(/^Bearer /, "").split(".")[1], "base64url").toString());
  return payload.sid as string;
}

test("an admin sees the storage health page", async ({ dana: page }) => {
  await page.goto("/admin?tab=storage");
  await expect(page.getByRole("region", { name: "Disk space" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("region", { name: "Disk space" })).toContainText("free of");
  const integrity = page.getByRole("region", { name: "Integrity check" });
  await expect(integrity).toBeVisible();
  await integrity.getByRole("button", { name: "Check now" }).click();
  await expect(integrity).toContainText(/Last check .*(All good|Found problems)/, { timeout: 60_000 });
  await expect(page.getByRole("region", { name: "Database checksums" })).toContainText(/Database checksums (on|off)/);
  await expect(page.getByRole("region", { name: "Quarantine" })).toBeVisible();
  // WP-7.4: what the media worker has done.
  await expect(page.getByRole("region", { name: "Photos and videos" })).toContainText(/\d+ ready/);
});

test("everything one device sent to the trash comes back in one go", async ({ alice: page }) => {
  const auth = await bearer(page);
  const sid = sidOf(auth);
  expect(sid).toBeTruthy();
  const ids: string[] = [];
  for (const n of [1, 2]) {
    const r = await page.request.post("/api/files/", {
      headers: { Authorization: auth },
      multipart: { scope: "mine", file: { name: `e2e-oops-${stamp}-${n}.txt`, mimeType: "text/plain", buffer: Buffer.from("x") } },
    });
    ids.push((await r.json()).id);
  }
  const t = await page.request.post("/api/files/bulk/trash", {
    headers: { Authorization: auth },
    data: { file_ids: ids, folder_ids: [] },
  });
  expect(t.ok()).toBeTruthy();

  await page.goto(`/files/trash?restore=${encodeURIComponent(`session:${sid}`)}`);
  const banner = page.getByRole("region", { name: "Restore deleted files" });
  await expect(banner).toContainText(/files? .*sent to the trash from this device/, { timeout: 20_000 });
  await banner.getByRole("button", { name: "Restore everything" }).click();
  await expect(banner).toBeHidden({ timeout: 15_000 });
  for (const id of ids) {
    const f = await (await page.request.get(`/api/files/${id}`, { headers: { Authorization: auth } })).json();
    expect(f.trashed_at).toBeNull();
  }
});
