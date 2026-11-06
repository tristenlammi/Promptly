// node --test src/ssh.test.ts. Keys come from the real ssh-keygen, in a throwaway folder.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseOpenSshEd25519, parsePublicLine, usableIdentity } from "./ssh.ts";

const KEYGEN = "C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "promptly-ssh-"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function keygen(name: string, type: string, passphrase = ""): { pub: string; priv: string } {
  const file = path.join(dir, name);
  execFileSync(KEYGEN, ["-q", "-t", type, "-N", passphrase, "-C", "test key", "-f", file]);
  return { pub: fs.readFileSync(`${file}.pub`, "utf8"), priv: fs.readFileSync(file, "utf8") };
}

test("a real ssh-keygen ed25519 key parses, and its halves match", () => {
  const k = keygen("ed", "ed25519");
  const pub = parsePublicLine(k.pub)!;
  assert.equal(pub.type, "ssh-ed25519");
  assert.equal(pub.comment, "test key");
  const priv = parseOpenSshEd25519(k.priv)!;
  assert.equal(priv.seed.length, 32);
  assert.deepEqual(priv.publicBlob, pub.blob);
  const id = usableIdentity({ kind: "ssh", title: "Work", sshPublic: k.pub, sshPrivate: k.priv })!;
  assert.equal(id.comment, "Work");
  assert.deepEqual(id.seed, priv.seed);
});

test("passphrase-protected and non-ed25519 keys aren't offered", () => {
  const locked = keygen("locked", "ed25519", "a passphrase");
  assert.equal(parseOpenSshEd25519(locked.priv), null);
  assert.equal(usableIdentity({ kind: "ssh", title: "x", sshPublic: locked.pub, sshPrivate: locked.priv }), null);
  const rsa = keygen("rsa", "rsa");
  assert.equal(usableIdentity({ kind: "ssh", title: "x", sshPublic: rsa.pub, sshPrivate: rsa.priv }), null);
});

test("an item whose two halves don't belong together isn't offered", () => {
  const a = keygen("a", "ed25519");
  const b = keygen("b", "ed25519");
  assert.equal(usableIdentity({ kind: "ssh", title: "x", sshPublic: a.pub, sshPrivate: b.priv }), null);
  assert.equal(usableIdentity({ kind: "login", title: "x", sshPublic: a.pub, sshPrivate: a.priv }), null);
});

test("junk doesn't throw", () => {
  for (const bad of [undefined, "", "not a key", "ssh-ed25519", "ssh-ed25519 !!!", "ssh-rsa AAAAC3NzaC1lZDI1NTE5AAAAIA=="]) assert.equal(parsePublicLine(bad), null);
  for (const bad of [undefined, "", "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----", "-----BEGIN OPENSSH PRIVATE KEY-----\n!!!\n-----END OPENSSH PRIVATE KEY-----"]) assert.equal(parseOpenSshEd25519(bad), null);
});
