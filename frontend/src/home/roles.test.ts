import { describe, expect, it } from "vitest";

import { leavingChoices, ROLE_WORDS, whoRuns } from "./roles";

describe("home roles", () => {
  it("names each role", () => {
    expect(ROLE_WORDS).toEqual({ owner: "Owner", coowner: "Co-owner", member: "Member" });
  });

  it("tells each person what they can do", () => {
    expect(whoRuns("owner")).toContain("only you choose them");
    expect(whoRuns("coowner")).toContain("Only the owner");
    expect(whoRuns("member")).toContain("owner and co-owners add devices");
  });

  it("offers co-owners first when the owner passes the home on, never the owner", () => {
    const people = [
      { id: "me", role: "owner" as const },
      { id: "mel", role: "member" as const },
      { id: "cora", role: "coowner" as const },
      { id: "pip", role: "member" as const },
    ];
    expect(leavingChoices(people, "me").map((p) => p.id)).toEqual(["cora", "mel", "pip"]);
    expect(leavingChoices([people[0]], "me")).toEqual([]);
  });
});
