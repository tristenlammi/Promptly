import { describe, expect, it } from "vitest";

import { findAddresses, splitAddresses } from "./addresses";

describe("findAddresses", () => {
  it("finds an address as people write one", () => {
    expect(findAddresses("The house is at 342 Palmwoods-Montville Road, Palmwoods. Lockbox 4410.")).toEqual(["342 Palmwoods-Montville Road, Palmwoods"]);
    expect(findAddresses("Meet at 12 Smith St, Baringa then lunch")).toEqual(["12 Smith St, Baringa"]);
  });

  it("leaves ordinary sentences alone", () => {
    expect(findAddresses("Invoice 2316 is due on 20 November. Call Dr Smith on 5 Dec.")).toEqual([]);
    expect(findAddresses("We sold 40 Big Macs and 3 Large Drinks")).toEqual([]);
    expect(findAddresses("See 14 St Kilda for details")).toEqual([]);
    expect(findAddresses("No numbers here on Main Street")).toEqual([]);
  });

  it("skips links and email addresses, and gives each address once", () => {
    expect(findAddresses("https://example.com/12 Main Street and 9 Ocean Drive, then 9 Ocean Drive again")).toEqual(["9 Ocean Drive"]);
  });

  it("stops at the limit", () => {
    expect(findAddresses("1 Alpha Road, 2 Beta Road, 3 Gamma Road, 4 Delta Road", 2)).toHaveLength(2);
  });
});

describe("splitAddresses", () => {
  it("keeps every character, marking the addresses", () => {
    const text = "Come to 12 Smith St, Baringa at 6.";
    const parts = splitAddresses(text);
    expect(parts.map((p) => p.text).join("")).toBe(text);
    expect(parts.filter((p) => p.address).map((p) => p.text)).toEqual(["12 Smith St, Baringa"]);
  });

  it("gives plain text back whole", () => {
    expect(splitAddresses("Nothing here")).toEqual([{ text: "Nothing here", address: false }]);
  });
});
