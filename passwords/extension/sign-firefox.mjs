// Has Mozilla sign the Firefox build as a self-distributed ("unlisted") add-on, then records it
// in updates.json, which every signed copy checks for new versions (FIREFOX_UPDATE_URL in
// build.mjs). Nothing is published: it prints the release to make, and publish-downloads.mjs
// then puts the signed file on Promptly's Install apps page.
//
//   node build.mjs firefox
//   set WEB_EXT_API_KEY=...   (from https://addons.mozilla.org/developers/addon/api/key/)
//   set WEB_EXT_API_SECRET=...
//   node sign-firefox.mjs
//
// The code is bundled and minified, so Mozilla gets the source it was built from as well.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const ID = "passwords@promptly.app";
const REPO = "tristenlammi/Promptly";
const version = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8")).version;
const tag = `passwords-ext-v${version}`;
const name = `promptly-passwords-firefox-${version}.xpi`;

const src = path.join(here, "dist", "firefox");
const manifest = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8"));
if (manifest.version !== version) throw new Error(`dist/firefox is ${manifest.version}, package.json says ${version}. Run node build.mjs firefox.`);
if (!manifest.browser_specific_settings?.gecko?.update_url) throw new Error("dist/firefox has no update_url: that's a test build. Run node build.mjs firefox.");
if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) throw new Error("Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET to your addons.mozilla.org API key.");

const updatesFile = path.join(here, "updates.json");
const updates = JSON.parse(fs.readFileSync(updatesFile, "utf8"));
const list = updates.addons[ID].updates;
if (list.some((u) => u.version === version)) throw new Error(`${version} is already in updates.json. Bump the version in package.json first.`);

// The source Mozilla's reviewers can rebuild it from: the extension and the frontend it bundles.
const work = path.join(here, "dist", "signing");
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
const source = path.join(work, `source-${version}.zip`);
execFileSync("git", ["archive", "--format=zip", "-o", source, "HEAD", "passwords/extension", "frontend", ":!frontend/public/downloads"], { cwd: root, stdio: "inherit" });

const webExt = path.join(here, "node_modules", "web-ext", "bin", "web-ext.js");
execFileSync(process.execPath, [webExt, "sign", "--channel=unlisted", "--source-dir", src, "--artifacts-dir", work, "--upload-source-code", source, "--approval-timeout", "900000"], {
  cwd: here,
  stdio: "inherit",
  env: process.env,
});

const signed = fs.readdirSync(work).find((f) => f.endsWith(".xpi"));
if (!signed) throw new Error("Mozilla didn't send back a signed file. The output above says why.");
const out = path.join(here, "dist", "signed");
fs.mkdirSync(out, { recursive: true });
const xpi = path.join(out, name);
fs.copyFileSync(path.join(work, signed), xpi);
const hash = createHash("sha256").update(fs.readFileSync(xpi)).digest("hex");

list.push({ version, update_link: `https://github.com/${REPO}/releases/download/${tag}/${name}`, update_hash: `sha256:${hash}` });
fs.writeFileSync(updatesFile, JSON.stringify(updates, null, 2) + "\n");

console.log(`
Signed: ${xpi}
updates.json now lists ${version}.

To publish it:
  1. gh release create ${tag} "${xpi}" --repo ${REPO} --title "Promptly Passwords for Firefox ${version}" --notes "Signed by Mozilla."
  2. Commit passwords/extension/updates.json and push it to main. Firefox copies already installed
     find the new version there, within a day.
  3. In passwords/desktop: node publish-downloads.mjs, so the Install apps page offers this file.
`);
