import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";

/** Chat Uploads and Generated Files are folders you can clear out like any other. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

async function put(page: Page, auth: string, name: string, route: string): Promise<{ id: string; folder_id: string }> {
  const r = await page.request.post("/api/files/", {
    headers: { Authorization: auth },
    multipart: { route, file: { name, mimeType: "text/plain", buffer: Buffer.from(`${name}\n`) } },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}

for (const route of ["chat", "generated"]) {
  test(`files in the ${route} system folder can be selected and trashed together`, async ({ alice: page }) => {
    const auth = await bearer(page);
    const tag = `${stamp}-${route}`;
    const a = await put(page, auth, `bulk-${tag}-a.txt`, route);
    const b = await put(page, auth, `bulk-${tag}-b.txt`, route);
    const ids = [a.id, b.id];
    try {
      await page.goto(`/files/folder/${a.folder_id}`);
      await ready(page);
      for (const n of ["a", "b"]) {
        const name = page.getByRole("button", { name: `bulk-${tag}-${n}`, exact: true });
        await name.locator('xpath=ancestor::*[.//*[@role="checkbox"]][1]').getByRole("checkbox").click();
      }
      await expect(page.getByText("2 selected")).toBeVisible();
      await page.getByRole("button", { name: "Move to trash" }).click();
      await expect(page.getByText(`bulk-${tag}-a.txt`)).toHaveCount(0);
      await expect(page.getByText(`bulk-${tag}-b.txt`)).toHaveCount(0);
    } finally {
      await page.request.post("/api/files/bulk/trash", {
        headers: { Authorization: auth },
        data: { file_ids: ids, folder_ids: [] },
      });
    }
  });
}

test("Select all takes the whole folder, including what hasn't scrolled in", async ({ alice: page }) => {
  const auth = await bearer(page);
  const made = await page.request.post("/api/files/folders", {
    headers: { Authorization: auth },
    data: { name: `select-all-${stamp}` },
  });
  expect(made.ok(), await made.text()).toBeTruthy();
  const folder = (await made.json()).id as string;
  const up = (name: string) =>
    page.request.post("/api/files/", {
      headers: { Authorization: auth },
      multipart: { folder_id: folder, file: { name, mimeType: "text/plain", buffer: Buffer.from(`${name}\n`) } },
    });
  for (const n of [1, 2, 3, 4, 5]) expect((await up(`all-${n}.txt`)).ok()).toBeTruthy();
  try {
    // One row a page, so most of the folder isn't loaded yet.
    await page.route("**/api/files/browse*", (r) => {
      const url = new URL(r.request().url());
      url.searchParams.set("limit", "1");
      return r.continue({ url: url.toString() });
    });
    await page.goto(`/files/folder/${folder}`);
    await ready(page);
    const all = page.getByRole("checkbox", { name: "Select all" });
    await expect(all).toHaveAttribute("aria-checked", "false");
    await all.click();
    await expect(page.getByText("5 selected")).toBeVisible();
    await expect(all).toHaveAttribute("aria-checked", "true");

    // And off again.
    await all.click();
    await expect(page.getByText("5 selected")).toHaveCount(0);

    await all.click();
    await page.getByRole("button", { name: "Move to trash" }).click();
    await expect(page.getByText("Moved 5 items to trash")).toBeVisible();
    const left = await page.request.get(`/api/files/browse?scope=mine&folder_id=${folder}&limit=50`, { headers: { Authorization: auth } });
    expect((await left.json()).files).toHaveLength(0);
  } finally {
    await page.request.post("/api/files/bulk/trash", {
      headers: { Authorization: auth },
      data: { file_ids: [], folder_ids: [folder] },
    });
  }
});
