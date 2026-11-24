import { describe, expect, it } from "vitest";

import { ageNow, liveState, recordingWords, seenWords, sharingWords, whenWords, type MySharing, type PhoneReport } from "./freshness";

const NOW = new Date(2026, 10, 24, 15, 0, 0); // Tuesday 24 Nov 2026, 3 pm
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

describe("how fresh a shared position is", () => {
  it("is fresh for five minutes, late to half an hour, then stale", () => {
    expect(liveState(0)).toBe("fresh");
    expect(liveState(300)).toBe("fresh");
    expect(liveState(301)).toBe("late");
    expect(liveState(1800)).toBe("late");
    expect(liveState(1801)).toBe("stale");
    expect(liveState(null)).toBe("waiting");
    expect(liveState(undefined)).toBe("waiting");
  });

  it("always says how old it is, and never passes an old place off as current", () => {
    expect(seenWords(20, ago(0).toISOString(), NOW)).toBe("Updated just now");
    expect(seenWords(70, ago(1).toISOString(), NOW)).toBe("Updated 1 min ago");
    expect(seenWords(12 * 60, ago(12).toISOString(), NOW)).toBe("Last seen 12 min ago");
    expect(seenWords(46 * 60, ago(46).toISOString(), NOW)).toMatch(/^Phone hasn't checked in since 2:14/);
    expect(seenWords(null, null, NOW)).toBe("No location yet");
  });

  it("keeps ageing between fetches", () => {
    expect(ageNow(240, 1_000_000, 1_000_000 + 90_000)).toBe(330);
    expect(liveState(ageNow(240, 1_000_000, 1_000_000 + 90_000))).toBe("late");
    expect(ageNow(null, 0, 5)).toBeNull();
  });

  it("names the day when it wasn't today", () => {
    expect(whenWords(ago(30), NOW)).toMatch(/^2:30/);
    expect(whenWords(new Date(2026, 10, 23, 9, 5), NOW)).toMatch(/^yesterday 9:05/);
    expect(whenWords(new Date(2026, 10, 20, 14, 14), NOW)).toMatch(/^Friday 2:14/);
    expect(whenWords(new Date(2026, 10, 3, 14, 14), NOW)).toMatch(/3 Nov|Nov 3/);
  });
});

describe("what the person sharing is told", () => {
  const me = (over: Partial<MySharing>): MySharing => ({ sent_at: null, age_s: null, state: "waiting", phone_seen_at: null, problem: null, ...over });

  it("says so when the phone hasn't picked the share up", () => {
    const got = sharingWords(me({}), NOW);
    expect(got.bad).toBe(true);
    expect(got.text).toBe("Your phone hasn't picked this up yet. Open Promptly on your phone to start it.");
  });

  it("says why, when the phone has said why", () => {
    expect(sharingWords(me({ problem: "permission" }), NOW).text).toBe("Promptly on your phone isn't allowed to use its location. Open Promptly on your phone to start it.");
  });

  it("is quiet reassurance when it's working", () => {
    expect(sharingWords(me({ sent_at: ago(2).toISOString(), age_s: 120, state: "fresh" }), NOW)).toEqual({ text: "Your phone last sent where you are 2 min ago.", bad: false });
    expect(sharingWords(me({ sent_at: ago(0).toISOString(), age_s: 15, state: "fresh" }), NOW).text).toBe("Your phone sent where you are just now.");
  });

  it("says when it stopped", () => {
    const got = sharingWords(me({ sent_at: ago(46).toISOString(), age_s: 46 * 60, state: "stale" }), NOW);
    expect(got.bad).toBe(true);
    expect(got.text).toMatch(/^Your phone stopped sending your location at 2:14.*Open Promptly on your phone to start it again\.$/);
  });
});

describe("what the timeline panel says while recording is on", () => {
  const phone = (over: Partial<PhoneReport>): PhoneReport => ({ seen_at: null, points_at: null, last_point_at: null, quiet: false, recording: null, waiting: null, problem: null, ...over });

  it("says the phone has gone quiet, and since when", () => {
    const got = recordingWords(phone({ quiet: true, seen_at: new Date(2026, 10, 20, 14, 14).toISOString() }), NOW);
    expect(got?.bad).toBe(true);
    expect(got?.text).toMatch(/^Your phone hasn't sent anything since Friday 2:14.*\. Open Promptly on your phone to start it again\.$/);
  });

  it("says so when it has never sent anything", () => {
    expect(recordingWords(phone({ quiet: true }), NOW)?.text).toBe("Your phone hasn't sent anything yet. Open Promptly on your phone to start it again.");
  });

  it("says when the phone itself reports it isn't running", () => {
    const got = recordingWords(phone({ seen_at: ago(3).toISOString(), recording: false, problem: "blocked" }), NOW);
    expect(got).toEqual({ text: "Android stopped it on your phone and wouldn't let it start again by itself. Open Promptly on your phone to start it again.", bad: true });
  });

  it("shows it's alive when all is well", () => {
    expect(recordingWords(phone({ seen_at: ago(4).toISOString(), recording: true, waiting: 0 }), NOW)).toEqual({ text: "Your phone last checked in 4 min ago.", bad: false });
    expect(recordingWords(phone({ seen_at: ago(4).toISOString(), recording: true, waiting: 412 }), NOW)?.text).toBe("Your phone last checked in 4 min ago. 412 positions are waiting on it to send.");
  });

  it("says nothing before it knows anything", () => {
    expect(recordingWords(undefined, NOW)).toBeNull();
    expect(recordingWords(phone({}), NOW)).toBeNull();
  });
});
