// A pure-function check run by the Playwright runner (the frontend has no
// unit-test runner of its own).
import { expect, test } from "@playwright/test";

import { isSpokenYes } from "../../frontend/src/lib/spokenConfirm";

test.describe("spoken confirmation (R-131)", () => {
  for (const yes of ["Yes", "yes please", "Yeah.", "OK", "Okay, do it", "Sure!", "Go ahead", "go for it", "Confirm"]) {
    test(`"${yes}" runs it`, () => {
      expect(isSpokenYes(yes)).toBe(true);
    });
  }
  for (const no of [
    "Okay, cancel that.",
    "OK no, stop",
    "Sure, wait no",
    "Do it later",
    "Confirm? No.",
    "Yesterday I said no",
    "yes, hold on",
    "don't",
    "Please",
    "it",
    "",
    "open the garage",
  ]) {
    test(`"${no}" doesn't`, () => {
      expect(isSpokenYes(no)).toBe(false);
    });
  }
});
