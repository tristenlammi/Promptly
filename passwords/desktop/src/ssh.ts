// Reads what the SSH agent needs from an item's text: the public key line and an unencrypted
// OpenSSH private key. Ed25519 only. A passphrase-protected or RSA key simply isn't offered.
export type SshPublic = { type: string; blob: Uint8Array; comment: string };

const ED25519 = "ssh-ed25519";

function fromB64(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class Reader {
  at = 0;
  private b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  u32(): number {
    if (this.at + 4 > this.b.length) throw new Error("short");
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.at, 4).getUint32(0);
    this.at += 4;
    return v;
  }
  string(): Uint8Array {
    const n = this.u32();
    if (this.at + n > this.b.length) throw new Error("short");
    const out = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  text(): string {
    return new TextDecoder().decode(this.string());
  }
}

export function parsePublicLine(line: string | undefined): SshPublic | null {
  if (!line) return null;
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) return null;
  try {
    const blob = fromB64(parts[1]);
    const type = new Reader(blob).text();
    if (type !== parts[0]) return null;
    return { type, blob, comment: parts.slice(2).join(" ") };
  } catch {
    return null;
  }
}

/** The 32-byte Ed25519 seed from an `OPENSSH PRIVATE KEY`, with the public key that goes with
 *  it so the caller can check the item's two halves belong together. */
export function parseOpenSshEd25519(pem: string | undefined): { seed: Uint8Array; publicBlob: Uint8Array } | null {
  if (!pem) return null;
  const m = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END OPENSSH PRIVATE KEY-----/.exec(pem);
  if (!m) return null;
  try {
    const data = fromB64(m[1]);
    const magic = new TextEncoder().encode("openssh-key-v1\0");
    if (data.length < magic.length || magic.some((b, i) => data[i] !== b)) return null;
    const r = new Reader(data.subarray(magic.length));
    if (r.text() !== "none") return null; // cipher: passphrase-protected
    if (r.text() !== "none") return null; // kdf
    r.string(); // kdf options
    if (r.u32() !== 1) return null;
    const publicBlob = r.string();
    const priv = new Reader(r.string());
    if (priv.u32() !== priv.u32()) return null; // the two check ints must match
    if (priv.text() !== ED25519) return null;
    const pub = priv.string();
    const sk = priv.string();
    if (pub.length !== 32 || sk.length !== 64) return null;
    return { seed: sk.slice(0, 32), publicBlob: publicBlob.slice() };
  } catch {
    return null;
  }
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function toB64u(b: Uint8Array): string {
  let s = "";
  for (const v of b) s += String.fromCharCode(v);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64u(s: string): Uint8Array {
  return fromB64(s.replace(/-/g, "+").replace(/_/g, "/"));
}

/** An item the agent can use: Ed25519, with a private key that matches its public line. */
export function usableIdentity(body: { kind: string; title: string; sshPublic?: string; sshPrivate?: string }): { blob: Uint8Array; comment: string; seed: Uint8Array } | null {
  if (body.kind !== "ssh") return null;
  const pub = parsePublicLine(body.sshPublic);
  const priv = parseOpenSshEd25519(body.sshPrivate);
  if (!pub || !priv || pub.type !== ED25519 || !sameBytes(pub.blob, priv.publicBlob)) return null;
  return { blob: pub.blob, comment: body.title || pub.comment, seed: priv.seed };
}
