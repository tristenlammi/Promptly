// "Accounts you have": the comparison with the vault, done on the device.
import { describe, expect, it } from "vitest";

import { readComposeLink } from "../../mail/composeLink";
import {
  ACCOUNT_PREFS,
  accountsNotInVault,
  composeHref,
  deletionEmail,
  deletionLinks,
  inVault,
  loginFor,
  type MailSite,
  openHref,
  prefsBody,
  readPrefs,
  vaultDomains,
  withSiteState,
} from "./accounts";
import { type Item, type ItemBody, newBody } from "./model";

const ACC = "11111111-2222-3333-4444-555555555555";
const ACC2 = "66666666-7777-8888-9999-000000000000";

function site(domain: string, extra: Partial<MailSite> = {}): MailSite {
  return {
    domain,
    name: "",
    address: "sam@example.org",
    account_id: ACC,
    kinds: ["welcome"],
    first_seen: "2024-01-01T00:00:00Z",
    last_seen: "2025-01-01T00:00:00Z",
    open: `${ACC}/abc123`,
    deletion: null,
    ...extra,
  };
}

let n = 0;
function item(body: ItemBody, extra: Partial<Item> = {}): Item {
  n += 1;
  return { id: `i${n}`, vaultId: "personal", revision: 1, deleted: false, updatedAt: "", body, ...extra };
}
const login = (url: string, extra: Partial<ItemBody> = {}) => item(newBody("login", url, { urls: [{ url }], ...extra }));

describe("accountsNotInVault", () => {
  it("hides sites the vault has, by base domain", () => {
    const items = [login("https://www.netflix.com/login"), login("accounts.google.com")];
    const rows = accountsNotInVault([site("netflix.com"), site("google.com"), site("mail.instagram.com"), site("example.co.uk")], items, { sites: {} });
    expect(rows.map((r) => r.domain)).toEqual(["instagram.com", "example.co.uk"]);
  });

  it("uses the real Public Suffix List, not just the last two labels", () => {
    const items = [login("https://alice.github.io")];
    // Same suffix, different site.
    expect(accountsNotInVault([site("bob.github.io")], items, { sites: {} }).map((r) => r.domain)).toEqual(["bob.github.io"]);
    expect(accountsNotInVault([site("alice.github.io")], items, { sites: {} })).toEqual([]);
  });

  it("counts sites that share sign-ins, passkeys and archived logins", () => {
    const items = [
      login("https://themeforest.net"),
      item(newBody("login", "pk", { passkeys: [{ credentialId: "a", rpId: "id.Example.dev", userHandle: "", userName: "", key: "", alg: -7, signCount: 0, createdAt: "", discoverable: true }] })),
      login("https://old.test", { archived: true }),
    ];
    const rows = accountsNotInVault([site("envato.com"), site("example.dev"), site("old.test"), site("new.test")], items, { sites: {} });
    expect(rows.map((r) => r.domain)).toEqual(["new.test"]);
  });

  it("ignores deleted items, other kinds and app ids", () => {
    const items = [
      login("https://gone.test", {}),
      item(newBody("note", "gone.test", { notes: "https://notes.test" })),
      item(newBody("login", "app", { urls: [{ url: "android://com.app.test" }] })),
    ];
    items[0].deleted = true;
    expect(vaultDomains(items).size).toBe(0);
    expect(inVault("gone.test", vaultDomains(items))).toBe(false);
  });

  it("groups mailboxes per site, newest first, and merges evidence", () => {
    const rows = accountsNotInVault(
      [
        site("shop.test", { kinds: ["receipt"], last_seen: "2025-03-01T00:00:00Z" }),
        site("www.shop.test", { account_id: ACC2, address: "sam@work.test", kinds: ["reset", "welcome"], first_seen: "2020-01-01T00:00:00Z", last_seen: "2025-06-01T00:00:00Z" }),
      ],
      [],
      { sites: {} },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kinds).toEqual(["reset", "welcome", "receipt"]);
    expect(rows[0].sites.map((s) => s.address)).toEqual(["sam@work.test", "sam@example.org"]);
    expect(rows[0].firstSeen).toBe("2020-01-01T00:00:00Z");
    expect(rows[0].lastSeen).toBe("2025-06-01T00:00:00Z");
  });

  it("not an account and gone are hidden for good; deleting stays, first", () => {
    let prefs = withSiteState({ sites: {} }, "hidden.test", "hidden", "2025-01-01T00:00:00Z");
    prefs = withSiteState(prefs, "gone.test", "gone");
    prefs = withSiteState(prefs, "deleting.test", "deleting");
    const rows = accountsNotInVault(
      [site("hidden.test"), site("gone.test"), site("deleting.test", { last_seen: "2001-01-01T00:00:00Z" }), site("fresh.test")],
      [],
      prefs,
    );
    expect(rows.map((r) => [r.domain, r.state?.state ?? null])).toEqual([
      ["deleting.test", "deleting"],
      ["fresh.test", null],
    ]);
    // Changing your mind.
    expect(withSiteState(prefs, "hidden.test", null).sites["hidden.test"]).toBeUndefined();
  });
});

describe("the prefs item", () => {
  it("round-trips through the vault's prefs item, keeping what it doesn't know", () => {
    const prefs = withSiteState({ sites: {} }, "a.test", "hidden", "2025-01-01T00:00:00Z");
    const body = prefsBody({ ...newBody("prefs", ACCOUNT_PREFS), prefs: { future: 1 } }, prefs);
    expect(body.kind).toBe("prefs");
    expect(body.prefs).toEqual({ future: 1, sites: { "a.test": { state: "hidden", at: "2025-01-01T00:00:00Z" } } });
    const stored = item(body);
    const read = readPrefs([stored, login("https://x.test")], "personal");
    expect(read.item?.id).toBe(stored.id);
    expect(read.prefs.sites["a.test"].state).toBe("hidden");
    // Only the personal vault's: a shared vault's member can't hide your rows.
    expect(readPrefs([item(body, { vaultId: "shared" })], "personal").item).toBeNull();
    // Junk in the item is dropped.
    const junk = item({ ...newBody("prefs", ACCOUNT_PREFS), prefs: { sites: { "x.test": { state: "nuke", at: "x" }, "y.test": null } } });
    expect(readPrefs([junk], "personal").prefs.sites).toEqual({});
  });
});

describe("Add login", () => {
  it("pre-fills the site and the address it wrote to", () => {
    const [row] = accountsNotInVault([site("mail.netflix.com", { address: "sam+tv@example.org" })], [], { sites: {} });
    const body = loginFor(row);
    expect(body.kind).toBe("login");
    expect(body.title).toBe("Netflix");
    expect(body.urls).toEqual([{ url: "https://netflix.com" }]);
    expect(body.username).toBe("sam+tv@example.org");
    expect(body.password).toBeUndefined();
  });
});

describe("deleting an account", () => {
  it("offers a known deletion page, else account settings", () => {
    const [known] = accountsNotInVault([site("example.com", { deletion: { url: "https://example.com/delete", difficulty: "easy" } })], [], { sites: {} });
    expect(deletionLinks(known)).toMatchObject({ known: "https://example.com/delete", difficulty: "easy" });
    const [bad] = accountsNotInVault([site("bad.test", { deletion: { url: "javascript:alert(1)" } })], [], { sites: {} });
    expect(deletionLinks(bad).known).toBeNull();
    expect(deletionLinks(bad).settings).toBe("https://bad.test/.well-known/change-password");
    // A site Apple's list knows goes to its own page.
    const [listed] = accountsNotInVault([site("1800contacts.com")], [], { sites: {} });
    expect(deletionLinks(listed).settings).toBe("https://www.1800contacts.com/account/settings");
  });

  it("writes a request from the mailbox the site writes to, to a known or guessed address", () => {
    const [row] = accountsNotInVault([site("shop.test", { account_id: ACC2, address: "sam+shop@work.test" })], [], { sites: {} });
    const mail = deletionEmail(row);
    expect(mail).toMatchObject({ to: "privacy@shop.test", from: ACC2, guessed: true });
    expect(mail.body).toContain("sam+shop@work.test");
    expect(mail.subject).toContain("sam+shop@work.test");
    const [known] = accountsNotInVault([site("k.test", { deletion: { email: "dpo@k.test" } })], [], { sites: {} });
    expect(deletionEmail(known)).toMatchObject({ to: "dpo@k.test", guessed: false });
  });

  it("opens Mail as a draft, with the draft after the # where the server never sees it", () => {
    const [row] = accountsNotInVault([site("shop.test", { account_id: ACC2 })], [], { sites: {} });
    const href = composeHref("https://promptly.example/", deletionEmail(row));
    const u = new URL(href);
    expect(u.origin + u.pathname).toBe("https://promptly.example/mail");
    expect(u.search).toBe("?compose=1");
    expect(u.hash).toContain("to=privacy%40shop.test");
    const link = readComposeLink(u.search, u.hash);
    expect(link).toMatchObject({ to: "privacy@shop.test", from: ACC2 });
    expect(link?.body).toContain("Please delete my account with shop.test");
  });

  it("Mail refuses a compose link that isn't addresses, and ignores a bad mailbox id", () => {
    expect(readComposeLink("?compose=1", "#to=javascript:alert(1)")).toBeNull();
    expect(readComposeLink("?other=1", "#to=a@b.test")).toBeNull();
    expect(readComposeLink("?compose=1", "#to=a@b.test&from=../../x&subject=a%0Ab")).toEqual({ to: "a@b.test", subject: "a b", body: "", from: null });
  });

  it("links to the email only for a well-formed thread", () => {
    expect(openHref("https://p.example", `${ACC}/abc_123`)).toBe(`https://p.example/mail?open=${ACC}/abc_123`);
    expect(openHref("https://p.example", "x/../../y")).toBeNull();
    expect(openHref("https://p.example", null)).toBeNull();
  });
});
