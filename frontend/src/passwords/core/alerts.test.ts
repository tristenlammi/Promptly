import { describe, expect, it } from "vitest";

import {
  daysBetween,
  defaultLabel,
  expiringSoon,
  expiryOf,
  expiryText,
  exposedPasswords,
  loginsForBreach,
  prefsOf,
  reminderPlan,
  safeLabel,
  type ServerReminder,
  wantedReminder,
} from "./alerts";
import { type Item, type ItemBody, newBody } from "./model";

function item(body: Partial<ItemBody> & { title?: string }, id = crypto.randomUUID(), deleted = false): Item {
  const b = newBody(body.kind ?? "document", body.title ?? "x", body);
  return { id, vaultId: "v1", revision: 1, deleted, updatedAt: b.updatedAt, body: b };
}

const on = (over: Partial<NonNullable<ItemBody["expiryReminder"]>> = {}) => ({ on: true, weeks: 8, calendar: true, task: false, label: "Passport", ...over });

function server(i: Item, over: Partial<ServerReminder> = {}): ServerReminder {
  return { item_id: i.id, expires_on: "2031-05-20", weeks: 8, label: "Passport", calendar: true, task: false, event_url: "/calendar?event=x", task_url: null, calendar_gone: false, task_gone: false, ...over };
}

describe("expiry dates", () => {
  it("reads a document's date and a card's month", () => {
    expect(expiryOf(newBody("document", "P", { expiresOn: "2031-05-20" }))).toBe("2031-05-20");
    expect(expiryOf(newBody("document", "P", { expiresOn: "2031-02-30" }))).toBeNull();
    expect(expiryOf(newBody("document", "P", {}))).toBeNull();
    expect(expiryOf(newBody("card", "Visa", { cardExpMonth: "2", cardExpYear: "28" }))).toBe("2028-02-29");
    expect(expiryOf(newBody("card", "Visa", { cardExpMonth: "12", cardExpYear: "2030" }))).toBe("2030-12-31");
    expect(expiryOf(newBody("card", "Visa", { cardExpMonth: "13", cardExpYear: "2030" }))).toBeNull();
    expect(expiryOf(newBody("card", "Visa", { cardExpMonth: "05" }))).toBeNull();
    expect(expiryOf(newBody("login", "L", { expiresOn: "2031-05-20" }))).toBeNull();
  });
});

describe("reminder labels", () => {
  it("never carries a number or a secret from the item", () => {
    const body = newBody("document", "Passport X1234567", { documentType: "Passport", documentNumber: "X1234567" });
    expect(defaultLabel(body)).toBe("Passport");
    expect(safeLabel("Passport X1234567", body)).toBe("Passport");
    expect(safeLabel("Licence 0412 345 678", body)).toBe("Licence");
    const card = newBody("card", "Everyday 4111 1111 1111 1111", { cardBrand: "Visa", cardNumber: "4111111111111111", cardCvv: "123" });
    expect(defaultLabel(card)).toBe("Visa card");
    expect(safeLabel(card.title, card)).toBe("Everyday");
    expect(safeLabel("4111111111111111", card)).toBe("Card");
    expect(safeLabel("   ", body)).toBe("Document");
    expect(safeLabel("A".repeat(100), body)).toHaveLength(60);
  });

  it("keeps a short number that isn't from the item", () => {
    expect(safeLabel("Kid 2's passport", newBody("document", "x"))).toBe("Kid 2's passport");
  });
});

describe("what the server should hold", () => {
  it("is only for an item that's on, has a date, and isn't deleted", () => {
    const doc = item({ title: "Passport", expiresOn: "2031-05-20", expiryReminder: on() });
    expect(wantedReminder(doc)).toEqual({ expires_on: "2031-05-20", weeks: 8, label: "Passport", calendar: true, task: false });
    expect(wantedReminder(item({ expiresOn: "2031-05-20", expiryReminder: on({ on: false }) }))).toBeNull();
    expect(wantedReminder(item({ expiresOn: "2031-05-20", expiryReminder: on({ calendar: false, task: false }) }))).toBeNull();
    expect(wantedReminder(item({ expiryReminder: on() }))).toBeNull();
    expect(wantedReminder(item({ expiresOn: "2031-05-20", expiryReminder: on() }, undefined, true))).toBeNull();
    // A label typed with the number in it is cleaned before it goes.
    expect(wantedReminder(item({ documentNumber: "PA998877", expiresOn: "2031-05-20", expiryReminder: on({ label: "Passport PA998877" }) }))?.label).toBe("Passport");
  });

  it("tolerates odd stored settings", () => {
    expect(prefsOf(newBody("document", "x", { expiryReminder: { on: true, weeks: 5, calendar: true, task: false, label: "" } }))).toMatchObject({ weeks: 8, label: "x" });
    expect(prefsOf(newBody("document", "x"))).toBeNull();
  });

  it("moves a reminder whose date changed elsewhere, and removes ones turned off", () => {
    const moved = item({ expiresOn: "2032-01-10", expiryReminder: on() });
    const same = item({ expiresOn: "2031-05-20", expiryReminder: on() });
    const off = item({ expiresOn: "2031-05-20", expiryReminder: on({ on: false }) });
    const noDate = item({ expiryReminder: on() });
    const legacy = item({ expiresOn: "2031-05-20" });
    const deleted = item({ expiresOn: "2031-05-20", expiryReminder: on() }, undefined, true);
    const gone = crypto.randomUUID();
    const plan = reminderPlan(
      [moved, same, off, noDate, legacy, deleted],
      [server(moved), server(same), server(off), server(noDate), server(legacy), server(deleted), { ...server(same), item_id: gone }],
    );
    expect(plan.put).toEqual([{ itemId: moved.id, body: { expires_on: "2032-01-10", weeks: 8, label: "Passport", calendar: true, task: false } }]);
    expect(plan.remove.sort()).toEqual([off.id, noDate.id].sort());
    // An item with no settings (another client's) is left alone, and deleted or unseen items are
    // the server's to clear: a vault hidden by travel mode mustn't lose its reminders.
    expect(plan.remove).not.toContain(legacy.id);
    expect(plan.remove).not.toContain(deleted.id);
    expect(plan.remove).not.toContain(gone);
  });

  it("never makes a reminder by itself", () => {
    const fresh = item({ expiresOn: "2031-05-20", expiryReminder: on() });
    expect(reminderPlan([fresh], [])).toEqual({ put: [], remove: [] });
  });
});

describe("expiring soon", () => {
  it("lists expired and soon-to-expire items, soonest first", () => {
    const items = [
      item({ title: "Far", expiresOn: "2027-06-01" }),
      item({ title: "Soon", expiresOn: "2026-12-01" }),
      item({ title: "Past", expiresOn: "2026-10-01" }),
      item({ kind: "card", title: "Card", cardExpMonth: "11", cardExpYear: "26" }),
      item({ title: "Gone", expiresOn: "2026-11-10" }, undefined, true),
      item({ title: "Archived", expiresOn: "2026-11-10", archived: true }),
      item({ kind: "login", title: "Login" }),
    ];
    const got = expiringSoon(items, "2026-11-08");
    expect(got.map((e) => [e.item.body.title, e.days])).toEqual([
      ["Past", -38],
      ["Card", 22],
      ["Soon", 23],
    ]);
    expect(expiringSoon(items, "2026-11-08", 22).map((e) => e.item.body.title)).toEqual(["Past", "Card"]);
  });

  it("says it plainly", () => {
    expect(daysBetween("2026-11-08", "2026-11-08")).toBe(0);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
    expect(expiryText(-5)).toBe("Expired 5 days ago");
    expect(expiryText(-1)).toBe("Expired yesterday");
    expect(expiryText(0)).toBe("Expires today");
    expect(expiryText(1)).toBe("Expires tomorrow");
    expect(expiryText(10)).toBe("Expires in 10 days");
    expect(expiryText(56)).toBe("Expires in 8 weeks");
  });
});

describe("breaches", () => {
  it("finds the logins at the breached site, on this device", () => {
    const adobe = item({ kind: "login", title: "Adobe", urls: [{ url: "https://account.adobe.com/login" }] });
    const other = item({ kind: "login", title: "Other", urls: [{ url: "https://notadobe.com" }] });
    const app = item({ kind: "login", title: "App", urls: [{ url: "android://com.adobe.app" }] });
    const removed = item({ kind: "login", title: "Old", urls: [{ url: "https://adobe.com" }] }, undefined, true);
    expect(loginsForBreach({ domain: "adobe.com" }, [adobe, other, app, removed]).map((i) => i.body.title)).toEqual(["Adobe"]);
    expect(loginsForBreach({ domain: "" }, [adobe])).toEqual([]);
  });

  it("knows when passwords were exposed", () => {
    expect(exposedPasswords({ data_classes: ["Email addresses", "Passwords"] })).toBe(true);
    expect(exposedPasswords({ data_classes: ["Email addresses"] })).toBe(false);
  });
});
