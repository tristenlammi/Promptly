import { describe, expect, it } from "vitest";

import {
  dupePrefsBody,
  DUPES_PREFS,
  type DupePrefs,
  findDuplicateGroups,
  fingerprint,
  liveDecisions,
  mergeDuplicates,
  normalizeUsername,
  prunePairs,
  readDupePrefs,
  sameSite,
  withNotDuplicate,
  withoutNotDuplicate,
} from "./duplicates";
import { decryptItem, encryptItem } from "./keys";
import { type Item, type ItemBody, newBody, type UrlMatch } from "./model";
import { aesKey } from "./primitives";

let n = 0;
function login(username: string | undefined, password: string | undefined, url: string | string[], over: Partial<ItemBody> & { vaultId?: string; at?: string } = {}): Item {
  const { vaultId = "v1", at, ...rest } = over;
  const urls = (Array.isArray(url) ? url : [url]).map((u) => ({ url: u }));
  const b = newBody("login", rest.title ?? `Login ${++n}`, { username, password, urls, ...rest });
  if (at) b.updatedAt = at;
  return { id: crypto.randomUUID(), vaultId, revision: 1, deleted: false, updatedAt: b.updatedAt, body: b };
}

const ids = (items: Item[]) => items.map((i) => i.id).sort();

describe("finding duplicates", () => {
  it("finds the same login saved twice", () => {
    const a = login("ana", "one", "https://www.example.com/login");
    const b = login("ana", "two", "https://www.example.com/");
    const [g, ...rest] = findDuplicateGroups([a, b]);
    expect(rest).toEqual([]);
    expect(g.kind).toBe("sure");
    expect(g.reason).toBe("username");
    expect(g.site).toBe("example.com");
    expect(ids(g.items)).toEqual(ids([a, b]));
  });

  it("ignores case and spaces in a username, and nothing else", () => {
    expect(normalizeUsername("  Ana@Example.COM ")).toBe("ana@example.com");
    expect(normalizeUsername("Ana  Lee")).toBe(normalizeUsername("ana lee"));
    const a = login("Tristen.Lammi@gmail.com ", "x1", "https://www.kickstarter.com/");
    const b = login("tristen.lammi@gmail.com", "x2", "https://kickstarter.com/");
    expect(findDuplicateGroups([a, b]).map((g) => g.kind)).toEqual(["sure"]);
    // A dot is part of the name: these are different usernames with different passwords.
    const c = login("tristen.lammi", "p1", "https://www.instagram.com/");
    const d = login("tristenlammi", "p2", "https://www.instagram.com/");
    expect(findDuplicateGroups([c, d])).toEqual([]);
  });

  it("suggests the same password under different usernames, never as sure", () => {
    const a = login("tristen.lammi@gmail.com", "Same-pw-1!", "https://www.kickstarter.com/");
    const b = login("tristenlammi", "Same-pw-1!", "https://www.kickstarter.com/");
    const [g] = findDuplicateGroups([a, b]);
    expect(g.kind).toBe("likely");
    expect(g.reason).toBe("password");
    expect(g.site).toBe("kickstarter.com");
  });

  it("different usernames and different passwords on one site are two accounts", () => {
    const a = login("streamer1", "pw-a", "https://www.twitch.tv/");
    const b = login("streamer2", "pw-b", "https://www.twitch.tv/");
    expect(findDuplicateGroups([a, b])).toEqual([]);
  });

  it("blank usernames: the same password is suggested, a different one isn't", () => {
    const a = login(undefined, "pin-1234", "https://router.example.net/");
    const b = login("", "pin-1234", "https://router.example.net/admin");
    const c = login("admin", "pin-1234", "https://router.example.net/");
    const groups = findDuplicateGroups([a, b, c]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("likely");
    expect(groups[0].reason).toBe("password-no-username");
    expect(ids(groups[0].items)).toEqual(ids([a, b, c]));

    const d = login(undefined, "one", "https://nas.example.org/");
    const e = login(undefined, "two", "https://nas.example.org/");
    expect(findDuplicateGroups([d, e])).toEqual([]);
    // No password at all isn't "the same password".
    expect(findDuplicateGroups([login(undefined, undefined, "https://x.example/"), login(undefined, undefined, "https://x.example/")])).toEqual([]);
  });

  it("doesn't match different sites, other vaults, or logins with no website", () => {
    const a = login("ana", "same", "https://example.com/");
    const b = login("ana", "same", "https://other.example/");
    const c = login("ana", "same", "https://example.com/", { vaultId: "v2" });
    const d = login("ana", "same", []);
    const e = login("ana", "same", "android://com.example.app");
    expect(findDuplicateGroups([a, b, c, d, e])).toEqual([]);
  });

  it("follows the vault's site rules for www, subdomains and sign-in hosts", () => {
    // www. is the same host; a sign-in host signs in for the whole domain.
    expect(sameSite(login("a", "1", "https://www.example.com/"), login("a", "1", "https://example.com/"))).toBe(true);
    expect(sameSite(login("a", "1", "https://www.example.com/"), login("a", "1", "https://login.example.com/"))).toBe(true);
    expect(sameSite(login("a", "1", "https://example.com/"), login("a", "1", "https://shop.example.com/"))).toBe(true);
    // Two services on one domain stay apart (D89), unless a login says Same domain.
    const zyx = login("me", "pw", "https://zyx.gymserver.org/");
    const abc = login("me", "pw", "https://abc.gymserver.org/");
    expect(sameSite(zyx, abc)).toBe(false);
    expect(findDuplicateGroups([zyx, abc])).toEqual([]);
    const wide = login("me", "pw", "https://abc.gymserver.org/", { match: "base" as UrlMatch });
    expect(sameSite(zyx, wide)).toBe(true);
    // Exact host means just that host.
    expect(sameSite(login("a", "1", "https://www.example.com/", { match: "host" }), login("a", "1", "https://login.example.com/", { match: "host" }))).toBe(false);
    // Private suffixes and IP addresses are separate sites (D94).
    expect(sameSite(login("a", "1", "https://a.duckdns.org/"), login("a", "1", "https://b.duckdns.org/"))).toBe(false);
    expect(sameSite(login("a", "1", "http://192.168.1.10/"), login("a", "1", "http://192.168.1.11/"))).toBe(false);
    expect(sameSite(login("a", "1", "http://192.168.1.10:8443/"), login("a", "1", "http://192.168.1.10/"))).toBe(true);
    // Sites that share sign-ins count as one.
    expect(sameSite(login("a", "1", "https://themeforest.net/"), login("a", "1", "https://envato.com/"))).toBe(true);
    // Never offered on a website is still that website's login.
    expect(sameSite(login("a", "1", "https://example.com/", { match: "never" }), login("a", "1", "https://example.com/"))).toBe(true);
  });

  it("skips deleted items and other kinds", () => {
    const a = login("ana", "pw", "https://example.com/");
    const b = { ...login("ana", "pw", "https://example.com/"), deleted: true };
    const note = { ...login("ana", "pw", "https://example.com/"), body: { ...newBody("note", "x"), urls: [{ url: "https://example.com/" }], username: "ana" } };
    expect(findDuplicateGroups([a, b, note])).toEqual([]);
  });

  it("puts the newest first, and joins chains into one group", () => {
    const a = login("ana", "1", "https://example.com/", { at: "2024-01-01T00:00:00.000Z" });
    const b = login("ANA", "2", ["https://example.com/", "https://app.other.example/"], { at: "2026-01-01T00:00:00.000Z" });
    const c = login("ana", "3", "https://app.other.example/", { at: "2025-01-01T00:00:00.000Z" });
    const [g] = findDuplicateGroups([a, b, c]);
    expect(g.items.map((i) => i.id)).toEqual([b.id, c.id, a.id]);
  });
});

describe("not a duplicate", () => {
  const pair = () => [login("tristen.lammi", "Same-1!", "https://www.instagram.com/"), login("tristenlammi", "Same-1!", "https://instagram.com/")];

  it("hides a group, and only that group", () => {
    const [a, b] = pair();
    const other = [login("bo", "x", "https://example.com/"), login("bo", "y", "https://example.com/")];
    const prefs = withNotDuplicate({ pairs: [] }, [a, b]);
    const groups = findDuplicateGroups([a, b, ...other], prefs);
    expect(groups).toHaveLength(1);
    expect(ids(groups[0].items)).toEqual(ids(other));
    expect(findDuplicateGroups([a, b], withoutNotDuplicate(prefs, [a.id, b.id]))).toHaveLength(1);
  });

  it("comes back when a site, username or password changes", () => {
    const [a, b] = pair();
    const prefs = withNotDuplicate({ pairs: [] }, [a, b]);
    const change = (i: Item, body: Partial<ItemBody>): Item => ({ ...i, body: { ...i.body, ...body } });
    // Notes, a title or a newer date don't count as a change.
    expect(findDuplicateGroups([change(a, { notes: "hi", title: "Insta", updatedAt: new Date().toISOString() }), b], prefs)).toEqual([]);
    expect(findDuplicateGroups([change(a, { password: "New-2!" }), change(b, { password: "New-2!" })], prefs)).toHaveLength(1);
    expect(findDuplicateGroups([change(a, { urls: [{ url: "https://www.instagram.com/" }, { url: "https://www.threads.net/" }] }), b], prefs)).toHaveLength(1);
    expect(findDuplicateGroups([change(a, { username: "someone.else" }), b], prefs)).toHaveLength(1);
    // A lapsed decision is tidied away; one for a login in Trash is kept.
    const changed = change(a, { password: "Other-3!" });
    expect(prunePairs(prefs, new Map([[a.id, changed], [b.id, b]])).pairs).toEqual([]);
    expect(liveDecisions(prefs, new Map([[a.id, { ...a, deleted: true }], [b.id, b]]))).toBe(1);
    expect(prunePairs(prefs, new Map([[b.id, b]])).pairs).toEqual([]);
  });

  it("a new login joining the group brings it back, without the pair already decided", () => {
    const [a, b] = pair();
    const c = login("tl", "Same-1!", "https://www.instagram.com/");
    const prefs = withNotDuplicate({ pairs: [] }, [a, b]);
    const [g] = findDuplicateGroups([a, b, c], prefs);
    expect(ids(g.items)).toEqual(ids([a, b, c]));
  });

  it("is kept encrypted in the personal vault, with no password, username or site in it", async () => {
    const [a, b] = pair();
    const prefs = withNotDuplicate({ pairs: [] }, [a, b]);
    const body = dupePrefsBody(newBody("prefs", DUPES_PREFS, { prefs: { future: 1 } }), prefs);
    expect(body.kind).toBe("prefs");
    expect(body.prefs).toMatchObject({ future: 1 });
    const plain = JSON.stringify(body);
    for (const secret of ["Same-1!", "tristen.lammi", "tristenlammi", "instagram"]) expect(plain).not.toContain(secret);
    // Salted per pair and per login: the same password doesn't give the same fingerprint.
    expect(prefs.pairs[0].fps[0]).not.toBe(prefs.pairs[0].fps[1]);
    expect(fingerprint(a, "s1")).not.toBe(fingerprint(a, "s2"));

    // Sealed like any other item, and read back the same way.
    const key = await aesKey(new Uint8Array(32).fill(9));
    const blob = await encryptItem(key, "personal", "prefs-1", body);
    const raw = new TextDecoder("latin1").decode(blob);
    expect(raw).not.toContain(a.id);
    expect(raw).not.toContain("notDuplicates");
    const back = await decryptItem<ItemBody>(key, "personal", "prefs-1", blob);
    const stored: Item = { id: "prefs-1", vaultId: "personal", revision: 1, deleted: false, updatedAt: back.updatedAt, body: back };
    const { item, prefs: read } = readDupePrefs([stored, a, b], "personal");
    expect(item?.id).toBe("prefs-1");
    expect(findDuplicateGroups([a, b], read)).toEqual([]);
  });

  it("only reads decisions from your own vault, and reads every copy and conflict there", () => {
    const [a, b] = pair();
    const prefs: DupePrefs = withNotDuplicate({ pairs: [] }, [a, b]);
    const planted: Item = { id: "p0", vaultId: "shared", revision: 1, deleted: false, updatedAt: "", body: dupePrefsBody(null, prefs) };
    expect(readDupePrefs([planted], "personal").prefs.pairs).toEqual([]);
    const other = [login("bo", "x", "https://example.com/"), login("bo", "y", "https://example.com/")];
    const p2 = withNotDuplicate({ pairs: [] }, other);
    const mine: Item = { id: "p1", vaultId: "personal", revision: 1, deleted: false, updatedAt: "", body: { ...dupePrefsBody(null, { pairs: [] }), conflicts: [{ at: "", body: dupePrefsBody(null, prefs) as unknown as Record<string, unknown> }] } };
    const second: Item = { id: "p2", vaultId: "personal", revision: 1, deleted: false, updatedAt: "", body: dupePrefsBody(null, p2) };
    const read = readDupePrefs([second, mine], "personal");
    expect(read.item?.id).toBe("p1");
    expect(findDuplicateGroups([a, b, ...other], read.prefs)).toEqual([]);
    // Junk is ignored, not trusted.
    const junk: Item = { id: "p3", vaultId: "personal", revision: 1, deleted: false, updatedAt: "", body: { ...newBody("prefs", DUPES_PREFS), prefs: { notDuplicates: [{ ids: ["x"] }, null, "y"] } } };
    expect(readDupePrefs([junk], "personal").prefs.pairs).toEqual([]);
  });
});

describe("merging a chosen one", () => {
  it("keeps the one picked, and keeps the other username and 2FA secret", () => {
    const old = login("tristen.lammi@gmail.com", "Same-1!", "https://www.kickstarter.com/", { at: "2024-01-01T00:00:00.000Z", totp: { secret: "AAAA" }, tags: ["fun"] });
    const fresh = login("tristenlammi", "Same-1!", "https://kickstarter.com/", { at: "2026-01-01T00:00:00.000Z", totp: { secret: "BBBB" }, favorite: true });
    const { keep, body, drop } = mergeDuplicates([old, fresh], old.id);
    expect(keep.id).toBe(old.id);
    expect(drop.map((d) => d.id)).toEqual([fresh.id]);
    expect(body.username).toBe("tristen.lammi@gmail.com");
    expect(body.fields).toEqual(expect.arrayContaining([{ name: "Other username", value: "tristenlammi", type: "text" }, { name: "Other 2FA secret", value: "BBBB", type: "hidden" }]));
    expect(body.totp?.secret).toBe("AAAA");
    expect(body.tags).toEqual(["fun"]);
    expect(body.favorite).toBe(true);
    expect(body.urls?.map((u) => u.url)).toEqual(["https://www.kickstarter.com/", "https://kickstarter.com/"]);
    // The same password isn't put in history twice.
    expect(body.passwordHistory ?? []).toEqual([]);
  });

  it("fills a blank username from a copy, and the default is still the newest", () => {
    const blank = login(undefined, "pw", "https://router.example.net/", { at: "2026-01-01T00:00:00.000Z" });
    const named = login("admin", "pw", "https://router.example.net/", { at: "2024-01-01T00:00:00.000Z" });
    const { keep, body } = mergeDuplicates([named, blank]);
    expect(keep.id).toBe(blank.id);
    expect(body.username).toBe("admin");
    expect(body.fields ?? []).toEqual([]);
  });
});
