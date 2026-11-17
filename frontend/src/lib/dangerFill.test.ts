// White words on red use --danger-fill, never --danger. In the dark theme
// --danger is a light red meant for text, and white on it is 2.8:1 (unreadable
// count badges, "New" markers and Remove buttons, found by the accessibility scan).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..");

function* files(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(full);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) yield full;
  }
}

describe("red fills", () => {
  it("never put white words on the text red", () => {
    const bad: string[] = [];
    for (const f of files(SRC)) {
      fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        // The solid fill only: "bg-[var(--danger)]/20" is a tint, and fine.
        if (/bg-\[var\(--danger\)\](?!\/)/.test(line) && /\btext-white\b/.test(line)) bad.push(`${path.relative(SRC, f)}:${i + 1}`);
      });
    }
    expect(bad, `use bg-[var(--danger-fill)] under white text:\n${bad.join("\n")}`).toEqual([]);
  });
});
