// Find stray passwords: the server reads your own Mail, Files and Photos (it holds them
// already) and says where something looks like a secret. Here it becomes a new vault
// item, encrypted on this device like any other, and the plain original can go.
import { baseDomain } from "./match";
import { type ItemBody, newBody } from "./model";
import { parseOtpauth } from "./totp";

export type StrayKind =
  | "password"
  | "wifi"
  | "api_key"
  | "private_key"
  | "recovery_codes"
  | "totp_secret"
  | "totp_qr"
  | "password_list"
  | "env_secrets"
  | "password_store"
  | "password_file";
export type StraySource = "mail" | "file" | "photo";
export type StrayFinding = {
  id: string;
  source: StraySource;
  kind: StrayKind;
  hits: number;
  label: string;
  /** A hint like pa••••rd, never the secret. */
  preview: string;
  where: { title: string; detail: string; at: string | null };
  found_at: string;
};
export type StrayList = {
  count: number;
  ignored: number;
  scanning: boolean;
  caught_up: boolean;
  last_scan_at: string | null;
  /** This device was connected without Mail codes, so mail isn't shown here. */
  mail_hidden: boolean;
  findings: StrayFinding[];
};
export type StraySecret = { kind: StrayKind; value: string; username: string; label: string; count: number };
export type StrayDetail = StrayFinding & { secrets: StraySecret[]; excerpt: string; site: string; name: string };

export const STRAY_KIND_LABEL: Record<StrayKind, string> = {
  password: "Password",
  wifi: "Wi-Fi password",
  api_key: "API key",
  private_key: "Private key",
  recovery_codes: "Recovery codes",
  totp_secret: "2FA setup key",
  totp_qr: "2FA setup screen",
  password_list: "List of passwords",
  env_secrets: "Secrets in a settings file",
  password_store: "Password manager file",
  password_file: "File named for passwords",
};

export const STRAY_SOURCE_LABEL: Record<StraySource, string> = { mail: "Mail", file: "Files", photo: "Photos" };

/** Where the original goes, in words for the question. */
export const STRAY_TRASH_WHERE: Record<StraySource, string> = { mail: "Mail's Trash", file: "Files' Trash", photo: "Trash in Files, where Photos keeps it" };

/** Kinds that become an item. The others are whole files: those are imported, not typed in. */
export function canSave(kind: StrayKind): boolean {
  return kind !== "password_store" && kind !== "password_file";
}

/** The sender's own domain, never a link from inside the message: that's whatever the mail cares to say. */
function siteOf(d: StrayDetail): string {
  if (d.source !== "mail" || !d.site) return "";
  return baseDomain(d.site) ?? d.site;
}

function titleOf(d: StrayDetail, fallback: string): string {
  const site = siteOf(d);
  if (site) return site;
  if (d.source === "file" && d.name) return d.name;
  return fallback;
}

function totpBody(value: string, title: string, note: string): ItemBody {
  if (/^otpauth:\/\//i.test(value)) {
    const cfg = parseOtpauth(value);
    return newBody("totp", cfg.issuer || title, { totp: cfg, notes: note });
  }
  return newBody("totp", title, { totp: { secret: value.toUpperCase().replace(/\s/g, "") }, notes: note });
}

/** A new item for the editor, filled from what was found. ``qr`` is what this device read
 *  from a 2FA setup screenshot, if anything. Null when it's a whole file to import. */
export function prefill(d: StrayDetail, qr?: string | null): ItemBody | null {
  const first = d.secrets[0];
  const note = `Moved from ${STRAY_SOURCE_LABEL[d.source]}: ${d.where.title}`;
  switch (d.kind) {
    case "password": {
      const site = siteOf(d);
      return newBody("login", titleOf(d, "Login"), { username: first?.username ?? "", password: first?.value ?? "", urls: [{ url: site ? `https://${site}` : "" }], notes: note });
    }
    case "wifi":
      return newBody("wifi", first?.username || "Wi-Fi", { ssid: first?.username ?? "", wifiPassword: first?.value ?? "", wifiSecurity: "WPA", notes: note });
    case "api_key":
      return newBody("apikey", titleOf(d, first?.label || "API key"), { apiKey: first?.value ?? "", notes: note });
    case "private_key":
      return newBody("ssh", titleOf(d, "SSH key"), { sshPrivate: first?.value ?? "", notes: note });
    case "recovery_codes":
      return newBody("note", `${titleOf(d, "Account")} recovery codes`, { notes: `${d.secrets.map((s) => s.value).join("\n\n")}\n\n${note}` });
    case "totp_secret":
      return totpBody(first?.value ?? "", titleOf(d, "2FA code"), note);
    case "totp_qr":
      if (qr && /^otpauth:\/\//i.test(qr)) return totpBody(qr, titleOf(d, "2FA code"), note);
      return newBody("totp", titleOf(d, "2FA code"), { notes: note });
    case "password_list":
    case "env_secrets":
      return newBody("note", d.name || d.where.title, { notes: `${d.secrets.map((s) => s.value).join("\n\n")}\n\n${note}` });
    default:
      return null;
  }
}
