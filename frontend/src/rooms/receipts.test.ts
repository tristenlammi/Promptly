import { describe, expect, it } from "vitest";

import { isMuted, muteChoices, receiptMarks } from "./receipts";

const me = "me";
const msg = (seq: number, author: string, kind = "user") => ({ id: `m${seq}`, seq, author_id: author, kind });

describe("receiptMarks", () => {
  it("says Sent, then Delivered, then Seen under your latest message", () => {
    const ms = [msg(1, "bob"), msg(2, me), msg(3, me)];
    expect(receiptMarks(ms, { bob: { read: 1, delivered: 1 } }, me)).toEqual({ m3: { seenBy: [], state: "sent" } });
    expect(receiptMarks(ms, { bob: { read: 1, delivered: 3 } }, me)).toEqual({ m3: { seenBy: [], state: "delivered" } });
    expect(receiptMarks(ms, { bob: { read: 3, delivered: 3 } }, me)).toEqual({ m3: { seenBy: ["bob"] } });
  });

  it("puts each person's picture under the last of your messages they've read", () => {
    const ms = [msg(1, me), msg(2, me), msg(3, me)];
    const got = receiptMarks(ms, { bob: { read: 2, delivered: 3 }, cat: { read: 3, delivered: 3 } }, me);
    expect(got).toEqual({ m2: { seenBy: ["bob"] }, m3: { seenBy: ["cat"] } });
  });

  it("shows the word on the latest while someone is still behind", () => {
    const ms = [msg(1, me), msg(2, me)];
    const got = receiptMarks(ms, { bob: { read: 1, delivered: 2 } }, me);
    expect(got).toEqual({ m1: { seenBy: ["bob"] }, m2: { seenBy: [], state: "delivered" } });
  });

  it("says nothing once they've answered", () => {
    const ms = [msg(1, me), msg(2, "bob")];
    expect(receiptMarks(ms, { bob: { read: 2, delivered: 2 } }, me)).toEqual({});
    // Their own message isn't one of yours: no picture under it.
    expect(receiptMarks([msg(1, "bob")], { bob: { read: 1, delivered: 1 } }, me)).toEqual({});
  });

  it("ignores system lines and rooms without receipts", () => {
    const ms = [msg(1, me), msg(2, me, "system")];
    expect(receiptMarks(ms, { bob: { read: 0, delivered: 0 } }, me)).toEqual({ m1: { seenBy: [], state: "sent" } });
    expect(receiptMarks(ms, undefined, me)).toEqual({});
    expect(receiptMarks([], { bob: { read: 0, delivered: 0 } }, me)).toEqual({});
  });
});

describe("muting for a while", () => {
  it("is over once the time has passed", () => {
    const now = Date.parse("2026-11-15T10:00:00Z");
    expect(isMuted("2026-11-15T11:00:00Z", now)).toBe(true);
    expect(isMuted("2026-11-15T09:59:00Z", now)).toBe(false);
    expect(isMuted(null, now)).toBe(false);
    expect(isMuted("nonsense", now)).toBe(false);
  });

  it("offers an hour, eight hours and tomorrow morning", () => {
    const now = new Date(2026, 10, 15, 22, 30);
    const [h1, h8, tom] = muteChoices(now);
    expect(new Date(h1.until).getTime() - now.getTime()).toBe(3600_000);
    expect(new Date(h8.until).getTime() - now.getTime()).toBe(8 * 3600_000);
    const t = new Date(tom.until);
    expect([t.getDate(), t.getHours(), t.getMinutes()]).toEqual([16, 8, 0]);
  });
});
