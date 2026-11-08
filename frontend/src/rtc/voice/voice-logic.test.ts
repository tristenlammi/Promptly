// Voice engine logic without LiveKit: the volume map, speaking reports
// (debounce and 429), Go Live plans and identities.
import { describe, expect, it } from "vitest";

import { allowedQualities, capQuality, streamPlan } from "./goLive";
import { SpeakingReporter, SPEAKING_OFF_MS, SPEAKING_ON_MS, type Clock } from "./speaking";
import { clampPercent, personGain, personPercent, streamGain, withLocalMute, withVolume } from "./volume";

const SAM = "11111111-1111-4111-8111-111111111111";
const JO = "22222222-2222-4222-8222-222222222222";

describe("volume map", () => {
  const prefs = { volumes: { [SAM]: 60 }, localMutes: [JO], output: 100 };

  it("plays each person at their own percent, 100% by default", () => {
    expect(personPercent(SAM, prefs)).toBe(60);
    expect(personPercent("someone", prefs)).toBe(100);
    expect(personGain(SAM, prefs)).toBeCloseTo(0.6);
    expect(personGain("someone", prefs)).toBe(1);
  });

  it("mute for me is silence, whatever the volume", () => {
    expect(personGain(JO, { ...prefs, volumes: { [JO]: 200 } })).toBe(0);
  });

  it("goes up to 200%, and the output volume multiplies", () => {
    expect(personGain(SAM, { ...prefs, volumes: { [SAM]: 200 } })).toBe(2);
    expect(personGain(SAM, { ...prefs, volumes: { [SAM]: 150 }, output: 50 })).toBeCloseTo(0.75);
    expect(personGain(SAM, { ...prefs, volumes: { [SAM]: 999 } })).toBe(2);
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(Number.NaN)).toBe(100);
  });

  it("the stream has its own volume", () => {
    expect(streamGain(50, 100)).toBe(0.5);
    expect(streamGain(200, 200)).toBe(4);
  });

  it("stores only what differs from the default", () => {
    expect(withVolume({ [SAM]: 60 }, SAM, 100)).toEqual({});
    expect(withVolume({}, JO, 140)).toEqual({ [JO]: 140 });
    expect(withLocalMute([JO], SAM, true)).toEqual([JO, SAM]);
    expect(withLocalMute([JO, SAM], JO, false)).toEqual([SAM]);
    expect(withLocalMute([JO], JO, true)).toEqual([JO]);
  });
});

/** A manual clock for the reporter. */
function fakeClock() {
  let t = 0;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  const clock: Clock = {
    now: () => t,
    setTimeout: (fn, ms) => {
      const id = next++;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimeout: (h) => {
      timers = timers.filter((x) => x.id !== h);
    },
  };
  const advance = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const due = timers[0];
      if (!due || due.at > end) break;
      timers.shift();
      t = due.at;
      due.fn();
      await Promise.resolve();
      await Promise.resolve();
    }
    t = end;
    await Promise.resolve();
    await Promise.resolve();
  };
  return { clock, advance };
}

describe("speaking reports", () => {
  it("debounces: on after 150 ms, off after 400 ms, blips ignored", async () => {
    const { clock, advance } = fakeClock();
    const sent: boolean[] = [];
    const r = new SpeakingReporter(async (on) => void sent.push(on), clock);
    r.input(true);
    await advance(SPEAKING_ON_MS - 10);
    r.input(false); // a blip
    await advance(500);
    expect(sent).toEqual([]);
    r.input(true);
    await advance(SPEAKING_ON_MS);
    expect(sent).toEqual([true]);
    r.input(false);
    await advance(SPEAKING_OFF_MS - 50);
    r.input(true); // a short pause between words
    await advance(1000);
    expect(sent).toEqual([true]);
    r.input(false);
    await advance(SPEAKING_OFF_MS);
    expect(sent).toEqual([true, false]);
  });

  it("on 429 waits out the window, then sends the latest state once", async () => {
    const { clock, advance } = fakeClock();
    const sent: boolean[] = [];
    let limited = true;
    const r = new SpeakingReporter(async (on) => {
      if (limited) throw { response: { status: 429 } };
      sent.push(on);
    }, clock);
    r.input(true);
    await advance(200);
    expect(sent).toEqual([]);
    limited = false;
    // Flapping during the back-off sends nothing ...
    r.input(false);
    await advance(500);
    r.input(true);
    await advance(500);
    expect(sent).toEqual([]);
    // ... and after it, just where things stand.
    await advance(10_000);
    expect(sent).toEqual([true]);
  });

  it("muting turns it off at once; 404 (out of voice) stops reporting", async () => {
    const { clock, advance } = fakeClock();
    const sent: boolean[] = [];
    let gone = false;
    const r = new SpeakingReporter(async (on) => {
      if (gone) throw { response: { status: 404 } };
      sent.push(on);
    }, clock);
    r.input(true);
    await advance(200);
    r.forceOff();
    await advance(1);
    expect(sent).toEqual([true, false]);
    gone = true;
    r.input(true);
    await advance(200);
    r.input(false);
    r.input(true);
    await advance(2000);
    expect(sent).toEqual([true, false]);
  });
});

describe("Go Live plans", () => {
  it("caps the quality at the server's limit", () => {
    expect(capQuality("1080p60", "720p30")).toBe("720p30");
    expect(capQuality("1080p60", "1080p30")).toBe("1080p30");
    expect(capQuality("720p30", "1080p60")).toBe("720p30");
    expect(allowedQualities("1080p30")).toEqual(["720p30", "1080p30"]);
  });

  it("1080p60 for a game: 60 fps on top, 720p and 360p layers below, keep the frame rate", () => {
    const p = streamPlan("1080p60", "1080p60", "motion");
    expect(p.capture).toEqual({ width: 1920, height: 1080, frameRate: 60 });
    expect(p.encoding.maxFramerate).toBe(60);
    expect(p.layers.map((l) => l.height)).toEqual([360, 720]);
    expect(p.degradation).toBe("maintain-framerate");
    expect(p.contentHint).toBe("motion");
  });

  it("better for text keeps the resolution and lowers the small layers' frame rate", () => {
    const p = streamPlan("1080p30", "1080p60", "detail");
    expect(p.degradation).toBe("maintain-resolution");
    expect(p.contentHint).toBe("detail");
    expect(p.layers.every((l) => l.maxFramerate <= 15)).toBe(true);
  });

  it("a capped choice gets the cap's plan", () => {
    const p = streamPlan("1080p60", "720p30", "motion");
    expect(p.quality).toBe("720p30");
    expect(p.capture.height).toBe(720);
    expect(p.layers.map((l) => l.height)).toEqual([360]);
  });
});
