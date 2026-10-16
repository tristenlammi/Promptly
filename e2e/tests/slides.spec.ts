import fs from "node:fs";

import { expect, ready, test } from "../fixtures";

/** Slides-lite (Stage 12): New → Presentation opens a whiteboard in slide
 *  mode with a first slide; slides are added and given notes, presented
 *  full-screen, and exported as a .pptx (with the notes) and a PDF. */

test("a presentation is built, presented and exported", async ({ alice: page }) => {
  test.setTimeout(120_000);
  await page.goto("/files/home");
  await ready(page);
  await page.getByRole("button", { name: "Presentation", exact: true }).click();
  await expect(page).toHaveURL(/\/files\/whiteboard\/[^?]+\?slides=new/);

  const sorter = page.getByRole("list", { name: "Slide order" });
  await expect(sorter.getByRole("button", { name: /^Slide 1/ })).toBeVisible({ timeout: 30_000 });
  const notes = page.getByRole("textbox", { name: /Speaker notes/ });
  await notes.fill("Welcome everyone.");

  await page.getByRole("button", { name: "New slide" }).click();
  await expect(sorter.getByRole("button", { name: /^Slide 2/ })).toBeVisible();
  await expect(sorter.getByRole("button", { name: /^Slide 2/ })).toHaveAttribute("aria-current", "true");
  await notes.fill("Thanks — questions?");

  // Back on slide 1, its own notes.
  await sorter.getByRole("button", { name: /^Slide 1/ }).click();
  await expect(notes).toHaveValue("Welcome everyone.");

  // Present: full-screen slides, → to the next, Esc to stop.
  await page.getByRole("button", { name: "Present" }).click();
  const show = page.getByRole("dialog", { name: "Presenting" });
  await expect(show.getByRole("img", { name: "Slide 1 of 2" })).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("ArrowRight");
  await expect(show.getByRole("img", { name: "Slide 2 of 2" })).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(show).toBeHidden();

  // Exports.
  await page.getByRole("button", { name: "Export slides" }).click();
  const pptxDl = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "PowerPoint (.pptx)" }).click();
  const pptx = await pptxDl;
  expect(pptx.suggestedFilename()).toBe("Untitled presentation.pptx");
  const pptxBytes = fs.readFileSync(await pptx.path());
  expect(pptxBytes.subarray(0, 2).toString()).toBe("PK"); // a zip, as .pptx is
  // The notes went in (notesSlide parts).
  expect(pptxBytes.includes(Buffer.from("ppt/notesSlides/notesSlide1.xml"))).toBe(true);

  await page.getByRole("button", { name: "Export slides" }).click();
  const pdfDl = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "PDF" }).click();
  const pdf = await pdfDl;
  const pdfBytes = fs.readFileSync(await pdf.path());
  expect(pdfBytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(pdfBytes.toString("latin1").match(/\/Type \/Page\b/g)?.length).toBe(2);
});

test("slides are generated from a file, citing it in the notes", async ({ alice: page }) => {
  test.setTimeout(120_000);
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files/home");
  await ready(page);
  const auth = { Authorization: (await seen).headers()["authorization"] };
  const name = `deck-notes-${Date.now().toString(36)}.txt`;
  const up = await page.request.post("/api/files/", {
    headers: auth,
    multipart: { scope: "mine", file: { name, mimeType: "text/plain", buffer: Buffer.from("We fixed the roof in March and plan solar panels next.") } },
  });
  expect(up.ok()).toBeTruthy();

  await page.getByRole("button", { name: "Presentation", exact: true }).click();
  const sorter = page.getByRole("list", { name: "Slide order" });
  await expect(sorter.getByRole("button", { name: /^Slide 1/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Generate slides from files" }).click();
  const dialog = page.getByRole("dialog", { name: "Generate slides from files" });
  await dialog.getByRole("button", { name: "Choose files" }).click();
  await page.getByRole("checkbox", { name: new RegExp(`^${name}`) }).check();
  await page.getByRole("button", { name: /^Use 1 file/ }).click();
  await expect(dialog.getByRole("list", { name: "Source files" })).toContainText(name);
  await dialog.getByRole("button", { name: "Generate" }).click();
  await expect(sorter.getByRole("button", { name: /^Slide 4/ })).toBeVisible({ timeout: 60_000 });
  await sorter.getByRole("button", { name: /^Slide 3: What the file says/ }).click();
  await expect(page.getByRole("textbox", { name: /Speaker notes/ })).toHaveValue(`Walk through it.\n\nSources: ${name}`);
});
