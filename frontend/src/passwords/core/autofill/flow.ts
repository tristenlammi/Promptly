// A sign-in that continues across pages (plan 6.3). Per tab: which item was chosen,
// and what's been filled, so step 2 fills with the same item and no second choice.
// Holds an item id and timestamps, never a secret.

export type TabFlow = { itemId: string; host: string; filled: string[]; at: number; otpDone?: boolean };
const TTL_MS = 5 * 60 * 1000;

export function flowFor(flow: TabFlow | undefined, host: string, sameSite: (a: string, b: string) => boolean, now = Date.now()): TabFlow | null {
  if (!flow) return null;
  if (now - flow.at > TTL_MS) return null;
  if (flow.host !== host && !sameSite(flow.host, host)) return null;
  return flow;
}

export function advance(flow: TabFlow, roles: string[], now = Date.now()): TabFlow {
  return { ...flow, filled: [...new Set([...flow.filled, ...roles])], at: now };
}

/** The flow after filling on this page: the same item on the same site carries on, and
 *  anything else starts again. Never restores an earlier item. */
export function afterFill(prev: TabFlow | undefined, itemId: string, host: string, roles: string[], sameSite: (a: string, b: string) => boolean, now = Date.now()): TabFlow {
  const live = flowFor(prev, host, sameSite, now);
  if (live && live.itemId === itemId) return { ...advance(live, roles, now), host };
  return { itemId, host, filled: [...new Set(roles)], at: now };
}

/** Plan 6.3: once the password's gone in and the page has moved on, what about the 2FA
 *  code? A page with a code box gets it filled, by the person, from the same item. A
 *  page with no box gets it on the clipboard, once. A password box still on screen means
 *  we're not past that step yet, or the login failed, so nothing happens. */
export function codeStep(flow: TabFlow | null, hasTotp: boolean, page: { hasCodeField: boolean; hasPasswordField: boolean }): "copy" | "wait" | "none" {
  if (!flow || !hasTotp || flow.otpDone) return "none";
  if (!flow.filled.includes("password")) return "none";
  if (flow.filled.includes("otp") || flow.filled.includes("otp-digit")) return "none";
  if (page.hasCodeField || page.hasPasswordField) return "wait";
  return "copy";
}

/** Plan 6.6: fill on load is opt-in per item, and only for an exact host match in the
 *  top frame over https. Anything looser needs a person. One match only, so a page can't
 *  pick between accounts by loading. ``allowPlainHttp`` is for test builds. */
export function mayFillOnLoad(
  page: { url: string; frameId: number; kinds: string[] },
  matches: { kind: string; optedIn: boolean; reprompt: boolean; downgrade: boolean }[],
  allowPlainHttp: (url: URL) => boolean = () => false,
): boolean {
  if (page.frameId !== 0 || !page.kinds.includes("signin")) return false;
  let url: URL;
  try {
    url = new URL(page.url);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowPlainHttp(url))) return false;
  if (matches.length !== 1) return false;
  const [m] = matches;
  return m.optedIn && !m.reprompt && !m.downgrade && (m.kind === "host" || m.kind === "exact");
}

export type NextAction = { fill: string[]; copyOtp: boolean };

/** After a fill, what the user would want next for this kind of form. */
export function nextFor(kind: string, hasOtp: boolean, flow: TabFlow | null): NextAction {
  if (kind === "otp") return { fill: ["otp"], copyOtp: false };
  if (kind === "email-first") return { fill: ["username"], copyOtp: false };
  if (kind === "password-next") return { fill: ["password"], copyOtp: false };
  if (kind === "signin") {
    const done = flow?.filled ?? [];
    const fill = ["username", "password"].filter((r) => !done.includes(r) || r === "password");
    // Most sites go straight to a 2FA page; have the code ready.
    return { fill, copyOtp: hasOtp };
  }
  return { fill: [], copyOtp: false };
}
