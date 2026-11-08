// The real app (the e2e build) in real WebView2, driven by tauri-driver and msedgedriver,
// against the isolated :8092 stack with a throwaway account. Run:
//   npm run build:e2e && MSEDGEDRIVER=<path> npm run test:e2e
//
// Differences from a release build, all behind the `e2e` feature: an in-memory clipboard, a
// mocked Hello gate (DPAPI stays real), no global shortcut or single-instance lock, a data
// folder from the environment, and a command to open the overlay. So this doesn't press real
// keys or touch the real clipboard on whoever's desktop it runs on.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Builder, By, until } from "selenium-webdriver";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const frontend = path.resolve(root, "../../frontend");
const BASE = process.env.PW_E2E_URL ?? "http://localhost:8092";
const BACKEND = process.env.PW_BACKEND ?? "PromptlyPw-Backend";
const EXE = path.join(root, "target/debug/promptly-passwords.exe");
const MASTER = "correct horse battery staple 7!";
const ITEM = { title: "Desktop Test Login", username: "ana@example.com", password: "s3cret-desktop-Pw-" + Date.now() };
const BACKUP_PASSWORD = "backup password for tests 1";
const OPENSSH = "C:\\Windows\\System32\\OpenSSH";
const SSH_PIPE = `\\\\.\\pipe\\promptly-e2e-agent-${Date.now()}`;

if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("Only runs against a local stack");
if (!process.env.MSEDGEDRIVER) throw new Error("Set MSEDGEDRIVER to the msedgedriver.exe matching the installed WebView2");

const SEED = `
import asyncio, json, secrets, uuid
import app.db_models
from app.auth.models import User
from app.auth.utils import create_access_token, hash_password
from app.database import SessionLocal

async def main():
    async with SessionLocal() as db:
        s = uuid.uuid4().hex[:10]
        u = User(email=f"pw-desktop-{s}@example.com", username=f"pwdesktop{s}", password_hash=hash_password("Dt-" + secrets.token_urlsafe(16) + "!9"), role="user")
        db.add(u)
        await db.flush()
        print("PW_RESULT " + json.dumps({"token": create_access_token(u.id, token_version=u.token_version)}))
        await db.commit()

asyncio.run(main())
`;

function makeUser() {
  const out = execFileSync("docker", ["exec", "-i", BACKEND, "python", "-"], { input: SEED, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  return JSON.parse(out.split(/\r?\n/).find((l) => l.startsWith("PW_RESULT ")).slice(10));
}

async function loadSeed() {
  const require = createRequire(path.join(frontend, "package.json"));
  const esbuild = await import(pathToFileURL(require.resolve("esbuild")).href);
  const out = path.join(root, ".e2e", "seed.mjs");
  await esbuild.build({ bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "warning", nodePaths: [path.join(frontend, "node_modules")], loader: { ".json": "json" }, entryPoints: [path.join(here, "seed.ts")], outfile: out });
  return import(pathToFileURL(out).href);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "promptly-desktop-e2e-"));
const dataDir = path.join(work, "data");
const backupDir = path.join(work, "backups");

let tauriDriver;
let driver;

async function waitPort(port, ms = 15000) {
  const until_ = Date.now() + ms;
  while (Date.now() < until_) {
    const ok = await new Promise((r) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.destroy();
        r(true);
      });
      s.on("error", () => r(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Nothing on port ${port}`);
}

function startDriver(extraEnv = {}) {
  tauriDriver = spawn("tauri-driver", ["--native-driver", process.env.MSEDGEDRIVER], {
    env: { ...process.env, PROMPTLY_PW_DATA_DIR: dataDir, PROMPTLY_PW_NO_BROWSER: "1", PROMPTLY_PW_NO_REGISTRY: "1", PROMPTLY_PW_SSH_PIPE: SSH_PIPE, ...extraEnv },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

async function openApp(extraEnv = {}) {
  startDriver(extraEnv);
  await waitPort(4444);
  driver = await new Builder()
    .usingServer("http://127.0.0.1:4444/")
    // msedgedriver otherwise points WebView2 at a throwaway profile of its own each session,
    // whatever the app asked for. This keeps it in the folder the app itself uses.
    .withCapabilities({ browserName: "wry", "tauri:options": { application: EXE, webviewOptions: { userDataFolder: path.join(dataDir, "webview") } } })
    .build();
  await driver.manage().setTimeouts({ implicit: 0, script: 30000 });
  await toMain();
}

/** The driver can land on either webview: the app opens two. */
async function toMain() {
  await driver.wait(async () => {
    for (const h of await driver.getAllWindowHandles()) {
      await driver.switchTo().window(h);
      if ((await driver.getTitle()) === "Promptly Passwords") return true;
    }
    return false;
  }, 15000, "the main webview");
}

async function closeApp() {
  try {
    await driver?.quit();
  } catch {
    /* it may already be gone */
  }
  driver = null;
  tauriDriver?.kill();
  tauriDriver = null;
  await new Promise((r) => setTimeout(r, 1500));
}

const invoke = (cmd, args = {}) =>
  driver.executeAsyncScript(
    `const [cmd, args, done] = arguments;
     window.__TAURI_INTERNALS__.invoke(cmd, args).then((v) => done({ ok: true, v }), (e) => done({ ok: false, e: String(e) }));`,
    cmd,
    args,
  );

const xp = (s) => By.xpath(s);
const byText = (tag, text) => xp(`//${tag}[normalize-space()=${JSON.stringify(text)}]`);
const byLabel = (text) => xp(`//label[.//span[normalize-space()=${JSON.stringify(text)}]]//input | //input[@aria-label=${JSON.stringify(text)}] | //textarea[@aria-label=${JSON.stringify(text)}]`);

async function el(locator, ms = 30000) {
  const e = await driver.wait(until.elementLocated(locator), ms);
  await driver.wait(until.elementIsVisible(e), ms);
  return e;
}
const click = async (locator, ms) => (await el(locator, ms)).click();
async function fill(locator, value) {
  const e = await el(locator);
  await e.clear();
  await e.sendKeys(value);
}
const pageText = () => driver.findElement(By.css("body")).getText();
async function see(text, ms = 30000) {
  try {
    await driver.wait(async () => (await pageText()).includes(text), ms);
  } catch {
    const logs = await driver.manage().logs().get("browser").catch(() => []);
    throw new Error(`Never saw "${text}". The page says: ${(await pageText()).slice(0, 400)}\nConsole: ${logs.map((l) => l.message).join("\n").slice(0, 1500)}`);
  }
}

let seed;
let user;
let other;

before(async () => {
  assert.ok(fs.existsSync(EXE), `Build it first: ${EXE}`);
  seed = await loadSeed();
  user = makeUser();
  other = await seed.createVault(BASE, user.token, MASTER);
  await openApp();
});

// So one failure in the overlay doesn't take every later test with it.
afterEach(async () => {
  if (driver) await toMain().catch(() => undefined);
});

after(async () => {
  await closeApp();
  fs.rmSync(work, { recursive: true, force: true });
});

test("the page's CSP is what the plan says, and it has no network of its own", async () => {
  const r = await driver.executeAsyncScript(`
    const done = arguments[0];
    (async () => {
      const out = {};
      // In a timer: code the driver runs directly is exempted from the eval rule.
      out.eval = await new Promise((r) => setTimeout(() => { try { (0, eval)("1+1"); r("allowed"); } catch { r("blocked"); } }, 0));
      out.func = await new Promise((r) => setTimeout(() => { try { new Function("return 1")(); r("allowed"); } catch { r("blocked"); } }, 0));
      window.__inline = false;
      const s = document.createElement("script");
      s.textContent = "window.__inline = true";
      document.head.append(s);
      out.inline = window.__inline ? "allowed" : "blocked";
      for (const [name, url] of [["server", "${BASE}/api/health"], ["remote", "https://example.com/"]]) {
        try { await fetch(url); out[name] = "allowed"; } catch { out[name] = "blocked"; }
      }
      const w = new Uint8Array([0,97,115,109,1,0,0,0]);
      try { await WebAssembly.instantiate(w); out.wasm = "allowed"; } catch { out.wasm = "blocked"; }
      out.origin = location.origin;
      done(out);
    })();
  `);
  assert.deepEqual(r, { eval: "blocked", func: "blocked", inline: "blocked", server: "blocked", remote: "blocked", wasm: "allowed", origin: "http://tauri.localhost" });
});

test("Rust refuses anything but the connected server's vault API", async () => {
  const meta = (o) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const call = (m) =>
    driver.executeAsyncScript(
      `const [m, done] = arguments;
       window.__TAURI_INTERNALS__.invoke("net_fetch", new Uint8Array(0), { headers: { "x-meta": m } }).then(() => done("sent"), (e) => done(String(e)));`,
      meta(m),
    );
  assert.equal(await invoke("connection_begin", { server: "http://example.org" }).then((x) => x.ok), false, "plain http to a remote host");
  assert.equal((await invoke("connection_begin", { server: BASE })).v, BASE);
  assert.match(await call({ url: "https://evil.example.org/api/passwords/account", method: "GET" }), /isn't the vault API/);
  assert.match(await call({ url: `${BASE}/api/auth/me`, method: "GET" }), /isn't the vault API/);
  assert.match(await call({ url: `${BASE}/api/passwords/../auth/me`, method: "GET" }), /isn't the vault API/);
  assert.match(await call({ url: `${BASE}/api/passwords/account`, method: "TRACE" }), /isn't used/);
});

test("connect by device token, approved on the server", async () => {
  await fill(byLabel("Your server's address"), BASE);
  await click(byText("button", "Connect"));
  const code = await (await el(By.css('[data-testid="connect-code"]'))).getText();
  assert.match(code, /\S+/);
  await seed.approveConnect(BASE, user.token, code);
  await see("Add this device");
  // Once connected, the address can't be changed to send the token somewhere else.
  const moved = await invoke("connection_begin", { server: "https://evil.example.org" });
  assert.equal(moved.ok, false);
  assert.match(moved.e, /already connected/);
  // The page never gets the token back.
  const c = await invoke("connection_get");
  assert.equal(c.v.server, BASE);
  assert.equal(c.v.token, undefined);
  const wrapped = fs.readFileSync(path.join(dataDir, "device-token.bin"));
  assert.ok(wrapped.length > 32, "stored wrapped");
  assert.ok(!fs.readFileSync(path.join(dataDir, "desktop.json"), "utf8").includes("token\""), "no token in settings");
});

test("kit join: a wrong password fails, the right one works", async () => {
  await click(byText("button", "Use my recovery kit"));
  await fill(byLabel("Secret Key"), other.secretKeyText);
  await fill(byLabel("Master password"), "not the master password");
  await click(byText("button", "Unlock"));
  await see("isn't right");
  await fill(byLabel("Master password"), MASTER);
  await click(byText("button", "Unlock"));
  await see("Your vault is locked");
});

test("unlock with the master password, with the Preview badge showing", async () => {
  await fill(byLabel("Master password"), "wrong wrong wrong wrong");
  await click(byText("button", "Unlock"));
  await see("That master password isn't right");
  await fill(byLabel("Master password"), MASTER);
  await click(byText("button", "Unlock"));
  await el(By.css('nav[aria-label="Passwords"]'));
  await el(By.css('[data-testid="preview-badge"]'));
});

test("add an item, and it reaches the server encrypted and readable on another client", async () => {
  await click(byText("button", "New"));
  await click(xp(`//button[@role="menuitem"][normalize-space()="Login"]`));
  await fill(byLabel("Name"), ITEM.title);
  await fill(byLabel("Username or email"), ITEM.username);
  await fill(byLabel("Password"), ITEM.password);
  await click(byText("button", "Save"));
  await el(xp(`//article[@aria-label=${JSON.stringify(ITEM.title)}]`));
  await click(xp(`//button[contains(normalize-space(),"Sync now")]`));
  await see("Synced");
  await driver.wait(async () => (await seed.titlesOnServer(other.vault)).some((i) => i.title === ITEM.title), 30000, "reaches the other client");
  const got = (await seed.titlesOnServer(other.vault)).find((i) => i.title === ITEM.title);
  assert.equal(got.password, ITEM.password);
});

test("clipboard: a secret copy is marked, clears itself, and leaves later copies alone", async () => {
  const peek = async () => (await invoke("e2e_clipboard")).v;
  await invoke("clipboard_copy", { text: "x-secret", sensitive: true, seconds: 5 });
  assert.deepEqual(await peek(), { text: "x-secret", secret: true });
  await new Promise((r) => setTimeout(r, 6000));
  assert.equal((await peek()).text, null, "cleared");

  await invoke("clipboard_copy", { text: "x-secret-2", sensitive: true, seconds: 5 });
  await invoke("clipboard_copy", { text: "plain", sensitive: false });
  await new Promise((r) => setTimeout(r, 6000));
  assert.deepEqual(await peek(), { text: "plain", secret: false }, "someone's later copy stays");
});

test("quick search overlay: find, Enter copies, and it never holds the secret", async () => {
  const main = await driver.getWindowHandle();
  assert.equal((await invoke("e2e_open_overlay")).ok, true);
  let overlay;
  await driver.wait(async () => {
    for (const h of await driver.getAllWindowHandles()) {
      if (h === main) continue;
      await driver.switchTo().window(h);
      if ((await driver.getTitle()) === "Promptly quick search") {
        overlay = h;
        return true;
      }
    }
    return false;
  }, 15000, "the overlay's webview");

  const q = await el(By.css("#q"));
  await q.sendKeys(ITEM.title.slice(0, 12));
  // The list is rebuilt as results arrive, so look for the text and not an element.
  await see(ITEM.title);
  assert.ok(!(await driver.getPageSource()).includes(ITEM.password), "no password in the overlay's page");

  // The overlay can't reach what only the main page can.
  for (const cmd of ["hello_unlock", "connection_get", "backup_password_get", "e2e_clipboard"]) {
    const r = await invoke(cmd);
    assert.equal(r.ok, false, cmd);
    assert.match(r.e, /Not allowed from this window/, cmd);
  }
  // And a made-up gesture does nothing.
  const fake = await invoke("overlay_act", { token: "made-up", id: "x", action: "copy", confirmed: false });
  assert.equal(fake.ok, false);

  // Auto-type with no target window is refused without a key being sent. Gesture path only.
  await q.sendKeys(await ctrlEnter());
  await driver.wait(async () => (await (await driver.findElement(By.css("#feedback"))).getText()).includes("no window"), 15000, "says there's no target");

  // Enter copies, then the overlay closes itself.
  await q.sendKeys("");
  await driver.switchTo().window(main);
  await driver.wait(async () => (await invoke("e2e_clipboard")).v.text === ITEM.password, 15000, "the password was copied");
  assert.equal((await invoke("e2e_clipboard")).v.secret, true);
  await driver.switchTo().window(overlay);
  await driver.wait(async () => (await driver.findElement(By.css("#results")).getText()) === "", 15000, "results cleared on close");
  await driver.switchTo().window(main);
});

async function ctrlEnter() {
  const { Key } = await import("selenium-webdriver");
  return Key.chord(Key.CONTROL, Key.ENTER);
}

test("auto-type refuses a call with no real gesture", async () => {
  const r = await invoke("autotype_perform", { token: "made-up", titles: ["x"], username: "a", password: "b", confirmed: true });
  assert.equal(r.v.outcome, "failed");
  assert.match(r.v.message, /shortcut/);
});

test("Hello with a mocked gate and real DPAPI: on, refused, then unlocks", async () => {
  await invoke("e2e_open_settings");
  await see("Desktop settings");
  await fill(byLabel("Master password for Hello"), "wrong wrong wrong");
  await click(byText("button", "Turn on Windows Hello"));
  await see("isn't right");
  await fill(byLabel("Master password for Hello"), MASTER);
  await click(byText("button", "Turn on Windows Hello"));
  await el(By.css('[data-testid="hello-on"]'));
  assert.ok(fs.existsSync(path.join(dataDir, "hello.bin")));
  await driver.actions().sendKeys("").perform(); // Esc closes the dialog
  await click(xp(`//nav[@aria-label="Passwords"]//button[contains(normalize-space(),"Lock")]`));
  await see("Your vault is locked");

  await invoke("e2e_hello_answer", { approve: false });
  await click(byText("button", "Unlock with Windows Hello"));
  await see("didn't confirm");
  await invoke("e2e_hello_answer", { approve: true });
  await click(byText("button", "Unlock with Windows Hello"));
  await el(By.css('nav[aria-label="Passwords"]'));
});

test("a PIN unlocks for this run of the app, and wrong tries are counted", async () => {
  await click(xp(`//nav[@aria-label="Passwords"]//button[contains(normalize-space(),"Settings")]`));
  const boxes = await driver.wait(async () => {
    const found = await driver.findElements(By.css('[data-testid="pin"] input[type="password"]'));
    return found.length === 2 ? found : null;
  }, 30000, "PIN boxes");
  await boxes[0].sendKeys(MASTER);
  await boxes[1].sendKeys("482193");
  await click(byText("button", "Set PIN"));
  await see("Remove my PIN");
  await click(xp(`//nav[@aria-label="Passwords"]//button[contains(normalize-space(),"Lock")]`));
  await see("Your vault is locked");
  await fill(By.css('input[aria-label="PIN"]'), "000000");
  await click(byText("button", "Use PIN"));
  await see("4 tries left");
  await fill(By.css('input[aria-label="PIN"]'), "482193");
  await click(byText("button", "Use PIN"));
  await el(By.css('nav[aria-label="Passwords"]'));
  await click(xp(`//nav[@aria-label="Passwords"]//button[contains(normalize-space(),"All items")]`));
});

test("backup: encrypted file in the chosen folder, opened by the core's reader", async () => {
  await invoke("e2e_open_settings");
  await see("Backup");
  const folder = await el(byLabel("Backup folder"));
  await folder.clear();
  await folder.sendKeys(backupDir);
  await (await el(byLabel("Back up on a schedule"))).click();
  await driver.wait(async () => (await invoke("backup_status")).v.enabled && (await invoke("backup_status")).v.dir === backupDir, 10000, "settings saved");
  await fill(byLabel("Backup password"), BACKUP_PASSWORD);
  await fill(byLabel("Backup password again"), BACKUP_PASSWORD);
  await click(byText("button", "Save password"));
  await driver.wait(async () => (await invoke("backup_status")).v.has_password, 10000, "password saved");
  await click(byText("button", "Back up now"));
  await el(By.css('[data-testid="backup-note"]'), 30000);

  // The note above can be the one from saving the password, so wait for the file itself.
  await driver.wait(async () => fs.existsSync(backupDir) && fs.readdirSync(backupDir).length > 0, 30000, 'backup file');
  const files = fs.readdirSync(backupDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^promptly-vault-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
  const text = fs.readFileSync(path.join(backupDir, files[0]), "utf8");
  assert.ok(!text.includes(ITEM.password) && !text.includes(ITEM.title), "nothing readable in the file");
  const opened = await seed.openBackup(text, BACKUP_PASSWORD);
  assert.ok(opened.items.some((i) => i.body.title === ITEM.title && i.body.password === ITEM.password));
  await assert.rejects(seed.openBackup(text, "the wrong password here"));

  // Writing anything that isn't an encrypted export is refused.
  const plain = await invoke("backup_save", { data: JSON.stringify({ format: "promptly-pw-plain", version: 1, items: [] }), stamp: "2026-01-01-0000" });
  assert.equal(plain.ok, false);
  assert.equal(fs.readdirSync(backupDir).length, 1);
  await driver.actions().sendKeys("").perform();
});

test("SSH agent status is reported, and stays off by default", async () => {
  const s = await invoke("ssh_status");
  assert.equal(s.v.enabled, false);
  assert.equal(s.v.running, false);
});

// Real ssh-add and ssh-keygen, through the app's Rust and its page, on a pipe of its own.
const sshTool = (name, args, input) =>
  new Promise((resolve) => {
    const c = spawn(path.join(OPENSSH, name), args, { env: { ...process.env, SSH_AUTH_SOCK: SSH_PIPE }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code, out }));
    c.stdin.end(input ?? "");
  });

test("SSH agent: lists a key from the vault, signs when approved, and not when refused", async () => {
  const keyFile = path.join(work, "id_test");
  execFileSync(path.join(OPENSSH, "ssh-keygen.exe"), ["-q", "-t", "ed25519", "-N", "", "-C", "e2e", "-f", keyFile]);
  const pub = fs.readFileSync(`${keyFile}.pub`, "utf8").trim();
  await seed.addSshItem(other.vault, "E2E SSH key", pub, fs.readFileSync(keyFile, "utf8"));
  await click(xp(`//button[contains(normalize-space(),"Sync now")]`));
  await see("E2E SSH key");

  const on = await invoke("ssh_set", { on: true });
  assert.equal(on.v.running, true, JSON.stringify(on));
  await driver.wait(async () => (await sshTool("ssh-add.exe", ["-L"])).out.includes(pub.split(" ")[1]), 15000, "ssh-add -L lists the key");

  const msg = path.join(work, "signed.txt");
  fs.writeFileSync(msg, "signed through the app");
  const signed = await sshTool("ssh-keygen.exe", ["-Y", "sign", "-n", "file", "-U", "-f", `${keyFile}.pub`, msg]);
  assert.equal(signed.code, 0, signed.out);
  const allowed = path.join(work, "allowed");
  fs.writeFileSync(allowed, `me@test ${pub}\n`);
  const verified = await sshTool("ssh-keygen.exe", ["-Y", "verify", "-n", "file", "-I", "me@test", "-f", allowed, "-s", `${msg}.sig`], fs.readFileSync(msg));
  assert.equal(verified.code, 0, verified.out);

  await invoke("e2e_ssh_approve", { approve: false });
  fs.rmSync(`${msg}.sig`);
  const refused = await sshTool("ssh-keygen.exe", ["-Y", "sign", "-n", "file", "-U", "-f", `${keyFile}.pub`, msg]);
  assert.notEqual(refused.code, 0);
  assert.ok(!fs.existsSync(`${msg}.sig`));
  await invoke("e2e_ssh_approve", { approve: true });
});

// ---- Quick search on items with limits ----

async function openOverlay() {
  assert.equal((await invoke("e2e_open_overlay")).ok, true);
  const main = await driver.getWindowHandle();
  await driver.wait(async () => {
    for (const h of await driver.getAllWindowHandles()) {
      await driver.switchTo().window(h);
      if ((await driver.getTitle()) === "Promptly quick search") return true;
    }
    return false;
  }, 15000, "the overlay's webview");
  return main;
}

async function overlaySays(text) {
  await driver.wait(async () => (await driver.findElement(By.css("#feedback")).getText()).includes(text), 15000, `the overlay saying: ${text}`);
}

async function syncInApp(title) {
  await click(xp(`//nav[@aria-label="Passwords"]//button[contains(normalize-space(),"All items")]`));
  await click(xp(`//button[contains(normalize-space(),"Sync now")]`));
  await see(title);
  // The quick search client re-reads the local copy once the sync has settled.
  await new Promise((r) => setTimeout(r, 1500));
}

const altEnter = async () => {
  const { Key } = await import("selenium-webdriver");
  return Key.chord(Key.ALT, Key.ENTER);
};

test("fill-only vault: quick search won't copy the password or 2FA code, and can still type", async () => {
  const FILL = { title: "Fill Only Login", username: "fill@example.com", password: "fill-only-Pw-" + Date.now(), totpSecret: "JBSWY3DPEHPK3PXP" };
  const sharerUser = makeUser();
  const sharer = await seed.createVault(BASE, sharerUser.token, "the sharer's master password 9!");
  await seed.shareFillOnly(sharer.vault, other.vault, FILL);
  await syncInApp(FILL.title);

  await invoke("clipboard_copy", { text: "baseline", sensitive: false });
  const main = await openOverlay();
  const q = await el(By.css("#q"));
  await q.sendKeys(FILL.title);
  await see(FILL.title);

  await q.sendKeys("\uE007");
  await overlaySays("not copy");
  await q.sendKeys(await altEnter());
  await overlaySays("not copy");
  // Nor type the code, which would put it on screen.
  await q.sendKeys((await import("selenium-webdriver")).Key.chord("\uE009", "\uE00A", "\uE007"));
  await overlaySays("stays hidden");
  // And a plain login gets past that check to the window it would type into, so the action is
  // really allowed through by the native side.
  // Auto-type gets past the role check, and stops at having no target window.
  await q.sendKeys(await ctrlEnter());
  await overlaySays("no window");
  await invoke("overlay_close");
  await driver.switchTo().window(main);
  assert.equal((await invoke("e2e_clipboard")).v.text, "baseline", "neither the password nor the code was copied");

  // The scheduled backup leaves them out too: its password is one the person knows.
  await invoke("e2e_open_settings");
  fs.rmSync(backupDir, { recursive: true, force: true });
  await click(byText("button", "Back up now"));
  await driver.wait(async () => fs.existsSync(backupDir) && fs.readdirSync(backupDir).length > 0, 15000, "a backup file");
  const newest = fs.readdirSync(backupDir).sort().at(-1);
  const opened = await seed.openBackup(fs.readFileSync(path.join(backupDir, newest), "utf8"), BACKUP_PASSWORD);
  assert.ok(opened.items.some((i) => i.body.title === ITEM.title), "own items are in it");
  assert.ok(!opened.items.some((i) => i.body.title === FILL.title), "the fill-only item isn't");
  await driver.actions().sendKeys("\uE00C").perform();
});

test("reprompt items: quick search won't copy or type them, and the SSH agent doesn't offer them", async () => {
  const LOGIN = { title: "Reprompt Login", username: "ask@example.com", password: "reprompt-Pw-" + Date.now(), reprompt: true };
  await seed.addLogin(other.vault, LOGIN);
  const keyFile = path.join(work, "id_reprompt");
  execFileSync(path.join(OPENSSH, "ssh-keygen.exe"), ["-q", "-t", "ed25519", "-N", "", "-C", "e2e-reprompt", "-f", keyFile]);
  const pub = fs.readFileSync(`${keyFile}.pub`, "utf8").trim();
  await seed.addRepromptSshItem(other.vault, "Reprompt SSH key", pub, fs.readFileSync(keyFile, "utf8"));
  await syncInApp(LOGIN.title);

  await invoke("clipboard_copy", { text: "baseline-2", sensitive: false });
  const main = await openOverlay();
  const q = await el(By.css("#q"));
  await q.sendKeys(LOGIN.title);
  await see(LOGIN.title);
  await q.sendKeys("\uE007");
  await overlaySays("master password");
  await q.sendKeys(await altEnter());
  await overlaySays("master password");
  await driver.executeScript('document.getElementById("feedback").textContent = ""');
  await q.sendKeys(await ctrlEnter());
  await overlaySays("master password");
  await invoke("overlay_close");
  await driver.switchTo().window(main);
  assert.equal((await invoke("e2e_clipboard")).v.text, "baseline-2");

  // The agent still has the ordinary key from the test before, and not this one.
  const listed = await sshTool("ssh-add.exe", ["-L"]);
  assert.ok(listed.out.includes("ssh-ed25519"), listed.out);
  assert.ok(!listed.out.includes(pub.split(" ")[1]), "not offered");
  const msg = path.join(work, "reprompt.txt");
  fs.writeFileSync(msg, "should not get signed");
  const signed = await sshTool("ssh-keygen.exe", ["-Y", "sign", "-n", "file", "-U", "-f", `${keyFile}.pub`, msg]);
  assert.notEqual(signed.code, 0, "approval is switched on, and it still can't sign");
  assert.ok(!fs.existsSync(`${msg}.sig`));
});

test("a new device's request shows up in the window and on the tray", async () => {
  await click(xp(`//nav[@aria-label="Passwords"]//button[contains(normalize-space(),"All items")]`));
  const name = "Someone's New Phone";
  const request = await seed.newDeviceRequest(other.vault, name);
  const notice = await el(By.css('[data-testid="device-request"]'), 40000);
  assert.match(await notice.getText(), /Someone's New Phone wants to join your vault/);
  assert.match((await invoke("e2e_device_notice")).v, /Someone's New Phone wants to join your vault/);

  await click(By.xpath(`//*[@data-testid="device-request"]//button[normalize-space()="Review"]`));
  await see("Devices");
  await see("wants to join your vault");
  assert.equal((await driver.findElements(By.css('[data-testid="device-request"]'))).length, 0, "the Devices screen lists it itself");

  await other.vault.api.deviceRequestDeny(request.id);
  await driver.wait(async () => (await invoke("e2e_device_notice")).v === null, 40000, "the tray notice clears once it's answered");
  await click(xp(`//nav[@aria-label="Passwords"]//button[contains(normalize-space(),"All items")]`));
  assert.equal((await driver.findElements(By.css('[data-testid="device-request"]'))).length, 0);
});

test("lock from the app", async () => {
  await click(xp(`//nav[@aria-label="Passwords"]//button[contains(normalize-space(),"Lock")]`));
  await see("Your vault is locked");
  const listed = await sshTool("ssh-add.exe", ["-L"]);
  assert.ok(!listed.out.includes("ssh-ed25519"), "locked: the agent offers nothing");
  assert.equal((await invoke("ssh_set", { on: false })).v.running, false);
});

test("nothing readable on disk after locking", async () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const needles = [ITEM.password, ITEM.title, MASTER, BACKUP_PASSWORD, other.secretKeyText].map((s) => Buffer.from(s));
  const utf16 = [ITEM.password, MASTER, BACKUP_PASSWORD].map((s) => Buffer.from(s, "utf16le"));
  await new Promise((r) => setTimeout(r, 2000));
  assert.ok(walk(dataDir).some((f) => /IndexedDB/.test(f)), "the offline copy really is in the folder being scanned");
  const hits = [];
  for (const f of walk(dataDir)) {
    let b;
    try {
      b = fs.readFileSync(f);
    } catch {
      continue; // locked by WebView2
    }
    for (const n of [...needles, ...utf16]) if (b.includes(n)) hits.push(`${path.relative(dataDir, f)}: ${n.toString().slice(0, 8)}…`);
  }
  assert.deepEqual(hits, []);
});

test("restart: still connected, and locked, and the item's there", async () => {
  await closeApp();
  await openApp();
  await see("Your vault is locked");
  await fill(byLabel("Master password"), MASTER);
  await click(byText("button", "Unlock"));
  await el(By.css('nav[aria-label="Passwords"]'));
  await see(ITEM.title);
});

test("the tray's Lock and the machine waking both lock everything", async () => {
  for (const event of ["app:lock", "power:resumed"]) {
    await invoke("e2e_emit", { event });
    await see("Your vault is locked");
    await fill(byLabel("Master password"), MASTER);
    await click(byText("button", "Unlock"));
    await el(By.css('nav[aria-label="Passwords"]'));
    await see(ITEM.title);
  }
  await click(xp(`//nav[@aria-label="Passwords"]//button[contains(normalize-space(),"Lock")]`));
  await see("Your vault is locked");
});

test("offline: server unreachable, the vault still opens from this computer's copy", async () => {
  await closeApp();
  await openApp({ PROMPTLY_PW_OFFLINE: "1" });
  await see("Your vault is locked");
  await see("can't be reached");
  await fill(byLabel("Master password"), MASTER);
  await click(byText("button", "Unlock"));
  await el(By.css('nav[aria-label="Passwords"]'));
  await see(ITEM.title);
});

test("after quitting, with nothing holding files open: still nothing readable on disk", async () => {
  await closeApp();
  await new Promise((r) => setTimeout(r, 2000));
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const texts = [ITEM.password, ITEM.title, MASTER, BACKUP_PASSWORD, other.secretKeyText];
  const needles = [...texts.map((s) => Buffer.from(s)), ...texts.map((s) => Buffer.from(s, "utf16le"))];
  const hits = [];
  const unread = [];
  for (const f of walk(dataDir)) {
    let b;
    try {
      b = fs.readFileSync(f);
    } catch {
      unread.push(path.relative(dataDir, f));
      continue;
    }
    for (const n of needles) if (b.includes(n)) hits.push(path.relative(dataDir, f));
  }
  assert.deepEqual(hits, []);
  assert.deepEqual(unread, [], "every file could be read");
});
