import { readFileSync } from "node:fs";
// Site matching and lookalike checks, including the origin-confusion cases in 13.5.
import { describe, expect, it } from "vitest";

import { baseDomain, editDistance, hostKey, hostOf, ITEM_MATCHES, lookalikeOf, matchItems, matchUrl, modeOf, pageContext, sharedWith, siteName, skeleton, URL_MATCHES } from "./match";
import { type Item, newBody } from "./model";

const login = (id: string, urls: Item["body"]["urls"], extra: Partial<Item["body"]> = {}): Item => ({ id, vaultId: "v", revision: 1, deleted: false, updatedAt: "", body: newBody("login", id, { urls, username: "u", password: "p", ...extra }) });
const offered = (items: Item[], page: string) => matchItems(items, page).map((c) => [c.item.id, c.kind]);

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

  it("IP addresses and bare hosts only match themselves, and a saved port counts", () => {
    expect(matchUrl({ url: "http://192.168.1.10" }, "http://192.168.1.11/")).toBeNull();
    expect(matchUrl({ url: "http://192.168.1.10" }, "http://192.168.1.10/admin")).toBe("host");
    expect(matchUrl({ url: "http://192.168.1.10", match: "base" }, "http://192.168.1.11/")).toBeNull();
    expect(matchUrl({ url: "http://192.168.1.10" }, "http://192.168.1.100/")).toBeNull();
    expect(matchUrl({ url: "http://192.168.1.10" }, "http://192.168.1.10.evil.test/")).toBeNull();
    expect(matchUrl({ url: "http://router" }, "http://router/")).toBe("host");
    expect(matchUrl({ url: "http://other" }, "http://router/")).toBeNull();
    expect(matchUrl({ url: "https://nas.example.com:5001" }, "https://nas.example.com:8443/")).toBeNull();
    expect(matchUrl({ url: "https://nas.example.com:5001" }, "https://nas.example.com:5001/x")).toBe("host");
  });

  it("no saved port: its host on any port, and other hosts on the default port only", () => {
    expect(matchUrl({ url: "https://bank.example" }, "https://bank.example/")).toBe("host");
    expect(matchUrl({ url: "https://bank.example:443" }, "https://bank.example/")).toBe("host");
    expect(matchUrl({ url: "bank.example" }, "https://bank.example/")).toBe("host");
    expect(matchUrl({ url: "https://bank.example" }, "https://bank.example:8443/")).toBe("anyport");
    expect(matchUrl({ url: "https://bank.example" }, "http://bank.example:8080/")).toBe("anyport");
    expect(matchUrl({ url: "https://bank.example" }, "https://app.bank.example:8443/")).toBeNull();
    expect(matchUrl({ url: "https://bank.example" }, "https://app.bank.example/")).toBe("base");
    expect(matchUrl({ url: "https://bank.example:8443" }, "https://app.bank.example:8443/")).toBe("base");
    expect(matchUrl({ url: "https://bank.example:8443" }, "https://bank.example/")).toBeNull();
  });

  it("self-hosted addresses work without editing", () => {
    expect(matchUrl({ url: "nas.home" }, "https://nas.home:5001/")).toBe("anyport");
    expect(matchUrl({ url: "192.168.1.10" }, "https://192.168.1.10:8443/")).toBe("anyport");
    expect(matchUrl({ url: "http://nas" }, "http://nas:8080/")).toBe("anyport");
    expect(matchUrl({ url: "http://[::1]" }, "http://[::1]:8080/")).toBe("anyport");
    expect(matchUrl({ url: "http://printer.local" }, "http://scanner.local/")).toBeNull();
    expect(matchUrl({ url: "https://nas.home.arpa" }, "https://router.home.arpa/")).toBeNull();
    expect(matchUrl({ url: "http://nas" }, "http://nas.lan/")).toBeNull();
    expect(matchUrl({ url: "https://foo.duckdns.org" }, "https://bar.duckdns.org/")).toBeNull();
  });

  it("prefix mode compares origins first", () => {
    expect(matchUrl({ url: "https://bank.example", match: "prefix" }, "https://bank.example/login")).toBe("prefix");
    expect(matchUrl({ url: "https://bank.example", match: "prefix" }, "https://bank.example.evil.test/login")).toBeNull();
    expect(matchUrl({ url: "https://bank.example", match: "prefix" }, "https://bank.example@evil.test/login")).toBeNull();
    expect(matchUrl({ url: "https://bank.example/app", match: "prefix" }, "https://bank.example/other")).toBeNull();
    expect(matchUrl({ url: "https://bank.example", match: "prefix" }, "http://bank.example/login")).toBeNull();
  });

  it("regex mode starts at the start, and takes in the whole origin", () => {
    expect(matchUrl({ url: "^https://bank\\.example/", match: "regex" }, "https://bank.example/login")).toBe("regex");
    expect(matchUrl({ url: "https://bank\\.example", match: "regex" }, "https://bank.example/login")).toBe("regex");
    expect(matchUrl({ url: "bank\\.example", match: "regex" }, "https://evil.test/?bank.example")).toBeNull();
    expect(matchUrl({ url: "https://bank\\.example", match: "regex" }, "https://bank.example.evil.test/")).toBeNull();
  });

  it("shared-credential groups match both ways", () => {
    const some = [...sharedWith("themeforest.net")];
    expect(some).toContain("envato.com");
    expect(matchUrl({ url: "https://themeforest.net" }, "https://envato.com/login")).toBe("shared");
  });
});

describe("matchItems", () => {
  const items = [
    login("base", [{ url: "https://accounts.example.com" }]),
    login("exact", [{ url: "https://www.example.com/login", match: "exact" }]),
    login("host", [{ url: "https://www.example.com" }]),
    login("other", [{ url: "https://other.test" }]),
    { ...login("gone", [{ url: "https://www.example.com" }]), deleted: true },
    { ...login("arch", [{ url: "https://www.example.com" }]), body: { ...newBody("login", "arch"), archived: true, urls: [{ url: "https://www.example.com" }] } },
  ];

  it("best first, nothing deleted or archived", () => {
    expect(offered(items, "https://www.example.com/login")).toEqual([["exact", "exact"], ["host", "host"], ["base", "sibling"]]);
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

describe("Auto, across the vault", () => {
  const zyx = login("zyx", [{ url: "https://zyx.gymserver.org" }]);
  const abc = login("abc", [{ url: "https://abc.gymserver.org" }]);

  it("offers each self-hosted service its own login, and lists the other apart", () => {
    expect(offered([zyx, abc], "https://zyx.gymserver.org/login")).toEqual([["zyx", "host"], ["abc", "sibling"]]);
    expect(offered([zyx, abc], "https://abc.gymserver.org/")).toEqual([["abc", "host"], ["zyx", "sibling"]]);
    expect(offered([zyx, abc], "https://gymserver.org/")).toEqual([["abc", "sibling"], ["zyx", "sibling"]]);
    expect(siteName("https://zyx.gymserver.org/login")).toBe("gymserver.org");
  });

  it("with one host known, it's offered on the others as before", () => {
    expect(offered([zyx], "https://abc.gymserver.org/")).toEqual([["zyx", "base"]]);
  });

  it("a big site's sign-in host still fills across the domain", () => {
    const acc = login("acc", [{ url: "https://accounts.example.com/signin" }]);
    const lg = login("lg", [{ url: "https://login.example.com" }]);
    for (const page of ["https://example.com/", "https://www.example.com/", "https://mail.example.com/"]) {
      expect(offered([acc], page)).toEqual([["acc", "base"]]);
      expect(offered([lg], page)).toEqual([["lg", "base"]]);
      // Even with another service's login on the domain.
      expect(offered([acc, login("app", [{ url: "https://app.example.com" }])], page)[0]).toEqual(["acc", "base"]);
    }
  });

  it("a single sign-on host stands for services with no login of their own", () => {
    const auth = login("auth", [{ url: "https://auth.gymserver.org" }]);
    expect(offered([auth, zyx], "https://wiki.gymserver.org/")).toEqual([["auth", "base"], ["zyx", "sibling"]]);
    expect(offered([auth, zyx], "https://zyx.gymserver.org/")).toEqual([["zyx", "host"], ["auth", "sibling"]]);
  });

  it("a saved port is a service of its own", () => {
    const dsm = login("dsm", [{ url: "https://nas.home:5001" }]);
    const other = login("other", [{ url: "https://nas.home:8443" }]);
    const router = login("router", [{ url: "https://nas.home" }]);
    expect(offered([dsm, other, router], "https://nas.home:5001/")).toEqual([["dsm", "host"], ["router", "sibling"]]);
    expect(offered([dsm, other, router], "https://nas.home:9000/")).toEqual([["router", "anyport"]]);
    expect(offered([dsm, other, router], "https://nas.home/")).toEqual([["router", "host"]]);
  });

  it("never lets an IP address match another", () => {
    const ip = login("ip", [{ url: "http://192.168.1.10" }]);
    expect(offered([ip], "http://192.168.1.10:8080/")).toEqual([["ip", "anyport"]]);
    expect(offered([ip], "http://192.168.1.11:8080/")).toEqual([]);
    expect(offered([ip], "http://192.168.1.1/")).toEqual([]);
  });

  it("counts only logins that could be offered", () => {
    const never = login("n", [{ url: "https://abc.gymserver.org" }], { match: "never" });
    const gone = { ...abc, deleted: true };
    expect(offered([zyx, never], "https://abc.gymserver.org/")).toEqual([["zyx", "base"]]);
    expect(offered([zyx, gone], "https://abc.gymserver.org/")).toEqual([["zyx", "base"]]);
  });

  it("the context it works from", () => {
    const entries = [{ url: "https://zyx.gymserver.org", mode: "auto" as const }, { url: "https://www.abc.gymserver.org", mode: "base" as const }, { url: "https://x.other.org", mode: "auto" as const }];
    expect(pageContext(entries, "https://zyx.gymserver.org/")).toEqual({ exactHere: true, hostsUnderBase: 2 });
    expect(pageContext(entries, "https://zyx.gymserver.org:8443/")).toEqual({ exactHere: false, hostsUnderBase: 2 });
    expect(pageContext(entries, "https://abc.gymserver.org/")).toEqual({ exactHere: true, hostsUnderBase: 2 });
    expect(pageContext([{ url: "https://zyx.gymserver.org", mode: "never" }], "https://zyx.gymserver.org/")).toEqual({ exactHere: false, hostsUnderBase: 0 });
    expect(pageContext(entries, "not a url")).toEqual({ exactHere: false, hostsUnderBase: 1 });
  });

  it("www. is the same site, unless it's someone else's", () => {
    expect(hostKey("www.example.com")).toBe("example.com");
    expect(hostKey("www.alice.github.io")).toBe("alice.github.io");
    expect(hostKey("www.github.io")).toBe("www.github.io");
    expect(hostKey("shop.example.com")).toBe("shop.example.com");
  });
});

describe("the item's match setting", () => {
  it("nothing set, or an older item, is Auto", () => {
    expect(modeOf({ url: "x" })).toBe("auto");
    expect(modeOf({ url: "x" }, null)).toBe("auto");
    expect(modeOf({ url: "x" }, "host")).toBe("host");
    expect(modeOf({ url: "x", match: "base" }, "host")).toBe("base");
    // Something from a newer client gets the strictest host rule.
    expect(modeOf({ url: "x", match: "later" as never })).toBe("port");
  });

  it("each choice, on the item", () => {
    const at = (match: Item["body"]["match"], page: string) => offered([login("a", [{ url: "https://zyx.gymserver.org" }], { match })], page);
    expect(at("base", "https://abc.gymserver.org/")).toEqual([["a", "base"]]);
    expect(at("host", "https://abc.gymserver.org/")).toEqual([]);
    expect(at("host", "https://zyx.gymserver.org:8443/")).toEqual([["a", "anyport"]]);
    expect(at("port", "https://zyx.gymserver.org:8443/")).toEqual([]);
    expect(at("port", "https://zyx.gymserver.org/x")).toEqual([["a", "host"]]);
    expect(at("prefix", "https://zyx.gymserver.org/x")).toEqual([["a", "prefix"]]);
    expect(at("prefix", "https://zyx.gymserver.org.evil.test/")).toEqual([]);
    expect(at("never", "https://zyx.gymserver.org/")).toEqual([]);
    expect(at(undefined, "https://zyx.gymserver.org/")).toEqual([["a", "host"]]);
  });

  it("Same domain on the item isn't set apart", () => {
    const a = login("a", [{ url: "https://abc.gymserver.org" }], { match: "base" });
    const b = login("b", [{ url: "https://zyx.gymserver.org" }]);
    expect(offered([a, b], "https://zyx.gymserver.org/")).toEqual([["b", "host"], ["a", "base"]]);
  });

  it("an address's own setting beats the item's", () => {
    const n = login("n", [{ url: "https://zyx.gymserver.org", match: "host" }, { url: "https://abc.gymserver.org" }], { match: "never" });
    expect(offered([n], "https://zyx.gymserver.org/")).toEqual([["n", "host"]]);
    expect(offered([n], "https://abc.gymserver.org/")).toEqual([]);
  });

  it("the editors' lists", () => {
    expect(ITEM_MATCHES.map((m) => m.value)).toEqual(["auto", "base", "host", "port", "prefix", "never"]);
    expect(ITEM_MATCHES.map((m) => m.label)).toEqual(["Auto", "Same domain", "Exact host", "Exact host and port", "Starts with", "Never"]);
    expect(URL_MATCHES[0]).toEqual({ value: "", label: "As the login" });
    expect(URL_MATCHES.map((m) => m.value)).toContain("regex");
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

describe("an app's id isn't a website", () => {
  it("has no host, and so matches nothing", () => {
    expect(hostOf("android://HASH==@com.acme.app/")).toBeNull();
    expect(hostOf("androidapp://com.acme.app")).toBeNull();
    expect(matchUrl({ url: "android://HASH==@com.acme.app/" }, "https://acme.app/")).toBeNull();
    expect(hostOf("https://acme.app/x")).toBe("acme.app");
    expect(hostOf("acme.app")).toBe("acme.app");
  });
});

describe("the list both clients share", () => {
  it("gives the answers in android/app/src/test/cross/match-vectors.json", () => {
    const file = new URL("../../../../android/app/src/test/cross/match-vectors.json", import.meta.url);
    type V = { url: string; match?: string };
    const v = JSON.parse(readFileSync(file, "utf8")) as {
      match: { url: string; mode?: string; item?: string; page: string; want: string | null }[];
      items: { vault: { id: string; match?: string; deleted?: boolean; urls: V[] }[]; page: string; want: [string, string][] }[];
      host: { url: string; want: string | null }[];
    };
    const wrong: string[] = [];
    expect(v.match.length).toBeGreaterThanOrEqual(100);
    for (const c of v.match) {
      const got = matchUrl({ url: c.url, match: c.mode as never }, c.page, { itemMatch: c.item as never });
      if (got !== c.want) wrong.push(`${c.url} (${c.mode ?? "-"}/${c.item ?? "-"}) on ${c.page}: ${got}, wanted ${c.want}`);
    }
    expect(v.items.length).toBeGreaterThanOrEqual(25);
    for (const c of v.items) {
      const vault = c.vault.map((x) => ({ ...login(x.id, x.urls as never, x.match ? { match: x.match as never } : {}), deleted: !!x.deleted }));
      const got = JSON.stringify(offered(vault, c.page));
      if (got !== JSON.stringify(c.want)) wrong.push(`vault on ${c.page}: ${got}, wanted ${JSON.stringify(c.want)}`);
    }
    for (const c of v.host) {
      const got = hostOf(c.url);
      if (got !== c.want) wrong.push(`hostOf ${c.url}: ${got}, wanted ${c.want}`);
    }
    expect(wrong).toEqual([]);
  });

  it("refuses a repeated choice, as Android does", () => {
    expect(matchUrl({ url: "https://(a|aa)+", match: "regex" }, "https://aaaa/")).toBeNull();
  });
});
