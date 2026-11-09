import type { APIRequestContext, Page } from "@playwright/test";

import { expect, ready, stamp, test } from "../fixtures";

/** Admin privacy: deleting a user never hands their work to the admin (AP4),
 *  and a pairing code never travels in an address (AP1).
 *  A shared workspace goes to one of its own members; a private one is only
 *  counted, never named, and goes with the account. */

async function bearer(page: Page, path = "/"): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto(path);
  await ready(page);
  return (await seen).headers()["authorization"];
}

async function signIn(request: APIRequestContext, identifier: string, password: string): Promise<string> {
  const r = await request.post("/api/auth/login", { data: { identifier, password } });
  expect(r.ok(), await r.text()).toBe(true);
  return `Bearer ${(await r.json()).access_token}`;
}

test("deleting a user gives their shared workspace to a member and names no private one", async ({
  dana: admin,
  bob,
  request,
}) => {
  test.setTimeout(120_000);
  const adminAuth = await bearer(admin);
  const bobAuth = await bearer(bob);
  const bobName = (await (await bob.request.get("/api/auth/me", { headers: { Authorization: bobAuth } })).json())
    .username as string;

  // Someone who's leaving, with one private workspace and one shared with Bob.
  const username = `e2e_leaver_${stamp}`;
  const password = `Leaver-${stamp}-pass!42`;
  const made = await admin.request.post("/api/admin/users", {
    headers: { Authorization: adminAuth },
    data: { email: `${username}@example.com`, username, password, role: "user", must_change_password: false },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const leaverId = (await made.json()).id as string;
  // Its own request context: signing in sets session cookies, and in the
  // admin's context they'd turn the admin's page into the leaver's.
  const leaver = await signIn(request, username, password);
  const create = async (title: string) => {
    const r = await request.post("/api/workspaces", { headers: { Authorization: leaver }, data: { title } });
    expect(r.ok(), await r.text()).toBe(true);
    return (await r.json()).id as string;
  };
  const privateTitle = `Private plans ${stamp}`;
  const teamTitle = `Team notes ${stamp}`;
  await create(privateTitle);
  const teamId = await create(teamTitle);
  const share = await request.post(`/api/workspaces/${teamId}/shares`, {
    headers: { Authorization: leaver },
    data: { username: bobName, role: "editor" },
  });
  expect(share.ok(), await share.text()).toBe(true);
  const accepted = await bob.request.post(`/api/workspace-share-invites/${(await share.json()).id}/accept`, {
    headers: { Authorization: bobAuth },
  });
  expect(accepted.ok(), await accepted.text()).toBe(true);

  await admin.goto("/admin?tab=users");
  await admin.getByRole("searchbox", { name: "Search users" }).fill(username);
  await admin.getByRole("button", { name: `More actions for ${username}` }).click();
  await admin.getByRole("button", { name: "Delete user…" }).click();

  const dialog = admin.getByRole("dialog", { name: "Delete user" });
  await expect(dialog).toContainText("Shared workspaces (1)");
  await expect(dialog).toContainText(`Shared workspace 1 · 1 other member. Goes to ${bobName}.`);
  await expect(dialog).toContainText("1 private workspace will be deleted with the account");
  await expect(dialog).toContainText("Export my library");
  // The admin isn't in either workspace: no names.
  await expect(dialog).not.toContainText(privateTitle);
  await expect(dialog).not.toContainText(teamTitle);
  // And nobody to choose but the workspace's own member.
  await expect(dialog.getByRole("combobox")).toHaveCount(0);

  await dialog.getByRole("textbox").fill(username);
  await dialog.getByRole("button", { name: "Delete user" }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });

  const users = await (await admin.request.get("/api/admin/users", { headers: { Authorization: adminAuth } })).json();
  expect(users.some((u: { id: string }) => u.id === leaverId)).toBe(false);
  // Bob owns the team's workspace now; the admin got nothing.
  const mine = await (await bob.request.get("/api/workspaces", { headers: { Authorization: bobAuth } })).json();
  const team = mine.find((w: { id: string }) => w.id === teamId);
  expect(team?.title).toBe(teamTitle);
  const adminWs = await (await admin.request.get("/api/workspaces", { headers: { Authorization: adminAuth } })).json();
  expect(adminWs.some((w: { title: string }) => w.title === teamTitle || w.title === privateTitle)).toBe(false);
});

test("pairing a phone asks with the code in the body, never in the address", async ({ alice: page }) => {
  const asks: { method: string; url: string; body: string | null }[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/devices/pair")) asks.push({ method: r.method(), url: r.url(), body: r.postData() });
  });
  await page.goto("/files/devices");
  await ready(page);
  await page.getByRole("button", { name: "Add device" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add a device" });
  await expect(dialog.getByRole("img", { name: "Pairing QR code" })).toBeVisible();
  await expect.poll(() => asks.filter((a) => a.url.endsWith("/api/devices/pair/status")).length, { timeout: 10_000 })
    .toBeGreaterThan(0);

  const status = asks.find((a) => a.url.endsWith("/api/devices/pair/status"))!;
  expect(status.method).toBe("POST");
  const code = JSON.parse(status.body!).code as string;
  expect(code.length).toBeGreaterThan(8);
  // No request carries the code in its address.
  expect(asks.every((a) => !a.url.includes(code))).toBe(true);
  await page.keyboard.press("Escape");
});
