import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures";

/** Labels nest by name, as Gmail keeps them: "Homes/Lot 7534" sits under "Homes". */

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const LABELS = [
  { id: id(1), name: "Homes", color: "#4F9DA6", unread: 1, fetching: false },
  { id: id(2), name: "Homes Two", color: "#D97757", unread: 0, fetching: false },
  { id: id(3), name: "Homes/64 Blackwood Cct", color: "#5B7FBF", unread: 2, fetching: false },
  { id: id(4), name: "Homes/Lot 7534", color: "#C2668A", unread: 0, fetching: false },
  { id: id(5), name: "Trips/Japan", color: "#C9A227", unread: 0, fetching: false },
];

async function mailbox(page: Page) {
  const edits: { name?: string }[] = [];
  const added: { name?: string }[] = [];
  await page.route("**/api/mail/**", async (r) => {
    const { pathname } = new URL(r.request().url());
    if (pathname.endsWith("/mail/overview")) {
      return r.fulfill({
        json: {
          accounts: [{ id: ACCOUNT, email: "me@example.com", display_name: "Me", color: "#D97757", provider: "imap", signature: "", notify: false, status: "ok", status_detail: "", last_sync_at: "2026-11-05T01:00:00+00:00", pinned: false }],
          folders: [],
          labels: LABELS,
          sorting: false,
          needs_reply: 0,
          failed: [],
        },
      });
    }
    if (pathname.endsWith("/mail/threads")) return r.fulfill({ json: { threads: [], next: null } });
    if (pathname.endsWith("/mail/rules")) return r.fulfill({ json: [] });
    if (r.request().method() === "PATCH") {
      edits.push(r.request().postDataJSON());
      return r.fulfill({ json: {} });
    }
    if (r.request().method() === "POST" && pathname.endsWith("/mail/labels")) {
      added.push(r.request().postDataJSON());
      return r.fulfill({ status: 201, json: { id: id(9), name: "x", color: "#D97757", unread: 0 } });
    }
    return r.fulfill({ json: {} });
  });
  return { edits, added };
}

const rail = (page: Page) => page.getByRole("navigation", { name: "Mail folders" });

test("labels sit under their parent, and a parent folds away", async ({ alice: page }) => {
  // Once only: the reload below is checking that it stays folded.
  await page.addInitScript(() => {
    if (sessionStorage.getItem("started")) return;
    sessionStorage.setItem("started", "1");
    localStorage.removeItem("promptly.mail.foldedLabels");
  });
  await mailbox(page);
  await page.goto("/mail");

  const child = rail(page).getByRole("button", { name: "Homes/64 Blackwood Cct" });
  await expect(child).toHaveText(/^64 Blackwood Cct\s*2$/);
  const parentBox = (await rail(page).getByRole("button", { name: "Homes", exact: true }).boundingBox())!;
  const dotOf = (name: string) => rail(page).getByRole("button", { name, exact: true }).locator("span").first().boundingBox();
  expect((await dotOf("Homes/64 Blackwood Cct"))!.x).toBeGreaterThan((await dotOf("Homes"))!.x);
  expect((await child.boundingBox())!.y).toBeGreaterThan(parentBox.y);
  // "Homes Two" is its own label, and comes after everything inside Homes.
  expect((await rail(page).getByRole("button", { name: "Homes Two" }).boundingBox())!.y).toBeGreaterThan((await rail(page).getByRole("button", { name: "Homes/Lot 7534" }).boundingBox())!.y);

  // A parent with no label of its own is only a heading.
  await expect(rail(page).getByText("Trips", { exact: true })).toBeVisible();
  await expect(rail(page).getByRole("button", { name: "Trips", exact: true })).toHaveCount(0);

  // Folded, its unread shows on the parent, and it stays folded.
  await rail(page).getByRole("button", { name: "Hide labels inside Homes" }).click();
  await expect(child).toHaveCount(0);
  await expect(rail(page).getByRole("button", { name: "Homes", exact: true })).toHaveText(/^Homes\s*3$/);
  await page.waitForTimeout(100);
  await page.reload();
  await expect(rail(page).getByRole("button", { name: "Show labels inside Homes" })).toBeVisible();
});

test("a label can be put inside another, or made inside one", async ({ alice: page }) => {
  await page.addInitScript(() => localStorage.removeItem("promptly.mail.foldedLabels"));
  const { edits, added } = await mailbox(page);
  await page.goto("/mail");
  await rail(page).getByRole("button", { name: "Manage labels and rules" }).click();
  const sheet = page.getByRole("dialog", { name: "Labels" });

  await sheet.getByRole("button", { name: "Edit Homes Two" }).click();
  await expect(sheet.getByLabel("Label name")).toHaveValue("Homes Two");
  const inside = sheet.getByLabel("Inside").first();
  await inside.selectOption("Homes");
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect.poll(() => edits).toEqual([{ name: "Homes/Homes Two" }]);

  // Not into itself, nor anything inside it.
  await sheet.getByRole("button", { name: "Edit Homes", exact: true }).click();
  await expect(sheet.getByLabel("Inside").first().locator("option", { hasText: /^Homes$/ })).toHaveCount(0);
  await expect(sheet.getByLabel("Inside").first().locator("option", { hasText: "Homes/Lot 7534" })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Done" }).click();

  await sheet.getByLabel("Inside").last().selectOption("Homes/Lot 7534");
  await sheet.getByRole("textbox", { name: "New label" }).fill("Plans");
  await sheet.getByRole("button", { name: "Add label" }).click();
  await expect.poll(() => added.map((a) => a.name)).toEqual(["Homes/Lot 7534/Plans"]);
});
