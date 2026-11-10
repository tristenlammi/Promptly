import type { Page } from "@playwright/test";

import { expect, ready, run, stamp, test } from "../fixtures";

/** Calendar labels: your own colour-coding. Make one, pick it when creating
 *  an event, the event is drawn in its colour, untick it to hide its events,
 *  and someone invited to the event never sees your label. */

const LABEL = `Gym ${stamp}`;
const COLOR = "#D9506A";
const TITLE = `Spin class ${stamp}`;

async function bearer(page: Page): Promise<string> {
  const seen = page.waitForRequest((r) => !!r.headers()["authorization"] && r.url().includes("/api/"));
  await page.goto("/calendar");
  await ready(page).catch(() => undefined);
  return (await seen).headers()["authorization"];
}

/** The event on the month grid (not its invitation card in the side panel). */
const chip = (page: Page) => page.locator("main button[data-color]").filter({ hasText: TITLE });

test("make a label, pick it for a new event, colour, hide by label, and a guest doesn't see it", async ({ alice, bob }) => {
  test.setTimeout(120_000);
  const auth = await bearer(alice);
  await expect(alice.getByRole("heading", { name: "Labels" })).toBeVisible();
  let eventId = "";
  let labelId = "";
  try {
    // Make a label from the side panel.
    await alice.getByRole("button", { name: "Edit labels" }).click();
    const sheet = alice.getByRole("dialog", { name: "Labels" });
    await expect(sheet).toBeVisible();
    // Everyone starts with Personal and Work.
    await expect(sheet.getByRole("textbox", { name: "Name of Personal" })).toBeVisible();
    await expect(sheet.getByRole("textbox", { name: "Name of Work" })).toBeVisible();
    await sheet.getByRole("textbox", { name: "New label name" }).fill(LABEL);
    await sheet.getByRole("radio", { name: COLOR }).last().click();
    const made = alice.waitForResponse((r) => r.url().endsWith("/api/calendar/labels") && r.request().method() === "POST");
    await sheet.getByRole("button", { name: "Add", exact: true }).click();
    labelId = (await (await made).json()).id;
    await expect(sheet.getByRole("textbox", { name: `Name of ${LABEL}` })).toBeVisible();
    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(sheet).toBeHidden();
    await expect(alice.getByRole("checkbox", { name: `Show events labelled ${LABEL}` })).toBeChecked();

    // A new event with that label.
    await alice.getByRole("button", { name: "New event" }).first().click();
    const editor = alice.getByRole("dialog", { name: "New event" });
    await expect(editor).toBeVisible();
    await editor.getByRole("textbox", { name: "Title" }).fill(TITLE);
    await editor.getByRole("radiogroup", { name: "Label" }).getByRole("button", { name: LABEL }).click();
    await expect(editor.getByRole("radiogroup", { name: "Label" }).getByRole("button", { name: LABEL })).toHaveAttribute("aria-pressed", "true");
    const created = alice.waitForResponse((r) => r.url().endsWith("/api/calendar/events") && r.request().method() === "POST");
    await editor.getByRole("button", { name: "Save" }).click();
    const ev = (await (await created).json()).event;
    eventId = ev.event_id;
    expect(ev.label_id).toBe(labelId);

    // Drawn in the label's colour; the event says its label.
    await expect(chip(alice)).toHaveAttribute("data-color", COLOR);
    await chip(alice).click();
    await expect(alice.locator(`[data-label-chip="${LABEL}"]`)).toBeVisible();
    await alice.keyboard.press("Escape");

    // Untick the label: its events hide; tick it again: back.
    const tick = alice.getByRole("checkbox", { name: `Show events labelled ${LABEL}` });
    const row = alice.getByRole("region", { name: "Labels" }).getByText(LABEL, { exact: true });
    await row.click();
    await expect(tick).not.toBeChecked();
    await expect(chip(alice)).toHaveCount(0);
    await row.click();
    await expect(tick).toBeChecked();
    await expect(chip(alice)).toHaveAttribute("data-color", COLOR);

    // Invite bob: he sees the event, but not alice's label.
    const r = await alice.request.patch(`/api/calendar/events/${eventId}`, { headers: { Authorization: auth }, data: { guests: [run.users.bob.id] } });
    expect(r.ok()).toBe(true);
    const bobAuth = await bearer(bob);
    const theirs = await (await bob.request.get(`/api/calendar/events/${eventId}`, { headers: { Authorization: bobAuth } })).json();
    expect(theirs.event.label_id).toBeNull();
    const bobLabels = await (await bob.request.get("/api/calendar/labels", { headers: { Authorization: bobAuth } })).json();
    expect(bobLabels.labels.map((l: { name: string }) => l.name)).not.toContain(LABEL);
    await bob.goto(`/calendar?event=${eventId}`);
    await expect(bob.getByRole("heading", { name: TITLE })).toBeVisible();
    await expect(bob.getByText("No label")).toBeVisible();
    await expect(bob.locator(`[data-label-chip="${LABEL}"]`)).toHaveCount(0);
    await expect(bob.getByText(LABEL)).toHaveCount(0);
    await bob.keyboard.press("Escape");
    await expect(chip(bob)).not.toHaveAttribute("data-color", COLOR);
  } finally {
    if (eventId) await alice.request.delete(`/api/calendar/events/${eventId}`, { headers: { Authorization: auth } });
    if (labelId) await alice.request.delete(`/api/calendar/labels/${labelId}`, { headers: { Authorization: auth } });
  }
});
