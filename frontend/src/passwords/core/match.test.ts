// Site matching and lookalike checks, including the origin-confusion cases in 13.5.
import { describe, expect, it } from "vitest";

import { baseDomain, editDistance, hostOf, lookalikeOf, matchItems, matchUrl, sharedWith, skeleton } from "./match";
import { type Item, newBody } from "./model";

const login = (id: string, urls: Item["body"]["urls"]): Item => ({ id, vaultId: "v", revision: 1, deleted: false, updatedAt: "", body: newBody("login", id, { urls, username: "u", password: "p" }) });

describe("matchUrl", () => {
  it("base domain by default, through the Public Suffix List", () => {
    expect(matchUrl({ url: "https://accounts.example.com/x" }, "https://www.example.com/login")).toBe("base");
    expect(matchUrl({ url: "https://example.com" }, "https://example.com/login")).toBe("host");
    expect(matchUrl({ url: "example.com" }, "https://shop.example.com")).toBe("base");
    expect(matchUrl({ url: "https://a.example.co.uk" }, "https://b.example.co.uk")).toBe("base");
    // Different registrable domains on a shared suffix don't match.
    expect(matchUrl({ url: "https://alice.github.io" }, "https://bob.github.io")).toBeNull();
    expect(matchUrl({ url: "https://example.co.uk" }, "https://other.co.uk")).toBeNull();
    expect(matchUrl({ url: "https://a.herokuapp.com" }, "https://b.herokuapp.com")).toBeNull();
  });

  it("per-URL modes", () => {
    expect(matchUrl({ url: "https://a.example.com", match: "host" }, "https://b.example.com")).toBeNull();
    expect(matchUrl({ url: "https://a.example.com", match: "host" }, "https://a.example.com/x")).toBe("host");
    expect(matchUrl({ url: "https://a.example.com/login", match: "exact" }, "https://a.example.com/login/")).toBe("exact");
    expect(matchUrl({ url: "https://a.example.com/login", match: "exact" }, "https://a.example.com/other")).toBeNull();
    expect(matchUrl({ url: "https://a.example.com/app", match: "prefix" }, "https://a.example.com/app/x")).toBe("prefix");
    expect(matchUrl({ url: "^https://a\\.example\\.com/", match: "regex" }, "https://a.example.com/q")).toBe("regex");
    expect(matchUrl({ url: "https://a.example.com", match: "never" }, "https://a.example.com")).toBeNull();
    expect(matchUrl({ url: "(", match: "regex" }, "https://x.example")).toBeNull();
    expect(matchUrl({ url: "(a+)+$", match: "regex" }, "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!")).toBeNull();
  });

  it("origin confusion fails safe", () => {
    const saved = { url: "https://bank.example.com" };
    for (const page of [
      "https://bank.example.com.evil.test/",
      "https://evil.test/bank.example.com",
      "https://bank.example.com@evil.test/",
      "https://user:pw@bank.example.com/",
      "https://evil.test/?u=https://bank.example.com",
      "data:text/html,<input>",
      "about:blank",
      "blob:https://bank.example.com/1",
      "file:///c:/bank.example.com/x.html",
      "javascript:alert(1)",
      "chrome-extension://abc/page.html",
      "not a url",
    ]) {
      expect(matchUrl(saved, page), page).toBeNull();
    }
    // Punycode lookalike: a different domain.
    expect(matchUrl({ url: "https://apple.com" }, "https://xn--pple-43d.com/")).toBeNull();
  });

  it("IP addresses and bare hosts only match exactly, and ports count", () => {
    expect(matchUrl({ url: "http://192.168.1.10" }, "http://192.168.1.11/")).toBeNull();
    expect(matchUrl({ url: "http://192.168.1.10" }, "http://192.168.1.10/admin")).toBe("host");
    expect(matchUrl({ url: "http://router" }, "http://router/")).toBe("host");
    expect(matchUrl({ url: "http://other" }, "http://router/")).toBeNull();
    expect(matchUrl({ url: "https://nas.example.com:5001" }, "https://nas.example.com:8443/")).toBeNull();
    expect(matchUrl({ url: "https://nas.example.com:5001" }, "https://nas.example.com:5001/x")).toBe("host");
  });

  it("shared-credential groups match both ways", () => {
    const some = [...sharedWith("themeforest.net")];
    expect(some).toContain("envato.com");
    expect(matchUrl({ url: "https://themeforest.net" }, "https://envato.com/login")).toBe("shared");
  });
});

describe("matchItems", () => {
  const items = [
    login("base", [{ url: "https://example.com" }]),
    login("exact", [{ url: "https://www.example.com/login", match: "exact" }]),
    login("host", [{ url: "https://www.example.com" }]),
    login("other", [{ url: "https://other.test" }]),
    { ...login("gone", [{ url: "https://www.example.com" }]), deleted: true },
    { ...login("arch", [{ url: "https://www.example.com" }]), body: { ...newBody("login", "arch"), archived: true, urls: [{ url: "https://www.example.com" }] } },
  ];

  it("best first, nothing deleted or archived", () => {
    expect(matchItems(items, "https://www.example.com/login").map((c) => c.item.id)).toEqual(["exact", "host", "base"]);
  });

  it("recently used breaks ties", () => {
    const two = [login("a", [{ url: "https://x.test" }]), login("b", [{ url: "https://x.test" }])];
    expect(matchItems(two, "https://x.test/", { b: 5, a: 1 }).map((c) => c.item.id)).toEqual(["b", "a"]);
  });

  it("flags a saved https login on an http page", () => {
    const [c] = matchItems([login("a", [{ url: "https://x.test" }])], "http://x.test/");
    expect(c.downgrade).toBe(true);
    const [d] = matchItems([login("a", [{ url: "http://x.test" }])], "http://x.test/");
    expect(d.downgrade).toBe(false);
    const [e] = matchItems([login("a", [{ url: "https://x.test" }])], "https://x.test/");
    expect(e.downgrade).toBe(false);
  });
});

describe("lookalikes", () => {
  const vault = ["paypal.com", "github.com", "mybank.com.au", "google.com"];
  it.each([
    ["paypa1.com", "paypal.com"],
    ["paypal.co", "paypal.com"],
    ["paypal.evil-login.com", null],
    ["paypal-login.com", "paypal.com"],
    ["secure-paypal.com", "paypal.com"],
    ["gíthub.com", "github.com"],
    ["githuh.com", "github.com"],
    ["gihtub.com", "github.com"],
    ["goog1e.com", "google.com"],
    ["rnybank.com.au", "mybank.com.au"],
    ["xn--pypal-4ve.com", "paypal.com"],
  ])("%s looks like %s", (page, want) => {
    expect(lookalikeOf(page, vault)).toBe(want);
  });

  it.each(["paypal.com", "www.paypal.com", "example.com", "gitlab.com", "bitbucket.org", "githubusercontent.org"])("%s is fine", (page) => {
    expect(lookalikeOf(page, ["paypal.com", "github.com"])).toBeNull();
  });

  it("known shared-credential sites aren't lookalikes", () => {
    expect(lookalikeOf("envato.com", ["themeforest.net"])).toBeNull();
  });

  it("helpers", () => {
    expect(editDistance("gihtub", "github")).toBe(1);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(skeleton("раураl")).toBe(skeleton("paypal"));
    expect(hostOf("https://A.Example.com:8/x")).toBe("a.example.com");
    expect(baseDomain("a.b.example.co.uk")).toBe("example.co.uk");
  });
});
