// Expiry reminders in Calendar and Tasks, "Expiring soon", and breach alerts on the Security page.
// Nothing here talks to Have I Been Pwned: no key is set, and breach rows are seeded straight
// into the database the way the job would write them.
import { execFileSync } from "node:child_process";

import { expect, type Page, test } from "@playwright/test";

import { addLogin, BACKEND, makeUsers, onboard, signedIn, type User } from "./helpers";

test.describe.configure({ timeout: 300_000 });

function py(body: string): string {
  return execFileSync("docker", ["exec", "-i", BACKEND, "python"], { input: body, encoding: "utf8" });
}

/** The person's own Calendar events and tasks, as the server holds them. */
function agenda(u: User): { events: [string, string][]; tasks: [string, string][] } {
  const out = py(`
import asyncio, json, uuid
from sqlalchemy import select
import app.db_models
from app.auth.models import User
from app.calendars.models import CalCalendar, CalEvent
from app.database import SessionLocal
from app.items import service as items
async def main():
    async with SessionLocal() as db:
        uid = uuid.UUID("${u.id}")
        rows = (await db.execute(select(CalEvent).join(CalCalendar, CalCalendar.id == CalEvent.calendar_id).where(CalCalendar.owner_id == uid).order_by(CalEvent.start_at))).scalars().all()
        found = await items.primary_file(db, await db.get(User, uid), "tasks")
        tasks = found[1].data["tasks"] if found else []
        print("AGENDA " + json.dumps({"events": [[e.title, e.start_at.date().isoformat()] for e in rows], "tasks": [[t["title"], t["due"]] for t in tasks]}))
asyncio.run(main())
`);
  const line = out.split(/\r?\n/).find((l) => l.startsWith("AGENDA "))!;
  return JSON.parse(line.slice("AGENDA ".length));
}

async function nav(page: Page, name: string) {
  await page.getByRole("navigation", { name: "Passwords" }).getByText(name, { exact: true }).click();
}

test("turning on an expiry reminder puts it on the Calendar and in Tasks, and it follows the item", async ({ browser }) => {
  const [u] = makeUsers(["remind"]);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  await onboard(page);

  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Licence or ID" }).click();
  await page.getByLabel("Name", { exact: true }).fill("My passport PA1234567");
  await page.getByLabel("Type", { exact: true }).fill("Passport");
  await page.getByLabel("Number", { exact: true }).fill("PA1234567");
  await page.getByLabel("Expires", { exact: true }).fill("2031-05-20");
  await page.getByLabel("Remind me before the expiry date").check();
  // It says what goes to the server before anything does.
  await expect(page.getByText("aren't end-to-end encrypted")).toBeVisible();
  await expect(page.getByLabel(/^Reminder wording/)).toHaveValue("Passport");
  await page.getByRole("combobox", { name: /^Remind me/ }).selectOption("4");
  await page.getByLabel("In Tasks").check();
  await page.getByRole("button", { name: "Save", exact: true }).click();

  const view = page.getByRole("article", { name: "My passport PA1234567" });
  await expect(view.getByTestId("reminder-status")).toContainText('A reminder is on your Calendar and in Tasks: "Passport expires"', { timeout: 30_000 });
  await expect
    .poll(() => agenda(u), { timeout: 30_000 })
    .toEqual({ events: [["Passport expires in 4 weeks", "2031-04-22"], ["Passport expires", "2031-05-20"]], tasks: [["Passport expires soon", "2031-04-22"]] });
  // Nothing from the item but the wording and the date.
  expect(JSON.stringify(agenda(u))).not.toContain("1234567");

  // The event is there in Promptly's Calendar.
  const [cal] = await Promise.all([ctx.waitForEvent("page"), view.getByRole("link", { name: "Open in Calendar" }).click()]);
  await expect(cal.getByText("Passport expires", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await cal.close();

  // A new date moves it.
  await view.getByRole("button", { name: "Edit" }).click();
  // Exact: the reminder's wording box mentions "expires" too.
  await page.getByLabel("Expires", { exact: true }).fill("2032-01-10");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() => agenda(u).events, { timeout: 30_000 })
    .toEqual([["Passport expires in 4 weeks", "2031-12-13"], ["Passport expires", "2032-01-10"]]);

  // Deleting the item takes the event and the task away.
  await view.getByRole("button", { name: "Move to Trash" }).click();
  await expect.poll(() => agenda(u), { timeout: 30_000 }).toEqual({ events: [], tasks: [] });
});

test("the Security page lists what's expiring and the breaches an address is in", async ({ browser }) => {
  const [u] = makeUsers(["breach"]);
  const ctx = await signedIn(browser, u);
  const page = await ctx.newPage();
  await onboard(page);
  await addLogin(page, { title: "Adobe", username: "ana", password: "old-Password-1", url: "https://account.adobe.com" });

  const soon = new Date(Date.now() + 10 * 86_400_000);
  const iso = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, "0")}-${String(soon.getDate()).padStart(2, "0")}`;
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Licence or ID" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Driver licence");
  await page.getByLabel("Expires", { exact: true }).fill(iso);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("article", { name: "Driver licence" })).toBeVisible();

  // What the job would have stored: a name and dates per address, and the public catalog.
  py(`
import asyncio, uuid
from datetime import date, datetime, timezone
import app.db_models
from app.auth.models import User
from app.breach_watch.models import BreachAddress, BreachCatalog, BreachHit, BreachWatch
from app.database import SessionLocal
async def main():
    async with SessionLocal() as db:
        u = await db.get(User, uuid.UUID("${u.id}"))
        now = datetime.now(timezone.utc)
        db.add(BreachWatch(user_id=u.id))
        db.add(BreachAddress(user_id=u.id, address=u.email.lower(), source="account", checked_at=now, next_check_at=now))
        if await db.get(BreachCatalog, "Adobe") is None:
            db.add(BreachCatalog(name="Adobe", title="Adobe", domain="adobe.com", data_classes=["Email addresses", "Passwords"], verified=True))
        db.add(BreachHit(user_id=u.id, address=u.email.lower(), name="Adobe", breach_date=date(2013, 10, 4), found_at=now))
        await db.commit()
asyncio.run(main())
`);

  await nav(page, "Security check");
  const expiring = page.getByTestId("expiring-soon");
  await expect(expiring).toContainText("Driver licence");
  await expect(expiring).toContainText("Expires in 10 days");

  const breaches = page.getByTestId("breach-alerts");
  await expect(breaches.getByTestId("breach-row")).toContainText("adobe.com");
  await expect(breaches.getByTestId("breach-row")).toContainText("Exposed: Email addresses, Passwords");
  await expect(breaches.getByRole("link", { name: "Have I Been Pwned" })).toHaveAttribute("href", "https://haveibeenpwned.com");
  await breaches.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("dialog", { name: "Change password for Adobe" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Off forgets what was found.
  await breaches.getByRole("button", { name: "Turn off" }).click();
  await expect(breaches.getByTestId("breach-row")).toHaveCount(0);
});
