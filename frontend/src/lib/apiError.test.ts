import { describe, expect, it } from "vitest";

import { apiErrorMessage, cleanValidationMessage, normalizeApiDetail } from "@/utils/apiError";

describe("validation messages read plainly", () => {
  it("drops the field prefix and Pydantic's 'Value error, '", () => {
    const detail = [
      { loc: ["body", "new_password"], msg: "Value error, Password must include at least one symbol (like ! @ # or -)." },
    ];
    expect(normalizeApiDetail(detail)).toBe("Password must include at least one symbol (like ! @ # or -).");
  });

  it("names the field for Pydantic's own wording", () => {
    expect(normalizeApiDetail([{ loc: ["body", "password"], msg: "String should have at least 10 characters" }])).toBe(
      "Password should have at least 10 characters",
    );
    expect(cleanValidationMessage("String should have at least 3 characters", "new_password")).toBe(
      "New password should have at least 3 characters",
    );
  });

  it("leaves other messages and plain strings alone", () => {
    expect(cleanValidationMessage("That password is too common.")).toBe("That password is too common.");
    expect(normalizeApiDetail("Email or username already exists")).toBe("Email or username already exists");
    const err = { response: { status: 422, data: { detail: [{ loc: ["body", "x"], msg: "Value error, too common" }] } } };
    expect(apiErrorMessage(err)).toBe("Too common");
  });
});
