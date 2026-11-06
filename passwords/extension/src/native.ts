// Windows Hello for the extension, through the desktop app's native messaging host.
// Nothing here runs unless the caller wires it in. The shape matches `Platform["hello"]`, so
// `hello: nativeHello()` is all a page needs, plus a background message to adopt the secret.
// The host only accepts this extension if the desktop app registered its id, and the host's
// Hello is a convenience gate, not a crypto boundary: see SECURITY.md.
import { ext } from "./rpc";

export const NATIVE_HOST = "org.promptly.passwords";

type Reply = { ok: boolean; available?: boolean; enabled?: boolean; secret?: string; error?: string; cancelled?: boolean };

function send(message: Record<string, unknown>): Promise<Reply> {
  return ext.runtime.sendNativeMessage(NATIVE_HOST, message) as Promise<Reply>;
}

function toB64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64u(text: string): Uint8Array {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** False when the desktop app isn't installed or hasn't registered this extension, which
 *  the browser reports as a rejected call. Never shows a prompt. */
export async function nativeHelloStatus(): Promise<{ available: boolean; enabled: boolean }> {
  try {
    const r = await send({ t: "status" });
    return { available: !!r.ok && !!r.available, enabled: !!r.ok && !!r.enabled };
  } catch {
    return { available: false, enabled: false };
  }
}

/** Fits `Platform["hello"]`. `unlock` resolves to null if the person said no; any other
 *  failure rejects, with a message to show. */
export function nativeHello() {
  return {
    available: async () => (await nativeHelloStatus()).available,
    enable: async (secret: Uint8Array) => {
      const r = await send({ t: "enable", secret: toB64u(secret) });
      if (!r.ok) throw new Error(r.error ?? "Windows Hello didn't turn on");
    },
    unlock: async (): Promise<Uint8Array | null> => {
      const r = await send({ t: "unlock" });
      if (r.ok && r.secret) return fromB64u(r.secret);
      if (r.cancelled) return null;
      throw new Error(r.error ?? "Windows Hello didn't work");
    },
    disable: async () => {
      const r = await send({ t: "disable" });
      if (!r.ok) throw new Error(r.error ?? "Windows Hello didn't turn off");
    },
  };
}
