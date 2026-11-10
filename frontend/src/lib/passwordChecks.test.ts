import { describe, expect, it } from "vitest";

import { passwordChecks, passwordMeetsRules } from "@/components/account/PasswordChecklist";
import { newMemberText } from "@/components/admin/NewMemberCard";

// Mirrors backend/app/auth/password_policy.py: length, a number, a symbol
// (anything that isn't a letter or a number — a space counts, as there).
describe("password checklist matches the server's rules", () => {
  const ok = (pw: string) => passwordChecks(pw, 10).map((c) => c.ok);

  it("checks each rule", () => {
    expect(ok("")).toEqual([false, false, false]);
    expect(ok("abcdefghij")).toEqual([true, false, false]);
    expect(ok("abcdefghi1")).toEqual([true, true, false]);
    expect(ok("abc-1")).toEqual([false, true, true]);
    expect(ok("my garden 7")).toEqual([true, true, true]);
  });

  it("only passes when all are met", () => {
    expect(passwordMeetsRules("Sunny-days-42", 10)).toBe(true);
    expect(passwordMeetsRules("Sunnydays42", 10)).toBe(false);
    expect(passwordMeetsRules("ab-1", 10)).toBe(false);
  });
});

describe("the Send them this text", () => {
  it("has the address, username and password, and the iPhone steps", () => {
    const text = newMemberText({ id: "x", username: "sam", email: "s@x", password: "Temp-pass-1", temporary: true }, "https://p.example");
    expect(text).toContain("Address: https://p.example");
    expect(text).toContain("Username: sam");
    expect(text).toContain("Temporary password: Temp-pass-1");
    expect(text).toContain("Choose your own password");
    expect(text).toContain("Add to Home Screen");
  });
});
