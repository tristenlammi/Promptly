import { describe, expect, it } from "vitest";

import { tooBigForRooms } from "@/api/rooms";

describe("a file over the limit for Rooms", () => {
  it("says the limit and where to put the file instead", () => {
    const said = tooBigForRooms("holiday.mp4", 1024 ** 3);
    expect(said).toContain("holiday.mp4 is over 1 GB");
    expect(said).toContain("Put it in your files, then use Send to…");
  });

  it("says megabytes on a server without big uploads", () => {
    expect(tooBigForRooms("clip.mov", 50 * 1024 * 1024)).toContain("clip.mov is over 50 MB");
  });
});
