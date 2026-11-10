import { describe, expect, it } from "vitest";
import { sanitizeSnippet } from "./sanitizeSnippet";

describe("sanitizeSnippet", () => {
  it("keeps the search highlight", () => {
    expect(sanitizeSnippet("a <mark>word</mark> here")).toContain("<mark");
    expect(sanitizeSnippet("a <mark>word</mark> here")).toContain("word</mark>");
  });

  it("escapes anything else a note could hold", () => {
    const out = sanitizeSnippet('<img src=x onerror="alert(1)"><mark>hit</mark><script>x</script>');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;img");
  });

  it("caps long snippets", () => {
    expect(sanitizeSnippet("x".repeat(500)).length).toBeLessThanOrEqual(321);
  });
});
