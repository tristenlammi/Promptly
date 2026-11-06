// Fresh throwaway users on the isolated stack, signed in by a minted refresh cookie.
// The master password flow goes through the real UI.
import { execFileSync } from "node:child_process";

import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";

export const BACKEND = process.env.PW_BACKEND ?? "PromptlyPw-Backend";
export const BASE = process.env.PW_E2E_URL ?? "http://localhost:8092";

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
            u = User(email=f"pw-e2e-{tag}-{s}@example.com", username=f"pwe2e{tag}{s}", password_hash=hash_password(password), role=os.environ.get("PW_ROLE", "user"))
            db.add(u)
            await db.flush()
            out.append({"tag": tag, "id": str(u.id), "username": u.username, "password": password,
                        "refresh": create_refresh_token(u.id, token_version=u.token_version),
                        "access": create_access_token(u.id, token_version=u.token_version)})
        await db.commit()
    print("PW_RESULT " + json.dumps(out))

asyncio.run(main())
`;

export type User = { tag: string; id: string; username: string; password: string; refresh: string; access: string };

export function makeUsers(tags: string[], role = "user"): User[] {
  const out = execFileSync("docker", ["exec", "-i", "-e", `PW_USERS=${tags.join(",")}`, "-e", `PW_ROLE=${role}`, BACKEND, "python", "-"], {
    input: SEED,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const line = out.split(/\r?\n/).find((l) => l.startsWith("PW_RESULT "));
  if (!line) throw new Error(out);
  return JSON.parse(line.slice("PW_RESULT ".length));
}

export async function signedIn(browser: Browser, user: User, opts: Parameters<Browser["newContext"]>[0] = {}): Promise<BrowserContext> {
  const host = new URL(BASE).hostname;
  return browser.newContext({
    ...opts,
    storageState: {
      cookies: [
        { name: "promptly_refresh", value: user.refresh, domain: host, path: "/api/auth", expires: Math.floor(Date.now() / 1000) + 86400, httpOnly: true, secure: false, sameSite: "Strict" },
      ],
      origins: [],
    },
  });
}

export const MASTER = "correct horse battery staple 7!";

export async function onboard(page: Page, master = MASTER): Promise<string> {
  await page.goto("/passwords");
  await page.getByText("I understand").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Master password").fill(master);
  await page.getByLabel("Type it again").fill(master);
  await page.getByRole("button", { name: "Create vault" }).click();
  const key = page.getByTestId("secret-key");
  await expect(key).toBeVisible({ timeout: 30_000 });
  const secret = (await key.textContent())!.trim();
  await page.getByText("I've saved my recovery kit").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Last group of your Secret Key").fill(secret.slice(secret.lastIndexOf("-") + 1));
  await page.getByRole("button", { name: "Finish" }).click();
  await page.getByRole("button", { name: "Open my vault" }).click();
  await expect(page.getByRole("navigation", { name: "Passwords" })).toBeVisible();
  return secret;
}

export async function addLogin(page: Page, fields: { title: string; username?: string; password?: string; url?: string; otp?: string }) {
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Login" }).click();
  await page.getByLabel("Name", { exact: true }).fill(fields.title);
  if (fields.username) await page.getByLabel("Username or email").fill(fields.username);
  if (fields.password) await page.getByLabel("Password", { exact: true }).fill(fields.password);
  if (fields.url) await page.getByLabel("Website 1", { exact: true }).fill(fields.url);
  if (fields.otp) await page.getByLabel("2FA secret or otpauth link").fill(fields.otp);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("article", { name: fields.title })).toBeVisible();
}

export async function unlock(page: Page, master = MASTER) {
  await page.getByLabel("Master password").fill(master);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Passwords" })).toBeVisible({ timeout: 30_000 });
}

/** Wait for this page's service worker to be in control, so it can serve offline. */
export async function swReady(page: Page) {
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((r) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => r(), { once: true });
        reg.active?.postMessage({ type: "SKIP_WAITING" });
        setTimeout(r, 3000);
      });
    }
  });
}
