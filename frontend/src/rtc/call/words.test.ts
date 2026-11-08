// DM call wording: each viewer's line in the conversation, how a call
// ended, lengths and the timer.
import { describe, expect, it } from "vitest";

import type { CallLineMeta } from "@/api/dmCalls";

import { callLineWords, clock, endedWords, historyWords, lengthWords } from "./words";

const ALICE = "aaaaaaaa-1111-4111-8111-111111111111";
const BOB = "bbbbbbbb-2222-4222-8222-222222222222";
const DANA = "dddddddd-3333-4333-8333-333333333333";
const names = { [ALICE]: { username: "alice" }, [BOB]: { username: "bob" }, [DANA]: { username: "dana" } };

function meta(over: Partial<CallLineMeta>): CallLineMeta {
  return { id: "c1", media: "audio", outcome: "completed", seconds: 0, started_by: ALICE, joined: [], missed: [], declined: [], ...over };
}

describe("call lines", () => {
  it("an answered call shows its length to both", () => {
    const m = meta({ seconds: 754, joined: [ALICE, BOB] });
    expect(callLineWords(m, ALICE, names, false)).toEqual({ text: "Call · 12 min", missed: false, again: null });
    expect(callLineWords({ ...m, media: "video" }, BOB, names, false).text).toBe("Video call · 12 min");
  });

  it("a missed call is red with Call back for the person called, No answer for the caller", () => {
    const m = meta({ outcome: "missed", missed: [BOB], joined: [ALICE] });
    expect(callLineWords(m, BOB, names, false)).toEqual({ text: "Missed call from alice", missed: true, again: "Call back" });
    expect(callLineWords(m, ALICE, names, false)).toEqual({ text: "No answer", missed: false, again: "Call again" });
  });

  it("a declined call never tells the caller it was declined", () => {
    const m = meta({ outcome: "declined", declined: [BOB], joined: [ALICE], media: "video" });
    expect(callLineWords(m, ALICE, names, false).text).toBe("No answer");
    expect(callLineWords(m, BOB, names, false).text).toBe("You declined a video call from alice");
  });

  it("a cancelled call", () => {
    const m = meta({ outcome: "cancelled", missed: [BOB], joined: [ALICE] });
    expect(callLineWords(m, ALICE, names, false)).toEqual({ text: "You cancelled a call", missed: false, again: "Call again" });
    expect(callLineWords(m, BOB, names, false).missed).toBe(true);
  });

  it("group calls say who started them", () => {
    const done = meta({ seconds: 3900, joined: [ALICE, BOB] });
    expect(callLineWords(done, DANA, names, true).text).toBe("alice started a call · 1 h 5 min");
    expect(callLineWords(done, ALICE, names, true).text).toBe("You started a call · 1 h 5 min");
    const missed = meta({ outcome: "missed", missed: [DANA], joined: [ALICE] });
    expect(callLineWords(missed, DANA, names, true).text).toBe("Missed group call from alice");
  });
});

describe("call words", () => {
  it("lengths and the timer", () => {
    expect(lengthWords(0)).toBe("1 sec");
    expect(lengthWords(45)).toBe("45 sec");
    expect(lengthWords(3600)).toBe("1 h");
    expect(clock(42)).toBe("0:42");
    expect(clock(723)).toBe("12:03");
    expect(clock(3729)).toBe("1:02:09");
  });

  it("how a call ended", () => {
    expect(endedWords("ended", 125)).toBe("Call ended · 2:05");
    expect(endedWords("ended", 0)).toBe("Call ended");
    expect(endedWords("declined", 0)).toBe("No answer");
    expect(endedWords("cancelled", 0)).toBe("Call cancelled");
  });
});

describe("call history", () => {
  const base = { media: "audio" as const, direction: "incoming" as const, outcome: "answered" as const, duration: 754, my_seconds: 700, group: false };

  it("says which way it went and how long", () => {
    expect(historyWords(base)).toEqual({ text: "Incoming call", detail: "12 min", missed: false });
    expect(historyWords({ ...base, direction: "outgoing", media: "video" })).toEqual({ text: "Outgoing video call", detail: "12 min", missed: false });
  });

  it("missed calls are red; your own unanswered calls aren't", () => {
    expect(historyWords({ ...base, outcome: "missed", duration: 0 })).toEqual({ text: "Missed call", detail: "", missed: true });
    expect(historyWords({ ...base, outcome: "missed", group: true, media: "video" }).text).toBe("Missed group video call");
    expect(historyWords({ ...base, direction: "outgoing", outcome: "no_answer", duration: 0 })).toEqual({ text: "Outgoing call", detail: "No answer", missed: false });
    expect(historyWords({ ...base, direction: "outgoing", outcome: "cancelled", duration: 0 }).detail).toBe("Cancelled");
    expect(historyWords({ ...base, outcome: "declined" }).text).toBe("Declined call");
  });

  it("live calls", () => {
    expect(historyWords({ ...base, outcome: "live", group: true }).text).toBe("Group call in progress");
    expect(historyWords({ ...base, outcome: "ringing", direction: "outgoing" }).detail).toBe("Ringing");
  });
});
