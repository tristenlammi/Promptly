import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";

/** Page setup (WP-6.4): chosen in the editor, shared live through the
 *  document, and carried into the PDF (print preview) and the .docx. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

/** One file out of a zip (the .docx), enough for a test. */
function unzipEntry(zip: Buffer, name: string): string | null {
  let at = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const entries = zip.readUInt16LE(at + 10);
  at = zip.readUInt32LE(at + 16);
  for (let i = 0; i < entries; i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30);
    const comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const entry = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    if (entry === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    }
    at += 46 + nameLen + extra + comment;
  }
  return null;
}

test("page setup reaches everyone, the PDF preview and the Word file", async ({ alice: page }) => {
  test.setTimeout(150_000);
  const auth = await bearer(page);
  const r = await page.request.post("/api/files/office", {
    headers: { Authorization: auth },
    data: { kind: "document", title: `E2E paged ${stamp}` },
  });
  const docId = (await r.json()).id as string;
  await page.goto(`/files/doc/${docId}`);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 20_000 });
  await editor.click();
  await page.keyboard.type("Paged words for the printer.");

  const other = await page.context().newPage();
  await other.goto(`/files/doc/${docId}`);
  await expect(other.locator(".ProseMirror").first()).toContainText("Paged words", { timeout: 20_000 });

  // Choose Letter, landscape, a footer and page numbers.
  await page.getByRole("button", { name: "Download document" }).click();
  await page.getByRole("menuitem", { name: "Page setup…" }).click();
  const dialog = page.getByRole("dialog", { name: "Page setup" });
  await dialog.getByLabel("Paper size").selectOption("Letter");
  await dialog.getByRole("radio", { name: "landscape" }).click();
  await dialog.getByRole("button", { name: "Narrow" }).click();
  await dialog.getByLabel("Footer").fill("E2E footer");
  await dialog.getByLabel("Page numbers").selectOption("bottom-center");
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog).toBeHidden();

  // The server reads it from the document…
  await expect
    .poll(
      async () => {
        const s = await (await page.request.get(`/api/documents/${docId}/page-setup`, { headers: { Authorization: auth } })).json();
        return `${s.size} ${s.orientation} ${s.margins.left} ${s.footer} ${s.pageNumbers}`;
      },
      { timeout: 20_000 }
    )
    .toBe("Letter landscape 12.7 E2E footer bottom-center");

  // …and the other window has it too.
  await other.getByRole("button", { name: "Download document" }).click();
  await other.getByRole("menuitem", { name: "Page setup…" }).click();
  const otherDialog = other.getByRole("dialog", { name: "Page setup" });
  await expect(otherDialog.getByLabel("Paper size")).toHaveValue("Letter");
  await expect(otherDialog.getByLabel("Footer")).toHaveValue("E2E footer");
  await otherDialog.getByRole("button", { name: "Cancel" }).click();

  // Print preview: the server's PDF, landscape.
  await page.getByRole("button", { name: "Download document" }).click();
  await page.getByRole("menuitem", { name: "Print preview…" }).click();
  const preview = page.getByTestId("print-preview");
  const canvas = preview.locator("canvas").first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => canvas.evaluate((c: HTMLCanvasElement) => c.width > c.height && c.height > 0), { timeout: 15_000 })
    .toBe(true);
  await page.getByRole("dialog", { name: "Print preview" }).getByRole("button", { name: "Close", exact: true }).first().click();

  // The Word file: landscape Letter, narrow margins, the footer with a page field.
  await page.getByRole("button", { name: "Download document" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Word (.docx)" }).click();
  const file = await (await download).path();
  const zip = readFileSync(file);
  const body = unzipEntry(zip, "word/document.xml") ?? "";
  expect(body).toMatch(/<w:pgSz[^>]*w:orient="landscape"/);
  expect(body).toMatch(/<w:pgSz[^>]*w:w="15840"[^>]*w:h="12240"|<w:pgSz[^>]*w:h="12240"[^>]*w:w="15840"/);
  expect(body).toMatch(/<w:pgMar[^>]*w:left="720"/);
  const footerXml = ["word/footer1.xml", "word/footer2.xml", "word/footer3.xml"].map((n) => unzipEntry(zip, n) ?? "").join("");
  expect(footerXml).toContain("E2E footer");
  expect(footerXml).toMatch(/PAGE/);
});
