// @vitest-environment jsdom
// KeePass, against a database written by pykeepass (an independent implementation),
// and KeePass XML, with hostile input.
import fs from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { fromKeepassXml, importFile, NeedsPasswordError } from "./importers";
import { fromKdbx, gunzipLimited } from "./kdbx";
import { gzipSync } from "fflate";

const fixture = new Uint8Array(fs.readFileSync(path.join(__dirname, "testing", "fixture.kdbx")));

describe("KDBX 4", () => {
  it("reads entries, groups, protected values and 2FA", async () => {
    const r = await fromKdbx(fixture, "kdbx test password");
    expect(r.format).toBe("KeePass");
    const byTitle = new Map(r.items.map((i) => [i.body.title, i]));
    const mail = byTitle.get("Mail")!;
    expect(mail.folder).toBe("Work");
    expect(mail.body).toMatchObject({ username: "ana@example.com", password: "changed-password-2", notes: "line one\nline two", urls: [{ url: "https://mail.example.com" }] });
    expect(mail.body.totp?.secret).toBe("JBSWY3DPEHPK3PXP");
    expect(mail.body.fields).toEqual([{ name: "Pin", value: "1234", type: "text" }]);
    expect(byTitle.get("Nested")).toMatchObject({ folder: "Work/Deep", body: { password: "nested-pass" } });
    expect(byTitle.get("Root Entry")?.body.password).toBe("root-pass");
    expect(r.items).toHaveLength(3);
  });

  it("wants a password, and refuses the wrong one", async () => {
    await expect(importFile("x.kdbx", fixture)).rejects.toBeInstanceOf(NeedsPasswordError);
    await expect(fromKdbx(fixture, "wrong")).rejects.toThrow(/didn't open/);
  });

  it("notices a damaged file", async () => {
    const bad = fixture.slice();
    bad[bad.length - 60] ^= 1;
    await expect(fromKdbx(bad, "kdbx test password")).rejects.toThrow();
    const header = fixture.slice();
    header[40] ^= 1;
    await expect(fromKdbx(header, "kdbx test password")).rejects.toThrow();
  });

  it("random corruption fails with an error", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 180 }), fc.integer({ min: 1, max: 255 }), async (at, mask) => {
        const bad = fixture.slice();
        bad[at] ^= mask;
        await expect(fromKdbx(bad, "kdbx test password")).rejects.toBeInstanceOf(Error);
      }),
      { numRuns: 15 },
    );
  });
});

describe("KeePass XML", () => {
  const xml = `<?xml version="1.0"?><KeePassFile><Root><Group><Name>Root</Name>
    <Entry><String><Key>Title</Key><Value>A</Value></String><String><Key>UserName</Key><Value>u</Value></String><String><Key>Password</Key><Value>p&amp;w</Value></String><String><Key>URL</Key><Value>https://a.example</Value></String><String><Key>Extra</Key><Value>e</Value></String><String><Key>TimeOtp-Secret-Base32</Key><Value>JBSWY3DPEHPK3PXP</Value></String></Entry>
    <Group><Name>Sub</Name><Entry><String><Key>Title</Key><Value>B</Value></String></Entry></Group>
  </Group></Root></KeePassFile>`;

  it("reads it", () => {
    const r = fromKeepassXml(xml);
    expect(r.items).toHaveLength(2);
    expect(r.items[0].body).toMatchObject({ title: "A", username: "u", password: "p&w", totp: { secret: "JBSWY3DPEHPK3PXP" } });
    expect(r.items[0].body.fields?.[0]).toMatchObject({ name: "Extra", value: "e" });
    expect(r.items[1].folder).toBe("Sub");
  });

  it("refuses XML with its own entities (billion laughs, file stealing)", () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><KeePassFile><Root><Group><Entry><String><Key>Title</Key><Value>&b;</Value></String></Entry></Group></Root></KeePassFile>`;
    expect(() => fromKeepassXml(evil)).toThrow(/entities/);
    const xxe = `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><KeePassFile/>`;
    expect(() => fromKeepassXml(xxe)).toThrow(/entities/);
  });

  it("refuses groups nested absurdly deep, and non-KeePass XML", () => {
    const deep = "<KeePassFile><Root>" + "<Group><Name>x</Name>".repeat(100) + "</Group>".repeat(100) + "</Root></KeePassFile>";
    expect(() => fromKeepassXml(deep)).toThrow(/deeply/);
    expect(() => fromKeepassXml("<html></html>")).toThrow();
    expect(() => fromKeepassXml("<<<not xml")).toThrow();
  });

  it("script in a value stays a string", () => {
    const r = fromKeepassXml(`<KeePassFile><Root><Group><Entry><String><Key>Title</Key><Value>&lt;script&gt;alert(1)&lt;/script&gt;</Value></String></Entry></Group></Root></KeePassFile>`);
    expect(r.items[0].body.title).toBe("<script>alert(1)</script>");
  });
});

describe("a file with more protected values than one run of the stream", () => {
  // Written by pykeepass, an independent KDBX writer: android/app/src/test/cross/make-kdbx-fixtures.py
  const large = new Uint8Array(fs.readFileSync(path.join(__dirname, "../../../../android/app/src/test/cross/import-fixtures/large.kdbx")));

  it("reads every password as it was written", async () => {
    const r = await fromKdbx(large, "kdbx test password");
    expect(r.items).toHaveLength(300);
    for (const item of r.items) {
      const n = item.body.title.replace("Entry ", "");
      expect(item.body.password, item.body.title).toBe(`bulk-test-password-${n}-with-some-length`);
    }
  }, 120_000);
});

describe("unpacking", () => {
  it("stops at the limit rather than filling memory", () => {
    const packed = gzipSync(new Uint8Array(4096));
    expect(gunzipLimited(packed).length).toBe(4096);
    expect(() => gunzipLimited(packed, 1024)).toThrow(/too large/);
  });
});
