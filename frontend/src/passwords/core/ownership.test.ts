import { describe, expect, it } from "vitest";

import { fromHex } from "./bytes";
import { homeInput, isNamed, mergeCounters, named, nameContact, removeContact, signHome, verifyHome, withListed } from "./ownership";
import { ed25519Public } from "./primitives";
import V from "./vectors.json";

describe("your own vault, signed", () => {
  const seed = fromHex("505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f");
  const pub = ed25519Public(seed);
  const me = "44444444-4444-4444-8444-444444444444";
  const vault = "22222222-2222-4222-8222-222222222222";

  it("matches the vector", () => {
    const c = V.signature.find((x) => x.purpose === "personal_vault")!;
    expect(Buffer.from(homeInput(me, vault)).toString("hex")).toBe(c.input_hex);
    expect(verifyHome(Buffer.from(fromHex(c.sig_hex)).toString("base64url"), me, vault, pub)).toBe(true);
  });

  it("can't be moved to another vault, or claimed for another person, or made by anyone else", () => {
    const sig = signHome(seed, me, vault);
    expect(verifyHome(sig, me, vault, pub)).toBe(true);
    expect(verifyHome(sig, me, "33333333-3333-4333-8333-333333333333", pub)).toBe(false);
    expect(verifyHome(sig, "55555555-5555-4555-8555-555555555555", vault, pub)).toBe(false);
    expect(verifyHome(signHome(fromHex("01".repeat(32)), me, vault), me, vault, pub)).toBe(false);
    expect(verifyHome(undefined, me, vault, pub)).toBe(false);
    expect(verifyHome("not base64!", me, vault, pub)).toBe(false);
  });
});

describe("emergency contacts by counter", () => {
  it("a removal beats an older list or counter on another device", () => {
    const a: Record<string, number> = {};
    nameContact(a, "carol");
    const b = { ...a };
    removeContact(a, "carol");
    expect(named(mergeCounters(a, b))).toEqual([]);
    // An old client's plain list doesn't bring her back either.
    expect(named(withListed(mergeCounters(a, b), ["carol"]))).toEqual([]);
    // Naming her again does.
    const c = mergeCounters(a, b);
    nameContact(c, "carol");
    expect(named(mergeCounters(a, b, c))).toEqual(["carol"]);
  });

  it("an old list entry counts as named until it's removed", () => {
    const s = withListed({}, ["dana"]);
    expect(isNamed(s, "dana")).toBe(true);
    removeContact(s, "dana");
    expect(isNamed(s, "dana")).toBe(false);
    // Removing someone never named still leaves a tombstone.
    const t: Record<string, number> = {};
    removeContact(t, "erin");
    expect(named(withListed(t, ["erin"]))).toEqual([]);
  });

  it("ignores junk", () => {
    expect(mergeCounters({ a: -3, b: Number.NaN, c: 2.7 } as Record<string, number>)).toEqual({ c: 2 });
  });
});
