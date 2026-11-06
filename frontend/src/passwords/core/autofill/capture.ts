// Noticing a sign-in or sign-up so it can be offered for saving (plan 6.4). The value
// stays in the content script until the page moves on, and it's only offered if that
// looks like success: a form that comes straight back, or an error message, means the
// login failed, and nobody should be asked to save a typo.
import { analyzePage, type DomAdapter, type FormInfo, isVisible } from "./classify";

export type Captured = { kind: FormInfo["kind"]; username?: string; password?: string; newPassword?: string; host: string; url: string; at: number };

const FAILURE = /(incorrect|invalid|wrong|doesn.?t match|not recogni[sz]ed|failed|try again|couldn.?t sign|falsch|ungültig|incorrecto|incorrecta|inválid|erreur|incorrect|errato|onjuist|неверн|ошибк|間違|错误|错誤|잘못|غير صحيح|गलत)/i;

export function capture(form: FormInfo, location: Location): Captured | null {
  const get = (...roles: string[]) => {
    for (const f of form.fields) if (roles.includes(f.role)) {
      const v = (f.el as HTMLInputElement).value;
      if (v) return v;
    }
    return undefined;
  };
  const password = get("password", "current-password");
  const newPassword = get("new-password");
  const username = get("username", "email");
  if (!password && !newPassword && !username) return null;
  return { kind: form.kind, username, password, newPassword, host: location.hostname, url: location.href, at: Date.now() };
}

/** After a submit, has the page clearly refused? */
export function looksFailed(doc: Document, submitted: Pick<Captured, "kind">, dom: DomAdapter = {}): boolean {
  const page = analyzePage(doc, dom);
  const same = page.forms.find((f) => f.kind === submitted.kind && f.fields.some((x) => x.role === "password" || x.role === "new-password"));
  if (same) {
    const pw = same.fields.find((x) => x.role === "password" || x.role === "new-password")?.el as HTMLInputElement | undefined;
    if (pw && isVisible(pw, dom)) return true;
  }
  const alerts = doc.querySelectorAll('[role=alert],[aria-live=assertive],.error,.alert-danger,.alert-error,[class*="error" i]');
  for (const a of alerts) {
    if (isVisible(a, dom) && FAILURE.test(a.textContent ?? "")) return true;
  }
  return false;
}

/** What a background request after a submit says. A page gains nothing by faking this:
 *  it only decides whether a person gets asked about saving. Status 0 is a cross-origin
 *  request the browser won't describe, so it says nothing. */
export function requestVerdict(status: number): "ok" | "failed" | "unknown" {
  if (status >= 200 && status < 400) return "ok";
  if ([400, 401, 403, 422, 429].includes(status)) return "failed";
  return "unknown";
}

export type SaveOffer = {
  kind: "save" | "update";
  itemId?: string;
  username?: string;
  password: string;
  host: string;
  url: string;
  /** A password we generated and saved before the site said yes. */
  generated?: "signup" | "change";
};

/** What's already saved for this site. ``unconfirmed`` is a generated sign-up the site
 *  hasn't accepted yet, ``pendingPassword`` a generated change it hasn't accepted yet. */
export type KnownLogin = { id: string; username?: string; password?: string; pendingPassword?: string; unconfirmed?: boolean };

/** What to ask, knowing what's already saved for this site. Same password: nothing. */
export function decideOffer(c: Captured, existing: KnownLogin[], neverHosts: string[]): SaveOffer | null {
  const password = c.newPassword ?? c.password;
  if (!password) return null;
  // A password we made for this site went through: finish that item, don't make another.
  const changing = existing.find((e) => e.pendingPassword === password);
  if (changing) return { kind: "update", itemId: changing.id, username: changing.username ?? c.username, password, host: c.host, url: c.url, generated: "change" };
  const signup = existing.find((e) => e.unconfirmed && e.password === password);
  if (signup) return { kind: "save", itemId: signup.id, username: c.username ?? signup.username, password, host: c.host, url: c.url, generated: "signup" };
  if (neverHosts.includes(c.host)) return null;
  const same = existing.find((e) => (e.username ?? "") === (c.username ?? ""));
  if (same) {
    if (same.password === password) return null;
    return { kind: "update", itemId: same.id, username: c.username, password, host: c.host, url: c.url };
  }
  // A password change with no username on the page: the only saved one is the one.
  if (!c.username && c.kind === "change-password" && existing.length === 1) {
    if (existing[0].password === password) return null;
    return { kind: "update", itemId: existing[0].id, username: existing[0].username, password, host: c.host, url: c.url };
  }
  // A known password with a username we've no record of, on a sign-in, is still new.
  return { kind: "save", username: c.username, password, host: c.host, url: c.url };
}
