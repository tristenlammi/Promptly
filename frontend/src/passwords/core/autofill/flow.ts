// A sign-in that continues across pages (plan 6.3). Per tab: which item was chosen,
// and what's been filled, so step 2 fills with the same item and no second choice.
// Holds an item id and timestamps, never a secret.

export type TabFlow = { itemId: string; host: string; filled: string[]; at: number };
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
