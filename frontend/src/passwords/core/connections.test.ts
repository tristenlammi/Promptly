import { describe, expect, it } from "vitest";

import { randomBytes } from "./bytes";
import { agoText, changePageUrl, clockDriftText, commitPending, dropPending, findDuplicates, linkIsSafe, type MailCode, memoryPin, mergeDuplicates, rankMailCodes, savedDomainsOf, securityAlerts, type SecurityEvent, unwrapUnlockSecret, withPending, wrapUnlockSecret } from "./connections";
import { touch } from "./model";
import { type Item, type ItemBody, newBody } from "./model";

function item(body: Partial<ItemBody> & { title?: string }, id = crypto.randomUUID(), vaultId = "v1"): Item {
  const b = newBody(body.kind ?? "login", body.title ?? "x", body);
  return { id, vaultId, revision: 1, deleted: false, updatedAt: b.updatedAt, body: b };
}

const code = (over: Partial<MailCode>): MailCode => ({ id: crypto.randomUUID(), from_name: "", from_domain: "netflix.com", at: new Date().toISOString(), code: "482913", link: null, ...over });

describe("mail codes", () => {
  it("puts this site's sender first, and marks the rest", () => {
    const now = Date.now();
    const out = rankMailCodes(
      [code({ from_domain: "other.example", at: new Date(now - 5000).toISOString() }), code({ from_domain: "mailer.netflix.com", at: new Date(now - 40000).toISOString() })],
      "https://www.netflix.com/login",
      [],
      now,
    );
    expect(out[0].from_domain).toBe("mailer.netflix.com");
    expect(out[0].matches).toBe(true);
    expect(out[1].matches).toBe(false);
    expect(agoText(out[0].agoSeconds)).toBe("40 s ago");
  });

  it("says when a sender looks like a site you have, and isn't", () => {
    const [r] = rankMailCodes([code({ from_domain: "paypa1.com" })], "https://www.example.org/", ["paypal.com"]);
    expect(r.matches).toBe(false);
    expect(r.lookalike).toBe("paypal.com");
  });

  it("only trusts a sign-in link that goes where the sender is", () => {
    expect(linkIsSafe({ from_domain: "accounts.example.com", link: "https://www.example.com/magic/abc" })).toBe(true);
    expect(linkIsSafe({ from_domain: "example.com", link: "https://evil.example/magic" })).toBe(false);
    expect(linkIsSafe({ from_domain: "example.com", link: "http://example.com/magic" })).toBe(false);
    expect(linkIsSafe({ from_domain: "example.com", link: "https://example.com@evil.example/" })).toBe(false);
    expect(linkIsSafe({ from_domain: "example.com", link: "javascript:alert(1)" })).toBe(false);
    expect(linkIsSafe({ from_domain: "example.com", link: null })).toBe(false);
  });
});

describe("security emails", () => {
  const ev = (over: Partial<SecurityEvent>): SecurityEvent => ({ id: "1", kind: "password_changed", from_name: "Instagram", from_domain: "mail.instagram.com", subject: "Your password was changed", at: new Date().toISOString(), ...over });

  it("matches against the vault here, and asks", () => {
    const login = item({ title: "Instagram", urls: [{ url: "https://www.instagram.com/" }] });
    const [a] = securityAlerts([ev({})], [login]);
    expect(a.item.id).toBe(login.id);
    expect(a.text).toBe("Instagram says your password changed. Was that you?");
    expect(securityAlerts([ev({ kind: "new_signin" })], [login])[0].text).toContain("new sign-in");
  });

  it("says nothing about a site you've no login for", () => {
    expect(securityAlerts([ev({ from_domain: "nothere.example" })], [item({ urls: [{ url: "https://www.instagram.com/" }] })])).toEqual([]);
  });

  it("lists saved sites by base domain", () => {
    expect([...savedDomainsOf([item({ urls: [{ url: "https://a.b.example.com/x" }] })])]).toEqual(["example.com"]);
  });
});

describe("changing a password", () => {
  it("knows a site's page, or asks the standard place", () => {
    expect(changePageUrl(newBody("login", "x", { urls: [{ url: "https://www.23andme.com/login" }] }))).toBe("https://you.23andme.com/user/edit/password/");
    expect(changePageUrl(newBody("login", "x", { urls: [{ url: "https://23andme.com/" }] }))).toBe("https://you.23andme.com/user/edit/password/");
    expect(changePageUrl(newBody("login", "x", { urls: [{ url: "https://nothing.example/a" }] }))).toBe("https://nothing.example/.well-known/change-password");
    expect(changePageUrl(newBody("login", "x"))).toBeNull();
  });

  it("keeps the new one waiting, and either swaps it in or drops it", () => {
    const start = newBody("login", "x", { password: "old" });
    const waiting = withPending(start, "new");
    expect(waiting.password).toBe("old");
    expect(waiting.pendingPassword).toBe("new");
    const done = commitPending(waiting);
    expect(done.password).toBe("new");
    expect(done.pendingPassword).toBeUndefined();
    expect(done.passwordHistory?.[0].password).toBe("old");
    const dropped = dropPending(waiting);
    expect(dropped.password).toBe("old");
    expect(dropped.pendingPassword).toBeUndefined();
    expect(dropped.passwordHistory?.map((h) => h.password)).toEqual(["new"]);
  });
});

describe("duplicates", () => {
  it("finds the same login on the same site, not different people", () => {
    const a = item({ username: "ana", urls: [{ url: "https://www.example.com/" }] });
    const b = item({ username: "ANA", urls: [{ url: "https://login.example.com/" }] });
    const c = item({ username: "bo", urls: [{ url: "https://example.com/" }] });
    const d = item({ username: "ana", urls: [{ url: "https://other.example/" }] });
    const e = item({ username: "ana", urls: [{ url: "https://example.com/" }] }, undefined, "v2");
    const groups = findDuplicates([a, b, c, d, e]);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("merges without losing anything", () => {
    const old = item({ username: "ana", password: "older", notes: "first note", totp: { secret: "ABC" }, urls: [{ url: "https://a.example.com/" }], fields: [{ name: "pin", value: "1", type: "text" }] });
    old.body.updatedAt = "2024-01-01T00:00:00.000Z";
    const fresh = item({ username: "ana", password: "newer", notes: "second note", urls: [{ url: "https://b.example.com/" }] });
    fresh.body.updatedAt = "2026-01-01T00:00:00.000Z";
    const { keep, body, drop } = mergeDuplicates([old, fresh]);
    expect(keep.id).toBe(fresh.id);
    expect(drop.map((d) => d.id)).toEqual([old.id]);
    expect(body.password).toBe("newer");
    expect(body.passwordHistory?.map((h) => h.password)).toContain("older");
    expect(body.urls?.map((u) => u.url)).toEqual(["https://b.example.com/", "https://a.example.com/"]);
    expect(body.notes).toContain("first note");
    expect(body.notes).toContain("second note");
    expect(body.totp?.secret).toBe("ABC");
    expect(body.fields?.[0].name).toBe("pin");
  });

  it("what's merged in survives a full history, and a copy's waiting password isn't lost", () => {
    const full = Array.from({ length: 20 }, (_, i) => ({ password: `old-${i}`, at: "2024-01-01T00:00:00.000Z" }));
    const old = item({ username: "ana", password: "from-the-copy", pendingPassword: "waiting-on-the-copy" });
    old.body.updatedAt = "2024-01-01T00:00:00.000Z";
    const fresh = item({ username: "ana", password: "newer", passwordHistory: full });
    fresh.body.updatedAt = "2026-01-01T00:00:00.000Z";
    const history = mergeDuplicates([old, fresh]).body.passwordHistory!.map((h) => h.password);
    expect(history).toHaveLength(20);
    expect(history).toContain("from-the-copy");
    expect(history).toContain("waiting-on-the-copy");
  });

  it("a waiting password can't later overwrite one set another way, and saying no keeps it", () => {
    const b = item({ username: "ana", password: "current", pendingPassword: "generated" }).body;
    const typed = touch(b, { ...b, password: "typed-by-hand" });
    expect(typed.pendingPassword).toBeUndefined();
    expect(commitPending(typed).password).toBe("typed-by-hand");
    expect(typed.passwordHistory?.map((h) => h.password)).toEqual(expect.arrayContaining(["current", "generated"]));

    const dropped = dropPending(b);
    expect(dropped.pendingPassword).toBeUndefined();
    expect(dropped.password).toBe("current");
    expect(dropped.passwordHistory?.map((h) => h.password)).toContain("generated");

    // The ordinary way still works.
    const done = commitPending(b);
    expect(done.password).toBe("generated");
    expect(done.pendingPassword).toBeUndefined();
    expect(done.passwordHistory?.map((h) => h.password)).toContain("current");
  });

  it("doesn't list a dropped copy's attachment until it's been moved, and keeps a reprompt", () => {
    const ref = { id: "att-1", name: "scan.pdf", size: 10, key: "k", chunks: 1 };
    const old = item({ username: "ana", password: "older", reprompt: true, attachments: [ref] });
    old.body.updatedAt = "2024-01-01T00:00:00.000Z";
    const fresh = item({ username: "ana", password: "newer" });
    fresh.body.updatedAt = "2026-01-01T00:00:00.000Z";
    const { body, moves } = mergeDuplicates([old, fresh]);
    expect(body.attachments ?? []).toEqual([]);
    expect(moves.map((m) => [m.from.id, m.ref.id])).toEqual([[old.id, "att-1"]]);
    expect(body.reprompt).toBe(true);
  });
});

describe("clock and PIN", () => {
  it("a memory PIN opens, counts tries, and wipes itself at five", async () => {
    const pin = memoryPin();
    const secret = randomBytes(64);
    expect(pin.has()).toBe(false);
    await expect(pin.set("12", secret)).rejects.toThrow("4 to 12");
    await pin.set("4821", secret);
    expect(await pin.open("4821")).toEqual(secret);
    for (const left of [4, 3, 2, 1]) await expect(pin.open("0000")).rejects.toThrow(`${left} tries left`);
    expect(await pin.open("4821")).toEqual(secret);
    for (let i = 0; i < 4; i++) await expect(pin.open("0000")).rejects.toThrow("tries left");
    await expect(pin.open("0000")).rejects.toThrow("last try");
    expect(pin.has()).toBe(false);
    await expect(pin.open("4821")).rejects.toThrow("no PIN");
  }, 120_000);

  it("warns only when codes are at risk", () => {
    expect(clockDriftText(10_000)).toBeNull();
    expect(clockDriftText(45_000)).toContain("45 seconds behind");
    expect(clockDriftText(-300_000)).toContain("5 minutes ahead");
  });

  it("a wrapped secret opens only with what wrapped it", async () => {
    const secret = randomBytes(64);
    const input = randomBytes(32);
    const salt = randomBytes(16);
    const wrapped = await wrapUnlockSecret(input, salt, secret, "pin-unlock");
    expect(await unwrapUnlockSecret(input, salt, wrapped, "pin-unlock")).toEqual(secret);
    await expect(unwrapUnlockSecret(randomBytes(32), salt, wrapped, "pin-unlock")).rejects.toThrow();
    await expect(unwrapUnlockSecret(input, salt, wrapped, "passkey-unlock")).rejects.toThrow();
  });
});
