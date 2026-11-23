import { describe, expect, it } from "vitest";

import { countryOfLanguage, countryOfTimeZone, mapForCountry } from "./guessCountry";

describe("guessing the browser's country", () => {
  it("reads the country from a time zone", () => {
    expect(countryOfTimeZone("Pacific/Auckland")).toBe("nz");
    expect(countryOfTimeZone("Australia/Brisbane")).toBe("au");
    expect(countryOfTimeZone("Europe/London")).toBe("gb");
    expect(countryOfTimeZone("America/Indiana/Indianapolis")).toBe("us");
    expect(countryOfTimeZone("America/Argentina/Cordoba")).toBe("ar");
    expect(countryOfTimeZone("America/Toronto")).toBe("ca");
    expect(countryOfTimeZone("UTC")).toBeNull();
    expect(countryOfTimeZone("")).toBeNull();
  });

  it("reads the country from a language tag that names one", () => {
    expect(countryOfLanguage("en-NZ")).toBe("nz");
    expect(countryOfLanguage("zh-Hant-TW")).toBe("tw");
    expect(countryOfLanguage("en")).toBeNull();
    expect(countryOfLanguage(undefined)).toBeNull();
  });

  it("picks the whole-country map, the one covering the fewest others", () => {
    const regions = [
      { id: "britain-and-ireland", parent: null, kind: "part", codes: ["gb", "ie", "im"] },
      { id: "great-britain", parent: null, kind: "part", codes: ["gb"] },
      { id: "england", parent: "great-britain", kind: "part", codes: ["gb"] },
      { id: "ireland-and-northern-ireland", parent: null, kind: "country", codes: ["gb", "ie"] },
      { id: "new-zealand", parent: null, kind: "country", codes: ["nz"] },
    ];
    expect(mapForCountry(regions, "gb")?.id).toBe("great-britain");
    expect(mapForCountry(regions, "ie")?.id).toBe("ireland-and-northern-ireland");
    expect(mapForCountry(regions, "nz")?.id).toBe("new-zealand");
    expect(mapForCountry(regions, "fr")).toBeNull();
    expect(mapForCountry(regions, null)).toBeNull();
  });
});
