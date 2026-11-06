// Real Firefox through Selenium and geckodriver. Playwright's own Firefox build
// won't start on this machine (see passwords/DECISIONS.md), and it has no real
// add-on support anyway, so the Firefox side of the suite lives here.
import { execFileSync } from "node:child_process";
import http from "node:http";
import { Builder, By, until } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";

export const BACKEND = process.env.PW_BACKEND ?? "PromptlyPw-Backend";
export const BASE = process.env.PW_E2E_URL ?? "http://localhost:8092";
export const MASTER = "correct horse battery staple 7!";

const SEED = `
import asyncio, json, os, secrets, uuid
import app.db_models
from app.auth.models import User
from app.auth.utils import create_refresh_token, create_access_token, hash_password
from app.database import SessionLocal

async def main():
    out = []
    async with SessionLocal() as db:
        for tag in os.environ["PW_USERS"].split(","):
            s = uuid.uuid4().hex[:10]
            password = "E2e-" + secrets.token_urlsafe(16) + "!9"
            u = User(email=f"pw-ff-{tag}-{s}@example.com", username=f"pwff{tag}{s}", password_hash=hash_password(password), role=os.environ.get("PW_ROLE", "user"))
            db.add(u)
            await db.flush()
            out.append({"tag": tag, "id": str(u.id), "username": u.username, "password": password,
                        "refresh": create_refresh_token(u.id, token_version=u.token_version),
                        "access": create_access_token(u.id, token_version=u.token_version)})
        await db.commit()
    print("PW_RESULT " + json.dumps(out))

asyncio.run(main())
`;

export function makeUsers(tags, role = "user") {
  const out = execFileSync("docker", ["exec", "-i", "-e", `PW_USERS=${tags.join(",")}`, "-e", `PW_ROLE=${role}`, BACKEND, "python", "-"], {
    input: SEED,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const line = out.split(/\r?\n/).find((l) => l.startsWith("PW_RESULT "));
  if (!line) throw new Error(out);
  return JSON.parse(line.slice("PW_RESULT ".length));
}

export async function newFirefox({ headless = true, prefs = {} } = {}) {
  const options = new firefox.Options();
  if (headless) options.addArguments("-headless");
  options.setPreference("dom.serviceWorkers.testing.enabled", true);
  options.setPreference("browser.aboutConfig.showWarning", false);
  for (const [k, v] of Object.entries(prefs)) options.setPreference(k, v);
  // Needed for WebDriver to drive our own moz-extension:// pages.
  const service = new firefox.ServiceBuilder().addArguments("--allow-system-access");
  return new Builder().forBrowser("firefox").setFirefoxOptions(options).setFirefoxService(service).build();
}

/** A local pass-through to the stack that can be switched off, for real offline tests. */
export function startProxy(target = BASE) {
  const t = new URL(target);
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const up = http.request({ host: t.hostname, port: t.port, path: req.url, method: req.method, headers: { ...req.headers, host: t.host } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.destroy());
    req.pipe(up);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        url: `http://localhost:${port}`,
        port,
        off: () =>
          new Promise((r) => {
            server.close(() => r());
            for (const s of sockets) s.destroy();
          }),
        on: () => new Promise((r) => server.listen(port, "127.0.0.1", () => r())),
      });
    }),
  );
}

export async function signIn(driver, user, base = BASE) {
  await driver.get(`${base}/favicon.png`);
  await driver.manage().addCookie({ name: "promptly_refresh", value: user.refresh, path: "/api/auth", httpOnly: true, sameSite: "Strict" });
}

export const byText = (text, tag = "*") => By.xpath(`//${tag}[contains(normalize-space(.), ${JSON.stringify(text)})]`);
export const button = (text) => By.xpath(`//button[normalize-space(.)=${JSON.stringify(text)} or @aria-label=${JSON.stringify(text)}]`);
export const labelled = (text) => By.xpath(`//label[.//span[normalize-space(.)=${JSON.stringify(text)}]]//*[self::input or self::textarea or self::select]`);

export async function see(driver, locator, timeout = 30000) {
  const el = await driver.wait(until.elementLocated(locator), timeout);
  await driver.wait(until.elementIsVisible(el), timeout);
  return el;
}

export async function click(driver, locator, timeout = 30000) {
  const el = await see(driver, locator, timeout);
  await driver.wait(until.elementIsEnabled(el), timeout);
  await el.click();
}

export async function fill(driver, locator, value) {
  const el = await see(driver, locator);
  await el.clear();
  await el.sendKeys(value);
}

export async function onboard(driver, base = BASE, master = MASTER) {
  await driver.get(`${base}/passwords`);
  await click(driver, byText("I understand", "label"));
  await click(driver, button("Continue"));
  await fill(driver, labelled("Master password"), master);
  await fill(driver, labelled("Type it again"), master);
  await click(driver, button("Create vault"));
  const keyEl = await see(driver, By.css('[data-testid="secret-key"]'), 60000);
  const secret = (await keyEl.getText()).trim();
  await click(driver, byText("I've saved my recovery kit", "label"));
  await click(driver, button("Continue"));
  await fill(driver, labelled("Last group of your Secret Key"), secret.slice(secret.lastIndexOf("-") + 1));
  await click(driver, button("Finish"));
  await click(driver, button("Open my vault"));
  await see(driver, By.css('nav[aria-label="Passwords"]'));
  return secret;
}

export async function unlock(driver, master = MASTER) {
  await fill(driver, labelled("Master password"), master);
  await click(driver, button("Unlock"));
  await see(driver, By.css('nav[aria-label="Passwords"]'), 60000);
}

export async function addLogin(driver, { title, username, password, url, otp }) {
  await click(driver, button("New"));
  await click(driver, By.xpath('//*[@role="menuitem"][normalize-space(.)="Login"]'));
  await fill(driver, labelled("Name"), title);
  if (username) await fill(driver, labelled("Username or email"), username);
  if (password) await fill(driver, labelled("Password"), password);
  if (url) await fill(driver, By.css('input[aria-label="Website 1"]'), url);
  if (otp) await fill(driver, labelled("2FA secret or otpauth link"), otp);
  await click(driver, button("Save"));
  await see(driver, By.css(`article[aria-label=${JSON.stringify(title)}]`));
}
