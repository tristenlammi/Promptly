import { describe, expect, it } from "vitest";
import { darkByClock, mapDark, sunElevation } from "./daylight";

const dubbo = { lat: -32.25, lon: 148.6 };

describe("map colours by the sun", () => {
  it("is light at midday and dark at midnight in Dubbo", () => {
    // 11 November 2026: noon and midnight, Sydney summer time (UTC+11).
    expect(mapDark("auto", dubbo, new Date("2026-11-11T01:00:00Z"))).toBe(false);
    expect(mapDark("auto", dubbo, new Date("2026-11-11T13:00:00Z"))).toBe(true);
  });

  it("turns at sunset and sunrise, not at a fixed hour", () => {
    // Dubbo that day: sunrise about 5:57 am, sunset about 7:27 pm local.
    expect(mapDark("auto", dubbo, new Date("2026-11-10T18:40:00Z"))).toBe(true); // 5:40 am
    expect(mapDark("auto", dubbo, new Date("2026-11-10T19:15:00Z"))).toBe(false); // 6:15 am
    expect(mapDark("auto", dubbo, new Date("2026-11-11T08:10:00Z"))).toBe(false); // 7:10 pm
    expect(mapDark("auto", dubbo, new Date("2026-11-11T08:45:00Z"))).toBe(true); // 7:45 pm
  });

  it("puts the midday sun high in the north", () => {
    expect(sunElevation(dubbo.lat, dubbo.lon, new Date("2026-11-11T01:50:00Z"))).toBeGreaterThan(70);
  });

  it("does what you chose, whatever the sun is doing", () => {
    expect(mapDark("light", dubbo, new Date("2026-11-11T13:00:00Z"))).toBe(false);
    expect(mapDark("dark", dubbo, new Date("2026-11-11T01:00:00Z"))).toBe(true);
  });

  it("goes by the clock when it doesn't know where you are", () => {
    expect(darkByClock(new Date(2026, 10, 11, 5, 59))).toBe(true);
    expect(darkByClock(new Date(2026, 10, 11, 6, 0))).toBe(false);
    expect(darkByClock(new Date(2026, 10, 11, 17, 59))).toBe(false);
    expect(darkByClock(new Date(2026, 10, 11, 18, 0))).toBe(true);
    expect(mapDark("auto", null, new Date(2026, 10, 11, 22, 0))).toBe(true);
  });
});
