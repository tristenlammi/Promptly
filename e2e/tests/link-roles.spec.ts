import type { Page } from "@playwright/test";

import { expect, ready, run, stamp, test } from "../fixtures";

/** "Signed-in users with the link can comment" (WP-6.6). */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

test("a comment link lets a signed-in person read and comment, until it's revoked", async ({ alice, bob }) => {
  test.setTimeout(150_000);
  const auth = await bearer(alice);
  const title = `E2E link ${stamp}`;
  const r = await alice.request.post("/api/files/office", {
    headers: { Authorization: auth },
    data: { kind: "document", title },
  });
  const docId = (await r.json()).id as string;

  // Alice writes something, then makes a comment link from the header.
  await alice.goto(`/files/doc/${docId}`);
  const editor = alice.locator(".ProseMirror").first();
  await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 20_000 });
  await editor.click();
  await alice.keyboard.type("The launch moves to March.");
  await expect(alice.getByText("Saved", { exact: true })).toBeVisible({ timeout: 20_000 });
  await alice.waitForTimeout(3000); // the collab store is debounced

  await alice.getByRole("button", { name: "Share", exact: true }).click();
  await alice.getByRole("button", { name: "Manage links" }).click();
  const links = alice.getByRole("dialog").filter({ hasText: "People with the link can" });
  await links.getByRole("radio", { name: "Comment" }).click();
  await expect(links.getByRole("button", { name: /Anyone with the link/ })).toBeDisabled();
  await links.getByRole("button", { name: "Create link" }).click();
  await expect(links.getByText("Can comment")).toBeVisible();
  const url = await links.locator("input[readonly]").first().inputValue();
  expect(url).toContain("/s/");

  // Bob opens it: straight into the document, read-only, and can comment.
  await bob.goto(url.replace(/^https?:\/\/[^/]+/, ""));
  await expect(bob).toHaveURL(new RegExp(`/files/doc/${docId}`), { timeout: 20_000 });
  const bobEditor = bob.locator(".ProseMirror").first();
  await expect(bobEditor).toContainText("The launch moves to March.", { timeout: 20_000 });
  await expect(bobEditor).toHaveAttribute("contenteditable", "false");
  await bobEditor.locator("p").first().click({ clickCount: 3 });
  await bob.getByRole("toolbar", { name: "Comment on the selection" }).getByRole("button").click();
  const panel = bob.getByRole("complementary", { name: "Comments" });
  await panel.getByRole("textbox").first().fill("Is March firm?");
  await panel.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(panel.getByRole("article", { name: /Comment by/ })).toContainText("Is March firm?");

  // Alice sees Bob on the people list, joined through the link.
  const grants = await (await alice.request.get(`/api/files/file/${docId}/grants`, { headers: { Authorization: auth } })).json();
  expect(grants.grants.map((g: { username: string; via_link: boolean; can_comment: boolean }) => [g.username, g.via_link, g.can_comment])).toEqual([
    [run.users.bob.username, true, true],
  ]);

  // Revoked: Bob's access goes with the link.
  await links.getByRole("button", { name: "Revoke link" }).click();
  await expect(links.getByText("No active links yet.")).toBeVisible();
  await bob.reload();
  await expect(bob.locator(".ProseMirror")).toHaveCount(0, { timeout: 20_000 });
});
