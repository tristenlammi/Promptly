// Ctrl+K "Call Mum" / "Video call Sam": what was asked for.
import { describe, expect, it } from "vitest";

import { parseCallQuery } from "./paletteCalls";

describe("call commands", () => {
  it("reads who and how", () => {
    expect(parseCallQuery("Call Mum")).toEqual({ media: "audio", term: "Mum" });
    expect(parseCallQuery("  video call   sam ")).toEqual({ media: "video", term: "sam" });
    expect(parseCallQuery("videocall sam")).toEqual({ media: "video", term: "sam" });
    expect(parseCallQuery("ring dad")).toEqual({ media: "audio", term: "dad" });
    expect(parseCallQuery("call")).toEqual({ media: "audio", term: "" });
  });

  it("leaves everything else alone", () => {
    expect(parseCallQuery("calls")).toBeNull();
    expect(parseCallQuery("recall the memo")).toBeNull();
    expect(parseCallQuery("message sam")).toBeNull();
  });
});
