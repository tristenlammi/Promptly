// Plan 13.8: the main SPA's chunks contain no vault crypto. Walks from index.html
// through every static and dynamic import in the build, and fails if any file it
// reaches holds a marker only vault code has.
//   node passwords/tests/bundle-check.mjs [frontend/dist]
import fs from "node:fs";
import path from "node:path";

const dist = process.argv[2] ?? "frontend/dist";
const MARKERS = ["promptly-pw/v1", "PWK1-", "argon2id", "promptly-vault"];

const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const queue = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
const seen = new Set();
const bad = [];
while (queue.length) {
  const rel = queue.pop();
  if (seen.has(rel)) continue;
  seen.add(rel);
  const file = path.join(dist, rel);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, "utf8");
  for (const m of MARKERS) if (text.includes(m)) bad.push(`${rel}: ${m}`);
  for (const m of text.matchAll(/["'`(/]([\w./-]*?assets\/[\w.-]+\.js|\.\/[\w.-]+\.js)["'`)]/g)) {
    const raw = m[1];
    const next = raw.startsWith("./") ? path.posix.join(path.posix.dirname(rel), raw) : raw.replace(/^.*assets\//, "assets/");
    if (!seen.has(next)) queue.push(next);
  }
}
// And the other way: the vault page never runs the main app's entry, stores or API client.
const vaultHtml = fs.readFileSync(path.join(dist, "passwords.html"), "utf8");
const mainEntry = /src="\/assets\/(main-[^"]+\.js)"/.exec(html)?.[1];
const vaultQueue = [...vaultHtml.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
const vaultSeen = new Set();
while (vaultQueue.length) {
  const rel = vaultQueue.pop();
  if (vaultSeen.has(rel)) continue;
  vaultSeen.add(rel);
  const file = path.join(dist, rel);
  if (!fs.existsSync(file)) continue;
  if (mainEntry && rel.endsWith(mainEntry)) bad.push(`vault page reaches the main entry through ${rel}`);
  const text = fs.readFileSync(file, "utf8");
  if (text.includes("Loading Promptly...")) bad.push(`${rel}: main app code in the vault's graph`);
  for (const m of text.matchAll(/["'`(/]([\w./-]*?assets\/[\w.-]+\.js|\.\/[\w.-]+\.js)["'`)]/g)) {
    const raw = m[1];
    vaultQueue.push(raw.startsWith("./") ? path.posix.join(path.posix.dirname(rel), raw) : raw.replace(/^.*assets\//, "assets/"));
  }
}
console.log(`Checked ${vaultSeen.size} chunks reachable from the vault page.`);
if (/href="\/manifest\.webmanifest"/.test(vaultHtml)) bad.push("passwords.html: has the main app's manifest");
if (!/<script[^>]+src="\/assets\/passwords-[^"]+\.js"/.test(vaultHtml)) bad.push("passwords.html: no entry script");
if (/<script(?![^>]*\bsrc=)[^>]*>/.test(vaultHtml)) bad.push("passwords.html: inline script would fail the CSP");
console.log(`Checked ${seen.size} chunks reachable from the main app.`);
if (bad.length) {
  console.error(`Vault code in the main app's bundles:\n${bad.join("\n")}`);
  process.exit(1);
}
console.log("No vault crypto in the main app's bundles.");
