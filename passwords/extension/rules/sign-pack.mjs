// Signs the curated rules pack (plan 6.5). The key stays with the owner, in a file only
// they hold: this script reads it from the path it's given and never keeps a copy.
//
//   Make a key, once. Put the file somewhere safe and never in the repo:
//     node rules/sign-pack.mjs --new-key C:\somewhere-safe\promptly-pack-key.jwk.json
//   It prints the public key. Paste that into RELEASE_PUBLIC_KEY in src/rules-key.ts.
//
//   Sign a pack, each time rules/pack.json changes:
//     node rules/sign-pack.mjs --key C:\somewhere-safe\promptly-pack-key.jwk.json
//
// A pack is data only: a version, which must go up, and a list of rules made of a host,
// four CSS selectors and a "never" flag. Nothing in it can run.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

/** The same bytes as signingInput("rules_pack", [pack]) in core/format.ts. A test keeps
 *  them the same. */
function signingInput(purpose, fields) {
  const lp = (b) => {
    if (b.length > 0xffff) throw new Error("A signed field has to be under 64 KB, and this is bigger.");
    return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]);
  };
  return Buffer.concat([Buffer.from("promptly-pw/v1/sig"), Buffer.from([0]), lp(Buffer.from(purpose)), ...fields.map(lp)]);
}

const newKey = arg("--new-key");
if (newKey) {
  if (fs.existsSync(newKey)) {
    console.error(`${newKey} already exists. A new key means every signed pack has to be signed again, so this won't overwrite it.`);
    process.exit(1);
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(newKey, JSON.stringify(privateKey.export({ format: "jwk" }), null, 1), { mode: 0o600 });
  console.log(`Key saved to ${newKey}. Keep it safe and out of the repo.`);
  console.log(`Public key, for RELEASE_PUBLIC_KEY in src/rules-key.ts:\n${publicKey.export({ format: "jwk" }).x}`);
  process.exit(0);
}

const keyPath = arg("--key");
if (!keyPath) {
  console.error("Usage: node rules/sign-pack.mjs --key <path to key file> [--in <pack.json>] [--out <pack.sig>]\n       node rules/sign-pack.mjs --new-key <path for a new key file>");
  process.exit(1);
}
const input = arg("--in") ?? path.join(here, "pack.json");
const output = arg("--out") ?? path.join(here, "pack.sig");
const pack = fs.readFileSync(input);
JSON.parse(pack.toString("utf8")); // Refuse to sign something that isn't JSON at all.
const key = crypto.createPrivateKey({ key: JSON.parse(fs.readFileSync(keyPath, "utf8")), format: "jwk" });
fs.writeFileSync(output, crypto.sign(null, signingInput("rules_pack", [pack]), key).toString("base64url"));
console.log(`Signed ${input}. Signature in ${output}.`);
