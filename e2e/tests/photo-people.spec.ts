import fs from "node:fs";

import type { Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";
import { seedFaces, wordPhoto } from "../lib/files";

/** People (PH-3): faces that look alike become one person; "Who is this?"
 *  names them, and their photos are a click away. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("alike faces become a person who's named once", async ({ bob: page }) => {
  test.setTimeout(240_000);
  const auth = { Authorization: await bearer(page) };
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const name = `ada-${stamp}-${i}.jpg`;
    const up = await page.request.post("/api/files/", {
      headers: auth,
      multipart: { scope: "mine", route: "camera", file: { name, mimeType: "image/jpeg", buffer: fs.readFileSync(wordPhoto(name, `ADA ${i}`)) } },
    });
    ids.push((await up.json()).id);
  }
  seedFaces("e2e_bob", ids, 7 + (Number.parseInt(stamp.slice(-2), 36) % 400));

  // The next understanding tick clusters them into one (unnamed) person.
  await expect
    .poll(async () => {
      const r = await (await page.request.get("/api/photos/people/review", { headers: auth })).json();
      return (r.people as { kind: string; photos: number }[]).some((p) => p.kind === "person" && p.photos >= 3);
    }, { timeout: 180_000, intervals: [5_000] })
    .toBe(true);

  await page.goto("/files/photos");
  await ready(page);
  await page.getByRole("link", { name: "People" }).click();
  const review = page.getByRole("region", { name: "Who is this?" });
  const name = `Ada ${stamp}`;
  await review.getByRole("combobox", { name: "Who is this?" }).first().fill(name);
  await review.getByRole("button", { name: "Save name" }).first().click();
  const person = page.getByRole("list", { name: "People" }).getByRole("link", { name: new RegExp(name) });
  await expect(person).toBeVisible({ timeout: 15_000 });
  await expect(person).toContainText("3 photos");
  await person.click();
  await expect(page.getByRole("heading", { name: new RegExp(name) })).toBeVisible();
  await expect(page.getByLabel("Their photos").locator("[data-photo]")).toHaveCount(3);

  // Who she is to you — yours only — shows in People.
  const rel = page.getByRole("combobox", { name: "Who are they to you?" });
  await rel.fill("my wife");
  const saved = page.waitForResponse((r) => r.url().endsWith("/relationship") && r.request().method() === "PUT");
  await rel.press("Enter");
  expect((await (await saved).json()).kind).toBe("spouse");

  // The faces view: one face picked out and moved to someone new.
  await page.getByRole("button", { name: "Faces" }).click();
  await page.getByRole("list", { name: "Their faces" }).getByRole("button").first().click();
  const bar = page.getByRole("toolbar", { name: "Selected faces" });
  await bar.getByRole("textbox", { name: "Someone new" }).fill(`Eve ${stamp}`);
  await bar.getByRole("button", { name: "Move" }).click();
  await expect(page.getByRole("list", { name: "Their faces" }).getByRole("button")).toHaveCount(2);
});
