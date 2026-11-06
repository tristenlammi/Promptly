// @vitest-environment jsdom
// Unit tests for the pieces that don't need layout. The real corpus runs in browsers.
import { describe, expect, it, beforeEach } from "vitest";

import { b64u, utf8 } from "../bytes";
import { signingInput } from "../format";
import { ed25519Public, ed25519Sign } from "../primitives";
import { analyzePage, tokens } from "./classify";
import { capture, decideOffer, looksFailed } from "./capture";
import { fillField, fillFields, fillSplit } from "./fill";
import { advance, flowFor, nextFor } from "./flow";
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
