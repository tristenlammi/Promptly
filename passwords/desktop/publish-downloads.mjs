// Copies the built installer and the extension's zips to frontend/public/downloads, with the
// version files the install page reads. Run after `cargo tauri build` and, in passwords/extension,
// `node build.mjs all`. The same job android/build-release.ps1 does for the APK.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../../frontend/public/downloads");
const version = JSON.parse(fs.readFileSync(path.join(here, "src-tauri/tauri.conf.json"), "utf8")).version;
const extVersion = JSON.parse(fs.readFileSync(path.join(here, "../extension/package.json"), "utf8")).version;

function publish(from, name) {
  if (!fs.existsSync(from)) throw new Error(`Build it first: ${from}`);
  const to = path.join(out, name);
  fs.copyFileSync(from, to);
  const data = fs.readFileSync(to);
  return { file: name, size_bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
}

const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + "\n");

const setup = publish(path.join(here, `target/release/bundle/nsis/Promptly Passwords_${version}_x64-setup.exe`), "PromptlyPasswords-Setup.exe");
write("PromptlyPasswords.json", { version, ...setup });

const chrome = publish(path.join(here, `../extension/dist/promptly-passwords-chrome-${extVersion}.zip`), "promptly-passwords-chrome.zip");
const firefox = publish(path.join(here, `../extension/dist/promptly-passwords-firefox-${extVersion}.zip`), "promptly-passwords-firefox.zip");
write("PromptlyPasswordsExtension.json", { version: extVersion, chrome, firefox });

console.log(`published installer ${version} (${setup.size_bytes} bytes), extension ${extVersion} (${chrome.size_bytes} and ${firefox.size_bytes} bytes)`);
