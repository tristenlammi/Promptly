import fs from "node:fs";

import type { Page } from "@playwright/test";

import { expect, ready, run, stamp, test } from "../fixtures";
import { png } from "../lib/files";

/** Albums (WP-9.4): make one from a selection, share it, and the person it's
 *  shared with sees its photos — but can't add to it as a viewer. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("an album made from a selection, shared, and seen by someone else", async ({ alice, bob }) => {
  test.setTimeout(150_000);
  const auth = await bearer(alice);
  const ids: string[] = [];
  for (const n of ["one", "two"]) {
    const name = `e2e-album-${n}-${stamp}.png`;
    const r = await alice.request.post("/api/files/", {
      headers: { Authorization: auth },
      multipart: { file: { name, mimeType: "image/png", buffer: fs.readFileSync(png(name)) }, scope: "mine" },
    });
    expect(r.status()).toBe(201);
    ids.push((await r.json()).id);
  }
  // Read by the media worker, so they're in Photos.
  await expect
    .poll(async () => {
      const t = await (await alice.request.get("/api/photos/timeline?limit=200", { headers: { Authorization: auth } })).json();
      return ids.every((id) => t.items.some((i: { id: string }) => i.id === id));
    }, { timeout: 30_000 })
    .toBe(true);

  await alice.goto("/files/photos");
  await ready(alice);
  const first = alice.locator(`[data-photo="${ids[0]}"]`);
  await first.hover();
  await first.getByRole("button", { name: "Select" }).click();
  await alice.locator(`[data-photo="${ids[1]}"]`).click();
  await alice.getByRole("toolbar", { name: "Selected photos" }).getByRole("button", { name: "Add to album" }).click();
  const title = `E2E holiday ${stamp}`;
  await alice.getByLabel("New album name").fill(title);
  await alice.getByRole("button", { name: "Create" }).click();
  await expect(alice.getByText(`Added 2 to “${title}”.`)).toBeVisible();

  // Albums → the album, with both photos.
  await alice.getByRole("link", { name: "Albums" }).click();
  await alice.getByRole("list", { name: "Albums" }).getByRole("link", { name: new RegExp(title) }).click();
  await expect(alice).toHaveURL(/\/files\/photos\/albums\/[0-9a-f-]{36}$/);
  await expect(alice.locator("[data-photo]")).toHaveCount(2);

  // Share it with Bob, who can look.
  await alice.getByRole("button", { name: "Share" }).click();
  const share = alice.getByRole("dialog");
  await share.getByPlaceholder("Add someone by name or email").fill(run.users.bob.username);
  await share.getByRole("button", { name: new RegExp(run.users.bob.username) }).first().click();
  await share.getByLabel("What they can do").selectOption("viewer");
  await share.getByRole("button", { name: "Add", exact: true }).click();
  await expect(share.getByRole("list", { name: "People in this album" })).toContainText(run.users.bob.username);
  const albumUrl = alice.url();

  await bob.goto("/files/photos/albums");
  await ready(bob);
  const card = bob.getByRole("list", { name: "Albums" }).getByRole("link", { name: new RegExp(title) });
  await expect(card).toContainText(`from ${run.users.alice.username}`);
  await card.click();
  await expect(bob).toHaveURL(new RegExp(`/files/photos/albums/${albumUrl.split("/").pop()}$`));
  await expect(bob.locator("[data-photo]")).toHaveCount(2);
  await expect(bob.getByRole("button", { name: "Add photos" })).toHaveCount(0);
  // Bob can open Alice's photo through the album.
  await bob.locator(`[data-photo="${ids[0]}"]`).click();
  await expect(bob.getByRole("dialog", { name: "Photo viewer" })).toBeVisible();
});
