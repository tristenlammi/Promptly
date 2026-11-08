// Aliases on your own domain: the word, the leak check against the login's own
// websites, the API calls, and Mail's choice of which alias a reply comes from.
import { describe, expect, it } from "vitest";

import { replyAlias, sendAsNote, type ThreadAliases } from "../../mail/aliasReply";
import { type Alias, aliasApi, aliasesFor, aliasWarnings, aliasWord, cleanWord, sameBusiness, siteWord } from "./aliases";
import type { VaultApi } from "./api";
import type { Item } from "./model";
import { WORDLIST } from "./safety";

function alias(over: Partial<Alias> = {}): Alias {
  return {
    id: "a1", address: "shop.k7m2@alias.test", domain_id: "d1", domain: "alias.test", account_id: "acc", item_id: "i1", enabled: true,
    disabled_at: null, created_at: "2026-11-01T00:00:00Z", baseline: "shop.example", allowed_senders: [], flagged_at: null, flagged_sender: "",
    count: 0, last_at: null, senders: [], send_as: "ok", send_as_text: "", ...over,
  };
}

const item = (url: string) => ({ id: "i1", body: { kind: "login", title: "Shop", urls: [{ url }] } }) as unknown as Item;
const sender = (domain: string, unlike = false) => ({ domain, count: 2, last_at: "2026-11-02T09:00:00Z", unlike });

describe("the word an alias starts with", () => {
  it("is cleaned the way the server cleans it", () => {
    expect(cleanWord("Über Shop 24/7")).toBe("bershop247");
    expect(cleanWord("a".repeat(40))).toHaveLength(20);
  });

  it("comes from the site's name, without its www or ending", () => {
    expect(siteWord("https://www.shop.co.uk/login")).toBe("shop");
    expect(siteWord("https://login.shop.example.co.uk")).toBe("example");
    expect(siteWord("https://accounts.netflix.com")).toBe("netflix");
    expect(siteWord("not a url at all")).toBe("");
    expect(siteWord("android://com.acme.app")).toBe("");
  });

  it("follows the domain's style", () => {
    const words = new Set(WORDLIST.map(cleanWord));
    for (let i = 0; i < 30; i++) {
      const w = aliasWord("word", { url: "https://shop.example" });
      expect(words.has(w)).toBe(true);
      expect(w).toMatch(/^[a-z0-9]{3,9}$/);
    }
    expect(aliasWord("site", { url: "https://www.netflix.com" })).toBe("netflix");
    expect(words.has(aliasWord("site", { url: "" }))).toBe(true);
    expect(aliasWord("custom", { custom: "My Bank!" })).toBe("mybank");
    expect(aliasWord("none", { url: "https://shop.example" })).toBe("");
  });
});

describe("a sender unlike the site", () => {
  it("knows the same business by its domain, sub-domains and mail services", () => {
    expect(sameBusiness("mail.netflix.com", "www.netflix.com")).toBe(true);
    expect(sameBusiness("amazonses.com", "amazon.com.au")).toBe(true);
    expect(sameBusiness("shop.co.uk", "shop.com")).toBe(true);
    expect(sameBusiness("cheap-pills.example", "netflix.com")).toBe(false);
    expect(sameBusiness("ab.com", "abc.com")).toBe(false);
  });

  it("is judged against the login's own websites when the vault has it", () => {
    const a = alias({ senders: [sender("netflix.com"), sender("mailer.netflix.com"), sender("cheap-pills.example")] });
    expect(aliasWarnings(a, item("https://www.netflix.com")).map((w) => w.sender)).toEqual(["cheap-pills.example"]);
    // Even where the server's guess (the first sender) was the leak itself.
    const wrongGuess = alias({ baseline: "cheap-pills.example", senders: [sender("cheap-pills.example"), sender("netflix.com", true)] });
    expect(aliasWarnings(wrongGuess, item("https://netflix.com")).map((w) => w.sender)).toEqual(["cheap-pills.example"]);
  });

  it("falls back to the server's flag without the login, and respects 'this sender is fine'", () => {
    const a = alias({ item_id: null, senders: [sender("shop.example"), sender("cheap-pills.example", true)] });
    expect(aliasWarnings(a, null).map((w) => w.sender)).toEqual(["cheap-pills.example"]);
    expect(aliasWarnings({ ...a, allowed_senders: ["cheap-pills.example"] }, null)).toEqual([]);
    expect(aliasWarnings({ ...a, allowed_senders: ["cheap-pills.example"] }, item("https://shop.example"))).toEqual([]);
    // Your own replies from the alias's domain aren't a leak.
    expect(aliasWarnings(alias({ senders: [sender("alias.test", true)] }), item("https://shop.example"))).toEqual([]);
  });

  it("finds a login's aliases", () => {
    expect(aliasesFor([alias(), alias({ id: "a2", item_id: "i2" })], "i1").map((a) => a.id)).toEqual(["a1"]);
  });
});

describe("the API", () => {
  it("sends the word and the item id, and nothing about the site", async () => {
    const calls: [string, string, unknown][] = [];
    const api = { request: async (method: string, path: string, body?: unknown) => (calls.push([method, path, body]), {}) } as unknown as VaultApi;
    const a = aliasApi(api);
    await a.make("d1", aliasWord("word"), "i1");
    await a.edit("a1", { enabled: false });
    await a.allow("a1", "cheap-pills.example");
    await a.check("d1");
    await a.editDomain("d1", { off_to_trash: true });
    expect(calls.map(([m, p]) => `${m} ${p}`)).toEqual(["POST /aliases", "PATCH /aliases/a1", "POST /aliases/a1/allow", "POST /aliases/domains/d1/check", "PATCH /aliases/domains/d1"]);
    const made = calls[0][2] as Record<string, unknown>;
    expect(Object.keys(made).sort()).toEqual(["domain_id", "item_id", "word"]);
    expect(JSON.stringify(made)).not.toMatch(/http|shop\.example/);
  });
});

describe("replying in Mail", () => {
  const info: ThreadAliases = {
    messages: { m1: "x", m3: "y" },
    aliases: {
      x: { id: "x", address: "shop.k7m2@alias.test", domain: "alias.test", item_id: null, enabled: true, count: 1, last_at: null, flagged_at: null, flagged_sender: "", send_as: "ok", send_as_text: "" },
      y: { id: "y", address: "news.p9q3@alias.test", domain: "alias.test", item_id: null, enabled: true, count: 1, last_at: null, flagged_at: null, flagged_sender: "", send_as: "rewritten", send_as_text: "Add it." },
    },
  };

  it("comes from the alias the newest email went to", () => {
    expect(replyAlias(info, ["m1", "m2", "m3", "m4"])?.address).toBe("news.p9q3@alias.test");
    expect(replyAlias(info, ["m1", "m2"])?.address).toBe("shop.k7m2@alias.test");
    expect(replyAlias(info, ["m2"])).toBeNull();
    expect(replyAlias(undefined, ["m1"])).toBeNull();
    // An empty answer, as from an older server, is no alias rather than a crash.
    expect(replyAlias({} as ThreadAliases, ["m1"])).toBeNull();
  });

  it("says when the provider may not send as it", () => {
    expect(sendAsNote("ok", "")).toBe("");
    expect(sendAsNote("rewritten", "Add it.")).toContain("Add it.");
    expect(sendAsNote("unknown", "")).toMatch(/Not checked/);
  });
});
