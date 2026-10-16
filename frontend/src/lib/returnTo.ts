/** Where to go after signing in (R-102).
 *
 *  A link to a chat, a file or a workspace sent you to /login and then
 *  always on to /chat, so the link was lost — through MFA and SSO too. The
 *  destination is kept in sessionStorage: it survives the MFA step and the
 *  round trip to an identity provider, and stays in this tab. */
const KEY = "promptly.return-to";

function isSafe(path: string | null | undefined): path is string {
  if (!path || !path.startsWith("/") || path.startsWith("//")) return false;
  // Never back into the sign-in flow itself.
  return !/^\/(login|setup|mfa)(\/|$|\?)/.test(path);
}

export function rememberReturnTo(path: string | null | undefined): void {
  if (!isSafe(path)) return;
  try {
    sessionStorage.setItem(KEY, path);
  } catch {
    /* storage blocked — the link is just lost, as before */
  }
}

/** The remembered destination (and forget it), else ``fallback``. */
export function takeReturnTo(fallback: string): string;
export function takeReturnTo(fallback: null): string | null;
export function takeReturnTo(fallback: string | null): string | null {
  let value: string | null = null;
  try {
    value = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return isSafe(value) ? value : fallback;
}

/** The remembered destination without forgetting it — the sign-in pages
 *  head there; the app forgets it once you've arrived. */
export function peekReturnTo(fallback: string): string {
  try {
    const value = sessionStorage.getItem(KEY);
    return isSafe(value) ? value : fallback;
  } catch {
    return fallback;
  }
}
