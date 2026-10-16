import fs from "node:fs";

import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { pdf, pdfForm } from "../lib/files";

/** The PDF viewer (WP-6.5): fill in a form and save it as a new version;
 *  search; mark it up; delete a page; restore from the history. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

async function upload(page: Page, auth: string, name: string, file: string): Promise<string> {
  const r = await page.request.post("/api/files/", {
    headers: { Authorization: auth },
    multipart: { scope: "mine", file: { name, mimeType: "application/pdf", buffer: fs.readFileSync(file) } },
  });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).id as string;
}

test("a PDF form is filled in and saved as a new version", async ({ alice: page }) => {
  test.setTimeout(120_000);
  const auth = await bearer(page);
  const id = await upload(page, auth, `e2e-form-${stamp}.pdf`, pdfForm(`e2e-form-${stamp}.pdf`));
  await page.goto(`/files/f/${id}`);
  const preview = page.getByRole("dialog").filter({ has: page.locator("#preview-title") });
  await expect(preview.getByText("Page 1 of 1")).toBeVisible({ timeout: 20_000 });

  // Fill the field.
  const field = preview.locator(".annotationLayer input").first();
  await expect(field).toBeVisible({ timeout: 20_000 });
  await field.fill("Ada Lovelace");
  await field.press("Tab");
  await expect(preview.getByText("Unsaved changes")).toBeVisible();

  // Esc while there are changes asks first.
  await preview.locator(".pdfViewer").click({ position: { x: 20, y: 20 } });
  await page.keyboard.press("Escape");
  const ask = page.getByRole("dialog", { name: "Discard your changes?" });
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Cancel" }).click();

  // Save → a new version.
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/api/files/${id}/pdf`));
  await preview.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).ok()).toBeTruthy();
  await expect(preview.getByText("Unsaved changes")).toBeHidden();

  const bytes = await (await page.request.get(`/api/files/${id}/download`, { headers: { Authorization: auth } })).body();
  expect(bytes.toString("latin1")).toContain("Ada Lovelace");
  const versions = await (await page.request.get(`/api/files/${id}/versions`, { headers: { Authorization: auth } })).json();
  expect(versions.kind).toBe("pdf");
  expect(versions.versions.map((v: { source: string }) => v.source)).toEqual(["edit"]);

  // Reopened, the filled-in value is there.
  await page.reload();
  await expect(preview.locator(".annotationLayer input").first()).toHaveValue("Ada Lovelace", { timeout: 20_000 });
});

test("search, mark up, delete a page, and restore from the history", async ({ alice: page }) => {
  test.setTimeout(150_000);
  const auth = await bearer(page);
  const name = `e2e-pages-${stamp}.pdf`;
  const id = await upload(page, auth, name, pdf(name, ["Tenancy terms", "Rent and deposit", "Break clause"]));
  await page.goto(`/files/f/${id}`);
  const preview = page.getByRole("dialog").filter({ has: page.locator("#preview-title") });
  await expect(preview.getByText("Page 1 of 3")).toBeVisible({ timeout: 20_000 });

  // Search finds text on page 3.
  await preview.getByRole("button", { name: "Search in the PDF" }).click();
  await preview.getByLabel("Find in this PDF").fill("Break");
  await expect(preview.getByText("1 of 1")).toBeVisible({ timeout: 15_000 });
  await expect(preview.getByText("Page 3 of 3")).toBeVisible();
  await preview.getByRole("button", { name: "Close search" }).click();

  // Add a text note on page 3.
  await preview.getByRole("button", { name: "Add text" }).click();
  const page3 = preview.locator('.pdfViewer .page[data-page-number="3"]');
  await page3.click({ position: { x: 120, y: 300 } });
  await page.keyboard.type("Check this clause");
  await preview.getByRole("button", { name: "Select" }).click();
  await expect(preview.getByText("Unsaved changes")).toBeVisible();

  // Delete page 2 from the page rail.
  await preview.getByRole("button", { name: "Pages", exact: true }).click();
  const rail = preview.getByRole("complementary", { name: "Pages" });
  await rail.getByRole("button", { name: "Page 2", exact: true }).click();
  await rail.getByRole("button", { name: /Delete/ }).click();
  await expect(preview.getByText(/Page \d of 2/)).toBeVisible({ timeout: 20_000 });

  // Save: two pages, the note kept.
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith(`/api/files/${id}/pdf`));
  await preview.getByRole("button", { name: "Save", exact: true }).click();
  expect((await saved).ok()).toBeTruthy();
  // Reopened: two pages, and the note is a real annotation in the file.
  // (pdf.js writes compressed object streams, so the bytes aren't greppable.)
  await page.reload();
  await expect(preview.getByText("Page 1 of 2")).toBeVisible({ timeout: 20_000 });
  await preview.locator('.pdfViewer .page[data-page-number="2"]').scrollIntoViewIfNeeded();
  await expect(preview.locator('.pdfViewer .page[data-page-number="2"] .annotationLayer .freeTextAnnotation')).toHaveCount(1, {
    timeout: 15_000,
  });

  // History: restore the three-page original.
  await preview.getByRole("button", { name: /History/ }).click();
  const panel = page.getByRole("complementary", { name: "Version history" });
  await panel.getByRole("button", { name: /Before an edit/ }).click();
  await expect(panel.getByText("This version has 3 pages; the file now has 2.")).toBeVisible({ timeout: 15_000 });
  await panel.getByRole("button", { name: "Restore this version" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Restore", exact: true }).click();
  await expect(preview.getByText("Page 1 of 3")).toBeVisible({ timeout: 20_000 });
});
