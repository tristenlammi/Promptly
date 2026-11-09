import type { Page } from "@playwright/test";

import { expect, ready, run, stamp, test } from "../fixtures";

/** Sidebar count badges: an overdue task and an unread Rooms message put a
 *  small terracotta number on the Tasks and Rooms rows (expanded and
 *  collapsed), and they go when the task is done and the message read. */

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/files");
  await ready(page);
  return (await seen).headers()["authorization"];
}

async function counts(page: Page, auth: string): Promise<Record<string, number>> {
  const r = await page.request.get("/api/badges?apps=tasks,rooms", { headers: { Authorization: auth } });
  expect(r.ok()).toBe(true);
  return r.json();
}

/** The badge on a sidebar row, by app id (in the visible sidebar). */
const badge = (page: Page, app: string) => page.locator(`aside [data-badge="${app}"]`);

async function expectBadge(page: Page, app: string, n: number, words: string): Promise<void> {
  if (n <= 0) {
    await expect(badge(page, app)).toHaveCount(0);
    return;
  }
  await expect(badge(page, app)).toHaveText(n > 99 ? "99+" : String(n));
  await expect(badge(page, app)).toHaveAttribute("aria-label", `${n} ${words}`);
}

test("an overdue task and an unread message badge the sidebar, then clear", async ({ alice, bob }) => {
  test.setTimeout(120_000);
  const a = await bearer(alice);
  const b = await bearer(bob);
  const A = { Authorization: a };
  const me = (await (await alice.request.get("/api/auth/me", { headers: A })).json()) as { settings?: { nav_apps?: string[] } };
  const pinnedBefore = me.settings?.nav_apps ?? [];

  // Tasks and Rooms in alice's sidebar.
  expect((await alice.request.post("/api/items/store/tasks", { headers: A })).ok()).toBe(true);
  const nav = [...new Set([...pinnedBefore, "tasks", "rooms"])];
  expect((await alice.request.patch("/api/auth/me/preferences", { headers: A, data: { nav_apps: nav } })).ok()).toBe(true);

  let taskId = "";
  let fileId = "";
  try {
    // An overdue task.
    fileId = ((await (await alice.request.post("/api/items/open/tasks", { headers: A })).json()) as { file_id: string }).file_id;
    const title = `Badge test ${stamp}`;
    const yesterday = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const add = await alice.request.post(`/api/items/${fileId}/actions/add_tasks`, {
      headers: A,
      data: { args: { tasks: [{ title, due: yesterday }] } },
    });
    expect(add.ok(), await add.text()).toBe(true);
    taskId = title;

    // bob writes to alice.
    const dm = (await (
      await bob.request.post("/api/rooms/dms", { headers: { Authorization: b }, data: { user_ids: [run.users.alice.id] } })
    ).json()) as { id: string };
    const sent = await bob.request.post(`/api/rooms/rooms/${dm.id}/messages`, {
      headers: { Authorization: b },
      data: { body: `Hi from bob ${stamp}` },
    });
    expect(sent.ok(), await sent.text()).toBe(true);

    const before = await counts(alice, a);
    expect(before.tasks).toBeGreaterThanOrEqual(1);
    expect(before.rooms).toBeGreaterThanOrEqual(1);

    // Expanded sidebar.
    await alice.goto("/files");
    await ready(alice);
    await expectBadge(alice, "tasks", before.tasks, "due");
    await expectBadge(alice, "rooms", before.rooms, "unread");

    // Collapsed rail: on the icon's corner, and in the link's name.
    await alice.getByRole("button", { name: "Collapse sidebar" }).click();
    await expectBadge(alice, "tasks", before.tasks, "due");
    await expect(alice.getByRole("link", { name: new RegExp(`, ${before.rooms} unread$`) })).toBeVisible();
    await alice.getByRole("button", { name: "Expand sidebar" }).click();

    // Reading the conversation in Rooms clears its part (the app's own read).
    await alice.goto(`/rooms/r/${dm.id}`);
    await expect(alice.locator("p", { hasText: `Hi from bob ${stamp}` })).toBeVisible();
    await expect.poll(async () => (await counts(alice, a)).rooms, { timeout: 15_000 }).toBe(before.rooms - 1);
    // The sidebar beside Rooms catches up without a reload (the read is the
    // app's own action), and stays right after a fresh load.
    await expectBadge(alice, "tasks", before.tasks, "due"); // the sidebar is here
    await expectBadge(alice, "rooms", before.rooms - 1, "unread");
    await alice.goto("/files");
    await ready(alice);
    await expectBadge(alice, "rooms", before.rooms - 1, "unread");

    // Done somewhere else (another device): the badge catches up on focus.
    const done = await alice.request.post(`/api/items/${fileId}/actions/complete_tasks`, { headers: A, data: { args: { tasks: [taskId] } } });
    expect(done.ok(), await done.text()).toBe(true);
    taskId = "";
    // (What switching back to the tab fires; React Query listens on window.)
    await alice.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await expectBadge(alice, "tasks", before.tasks - 1, "due");
  } finally {
    if (taskId && fileId) {
      await alice.request.post(`/api/items/${fileId}/actions/complete_tasks`, { headers: A, data: { args: { tasks: [taskId] } } });
    }
    await alice.request.patch("/api/auth/me/preferences", { headers: A, data: { nav_apps: pinnedBefore } });
  }
});
