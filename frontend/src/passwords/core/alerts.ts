// Expiry reminders and breach alerts, the parts worked out on this device.
//
// An item's expiry date is inside its encryption. A reminder sends the server a short
// label and that date, only when the person turns it on (Calendar and Tasks can't be
// end-to-end encrypted). The label never holds a number from the item. The rest here
// (what's expiring soon, which logins a breach touches) never leaves the device.
import { baseDomain, hostOf, sharedWith } from "./match";
import type { Item, ItemBody } from "./model";

export const REMINDER_WEEKS = [1, 2, 4, 8, 12, 26] as const;
export const DEFAULT_WEEKS = 8;
export const SOON_DAYS = 90;
const LABEL_MAX = 60;

/** Kept in the item's encrypted body, so every device knows a reminder is wanted. */
export type ReminderPrefs = { on: boolean; weeks: number; calendar: boolean; task: boolean; label: string };

/** What the server is told: the same words Calendar and Tasks show. */
export type ReminderRequest = { expires_on: string; weeks: number; label: string; calendar: boolean; task: boolean };

export type ServerReminder = ReminderRequest & {
  item_id: string;
  event_url: string | null;
  task_url: string | null;
  calendar_gone: boolean;
  task_gone: boolean;
};

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(s: string): boolean {
  const m = ISO.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** The day an item stops being valid, as YYYY-MM-DD, or null if it has no expiry. A card's is
 *  the last day of its month. */
export function expiryOf(body: ItemBody): string | null {
  if (body.kind === "document") {
    const d = (body.expiresOn ?? "").trim();
    return validDate(d) ? d : null;
  }
  if (body.kind === "card") {
    const month = Number((body.cardExpMonth ?? "").trim());
    let year = Number((body.cardExpYear ?? "").trim());
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || !(body.cardExpYear ?? "").trim()) return null;
    if (year < 100) year += 2000;
    if (year < 2000 || year > 2200) return null;
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
  }
  return null;
}

/** Every value in the body that's a secret or an identifier. None may end up in a label. */
function secretsOf(body: ItemBody): string[] {
  const keys: (keyof ItemBody)[] = ["documentNumber", "cardNumber", "cardCvv", "accountNumber", "routingNumber", "iban", "password", "apiKey", "apiSecret", "wifiPassword", "username", "email", "phone"];
  const out = keys.map((k) => body[k]).filter((v): v is string => typeof v === "string" && v.trim().length >= 3).map((v) => v.trim());
  for (const f of body.fields ?? []) if (f.type === "hidden" && f.value.trim().length >= 3) out.push(f.value.trim());
  return out;
}

function fallback(body: ItemBody): string {
  return body.kind === "card" ? "Card" : "Document";
}

/** Short, with no runs of three or more digits and nothing secret from the item. */
export function safeLabel(raw: string, body: ItemBody): string {
  let text = raw;
  for (const s of secretsOf(body)) text = text.split(s).join(" ");
  const edges = /^[\s\-–:#,./]+|[\s\-–:#,./]+$/g;
  text = text.replace(/\d{3,}/g, " ").replace(/\s+/g, " ").replace(edges, "");
  // The same as the server's cleaning, so what's sent is what comes back.
  return text.slice(0, LABEL_MAX).replace(edges, "") || fallback(body);
}

/** What the label starts as: the document's type or the card's brand, else the item's name. */
export function defaultLabel(body: ItemBody): string {
  const typed = body.kind === "document" ? body.documentType : body.kind === "card" && body.cardBrand ? `${body.cardBrand} card` : "";
  return safeLabel((typed ?? "").trim() || body.title, body);
}

export function defaultPrefs(body: ItemBody): ReminderPrefs {
  return { on: false, weeks: DEFAULT_WEEKS, calendar: true, task: false, label: defaultLabel(body) };
}

export function prefsOf(body: ItemBody): ReminderPrefs | null {
  const p = body.expiryReminder as Partial<ReminderPrefs> | undefined;
  if (!p || typeof p !== "object") return null;
  const weeks = REMINDER_WEEKS.includes(p.weeks as (typeof REMINDER_WEEKS)[number]) ? (p.weeks as number) : DEFAULT_WEEKS;
  return {
    on: p.on === true,
    weeks,
    calendar: p.calendar !== false,
    task: p.task === true,
    label: typeof p.label === "string" && p.label.trim() ? p.label : defaultLabel(body),
  };
}

/** What the server should hold for this item, or null for nothing. */
export function wantedReminder(item: Item): ReminderRequest | null {
  if (item.deleted) return null;
  const on = expiryOf(item.body);
  const p = prefsOf(item.body);
  if (!on || !p?.on || !(p.calendar || p.task)) return null;
  return { expires_on: on, weeks: p.weeks, label: safeLabel(p.label, item.body), calendar: p.calendar, task: p.task };
}

export function sameReminder(a: ReminderRequest, b: ReminderRequest): boolean {
  return a.expires_on === b.expires_on && a.weeks === b.weeks && a.label === b.label && a.calendar === b.calendar && a.task === b.task;
}

/** Bring the server's reminders in line with the vault: a date changed on another device moves
 *  its event, and one turned off there is removed. A reminder is never made from here, only on
 *  the person's own say-so in the item. Items that are deleted, or not on this device (travel
 *  mode hides whole vaults), are left to the server, which removes reminders for items that
 *  really have gone. */
export function reminderPlan(items: Item[], server: ServerReminder[]): { put: { itemId: string; body: ReminderRequest }[]; remove: string[] } {
  const byId = new Map(items.map((i) => [i.id, i]));
  const put: { itemId: string; body: ReminderRequest }[] = [];
  const remove: string[] = [];
  for (const s of server) {
    const item = byId.get(s.item_id);
    if (!item || item.deleted) continue;
    const want = wantedReminder(item);
    if (!want) {
      // Only when this vault says so: an item with no settings at all may be from an older client.
      if (prefsOf(item.body) || !expiryOf(item.body)) remove.push(s.item_id);
      continue;
    }
    if (!sameReminder(want, s)) put.push({ itemId: item.id, body: want });
  }
  return { put, remove };
}

// ---- Expiring soon ---------------------------------------------------------------------

export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

export type Expiring = { item: Item; on: string; days: number };

/** Items expired already or expiring within ``within`` days, soonest first. */
export function expiringSoon(items: Item[], today: string, within = SOON_DAYS): Expiring[] {
  const out: Expiring[] = [];
  for (const item of items) {
    if (item.deleted || item.body.archived) continue;
    const on = expiryOf(item.body);
    if (!on) continue;
    const days = daysBetween(today, on);
    if (days <= within) out.push({ item, on, days });
  }
  return out.sort((a, b) => a.days - b.days || a.item.body.title.localeCompare(b.item.body.title));
}

export function expiryText(days: number): string {
  if (days < -1) return `Expired ${-days} days ago`;
  if (days === -1) return "Expired yesterday";
  if (days === 0) return "Expires today";
  if (days === 1) return "Expires tomorrow";
  if (days < 21) return `Expires in ${days} days`;
  return `Expires in ${Math.round(days / 7)} weeks`;
}

// ---- Breaches --------------------------------------------------------------------------

export type Breach = {
  address: string;
  name: string;
  title: string;
  domain: string;
  breach_date: string | null;
  added_date: string | null;
  data_classes: string[];
  verified: boolean;
  found_at: string;
};

export type BreachWatch = {
  available: boolean;
  on: boolean;
  addresses: { address: string; source: "account" | "mail"; checked_at: string | null }[];
  breaches: Breach[];
  attribution: string;
};

/** Logins at the breached site, matched here so the server never learns which ones you have. */
export function loginsForBreach(breach: Pick<Breach, "domain">, items: Item[]): Item[] {
  const site = breach.domain ? baseDomain(breach.domain.toLowerCase()) : null;
  if (!site) return [];
  const near = sharedWith(site);
  return items.filter(
    (i) =>
      !i.deleted &&
      i.body.kind === "login" &&
      (i.body.urls ?? []).some((u) => {
        const h = hostOf(u.url);
        const b = h ? baseDomain(h) : null;
        return !!b && (b === site || near.has(b));
      }),
  );
}

/** Whether a breach is worth changing a password over: it exposed passwords, or it's a site you log in to. */
export function exposedPasswords(breach: Pick<Breach, "data_classes">): boolean {
  return breach.data_classes.some((c) => /password/i.test(c));
}
