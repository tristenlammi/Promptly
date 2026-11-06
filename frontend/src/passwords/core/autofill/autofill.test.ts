// @vitest-environment jsdom
// Unit tests for the pieces that don't need layout. The real corpus runs in browsers.
import { describe, expect, it, beforeEach } from "vitest";

import { b64u, fromB64u, utf8 } from "../bytes";
import { signingInput } from "../format";
import { ed25519Public, ed25519Sign } from "../primitives";
import { analyzePage, tokens } from "./classify";
import { capture, decideOffer, looksFailed, requestVerdict } from "./capture";
import { fillField, fillFields, fillSplit } from "./fill";
import { advance, afterFill, codeStep, flowFor, mayFillOnLoad, nextFor } from "./flow";
import { checkAtClick, visibilityV2 } from "./guard";
import { applyRule, describeForm, openSignedPack, ruleForHost, selectorFor } from "./rules";

const DOM = { noLayout: true };
const set = (html: string) => {
  document.body.innerHTML = html;
};

beforeEach(() => set(""));

describe("classifier basics", () => {
  it("tokens split camelCase and separators", () => {
    expect(tokens("userName_field").words).toEqual(new Set(["user", "name", "field"]));
    expect(tokens("userName_field").joined).toBe("usernamefield");
  });

  it("sign-in", () => {
    set(`<form action="/login"><input name="user"><input type="password" name="pw"><button>Log in</button></form>`);
    const { best } = analyzePage(document, DOM);
    expect(best?.kind).toBe("signin");
    expect(best?.fields.map((f) => f.role)).toEqual(["username", "password"]);
    expect(best?.submit?.textContent).toBe("Log in");
  });

  it("CSS classes can't make a field something it isn't", () => {
    // Real sites' utility classes, found on public pages: these are all just styling.
    const noise = "min-h-10 max-w-md search-wrap comment-box phone-row coupon-style address-grid length-4 policy-note gift-card-shadow member-form";
    set(`<form><input id="email" type="email" class="${noise}"><input id="password" type="password" autocomplete="current-password" class="${noise}"><button>Log in</button></form>`);
    const { best } = analyzePage(document, DOM);
    expect(best?.kind).toBe("signin");
    expect(best?.fields.map((f) => f.role)).toEqual(["username", "password"]);
  });

  it("a box for a phone or an email is an identifier, whatever autocomplete says", () => {
    set(`<form><h1>Log in or sign up</h1><input id="phone-or-email" autocomplete="tel-national"><button>Continue</button></form>`);
    const { best } = analyzePage(document, DOM);
    expect(best?.kind).toBe("email-first");
  });

  it("a search box and a newsletter box don't count", () => {
    set(`<form role="search"><input name="q"><button>Go</button></form><form><h3>Newsletter</h3><input type="email" name="email"><button>Subscribe</button></form>`);
    const page = analyzePage(document, DOM);
    expect(page.best).toBeNull();
    expect(page.forms.map((f) => f.kind).sort()).toEqual(["newsletter", "search"]);
  });

  it("autocomplete attributes win over misleading names", () => {
    set(`<form><input name="field1" autocomplete="username"><input type="password" name="field2" autocomplete="current-password"><button type="submit">Go</button></form>`);
    expect(analyzePage(document, DOM).best?.fields.map((f) => f.role)).toEqual(["username", "password"]);
  });

  it("change-password in three boxes", () => {
    set(`<form><h2>Change password</h2><input type="password" name="current"><input type="password" name="new"><input type="password" name="confirm"><button>Save</button></form>`);
    const b = analyzePage(document, DOM).best;
    expect(b?.kind).toBe("change-password");
    expect(b?.fields.map((f) => f.role)).toEqual(["current-password", "new-password", "confirm-password"]);
  });

  it("sign-up with two password boxes", () => {
    set(`<form><h2>Create your account</h2><input type="email" name="email"><input type="password" name="password"><input type="password" name="password2"><button>Sign up</button></form>`);
    const b = analyzePage(document, DOM).best;
    expect(b?.kind).toBe("signup");
    expect(b?.fields.map((f) => f.role)).toEqual(["username", "new-password", "confirm-password"]);
  });

  it("disabled inputs and hidden ones are skipped", () => {
    set(`<form><input type="hidden" name="user"><input name="user" disabled><input name="user2"><input type="password"><button>Sign in</button></form>`);
    expect(analyzePage(document, DOM).best?.fields.map((f) => f.role)).toEqual(["username", "password"]);
  });

  it("honeypots named as such, or aria-hidden, are skipped", () => {
    set(`<form><input name="honeypot"><div aria-hidden="true"><input name="email2"></div><input name="login"><input type="password"><button>Sign in</button></form>`);
    const b = analyzePage(document, DOM).best;
    expect((b?.fields[0].el as HTMLInputElement).name).toBe("login");
  });

  it("a page with 1000 inputs stays within budget", () => {
    set(Array.from({ length: 1000 }, (_, i) => `<input name="f${i}">`).join(""));
    const t = performance.now();
    analyzePage(document, DOM);
    expect(performance.now() - t).toBeLessThan(4000);
  });
});

describe("filling", () => {
  it("gets past a React-style value tracker", async () => {
    set(`<input id="a">`);
    const el = document.getElementById("a") as HTMLInputElement;
    let tracked = "";
    // What React does: override value on the instance, so a plain assignment is
    // invisible to it. Only the prototype's setter plus an input event is noticed.
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
    Object.defineProperty(el, "value", {
      configurable: true,
      get() {
        return desc.get!.call(this);
      },
      set(v) {
        tracked = v;
        desc.set!.call(this, v);
      },
    });
    const seen: string[] = [];
    el.addEventListener("input", () => {
      if (el.value !== tracked) seen.push(el.value);
    });
    await fillField(el, "secret");
    expect(el.value).toBe("secret");
    expect(seen).toEqual(["secret"]);
  });

  it("sends events in the order a person's typing would", async () => {
    set(`<input id="a">`);
    const el = document.getElementById("a") as HTMLInputElement;
    const order: string[] = [];
    for (const t of ["focus", "keydown", "input", "keyup", "change", "blur"]) el.addEventListener(t, () => order.push(t));
    await fillField(el, "x");
    expect(order.indexOf("keydown")).toBeLessThan(order.indexOf("input"));
    expect(order.indexOf("input")).toBeLessThan(order.indexOf("change"));
    expect(order.indexOf("change")).toBeLessThan(order.indexOf("blur"));
    expect(order[0]).toBe("focus");
  });

  it("types per character if a page wipes a set value", async () => {
    set(`<input id="a">`);
    const el = document.getElementById("a") as HTMLInputElement;
    let bulk = true;
    el.addEventListener("input", (e) => {
      // Rejects anything that doesn't arrive one character at a time.
      if ((e as InputEvent).data && (e as InputEvent).data!.length > 1 && bulk) {
        bulk = false;
        el.value = "";
      }
    });
    const r = await fillField(el, "abc");
    expect(r.method).toBe("type");
    expect(el.value).toBe("abc");
  });

  it("waits out readonly-until-focus", async () => {
    set(`<input id="a" readonly>`);
    const el = document.getElementById("a") as HTMLInputElement;
    el.addEventListener("focus", () => setTimeout(() => (el.readOnly = false), 20));
    expect((await fillField(el, "ok")).ok).toBe(true);
    expect(el.value).toBe("ok");
  });

  it("selects by value, text, or a month and year written differently", async () => {
    set(`<select id="m"><option value="">--</option><option value="01">Jan</option><option value="12">Dec</option></select><select id="y"><option value="29">2029</option><option value="30">2030</option></select>`);
    const m = document.getElementById("m") as HTMLSelectElement;
    const y = document.getElementById("y") as HTMLSelectElement;
    expect((await fillField(m, "12")).ok).toBe(true);
    expect(m.value).toBe("12");
    expect((await fillField(m, "1")).ok).toBe(true);
    expect(m.value).toBe("01");
    expect((await fillField(y, "2030")).ok).toBe(true);
    expect(y.value).toBe("30");
    expect((await fillField(m, "notamonth")).ok).toBe(false);
  });

  it("split OTP: box by box, and a paste handler if the page has one", async () => {
    set(`<input class="d" maxlength="1"><input class="d" maxlength="1"><input class="d" maxlength="1">`);
    const boxes = [...document.querySelectorAll<HTMLInputElement>(".d")];
    await fillSplit(boxes, "123");
    expect(boxes.map((b) => b.value)).toEqual(["1", "2", "3"]);

    set(`<input class="p" maxlength="1"><input class="p" maxlength="1">`);
    const p = [...document.querySelectorAll<HTMLInputElement>(".p")];
    p[0].addEventListener("paste", (e) => {
      const text = (e as ClipboardEvent).clipboardData!.getData("text/plain");
      p.forEach((b, i) => (b.value = text[i]));
    });
    (globalThis as Record<string, unknown>).DataTransfer ??= class {
      store = new Map<string, string>();
      setData(k: string, v: string) {
        this.store.set(k, v);
      }
      getData(k: string) {
        return this.store.get(k) ?? "";
      }
    };
    (globalThis as Record<string, unknown>).ClipboardEvent ??= class extends Event {
      clipboardData: unknown;
      constructor(t: string, init: { clipboardData: unknown } & EventInit) {
        super(t, init);
        this.clipboardData = init.clipboardData;
      }
    };
    expect((await fillSplit(p, "45"))[0].method).toBe("paste");
    expect(p.map((b) => b.value)).toEqual(["4", "5"]);
  });

  it("fills only the roles asked for, and an email for a username box", async () => {
    set(`<form><input name="login"><input type="password" name="pw"><button>Log in</button></form>`);
    const b = analyzePage(document, DOM).best!;
    await fillFields(b.fields, { email: "a@b.example" });
    expect((b.fields[0].el as HTMLInputElement).value).toBe("a@b.example");
    expect((b.fields[1].el as HTMLInputElement).value).toBe("");
  });
});

describe("capture and offers", () => {
  const loc = { hostname: "a.example", href: "https://a.example/login" } as Location;

  it("captures, and notices a refused login", () => {
    set(`<form><input name="user" value="ana"><input type="password" name="pw" value="pw1"><button>Log in</button></form>`);
    const form = analyzePage(document, DOM).best!;
    const c = capture(form, loc)!;
    expect(c).toMatchObject({ username: "ana", password: "pw1", kind: "signin" });
    expect(looksFailed(document, c, DOM)).toBe(true);
    set(`<h1>Welcome back</h1>`);
    expect(looksFailed(document, c, DOM)).toBe(false);
    set(`<div role="alert">Incorrect password</div>`);
    expect(looksFailed(document, c, DOM)).toBe(true);
  });

  it("offers Save, Update or nothing as it should", () => {
    const c = { kind: "signin" as const, username: "ana", password: "new", host: "a.example", url: "u", at: 1 };
    expect(decideOffer(c, [], [])).toMatchObject({ kind: "save", password: "new" });
    expect(decideOffer(c, [{ id: "1", username: "ana", password: "new" }], [])).toBeNull();
    expect(decideOffer(c, [{ id: "1", username: "ana", password: "old" }], [])).toMatchObject({ kind: "update", itemId: "1" });
    expect(decideOffer(c, [{ id: "1", username: "other", password: "x" }], [])).toMatchObject({ kind: "save" });
    expect(decideOffer(c, [], ["a.example"])).toBeNull();
    const change = { kind: "change-password" as const, newPassword: "n2", password: "n1", host: "a.example", url: "u", at: 1 };
    expect(decideOffer(change, [{ id: "1", username: "ana", password: "n1" }], [])).toMatchObject({ kind: "update", itemId: "1", password: "n2", username: "ana" });
  });
});

describe("flow across pages", () => {
  const same = (a: string, b: string) => a.split(".").slice(-2).join(".") === b.split(".").slice(-2).join(".");
  it("keeps the item for the same site, for a while", () => {
    const f = { itemId: "i", host: "login.example.com", filled: ["username"], at: 1000 };
    expect(flowFor(f, "auth.example.com", same, 2000)?.itemId).toBe("i");
    expect(flowFor(f, "evil.test", same, 2000)).toBeNull();
    expect(flowFor(f, "login.example.com", same, 1000 + 6 * 60 * 1000)).toBeNull();
    expect(advance(f, ["password"], 3000).filled).toEqual(["username", "password"]);
  });
  it("says what's next", () => {
    expect(nextFor("email-first", false, null).fill).toEqual(["username"]);
    expect(nextFor("password-next", false, null).fill).toEqual(["password"]);
    expect(nextFor("signin", true, null)).toEqual({ fill: ["username", "password"], copyOtp: true });
    expect(nextFor("otp", true, null).fill).toEqual(["otp"]);
    expect(nextFor("search", true, null).fill).toEqual([]);
  });
});

describe("rules", () => {
  it("a site rule finds fields, and a bad selector is just no match", () => {
    set(`<input id="u"><input id="p" type="password"><button id="go">Go</button>`);
    const form = applyRule(document, { host: "a.example", username: "#u", password: "#p", submit: "#go" })!;
    expect(form.kind).toBe("signin");
    expect(form.fields.map((f) => f.role)).toEqual(["username", "password"]);
    expect(form.submit?.id).toBe("go");
    expect(applyRule(document, { host: "a.example", username: ":::" })).toBeNull();
    expect(applyRule(document, { host: "a.example", never: true, username: "#u" })).toBeNull();
    // A selector aimed at something that isn't a field does nothing.
    expect(applyRule(document, { host: "a.example", username: "#go" })).toBeNull();
  });

  it("the most specific host wins", () => {
    const rules = [{ host: "example.com", username: "#a" }, { host: "login.example.com", username: "#b" }];
    expect(ruleForHost(rules, "login.example.com")?.username).toBe("#b");
    expect(ruleForHost(rules, "x.example.com")?.username).toBe("#a");
    expect(ruleForHost(rules, "notexample.com")).toBeNull();
  });

  it("signed packs verify, and anything else is refused", () => {
    const seed = new Uint8Array(32).fill(9);
    const pub = ed25519Public(seed);
    const sign = (o: unknown) => {
      const bytes = utf8(JSON.stringify(o));
      return { pack: b64u(bytes), signature: b64u(ed25519Sign(seed, signingInput("rules_pack", [bytes]))) };
    };
    const good = sign({ version: 3, rules: [{ host: "a.example", username: "#u" }] });
    expect(openSignedPack(good, pub).rules).toHaveLength(1);
    expect(() => openSignedPack(good, ed25519Public(new Uint8Array(32).fill(1)))).toThrow(/signed/);
    expect(() => openSignedPack({ ...good, pack: b64u(utf8('{"version":3,"rules":[]}')) }, pub)).toThrow(/signed/);
    expect(() => openSignedPack(good, pub, 4)).toThrow(/out of date/);
    expect(() => openSignedPack(sign({ version: 1, rules: [{ host: "BAD HOST" }] }), pub)).toThrow(/malformed/);
    expect(() => openSignedPack(sign({ version: 1, rules: [{ host: "a.example", username: 5 }] }), pub)).toThrow(/malformed/);
  });

  it("selectors for a clicked element prefer stable ids and names", () => {
    set(`<form><input id="stable"><input id="input-12345" name="login"><input id="x12345"></form>`);
    const [a, c, d] = [...document.querySelectorAll("input")];
    expect(selectorFor(a)).toBe("#stable");
    expect(selectorFor(c)).toBe('input[name="login"]');
    expect(document.querySelector(selectorFor(d))).toBe(d);
  });

  it("a form report has structure and never a value", () => {
    set(`<form><input name="user" value="ana-private"><input type="password" value="hunter2"><button>Log in</button></form>`);
    const report = describeForm(document, "a.example");
    expect(report).toContain('"name": "user"');
    expect(report).toContain('"has_value": true');
    expect(report).not.toContain("ana-private");
    expect(report).not.toContain("hunter2");
  });
});

describe("generated passwords and save offers", () => {
  const at = { kind: "signup" as const, host: "site.test", url: "https://site.test/join", at: 1 };

  it("a sign-up with the password we generated finishes that item, even on a never site", () => {
    const offer = decideOffer({ ...at, username: "ana@site.test", newPassword: "made-here" }, [{ id: "a", password: "made-here", unconfirmed: true }], ["site.test"]);
    expect(offer).toMatchObject({ kind: "save", itemId: "a", username: "ana@site.test", generated: "signup" });
  });

  it("a different password on the same site is a separate login, and respects never", () => {
    const known = [{ id: "a", password: "made-here", unconfirmed: true }];
    expect(decideOffer({ ...at, username: "ana@site.test", newPassword: "typed" }, known, [])?.generated).toBeUndefined();
    expect(decideOffer({ ...at, username: "ana@site.test", newPassword: "typed" }, known, ["site.test"])).toBeNull();
  });

  it("a settled login with the same password isn't a sign-up", () => {
    expect(decideOffer({ ...at, username: "ana", password: "same" }, [{ id: "a", username: "ana", password: "same" }], [])).toBeNull();
  });

  it("a change with the waiting password commits it, keeping the saved username", () => {
    const offer = decideOffer({ ...at, kind: "change-password", password: "old", newPassword: "new" }, [{ id: "a", username: "ana", password: "old", pendingPassword: "new" }], []);
    expect(offer).toMatchObject({ kind: "update", itemId: "a", username: "ana", generated: "change" });
  });

  it("a change to some other password isn't that commit", () => {
    const offer = decideOffer({ ...at, kind: "change-password", username: "ana", newPassword: "other" }, [{ id: "a", username: "ana", password: "old", pendingPassword: "new" }], []);
    expect(offer?.generated).toBeUndefined();
    expect(offer?.kind).toBe("update");
  });

  it("what a page's requests say", () => {
    expect(requestVerdict(200)).toBe("ok");
    expect(requestVerdict(302)).toBe("ok");
    expect(requestVerdict(401)).toBe("failed");
    expect(requestVerdict(422)).toBe("failed");
    expect(requestVerdict(0)).toBe("unknown");
    expect(requestVerdict(500)).toBe("unknown");
    expect(requestVerdict(404)).toBe("unknown");
  });

  it("looksFailed needs only the kind of form that was submitted", () => {
    set(`<form><input name="user"><input type="password" name="pw"><button>Log in</button></form>`);
    expect(looksFailed(document, { kind: "signin" }, DOM)).toBe(true);
    expect(looksFailed(document, { kind: "signup" }, DOM)).toBe(false);
  });
});

describe("flows across pages", () => {
  const same = (a: string, b: string) => a === b;
  const flow = { itemId: "a", host: "site.test", filled: ["username"], at: 1000 };

  it("a different pick replaces the flow, and never restores the earlier item", () => {
    expect(afterFill(flow, "b", "site.test", ["password"], same, 2000)).toEqual({ itemId: "b", host: "site.test", filled: ["password"], at: 2000 });
  });

  it("the same item adds to what's filled", () => {
    expect(afterFill(flow, "a", "site.test", ["password"], same, 2000).filled).toEqual(["username", "password"]);
  });

  it("another site, or too much time, starts again", () => {
    expect(afterFill(flow, "a", "other.test", ["password"], same, 2000).filled).toEqual(["password"]);
    expect(afterFill(flow, "a", "site.test", ["password"], same, 1000 + 6 * 60_000).filled).toEqual(["password"]);
  });

  const page = (code: boolean, pw: boolean) => ({ hasCodeField: code, hasPasswordField: pw });

  it("the 2FA code waits for the password, and for the page to move on", () => {
    expect(codeStep(flow, true, page(false, false)), "email step only").toBe("none");
    const past = { ...flow, filled: ["username", "password"] };
    expect(codeStep(past, true, page(false, true)), "still on the form").toBe("wait");
    expect(codeStep(past, true, page(true, false)), "a box for it").toBe("wait");
    expect(codeStep(past, true, page(false, false)), "next page, no box").toBe("copy");
  });

  it("the 2FA code is copied once, and not when it was filled or there isn't one", () => {
    const past = { ...flow, filled: ["username", "password"] };
    expect(codeStep({ ...past, otpDone: true }, true, page(false, false))).toBe("none");
    expect(codeStep({ ...past, filled: ["password", "otp"] }, true, page(false, false))).toBe("none");
    expect(codeStep(past, false, page(false, false))).toBe("none");
    expect(codeStep(null, true, page(false, false))).toBe("none");
  });
});

describe("fill on load (plan 6.6)", () => {
  const signin = { url: "https://site.test/login", frameId: 0, kinds: ["signin"] };
  const ok = { kind: "host", optedIn: true, reprompt: false, downgrade: false };

  it("exact host, top frame, https, opted in", () => {
    expect(mayFillOnLoad(signin, [ok])).toBe(true);
    expect(mayFillOnLoad(signin, [{ ...ok, kind: "exact" }])).toBe(true);
  });

  it("never for a looser match", () => {
    for (const kind of ["base", "shared", "regex", "prefix"]) expect(mayFillOnLoad(signin, [{ ...ok, kind }]), kind).toBe(false);
  });

  it("never in a frame, over http, without a sign-in form, or for a page that isn't a URL", () => {
    expect(mayFillOnLoad({ ...signin, frameId: 4 }, [ok])).toBe(false);
    expect(mayFillOnLoad({ ...signin, url: "http://site.test/login" }, [ok])).toBe(false);
    expect(mayFillOnLoad({ ...signin, kinds: ["signup"] }, [ok])).toBe(false);
    expect(mayFillOnLoad({ ...signin, url: "nonsense" }, [ok])).toBe(false);
  });

  it("only if opted in, with no reprompt, no downgrade, and only one match", () => {
    expect(mayFillOnLoad(signin, [{ ...ok, optedIn: false }])).toBe(false);
    expect(mayFillOnLoad(signin, [{ ...ok, reprompt: true }])).toBe(false);
    expect(mayFillOnLoad(signin, [{ ...ok, downgrade: true }])).toBe(false);
    expect(mayFillOnLoad(signin, [ok, ok])).toBe(false);
    expect(mayFillOnLoad(signin, [])).toBe(false);
  });

  it("plain http only where the caller allows, and hostile look-alikes of localhost don't pass", () => {
    const local = (u: URL) => u.hostname === "localhost" || u.hostname.endsWith(".localhost");
    expect(mayFillOnLoad({ ...signin, url: "http://localhost:8111/login" }, [ok], local)).toBe(true);
    expect(mayFillOnLoad({ ...signin, url: "http://localhost.evil.test/login" }, [ok], local)).toBe(false);
    expect(mayFillOnLoad({ ...signin, url: "http://localhost@evil.test/login" }, [ok], local)).toBe(false);
  });
});

describe("IntersectionObserver v2 as an extra check", () => {
  const box = () => {
    set(`<div id="m"></div>`);
    return document.getElementById("m")!;
  };
  const state = { shownAt: 0, rect: { left: 0, top: 0, width: 0, height: 0 } };

  it("has no effect where the browser doesn't have it", () => {
    expect(visibilityV2(false, undefined)).toBeUndefined();
    expect(visibilityV2(false, false)).toBeUndefined();
  });

  it("where it does, no reading yet counts as not visible", () => {
    expect(visibilityV2(true, undefined)).toBe(false);
    expect(visibilityV2(true, false)).toBe(false);
    expect(visibilityV2(true, true)).toBe(true);
  });

  it("not visible stops a click that every other check would pass", () => {
    expect(checkAtClick(box(), state, { now: 1000, isTrusted: true, visibleV2: false })).toEqual({ ok: false, reason: "not-visible" });
  });

  it("the dwell still comes first", () => {
    expect(checkAtClick(box(), state, { now: 10, isTrusted: true, visibleV2: false })).toEqual({ ok: false, reason: "too-fast" });
  });
});

describe("rules pack contents", () => {
  const seed = new Uint8Array(32).fill(7);
  const pub = ed25519Public(seed);
  const sign = (pack: unknown) => {
    const bytes = utf8(JSON.stringify(pack));
    return { pack: b64u(bytes), signature: b64u(ed25519Sign(seed, signingInput("rules_pack", [bytes]))) };
  };

  it("takes the known fields, and refuses anything else", () => {
    expect(openSignedPack(sign({ version: 1, rules: [{ host: "a.example", username: "#u", password: "#p", submit: "#s", otp: "#o", never: false }] }), pub).rules).toHaveLength(1);
    for (const extra of [{ script: "alert(1)" }, { eval: "x" }, { onload: "y" }, { __proto__x: 1 }]) {
      expect(() => openSignedPack(sign({ version: 1, rules: [{ host: "a.example", ...extra }] }), pub), JSON.stringify(extra)).toThrow(/malformed/);
    }
  });

  it("sign-pack.mjs signs what openSignedPack checks, with a key from a file", async () => {
    const { execFileSync } = await import("node:child_process");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-sign-pack-"));
    const script = path.resolve(process.cwd(), "../passwords/extension/rules/sign-pack.mjs");
    const key = path.join(dir, "key.jwk.json");
    const made = execFileSync(process.execPath, [script, "--new-key", key], { encoding: "utf8" });
    const publicKey = made.trim().split(/\r?\n/).at(-1)!;
    const packFile = path.join(dir, "pack.json");
    const sigFile = path.join(dir, "pack.sig");
    fs.writeFileSync(packFile, JSON.stringify({ version: 3, rules: [{ host: "a.example", username: "#u" }] }));
    execFileSync(process.execPath, [script, "--key", key, "--in", packFile, "--out", sigFile], { encoding: "utf8" });
    const signed = { pack: b64u(new Uint8Array(fs.readFileSync(packFile))), signature: fs.readFileSync(sigFile, "utf8") };
    expect(openSignedPack(signed, fromB64u(publicKey)).version).toBe(3);
    // Not with another key, and it won't overwrite a key that exists.
    expect(() => openSignedPack(signed, pub)).toThrow(/signed/);
    expect(() => execFileSync(process.execPath, [script, "--new-key", key], { encoding: "utf8", stdio: "pipe" })).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the pack in the repo is signed by the key that's pinned for it", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.resolve(process.cwd(), "../passwords/extension");
    const keySource = fs.readFileSync(path.join(dir, "src/rules-key.ts"), "utf8");
    // The owner's key once there is one, and until then the test key on an empty pack.
    const release = /RELEASE_PUBLIC_KEY: string \| null = "([^"]+)"/.exec(keySource)?.[1];
    const key = release ?? /__TEST_BUILD__ \? "([^"]+)"/.exec(keySource)![1];
    const signed = { pack: b64u(new Uint8Array(fs.readFileSync(path.join(dir, "rules/pack.json")))), signature: fs.readFileSync(path.join(dir, "rules/pack.sig"), "utf8").trim() };
    const pack = openSignedPack(signed, fromB64u(key));
    if (!release) expect(pack.rules).toEqual([]);
  });
});
