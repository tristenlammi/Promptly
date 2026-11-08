import { describe, expect, it } from "vitest";

import { canSave, prefill, type StrayDetail } from "./stray";

function detail(over: Partial<StrayDetail>): StrayDetail {
  return {
    id: "f1",
    source: "mail",
    kind: "password",
    hits: 1,
    label: "Password",
    preview: "Kq••••Lm",
    where: { title: "Your new account", detail: "accounts.acme.co.uk · Inbox", at: null },
    found_at: new Date().toISOString(),
    secrets: [{ kind: "password", value: "Kq7#vR2pLm", username: "ana", label: "Password", count: 1 }],
    excerpt: "",
    site: "accounts.acme.co.uk",
    name: "",
    ...over,
  };
}

describe("prefill", () => {
  it("a password from mail becomes a login for the sender's own site", () => {
    const b = prefill(detail({}))!;
    expect(b.kind).toBe("login");
    expect(b.title).toBe("acme.co.uk");
    expect(b.username).toBe("ana");
    expect(b.password).toBe("Kq7#vR2pLm");
    expect(b.urls).toEqual([{ url: "https://acme.co.uk" }]);
    expect(b.notes).toContain("Moved from Mail: Your new account");
  });

  it("a file's password gets no website: a file says nothing about where it's for", () => {
    const b = prefill(detail({ source: "file", site: "", name: "wifi.txt", kind: "wifi", secrets: [{ kind: "wifi", value: "blue-otter-42", username: "Home", label: "", count: 1 }] }))!;
    expect(b.kind).toBe("wifi");
    expect(b.ssid).toBe("Home");
    expect(b.wifiPassword).toBe("blue-otter-42");
  });

  it("2FA keys, links and QR text become a 2FA code", () => {
    const key = prefill(detail({ kind: "totp_secret", secrets: [{ kind: "totp_secret", value: "jbsw y3dp ehpk 3pxp", username: "", label: "", count: 1 }] }))!;
    expect(key.kind).toBe("totp");
    expect(key.totp?.secret).toBe("JBSWY3DPEHPK3PXP");
    const link = prefill(detail({ kind: "totp_secret", secrets: [{ kind: "totp_secret", value: "otpauth://totp/Acme:ana?secret=JBSWY3DPEHPK3PXP&issuer=Acme", username: "", label: "", count: 1 }] }))!;
    expect(link.title).toBe("Acme");
    expect(link.totp?.secret).toBe("JBSWY3DPEHPK3PXP");
    const shot = detail({ source: "photo", site: "", kind: "totp_qr", secrets: [{ kind: "totp_qr", value: "", username: "", label: "", count: 1 }] });
    expect(prefill(shot, "otpauth://totp/Bank:me?secret=JBSWY3DPEHPK3PXP&issuer=Bank")!.totp?.issuer).toBe("Bank");
    // Couldn't read the QR: an empty 2FA item, to fill from the image.
    expect(prefill(shot, null)!.totp).toBeUndefined();
  });

  it("codes and lists become a note, and whole files aren't typed in", () => {
    const codes = prefill(detail({ kind: "recovery_codes", secrets: [{ kind: "recovery_codes", value: "1a2b3-c4d5e\n6f7g8-h9i0j", username: "", label: "", count: 2 }] }))!;
    expect(codes.kind).toBe("note");
    expect(codes.title).toBe("acme.co.uk recovery codes");
    expect(codes.notes).toContain("6f7g8-h9i0j");
    expect(prefill(detail({ kind: "password_store", secrets: [] }))).toBeNull();
    expect(canSave("password_store")).toBe(false);
    expect(canSave("env_secrets")).toBe(true);
  });
});
