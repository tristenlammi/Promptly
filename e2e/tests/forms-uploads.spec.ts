import type { Browser, Page } from "@playwright/test";
import { deflateSync } from "node:zlib";

import { expect, ready, stamp, test } from "../fixtures";
import { BASE_URL } from "../lib/stack";

/** Forms WP-F1.6: someone without an account answers a link form on a phone,
 *  with a photo; it uploads with its progress and shows as a tile. The owner
 *  sees it in Responses (a tile strip, and Download / Save to Files under the
 *  answer, with the "outside the server" warning), and the linked sheet lists
 *  the file with a link back to the answer. */

const PHONE = { width: 375, height: 812 };

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/forms");
  await ready(page);
  return (await seen).headers()["authorization"];
}

/** A small real PNG (a red square). */
function png(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const w = 32;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) raw[y * (w * 3 + 1) + 1 + x * 3] = 220;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function phone(browser: Browser) {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: PHONE, hasTouch: true, serviceWorkers: "block" });
  await context.route("**/version.json*", (r) => r.abort());
  return { context, page: await context.newPage() };
}

test("a photo sent from a phone shows in Responses and in the linked sheet", async ({ alice, browser }) => {
  test.setTimeout(180_000);
  const auth = await bearer(alice);
  const headers = { Authorization: auth };
  const title = `Receipts ${stamp}`;
  const made = await alice.request.post("/api/forms", { headers, data: {} });
  const fileId = (await made.json()).file.id as string;
  const definition = {
    version: 1, title, description: "", after: "continue",
    theme: { accent: "terracotta", header_asset_id: null, header_builtin: null, font: "default" },
    items: [
      { id: "name", kind: "short_text", title: "Your name", description: "", image_asset_id: null, required: true, deleted: false,
        config: { validation: { kind: "any", min: null, max: null, integer: false }, min_length: null, max_length: null } },
      { id: "receipt", kind: "file_upload", title: "Photo of your receipt", description: "", image_asset_id: null, required: true, deleted: false,
        config: { kinds: ["images", "pdf", "documents"], max_files: 2, max_size_mb: 5 } },
    ],
  };
  expect((await alice.request.put(`/api/forms/${fileId}/definition`, { headers, data: { definition, data_version: 1 } })).ok()).toBe(true);
  expect((await alice.request.patch(`/api/forms/${fileId}/settings`, { headers, data: { accepting: true, audience: "link", allow_uploads_from_link: true } })).ok()).toBe(true);
  const token = (await (await alice.request.post(`/api/forms/${fileId}/link`, { headers, data: {} })).json()).link.token as string;
  // A sheet, so the file's row lands there too.
  expect((await alice.request.post(`/api/forms/${fileId}/sheet`, { headers, data: { mode: "new" } })).ok()).toBe(true);

  // A phone, no account.
  const s = await phone(browser);
  await s.page.goto(`/f/${token}`);
  await expect(s.page.getByRole("heading", { name: title })).toBeVisible({ timeout: 20_000 });
  await s.page.getByLabel("Your name").fill("Ann");
  const q = s.page.locator('[data-file-question="receipt"]');
  // People without an account: pictures and PDFs only.
  await expect(q.getByText(/pictures or PDFs/)).toBeVisible();
  await expect(q.getByRole("button", { name: "Add files" })).toBeVisible();
  // A text file isn't one of them: refused on the phone, before it's sent.
  await q.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(q.getByRole("alert")).toContainText("isn't a kind of file this question takes");
  await q.locator('input[type="file"]').setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: png() });
  await expect(q.getByText("receipt.png")).toBeVisible({ timeout: 20_000 });
  await expect(q.getByText(/Ready to send/)).toBeVisible({ timeout: 20_000 });
  await s.page.screenshot({ path: test.info().outputPath("answer-with-photo.png"), fullPage: true });
  await s.page.waitForTimeout(3200);
  await s.page.getByRole("button", { name: "Submit" }).click();
  await expect(s.page.getByText("Your answer has been sent.")).toBeVisible({ timeout: 20_000 });
  await s.context.close();

  // Responses: the strip, then the answer with Download and Save to Files.
  await alice.goto(`/files/form/${fileId}?tab=responses`);
  const strip = alice.getByTestId("file-strip");
  await expect(strip.getByText("receipt.png")).toBeVisible({ timeout: 20_000 });
  await strip.getByRole("button", { name: /receipt\.png, from answer #1/ }).click();
  await expect(alice.getByText(/From someone outside the server/)).toBeVisible();
  const download = alice.getByRole("link", { name: "Download" });
  await expect(download).toHaveAttribute("href", /^\/m\//);
  const res = await alice.request.get(await download.getAttribute("href") as string);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-disposition"]).toContain("attachment");
  await alice.getByRole("button", { name: "Save to Files" }).click();
  await expect(alice.getByText(/Saved “receipt.*” to your Forms folder/)).toBeVisible({ timeout: 20_000 });
  await alice.screenshot({ path: test.info().outputPath("responses-file.png") });

  // The sheet: the file's name and a link back to its answer.
  const summary = await (await alice.request.get(`/api/forms/${fileId}/summary`, { headers })).json();
  const sheetId = summary.sheet.file_id as string;
  await expect
    .poll(async () => {
      const body = await (await alice.request.get(`/api/files/${sheetId}/sheet`, { headers })).json();
      const tab = (body.data ?? []).find((t: { name: string }) => t.name === "Form responses");
      const cells = (tab?.celldata ?? []) as { r: number; c: number; v: { v?: string } }[];
      return cells.map((c) => String(c.v?.v ?? "")).find((v) => v.startsWith("receipt.png")) ?? "";
    }, { timeout: 40_000 })
    .toMatch(new RegExp(`^receipt\\.png — https?://.+/files/form/${fileId}\\?tab=responses&answer=1&file=`));
});
