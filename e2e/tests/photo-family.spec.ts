import type { Page } from "@playwright/test";

import { expect, ready, test } from "../fixtures";

/** The family library (PH-5): one member shares their photos; another sees
 *  them in Photos → Family, and can look but not change them. Torn down
 *  after, so other tests' libraries stay their own. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

async function leave(page: Page, auth: Record<string, string>) {
  const f = (await (await page.request.get("/api/photos/family", { headers: auth })).json()).family;
  const me = f?.members.find((m: { you: boolean }) => m.you);
  if (me) await page.request.delete(`/api/photos/family/members/${me.user_id}`, { headers: auth });
}

test("a family member's shared photos show in Family", async ({ alice, dana }) => {
  test.setTimeout(120_000);
  const a = { Authorization: await bearer(alice) };
  const d = { Authorization: await bearer(dana) };
  await leave(alice, a);
  await leave(dana, d);
  try {
    expect((await alice.request.post("/api/photos/family", { headers: a, data: { name: "E2E family" } })).status()).toBe(201);
    const danaId = (await (await dana.request.get("/api/auth/me", { headers: d })).json()).id;
    expect((await alice.request.post("/api/photos/family/members", { headers: a, data: { user_id: danaId } })).ok()).toBe(true);
    const shared = await (await alice.request.put("/api/photos/family/share", { headers: a, data: { mode: "all" } })).json();
    const count = shared.family.members.find((m: { you: boolean }) => m.you).photos;
    expect(count).toBeGreaterThan(0);

    await dana.goto("/files/photos?view=family");
    await ready(dana);
    const tile = dana.locator("[data-photo]").first();
    await expect(tile).toBeVisible({ timeout: 20_000 });
    await tile.click();
    // Look, don't touch: no edit, favourite, archive or trash on someone else's photo.
    await expect(dana.getByRole("button", { name: "Info", exact: true })).toBeVisible();
    await expect(dana.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await expect(dana.getByRole("button", { name: "Move to trash" })).toHaveCount(0);
    await dana.keyboard.press("Escape");

    await dana.getByRole("button", { name: "Family…" }).click();
    const dialog = dana.getByRole("dialog", { name: "E2E family" });
    await expect(dialog.getByRole("region", { name: "People in the family" })).toContainText("sharing everything");
    await expect(dialog.getByRole("radio", { name: "Nothing" })).toBeChecked();
  } finally {
    await leave(dana, d);
    await leave(alice, a);
  }
});
