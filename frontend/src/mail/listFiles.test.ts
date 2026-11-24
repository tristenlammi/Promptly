import { describe, expect, it } from "vitest";

import type { ListFile } from "./api";
import { addressWith, chipsFor, CHIPS_FULL, CHIPS_SPLIT, fileKind, layoutInUse, nameParts, openInAddress, sameEmail } from "./listFiles";

const file = (name: string, part = 1, message_id = "m1"): ListFile => ({ message_id, part, name, mime: "application/octet-stream", size: 10 });

describe("nameParts", () => {
  it("keeps the end of a name, so a cut in the middle still shows the kind of file", () => {
    expect(nameParts("Quarterly report final.pdf")).toEqual(["Quarterly report fin", "al.pdf"]);
    expect(nameParts("Quarterly report final.pdf").join("")).toBe("Quarterly report final.pdf");
  });
  it("leaves a short name whole", () => {
    expect(nameParts("a.pdf")).toEqual(["a", ".pdf"]);
    expect(nameParts("scan.jpeg")).toEqual(["scan", ".jpeg"]);
  });
  it("only takes the last extension", () => {
    expect(nameParts("backup.tar.gz")).toEqual(["backup.t", "ar.gz"]);
  });
  it("doesn't mistake a full stop in a sentence for an extension", () => {
    expect(nameParts("Notes from Mr. Lee and the others")).toEqual(["Notes from Mr. Lee and the othe", "rs"]);
    expect(nameParts("README")).toEqual(["READ", "ME"]);
    expect(nameParts(".gitignore")).toEqual([".gitigno", "re"]);
  });
  it("gives a nameless file a name", () => {
    expect(nameParts("  ").join("")).toBe("attachment");
  });
});

describe("fileKind", () => {
  it("goes by the name first, then by what the sender said it is", () => {
    expect(fileKind("Invoice.PDF", "application/octet-stream")).toBe("pdf");
    expect(fileKind("holiday.heic", "")).toBe("picture");
    expect(fileKind("budget.xlsx", "")).toBe("sheet");
    expect(fileKind("noname", "image/png")).toBe("picture");
    expect(fileKind("noname", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("doc");
    expect(fileKind("mystery.bin", "application/octet-stream")).toBe("file");
  });
});

describe("chipsFor", () => {
  const five = [1, 2, 3, 4, 5].map((n) => file(`f${n}.pdf`, n));
  it("shows what fits, then counts the rest", () => {
    expect(chipsFor(five, 5, CHIPS_SPLIT)).toEqual({ shown: five.slice(0, 2), more: 3 });
    expect(chipsFor(five, 5, CHIPS_FULL)).toEqual({ shown: five.slice(0, 3), more: 2 });
  });
  it("counts the ones the list wasn't sent", () => {
    expect(chipsFor(five, 9, CHIPS_FULL).more).toBe(6);
  });
  it("has no +N when they all fit", () => {
    expect(chipsFor(five.slice(0, 2), 2, CHIPS_SPLIT)).toEqual({ shown: five.slice(0, 2), more: 0 });
    expect(chipsFor(five.slice(0, 1), 1, CHIPS_FULL).more).toBe(0);
  });
  it("is empty for an email with nothing attached, or an older server", () => {
    expect(chipsFor([], 0, CHIPS_FULL)).toEqual({ shown: [], more: 0 });
    expect(chipsFor(undefined, undefined, CHIPS_FULL)).toEqual({ shown: [], more: 0 });
  });
});

describe("sameEmail", () => {
  it("opens the viewer on that file, with the same email's others beside it", () => {
    const files = [file("a.pdf", 1, "new"), file("b.pdf", 2, "old"), file("c.pdf", 3, "old")];
    expect(sameEmail(files, files[2])).toEqual({ files: [files[1], files[2]], start: 1 });
    expect(sameEmail(files, files[0])).toEqual({ files: [files[0]], start: 0 });
  });
});

describe("layoutInUse", () => {
  it("is split unless you chose the full list", () => {
    expect(layoutInUse(undefined, false)).toBe("split");
    expect(layoutInUse("split", false)).toBe("split");
    expect(layoutInUse("full", false)).toBe("full");
  });
  it("never changes a phone", () => {
    expect(layoutInUse("full", true)).toBe("split");
  });
});

describe("the open email in the address", () => {
  const open = { account_id: "11111111-1111-4111-8111-111111111111", key: "abc_DEF-1" };
  it("round-trips", () => {
    expect(addressWith("", open)).toBe("?open=11111111-1111-4111-8111-111111111111/abc_DEF-1");
    expect(openInAddress(addressWith("", open))).toEqual(open);
  });
  it("keeps whatever else is in the address", () => {
    expect(addressWith("?x=1", open)).toBe("?x=1&open=11111111-1111-4111-8111-111111111111/abc_DEF-1");
    expect(addressWith("?x=1&open=11111111-1111-4111-8111-111111111111/abc", null)).toBe("?x=1");
    expect(addressWith("?open=11111111-1111-4111-8111-111111111111/abc", null)).toBe("");
  });
  it("ignores anything that isn't one of ours", () => {
    expect(openInAddress("?open=javascript:alert(1)")).toBeNull();
    expect(openInAddress("?open=../../etc")).toBeNull();
    expect(openInAddress("")).toBeNull();
  });
});
